#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu 22.04/24.04 server.
#
#   Usage (from the folder that contains tracker.py and deploy/):
#     sudo bash deploy/install.sh mailspy.aryanh.dev
#
# Installs Python + Caddy, runs MailSpy as a locked-down system service on
# 127.0.0.1:8025, and puts Caddy in front with automatic HTTPS for your domain.
# Safe to re-run: it updates tracker.py and keeps your data/config.
set -euo pipefail

DOMAIN="${1:?usage: sudo bash deploy/install.sh track.yourdomain.com}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
if [[ ! -f "$HERE/tracker.py" ]]; then echo "tracker.py not found next to deploy/."; exit 1; fi

echo "==> Installing Python and Caddy"
apt-get update -y
apt-get install -y python3 curl gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Creating service user and files"
id mailspy >/dev/null 2>&1 || useradd --system --home /opt/mailspy --shell /usr/sbin/nologin mailspy
mkdir -p /opt/mailspy/data
install -m 0644 "$HERE/tracker.py" /opt/mailspy/tracker.py
chown -R mailspy:mailspy /opt/mailspy
chmod 0700 /opt/mailspy/data

echo "==> Installing systemd service"
sed "s/__DOMAIN__/$DOMAIN/" "$HERE/deploy/mailspy.service" > /etc/systemd/system/mailspy.service
systemctl daemon-reload
systemctl enable mailspy
systemctl restart mailspy

echo "==> Configuring Caddy (automatic HTTPS)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8025 {
		flush_interval -1
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> Opening the firewall for HTTP/HTTPS (if ufw is active)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp; ufw allow 443/tcp
fi

cat <<EOF

Done. Next steps:
  1. Set your dashboard password:
       sudo -u mailspy MAILSPY_DATA_DIR=/opt/mailspy/data python3 /opt/mailspy/tracker.py set-password
       sudo systemctl restart mailspy
  2. Get the API key for the Chrome extension:
       sudo grep api_key /opt/mailspy/data/config.json
  3. Sign in at: https://$DOMAIN/emailtrack

Logs:    sudo journalctl -u mailspy -f
Update:  copy the new tracker.py here and re-run this script.
EOF
