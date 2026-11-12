#!/usr/bin/env bash
# Deploy the hosted translation proxy to one Compute Engine VM with a persistent
# disk (SQLite needs a real disk and a single writer - Cloud Storage volumes
# don't lock and lose concurrent writes). Caddy on the VM serves HTTPS.
# Prerequisites and secrets: server/README.md ("Deploy"). From the repo root:
#   PROJECT=my-gcp-project ZONE=us-central1-a DOMAIN=api.example.com server/deploy/gce.sh
# Re-run to roll out a new build (the VM pulls the new image and restarts).
set -euo pipefail

: "${PROJECT:?set PROJECT (GCP project id)}"
: "${ZONE:=us-central1-a}"
: "${DOMAIN:?set DOMAIN (DNS name pointing at the static IP of the VM)}"
REGION="${ZONE%-*}"
VM=ast-proxy
DISK=ast-proxy-data
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ast/ast-proxy:$(git rev-parse --short HEAD)"

gcloud config set project "$PROJECT" >/dev/null

# 1. Build the image with Cloud Build (no local Docker needed).
gcloud artifacts repositories describe ast --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create ast --repository-format docker --location "$REGION"
gcloud builds submit . --config server/deploy/cloudbuild.yaml --substitutions "_IMAGE=${IMAGE}"

# 2. Static IP, persistent disk, firewall (first run only).
gcloud compute addresses describe "$VM" --region "$REGION" >/dev/null 2>&1 ||
  gcloud compute addresses create "$VM" --region "$REGION"
IP=$(gcloud compute addresses describe "$VM" --region "$REGION" --format 'value(address)')
gcloud compute disks describe "$DISK" --zone "$ZONE" >/dev/null 2>&1 ||
  gcloud compute disks create "$DISK" --zone "$ZONE" --size 10GB --type pd-balanced
gcloud compute firewall-rules describe ast-proxy-web >/dev/null 2>&1 ||
  gcloud compute firewall-rules create ast-proxy-web --allow tcp:80,tcp:443 --target-tags ast-proxy

# 3. The VM: Debian + Docker; the startup script mounts the disk, writes the env
#    file from Secret Manager and (re)starts the stack with the current image.
METADATA="image=${IMAGE},domain=${DOMAIN}"
if gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
  gcloud compute instances add-metadata "$VM" --zone "$ZONE" --metadata "$METADATA" \
    --metadata-from-file startup-script=server/deploy/startup.sh,compose=server/deploy/docker-compose.yml,caddyfile=server/deploy/Caddyfile
  gcloud compute ssh "$VM" --zone "$ZONE" --command 'sudo google_metadata_script_runner startup'
else
  gcloud compute instances create "$VM" --zone "$ZONE" --machine-type e2-small \
    --image-family debian-12 --image-project debian-cloud \
    --address "$IP" --tags ast-proxy \
    --disk "name=${DISK},device-name=data,mode=rw,auto-delete=no" \
    --scopes cloud-platform \
    --metadata "$METADATA" \
    --metadata-from-file startup-script=server/deploy/startup.sh,compose=server/deploy/docker-compose.yml,caddyfile=server/deploy/Caddyfile
fi

echo "Point ${DOMAIN} (A record) at ${IP}. Stripe webhook endpoint: https://${DOMAIN}/v1/stripe/webhook"
