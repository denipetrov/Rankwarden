#!/usr/bin/env bash
#
# Deploys the database and the service, in the order that keeps the database
# structure ahead of the code that needs it:
#
#   1. MongoDB        StatefulSet up, then its users Job (roles and passwords)
#   2. schema Job     collections, indexes, one-off data repairs — as the
#                     schema user, the only one allowed to change structure
#   3. Rankwarden     one replica, started with DB_SCHEMA_MODE=verify: it checks
#                     the structure and refuses to start if step 2 was skipped
#
# Steps 2 and 3 are one Helm release: the schema Job is a pre-install /
# pre-upgrade hook, so a failed schema step stops the release before the
# running version is touched.
#
# Usage:
#   deploy/scripts/deploy.sh <image-tag>
#
# Environment:
#   NAMESPACE (rankwarden)
#   MONGODB_HELM_ARGS, RANKWARDEN_HELM_ARGS   extra arguments for each release,
#                                             e.g. "--values local.yaml"
#   SKIP_MONGODB=1                            leave the database release alone

set -euo pipefail

IMAGE_TAG="${1:-}"
if [ -z "$IMAGE_TAG" ]; then
  echo "usage: $0 <image-tag>" >&2
  exit 1
fi

NAMESPACE="${NAMESPACE:-rankwarden}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for tool in kubectl helm; do
  command -v "$tool" >/dev/null || { echo "error: ${tool} is not installed" >&2; exit 1; }
done

# Helm 4 renamed --atomic to --rollback-on-failure.
case "$(helm version --short)" in
  v3.*) ROLLBACK_FLAG=--atomic ;;
  *) ROLLBACK_FLAG=--rollback-on-failure ;;
esac

echo "cluster:   $(kubectl config current-context)"
echo "namespace: ${NAMESPACE}"
echo "image tag: ${IMAGE_TAG}"
echo

for secret in mongodb-auth rankwarden-app rankwarden-schema; do
  if ! kubectl get secret "$secret" --namespace "$NAMESPACE" >/dev/null 2>&1; then
    echo "error: secret/${secret} does not exist in ${NAMESPACE}; run deploy/scripts/create-secrets.sh first" >&2
    exit 1
  fi
done

if [ "${SKIP_MONGODB:-}" != "1" ]; then
  echo "==> MongoDB"
  # No rollback on failure: a database is never rolled back automatically.
  # shellcheck disable=SC2086
  helm upgrade --install mongodb "$ROOT/helm/mongodb" \
    --namespace "$NAMESPACE" \
    --wait --timeout 15m \
    ${MONGODB_HELM_ARGS:-}
  echo
fi

echo "==> Rankwarden (schema Job, then the service)"
# shellcheck disable=SC2086
helm upgrade --install rankwarden "$ROOT/helm/rankwarden" \
  --namespace "$NAMESPACE" \
  --set-string "image.tag=${IMAGE_TAG}" \
  --wait --timeout 20m "$ROLLBACK_FLAG" \
  ${RANKWARDEN_HELM_ARGS:-}

echo
kubectl get pods --namespace "$NAMESPACE" -o wide
echo
echo "Deployed ${IMAGE_TAG}. Readiness, from inside the cluster:"
echo "  kubectl -n ${NAMESPACE} port-forward deploy/rankwarden 3000:3000"
echo "  curl http://localhost:3000/health/ready"
