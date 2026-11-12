#!/usr/bin/env bash
# VM startup script (set by gce.sh): mount the data disk, install Docker, write
# the environment from Secret Manager, start the proxy + Caddy with the image
# named in the instance metadata.
set -euo pipefail
md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }

# Persistent disk (formatted once) at /mnt/disks/data.
DEV=/dev/disk/by-id/google-data
mkdir -p /mnt/disks/data
blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -m 0 -F "$DEV"
mountpoint -q /mnt/disks/data || mount -o discard,defaults "$DEV" /mnt/disks/data
grep -q /mnt/disks/data /etc/fstab || echo "$DEV /mnt/disks/data ext4 discard,defaults,nofail 0 2" >> /etc/fstab
mkdir -p /mnt/disks/data/caddy && chown 1000:1000 /mnt/disks/data

command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }
REGION_HOST=$(md image | cut -d/ -f1)
gcloud auth configure-docker "$REGION_HOST" --quiet

# Secrets -> env file readable by root only.
mkdir -p /etc/ast-proxy
secret() { gcloud secrets versions access latest --secret "$1"; }
umask 077
{
  echo "PUBLIC_URL=https://$(md domain)"
  echo "ANTHROPIC_API_KEY=$(secret ast-anthropic-key)"
  echo "DEEPL_API_KEY=$(secret ast-deepl-key)"
  echo "STRIPE_SECRET_KEY=$(secret ast-stripe-secret)"
  echo "STRIPE_WEBHOOK_SECRET=$(secret ast-stripe-webhook)"
  echo "STRIPE_PRICE_STANDARD=$(secret ast-stripe-price-standard)"
  echo "STRIPE_PRICE_PRO=$(secret ast-stripe-price-pro)"
  echo "RESEND_API_KEY=$(secret ast-resend-key)"
  echo "MAIL_FROM=$(secret ast-mail-from)"
  echo "ADMIN_TOKEN=$(secret ast-admin-token)"
} > /etc/ast-proxy/env

mkdir -p /opt/ast-proxy && cd /opt/ast-proxy
md compose > docker-compose.yml
md caddyfile > Caddyfile
export IMAGE="$(md image)" DOMAIN="$(md domain)"
docker compose pull
docker compose up -d --remove-orphans
