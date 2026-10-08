#!/usr/bin/env bash
#
# Creates or updates every Secret the two charts read. Run once before the
# first deploy, and again whenever a credential changes.
#
# Credentials come from the environment and go to the cluster on standard
# input: none is ever written to disk, put on a command line, or printed.
#
# Required:
#   BLIZZARD_CLIENT_ID  BLIZZARD_CLIENT_SECRET  RAIDER_IO_API_KEY
# Optional:
#   GHCR_USERNAME  GHCR_TOKEN                        pull secret for the image registry
#   BACKUP_ACCESS_KEY_ID  BACKUP_SECRET_ACCESS_KEY   bucket credentials for backups
#   NAMESPACE (rankwarden)  MONGODB_RELEASE (mongodb)  MONGODB_DATABASE (rankwarden)
#
# Database passwords are generated here, once. On a later run the existing ones
# are read back from the cluster and kept: the administrator's password is set
# when the database volume is first initialised and cannot be changed by
# changing a Secret afterwards.

set -euo pipefail

NAMESPACE="${NAMESPACE:-rankwarden}"
MONGODB_RELEASE="${MONGODB_RELEASE:-mongodb}"
MONGODB_DATABASE="${MONGODB_DATABASE:-rankwarden}"
MONGODB_HOST="${MONGODB_RELEASE}.${NAMESPACE}.svc.cluster.local:27017"

for name in BLIZZARD_CLIENT_ID BLIZZARD_CLIENT_SECRET RAIDER_IO_API_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "error: ${name} is not set" >&2
    exit 1
  fi
done

command -v kubectl >/dev/null || { echo "error: kubectl is not installed" >&2; exit 1; }

# A JSON string literal. Values are passed to the cluster as JSON on stdin, so
# anything a credential may contain is safe; a newline never belongs in one.
json() {
  case "$1" in *$'\n'*) echo "error: a credential contains a newline" >&2; exit 1 ;; esac
  local value=${1//\\/\\\\}
  printf '"%s"' "${value//\"/\\\"}"
}

# apply_secret <name> <type> <key> <value> [<key> <value> ...]
apply_secret() {
  local name=$1 type=$2 body="" separator=""
  shift 2
  while [ $# -gt 0 ]; do
    body="${body}${separator}$(json "$1"): $(json "$2")"
    separator=", "
    shift 2
  done

  printf '{"apiVersion": "v1", "kind": "Secret", "type": %s, "metadata": {"name": %s}, "stringData": {%s}}' \
    "$(json "$type")" "$(json "$name")" "$body" |
    kubectl apply --namespace "$NAMESPACE" -f - >/dev/null
  echo "applied secret/${name}"
}

# The stored value of one key, or nothing when the Secret or key is absent.
#
# Decoded by kubectl itself, so it does not depend on which `base64` the machine
# has, and with no error swallowed: a failed read must stop the script. Treating
# "could not read" as "does not exist" would generate fresh passwords over the
# live ones, and the database would then refuse the administrator it was
# initialised with.
existing() {
  kubectl get secret "$1" --namespace "$NAMESPACE" --ignore-not-found \
    -o go-template="{{ with .data }}{{ with index . \"$2\" }}{{ . | base64decode }}{{ end }}{{ end }}"
}

# 48 hex characters from the kernel's random source. Hex, so a password never
# needs escaping inside a connection string.
random_hex() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

AUTH_SECRET_EXISTS=$(kubectl get secret mongodb-auth --namespace "$NAMESPACE" --ignore-not-found -o name)

# The existing password when there is one; a new one only for a key that has
# never been set. The administrator's is never regenerated once the Secret
# exists: it is fixed when the database volume is first initialised.
password_for() {
  local current
  current=$(existing mongodb-auth "$1")

  if [ -n "$current" ]; then
    printf '%s' "$current"
  elif [ -n "$AUTH_SECRET_EXISTS" ] && [ "$1" = root-password ]; then
    echo "error: secret/mongodb-auth exists but its root-password could not be read; refusing to replace it" >&2
    exit 1
  else
    random_hex
  fi
}

ROOT_PASSWORD=$(password_for root-password)
SCHEMA_PASSWORD=$(password_for schema-password)
APP_PASSWORD=$(password_for app-password)
BACKUP_PASSWORD=$(password_for backup-password)
BACKEND_PASSWORD=$(password_for backend-password)

uri() { printf 'mongodb://%s:%s@%s/%s?authSource=admin' "$1" "$2" "$MONGODB_HOST" "$MONGODB_DATABASE"; }

apply_secret mongodb-auth Opaque \
  root-password "$ROOT_PASSWORD" \
  schema-password "$SCHEMA_PASSWORD" \
  app-password "$APP_PASSWORD" \
  backup-password "$BACKUP_PASSWORD" \
  backend-password "$BACKEND_PASSWORD"

# What the service runs with: a user that reads and writes documents only.
apply_secret rankwarden-app Opaque \
  BLIZZARD_CLIENT_ID "$BLIZZARD_CLIENT_ID" \
  BLIZZARD_CLIENT_SECRET "$BLIZZARD_CLIENT_SECRET" \
  RAIDER_IO_API_KEY "$RAIDER_IO_API_KEY" \
  MONGODB_URI "$(uri rankwarden_app "$APP_PASSWORD")"

# What the schema Job runs with: the one user allowed to change structure.
apply_secret rankwarden-schema Opaque \
  MONGODB_URI "$(uri rankwarden_schema "$SCHEMA_PASSWORD")"

if [ -n "${BACKUP_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_SECRET_ACCESS_KEY:-}" ]; then
  apply_secret mongodb-backup Opaque \
    MONGODB_URI "$(uri rankwarden_backup "$BACKUP_PASSWORD")" \
    ACCESS_KEY_ID "$BACKUP_ACCESS_KEY_ID" \
    SECRET_ACCESS_KEY "$BACKUP_SECRET_ACCESS_KEY"
else
  echo "skipped secret/mongodb-backup: BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY are not set"
  echo "  the backup CronJob cannot start without it; deploy with backup.enabled=false until it exists"
fi

if [ -n "${GHCR_USERNAME:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
  auth=$(printf '%s:%s' "$GHCR_USERNAME" "$GHCR_TOKEN" | base64 | tr -d '\n')
  apply_secret ghcr kubernetes.io/dockerconfigjson \
    .dockerconfigjson "{\"auths\": {\"ghcr.io\": {\"auth\": \"${auth}\"}}}"
else
  echo "skipped secret/ghcr: GHCR_USERNAME and GHCR_TOKEN are not set"
fi

echo
echo "The backend's read-only connection string, when it is needed:"
echo "  kubectl get secret mongodb-auth -n ${NAMESPACE} -o go-template='{{ index .data \"backend-password\" | base64decode }}'"
echo "  mongodb://rankwarden_backend:<that password>@${MONGODB_HOST}/${MONGODB_DATABASE}?authSource=admin"
