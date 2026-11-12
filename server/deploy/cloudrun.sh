#!/usr/bin/env bash
# Deploy the hosted translation proxy to Google Cloud Run.
# Prerequisites and secrets: see server/README.md ("Deploy"). Run from the repo root:
#   PROJECT=my-gcp-project REGION=us-central1 PUBLIC_URL=https://api.example.com server/deploy/cloudrun.sh
set -euo pipefail

: "${PROJECT:?set PROJECT (GCP project id)}"
: "${REGION:=us-central1}"
: "${SERVICE:=ast-proxy}"
: "${BUCKET:=${PROJECT}-ast-proxy-data}"   # Cloud Storage bucket holding the SQLite database
: "${PUBLIC_URL:?set PUBLIC_URL (the service's public https URL, for Stripe return links)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ast/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud config set project "$PROJECT" >/dev/null
gcloud artifacts repositories describe ast --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create ast --repository-format docker --location "$REGION"
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://${BUCKET}" --location "$REGION" --uniform-bucket-level-access

gcloud builds submit --tag "$IMAGE" --gcs-log-dir "gs://${BUCKET}/build-logs" . --config /dev/stdin <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'server/Dockerfile', '-t', '${IMAGE}', '.']
images: ['${IMAGE}']
EOF

# One instance: SQLite lives on one volume and rate limits/in-flight caps are per process.
# Secrets come from Secret Manager (create them first, see server/README.md).
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --cpu 1 --memory 512Mi \
  --execution-environment gen2 \
  --add-volume "name=data,type=cloud-storage,bucket=${BUCKET}" \
  --add-volume-mount "volume=data,mount-path=/data" \
  --set-env-vars "PUBLIC_URL=${PUBLIC_URL},TRUST_PROXY_HOPS=1,DB_PATH=/data/app.db,MAIL_FROM=${MAIL_FROM:-Auto Subtitle Translator <login@example.com>}" \
  --set-secrets "ANTHROPIC_API_KEY=ast-anthropic-key:latest,DEEPL_API_KEY=ast-deepl-key:latest,STRIPE_SECRET_KEY=ast-stripe-secret:latest,STRIPE_WEBHOOK_SECRET=ast-stripe-webhook:latest,STRIPE_PRICE_STANDARD=ast-stripe-price-standard:latest,STRIPE_PRICE_PRO=ast-stripe-price-pro:latest,RESEND_API_KEY=ast-resend-key:latest,ADMIN_TOKEN=ast-admin-token:latest"

echo "Deployed. Stripe webhook endpoint: ${PUBLIC_URL}/v1/stripe/webhook"
