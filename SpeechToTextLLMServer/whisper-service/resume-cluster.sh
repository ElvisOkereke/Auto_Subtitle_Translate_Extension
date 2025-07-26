#!/bin/bash
set -e

PROJECT_ID="clouddockercontainers"
CLUSTER_NAME="whisper-cluster"
REGION="northamerica-northeast1"

echo "🚀 Resuming Whisper Service cluster..."

# Get cluster credentials
gcloud container clusters get-credentials $CLUSTER_NAME \
    --region=$REGION \
    --project=$PROJECT_ID

echo "📈 Scaling deployments back up..."
# Scale Redis first
kubectl scale deployment redis --replicas=1 -n whisper-service

echo "⏳ Waiting for Redis to be ready..."
kubectl rollout status deployment/redis -n whisper-service

# Then scale whisper service
kubectl scale deployment whisper-service --replicas=2 -n whisper-service

echo "⏳ Waiting for Whisper service to be ready..."
kubectl rollout status deployment/whisper-service -n whisper-service

# Get the external IP
EXTERNAL_IP=$(kubectl get service whisper-service -n whisper-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "pending...")

echo "✅ Cluster resumed successfully!"
echo "🔗 Your API is available at: http://$EXTERNAL_IP"
echo "📊 Status:"
kubectl get pods -n whisper-service
kubectl get services -n whisper-service
