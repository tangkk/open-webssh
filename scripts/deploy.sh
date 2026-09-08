#!/usr/bin/env bash
set -euo pipefail

: "${WEBSSH_DEPLOY_HOST:?Set WEBSSH_DEPLOY_HOST to the gateway hostname or IP}"
: "${WEBSSH_PUBLIC_ORIGIN:?Set WEBSSH_PUBLIC_ORIGIN to the exact HTTPS origin}"
: "${WEBSSH_SSH_USER:?Set WEBSSH_SSH_USER to the remote SSH user}"
: "${WEBSSH_SSH_PORT:?Set WEBSSH_SSH_PORT to the reverse SSH port}"

deploy_user="${WEBSSH_DEPLOY_USER:-root}"
remote_dir="${WEBSSH_REMOTE_DIR:-/opt/webssh}"
remote_env="${WEBSSH_REMOTE_ENV:-/etc/webssh/webssh.env}"
service_name="${WEBSSH_SYSTEMD_SERVICE:-webssh.service}"
remote_target="${deploy_user}@${WEBSSH_DEPLOY_HOST}"
remote_env_dir="${remote_env%/*}"

if [[ "$remote_env_dir" == "$remote_env" ]]; then
  echo "WEBSSH_REMOTE_ENV must include a directory" >&2
  exit 1
fi

temp_env="$(mktemp "${TMPDIR:-/tmp}/open-webssh-env.XXXXXX")"
trap 'rm -f "$temp_env"' EXIT

cat >"$temp_env" <<EOF
NODE_ENV=production
PORT=${WEBSSH_PORT:-3000}
PUBLIC_ORIGIN=${WEBSSH_PUBLIC_ORIGIN}
SSH_HOST=${WEBSSH_SSH_HOST:-127.0.0.1}
SSH_PORT=${WEBSSH_SSH_PORT}
SSH_USER=${WEBSSH_SSH_USER}
SSH_KNOWN_HOSTS=${WEBSSH_SSH_KNOWN_HOSTS:-/etc/webssh/known_hosts}
ALLOWLIST_FILE=${WEBSSH_ALLOWLIST_FILE:-/etc/webssh/allowed_fingerprints}
MAX_CONNECTIONS=${WEBSSH_MAX_CONNECTIONS:-4}
TARGET_LABEL=${WEBSSH_TARGET_LABEL:-Remote}
GATEWAY_LABEL=${WEBSSH_GATEWAY_LABEL:-Gateway}
TMUX_SESSION=${WEBSSH_TMUX_SESSION:-main}
TMUX_BIN=${WEBSSH_TMUX_BIN:-tmux}
EOF

VITE_WEBSSH_APP_NAME="${WEBSSH_APP_NAME:-Open WebSSH}" \
VITE_WEBSSH_TARGET_LABEL="${WEBSSH_TARGET_LABEL:-Remote}" \
VITE_WEBSSH_GATEWAY_LABEL="${WEBSSH_GATEWAY_LABEL:-Gateway}" \
VITE_WEBSSH_TMUX_SESSION="${WEBSSH_TMUX_SESSION:-main}" \
npm run build

ssh "$remote_target" "install -d -m 755 '$remote_dir' '$remote_env_dir'"
scp -r dist dist-server package.json package-lock.json "$remote_target:$remote_dir/"
scp "$temp_env" "$remote_target:/tmp/open-webssh-env.$$"
ssh "$remote_target" "install -o root -g root -m 600 /tmp/open-webssh-env.$$ '$remote_env' && rm -f /tmp/open-webssh-env.$$ && systemctl restart '$service_name' && systemctl is-active --quiet '$service_name'"

echo "Deployed WebSSH to ${remote_target}:${remote_dir}"
