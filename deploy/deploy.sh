#!/usr/bin/env bash
# Deploy / update the Wiki Assistant agent sidecar on the EC2 host.
#
# Idempotent: safe to re-run for updates. First run installs the systemd unit
# and creates the service user; subsequent runs just rebuild and restart.
#
# Prereqs (one-time, run manually as root before first deploy):
#   1. Node 20+ installed (e.g. via NodeSource).
#   2. git installed.
#   3. /opt/magi-assistant-wiki cloned from GitHub.
#   4. /opt/magi-assistant-wiki/.env populated with real secrets.
#   5. Nginx snippets in /etc/nginx/snippets/ (see nginx-*.conf in this dir).
#
# Usage: sudo bash deploy/deploy.sh

set -euo pipefail

REPO_DIR=/opt/magi-assistant-wiki
SERVICE_USER=magi-assistant
SERVICE_NAME=magi-assistant-wiki
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$(id -u)" != "0" ]; then
    echo "must run as root (use sudo)" >&2
    exit 1
fi

if [ ! -d "$REPO_DIR" ]; then
    echo "$REPO_DIR not found — clone the repo first" >&2
    exit 1
fi

if [ ! -f "$REPO_DIR/.env" ]; then
    echo "$REPO_DIR/.env missing — copy .env.example and fill it in" >&2
    exit 1
fi

# 1. Service user (create if missing).
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 2. Ensure the repo (and everything inside it) is owned by the service user
# so subsequent git/npm/build steps can run as that user. Idempotent.
chown -R "$SERVICE_USER":"$SERVICE_USER" "$REPO_DIR"

# 3. Sync code from git.
cd "$REPO_DIR"
sudo -u "$SERVICE_USER" git fetch --all --prune
sudo -u "$SERVICE_USER" git checkout main
sudo -u "$SERVICE_USER" git pull --ff-only

# 3. Install dependencies (include dev for the TypeScript build).
sudo -u "$SERVICE_USER" npm ci

# 4. Build.
sudo -u "$SERVICE_USER" npm run build

# 5. Prune dev dependencies for runtime.
sudo -u "$SERVICE_USER" npm prune --omit=dev

# 6. Lock down .env permissions (contains the Anthropic API key).
chown "$SERVICE_USER":"$SERVICE_USER" "$REPO_DIR/.env"
chmod 600 "$REPO_DIR/.env"

# 7. Install / refresh the systemd unit.
if ! cmp -s "$REPO_DIR/deploy/${SERVICE_NAME}.service" "$UNIT_FILE"; then
    cp "$REPO_DIR/deploy/${SERVICE_NAME}.service" "$UNIT_FILE"
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
fi

# 8. Restart and verify.
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME" || {
    echo "service failed to start — check: journalctl -u ${SERVICE_NAME} -n 50" >&2
    exit 1
}

# 9. Hit the local health endpoint to confirm it's responding.
curl -fsS http://127.0.0.1:8766/api/assistant/health
echo
echo "deploy ok"
