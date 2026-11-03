#!/bin/bash
# Lightsail launch script: a Caddy forward proxy with a fixed IP for INDstocks order calls.
#
# It holds no broker credentials. Clients open an encrypted tunnel through it to
# api.indstocks.com, so this box only ever relays TLS bytes: it cannot read tokens,
# MPINs or orders. It keeps no access log.
#
# Paste this whole file into Lightsail > Create instance > Add launch script (Ubuntu 24.04).
# After the instance is up: attach a static IP, open TCP 443 in its firewall, then
# reboot it once (or run `sudo systemctl restart anton-proxy`). `sudo anton-proxy-url`
# prints the proxy URL to save in Anton.
set -euo pipefail

ALLOWED_HOSTS="api.indstocks.com checkip.amazonaws.com"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl openssl unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades || true

case "$(uname -m)" in
	x86_64) ARCH=amd64 ;;
	aarch64) ARCH=arm64 ;;
	*) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
# Caddy's own build service, with the forwardproxy plugin compiled in.
curl -fsSL -o /usr/local/bin/caddy \
	"https://caddyserver.com/api/download?os=linux&arch=${ARCH}&p=github.com/caddyserver/forwardproxy"
chmod 755 /usr/local/bin/caddy
/usr/local/bin/caddy version

id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -m 755 /etc/caddy
install -d -m 700 /etc/anton-proxy
# Hex only, so the password needs no escaping inside a URL.
[ -s /etc/anton-proxy/password ] || openssl rand -hex 24 > /etc/anton-proxy/password
chmod 600 /etc/anton-proxy/password
echo "$ALLOWED_HOSTS" > /etc/anton-proxy/allowed-hosts

# Writes the Caddyfile for this machine's current public IP. It runs before every
# start, so attaching a static IP and restarting is all a new address needs.
cat > /usr/local/bin/anton-proxy-config <<'EOF'
#!/bin/bash
set -euo pipefail
TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
HOST="${IP//./-}.sslip.io"
PASSWORD=$(cat /etc/anton-proxy/password)
ALLOWED=$(cat /etc/anton-proxy/allowed-hosts)
echo "$HOST" > /etc/anton-proxy/host
cat > /etc/caddy/Caddyfile <<CADDY
{
	order forward_proxy before file_server
	admin off
}

# ":443" as well as the name: a CONNECT request carries the target's host, not this
# one, so the site has to answer every host for the proxy to see it.
:443, ${HOST} {
	forward_proxy {
		basic_auth anton ${PASSWORD}
		hide_ip
		hide_via
		# Without the password it looks like an empty web server.
		probe_resistance
		ports 443
		acl {
			allow ${ALLOWED}
			deny all
		}
	}
}
CADDY
chown root:caddy /etc/caddy/Caddyfile
chmod 640 /etc/caddy/Caddyfile
EOF
chmod 700 /usr/local/bin/anton-proxy-config

cat > /usr/local/bin/anton-proxy-url <<'EOF'
#!/bin/bash
# The URL to save in Anton as TRADING_PROXY. Run with sudo.
echo "https://anton:$(cat /etc/anton-proxy/password)@$(cat /etc/anton-proxy/host)"
EOF
chmod 700 /usr/local/bin/anton-proxy-url

cat > /etc/systemd/system/anton-proxy.service <<'EOF'
[Unit]
Description=Caddy forward proxy for INDstocks order calls
Wants=network-online.target
After=network-online.target

[Service]
User=caddy
Group=caddy
ExecStartPre=+/usr/local/bin/anton-proxy-config
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
Environment=XDG_DATA_HOME=/var/lib XDG_CONFIG_HOME=/var/lib/caddy/config
StateDirectory=caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now anton-proxy
