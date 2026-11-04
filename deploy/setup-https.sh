#!/bin/bash
# Put the dashboard on HTTPS with Caddy (automatic Let's Encrypt certificate).
# Run as root after setup-server.sh:
#   ssh root@SERVER 'HOSTNAME_FQDN=2-29-115-23.sslip.io bash -s' < deploy/setup-https.sh
#
# The app keeps listening on 127.0.0.1:3000 and keeps its password; Caddy is the
# only thing on ports 80/443. sslip.io names resolve to the IP inside them, so no
# domain is needed. To use your own domain later, point it at the server and
# re-run with HOSTNAME_FQDN=your.domain.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
: "${HOSTNAME_FQDN:?set HOSTNAME_FQDN, e.g. 2-29-115-23.sslip.io}"

apt-get -y -q install caddy

cat >/etc/caddy/Caddyfile <<EOF
{
	email admin@${HOSTNAME_FQDN}
}

${HOSTNAME_FQDN} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Frame-Options "DENY"
		-Server
	}
	reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

ufw allow 80/tcp comment 'HTTP (redirects to HTTPS, certificate checks)'
ufw allow 443/tcp comment 'HTTPS dashboard'

echo "waiting for the certificate..."
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://${HOSTNAME_FQDN}/" || true)
  [ "$code" = "401" ] && { echo "https://${HOSTNAME_FQDN}/ is up (401 = password required)"; exit 0; }
  sleep 3
done
echo "HTTPS not answering yet; check: journalctl -u caddy -n 50"
exit 1
