#!/bin/bash
PROJECT_ID="your-gcp-project-id"
TAG=${1:-"latest"}

echo "🔄 Updating whisper-service with tag: $TAG"

# Build new image
echo "🐳 Building new image..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/whisper-service:$TAG

# Update deployment
echo "📝 Updating deployment..."
kubectl set image deployment/whisper-service \
    whisper-service=gcr.io/$PROJECT_ID/whisper-service:$TAG \
    -n whisper-service

# Wait for rollout
echo "⏳ Waiting for rollout to complete..."
kubectl rollout status deployment/whisper-service -n whisper-service

echo "✅ Update complete!"