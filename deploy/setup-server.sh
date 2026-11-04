#!/bin/bash
# One-time setup of a fresh Ubuntu server for the dashboard. Run as root:
#   ssh root@SERVER 'bash -s' < deploy/setup-server.sh
#
# - security updates installed now and automatically from then on
# - firewall: only SSH (22) is open; the dashboard listens on 127.0.0.1 only
# - SSH: key login only, no passwords; root login by key only
# - Node 22 LTS in /opt/node (checksum verified)
# - a locked-down "bot" system user that runs the app from /opt/trading-bot
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

NODE_MAJOR=22
APP_DIR=/opt/trading-bot

apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ufw unattended-upgrades curl ca-certificates rsync

# Automatic security updates (reboots at 04:00 UTC only if a kernel update needs it)
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52trading-bot-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF

# SSH: keys only
cat >/etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
EOF
sshd -t
# Ubuntu 24.04+ starts sshd per connection (ssh.socket), so there may be nothing to reload.
systemctl try-reload-or-restart ssh.service 2>/dev/null || true

# Firewall: SSH in, everything out
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# Node.js LTS from nodejs.org, checksum verified
arch=$(uname -m); case "$arch" in x86_64) arch=x64;; aarch64) arch=arm64;; esac
base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
file=$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-${arch}.tar.xz" | head -1)
tmp=$(mktemp -d)
curl -fsSL "$base/$file" -o "$tmp/$file"
(cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -)
rm -rf /opt/node && mkdir -p /opt/node
tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx
rm -rf "$tmp"

# App user and folders
id bot >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin bot
mkdir -p "$APP_DIR/data"
chown -R bot:bot "$APP_DIR"
chmod 750 "$APP_DIR"

echo "setup done: $(node -v), firewall: $(ufw status | head -1)"
