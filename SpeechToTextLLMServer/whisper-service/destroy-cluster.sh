#!/bin/bash
set -e

PROJECT_ID="clouddockercontainers"
CLUSTER_NAME="whisper-cluster"
REGION="northamerica-northeast1"

echo "⚠️  WARNING: This will completely delete your cluster!"
echo "💾 Your container images will be preserved in Container Registry"
echo "🗄️  Your Redis data (cache) will be lost"
echo "💰 This saves the most money (~$100-200/month depending on usage)"
echo ""
read -p "Are you sure you want to delete the cluster? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "❌ Cluster deletion cancelled"
    exit 1
fi

echo "🗑️  Deleting GKE cluster..."
gcloud container clusters delete $CLUSTER_NAME \
    --region=$REGION \
    --project=$PROJECT_ID \
    --quiet

echo "🗑️  Releasing static IP..."
gcloud compute addresses delete whisper-ip \
    --global \
    --project=$PROJECT_ID \
    --quiet

echo "✅ Cluster completely destroyed!"
echo "💰 Maximum cost savings achieved"
echo "📋 What's preserved:"
echo "   - Container images in gcr.io/$PROJECT_ID"
echo "   - Source code and Kubernetes manifests"
echo ""
echo "🔄 To recreate: run ./deploy.sh"
