#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu VPS for Clip Network, run as root from the repository root:
#
#   sudo ./deploy/setup-vps.sh app.example.com you@example.com
#
# Arguments: the public domain (its DNS A record must already point at this server) and an email
# for Let's Encrypt certificate notices, also used as the legal contact unless LEGAL_EMAIL is set.
# Safe to re-run: existing secrets in .env.production are kept.
set -euo pipefail

APP_DOMAIN="${1:-}"
ACME_EMAIL="${2:-}"
LEGAL_EMAIL="${LEGAL_EMAIL:-$ACME_EMAIL}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.production"
COMPOSE=(docker compose -f "$REPO_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE")

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
if [[ ! "$APP_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
  echo "Usage: $0 <app-domain> <email>   e.g. $0 app.example.com you@example.com" >&2; exit 1
fi
if [[ ! "$ACME_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "Give a valid email for certificate notices as the second argument." >&2; exit 1
fi

step() { printf '\n==> %s\n' "$*"; }

step "Installing Docker, Caddy and the firewall from Ubuntu's repositories"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git openssl ufw docker.io docker-compose-v2 caddy
systemctl enable --now docker

step "Checking that $APP_DOMAIN points at this server"
SERVER_IP="$(curl -4 -fsS https://api.ipify.org || true)"
DOMAIN_IP="$(getent ahostsv4 "$APP_DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [[ -n "$SERVER_IP" && "$DOMAIN_IP" != "$SERVER_IP" ]]; then
  echo "WARNING: $APP_DOMAIN resolves to '${DOMAIN_IP:-nothing}', but this server is $SERVER_IP."
  echo "Create an A record for $APP_DOMAIN -> $SERVER_IP first, or HTTPS certificates will fail."
fi

step "Firewall: allow SSH, HTTP and HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

step "Writing .env.production"
if [[ ! -f "$ENV_FILE" ]]; then
  hex() { openssl rand -hex "$1"; }
  POSTGRES_PASSWORD="$(hex 24)"
  sed -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
      -e "s|__LEGAL_EMAIL__|$LEGAL_EMAIL|g" \
      -e "s|__ENCRYPTION_MASTER_KEY__|$(hex 32)|g" \
      -e "s|__POSTGRES_PASSWORD__|$POSTGRES_PASSWORD|g" \
      -e "s|__S3_ACCESS_KEY_ID__|clipnetwork$(hex 6)|g" \
      -e "s|__S3_SECRET_ACCESS_KEY__|$(hex 24)|g" \
      "$REPO_DIR/deploy/env.production.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "    Created with new secrets. Back this file up somewhere safe: losing ENCRYPTION_MASTER_KEY"
  echo "    makes saved integration keys and connected social accounts unreadable."
else
  echo "    Kept the existing file (secrets unchanged)."
fi
BUCKET="$(grep -E '^S3_BUCKET=' "$ENV_FILE" | cut -d= -f2)"

step "Configuring Caddy for https://$APP_DOMAIN"
sed -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" -e "s|__ACME_EMAIL__|$ACME_EMAIL|g" -e "s|__S3_BUCKET__|${BUCKET:-clip-network-media}|g" \
  "$REPO_DIR/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

step "Building and starting the stack (the first build takes 10-20 minutes)"
"${COMPOSE[@]}" up -d --build

step "Waiting for the API to become healthy"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/api/readyz >/dev/null 2>&1; then break; fi
  sleep 5
done
"${COMPOSE[@]}" ps

step "Installing the nightly database backup (03:30 server time, keeps 14 days)"
cat > /etc/cron.d/clip-network-backup <<CRON
30 3 * * * root cd $REPO_DIR && BACKUP_DIR=$REPO_DIR/backups POSTGRES_USER=clipnetwork POSTGRES_DB=clipnetwork ./scripts/backup-postgres.sh >> /var/log/clip-network-backup.log 2>&1 && find $REPO_DIR/backups -name '*.sql.gz' -mtime +14 -delete
CRON
chmod 644 /etc/cron.d/clip-network-backup

cat <<DONE

Clip Network is running at https://$APP_DOMAIN

Next:
  1. Open https://$APP_DOMAIN/register and create your own account (verify the email, or sign in
     with Google once it is set up).
  2. Make that account the platform admin:
       ${COMPOSE[*]} exec api node apps/api/dist/provision-admin.js your@email.com
  3. In the app: Control Center > Integrations. Add Stripe (then "Test key and create plan prices"
     and "Create webhook"), Resend for email, and each platform's OAuth keys. Register these
     redirect URIs with the platforms:
       https://$APP_DOMAIN/social-accounts
       https://$APP_DOMAIN/auth/google
  4. Deploy updates later with: ./deploy/deploy.sh
DONE
