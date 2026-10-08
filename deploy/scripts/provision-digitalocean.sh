#!/usr/bin/env bash
#
# One-time: creates the DigitalOcean Kubernetes cluster and points kubectl at
# it. Costs money from the moment it succeeds — about $48 a month for the two
# nodes (DEPLOYMENT-PLAN.md §3.4).
#
# NOT YET RUN AGAINST A REAL ACCOUNT. The charts and the other scripts were
# exercised end to end on a local cluster; this one can only be exercised by
# spending money, so read it before running it and check the flags against
# `doctl kubernetes cluster create --help` for your doctl version.
#
# Needs `doctl` authenticated (`doctl auth init`) and `kubectl`.
#
# Environment:
#   CLUSTER (rankwarden)  REGION (fra1)  NODE_SIZE (s-2vcpu-4gb)
#   NODE_COUNT (2)        MAX_NODES (3)

set -euo pipefail

CLUSTER="${CLUSTER:-rankwarden}"
REGION="${REGION:-fra1}"
NODE_SIZE="${NODE_SIZE:-s-2vcpu-4gb}"
NODE_COUNT="${NODE_COUNT:-2}"
MAX_NODES="${MAX_NODES:-3}"

for tool in doctl kubectl; do
  command -v "$tool" >/dev/null || { echo "error: ${tool} is not installed" >&2; exit 1; }
done

if doctl kubernetes cluster get "$CLUSTER" >/dev/null 2>&1; then
  echo "cluster \"${CLUSTER}\" already exists; leaving it as it is"
else
  echo "creating cluster \"${CLUSTER}\" in ${REGION}: ${NODE_COUNT} x ${NODE_SIZE}, up to ${MAX_NODES}"
  # Standard (free) control plane. Automatic patch upgrades in a fixed weekly
  # window; surge upgrades add a node before draining one, so a node upgrade
  # restarts each pod once instead of leaving it nowhere to go.
  doctl kubernetes cluster create "$CLUSTER" \
    --region "$REGION" \
    --version latest \
    --node-pool "name=default;size=${NODE_SIZE};count=${NODE_COUNT};auto-scale=true;min-nodes=${NODE_COUNT};max-nodes=${MAX_NODES}" \
    --auto-upgrade \
    --surge-upgrade \
    --maintenance-window "sunday=03:00" \
    --wait
fi

doctl kubernetes cluster kubeconfig save "$CLUSTER"

# `rankwarden` holds the service and its database. `backend` is where the
# future backend will run; it exists now only so the network policies that
# admit it have something to name.
for namespace in rankwarden backend; do
  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
done

kubectl get nodes -o wide

cat <<'NEXT'

Next:
  1. Create a Spaces bucket for backups (control panel: Spaces Object Storage,
     region FRA1, name as in deploy/helm/mongodb/values.yaml), and a Spaces
     access key limited to that bucket.
  2. deploy/scripts/create-secrets.sh   (see the variables at the top of the file)
  3. deploy/scripts/deploy.sh <image-tag>
NEXT
