#!/bin/bash
set -e

PROJECT_ID="clouddockercontainers"
CLUSTER_NAME="whisper-cluster"
REGION="northamerica-northeast1"

echo "💰 Pausing Whisper Service cluster to save money..."

# Get cluster credentials first
gcloud container clusters get-credentials $CLUSTER_NAME \
    --region=$REGION \
    --project=$PROJECT_ID

echo "📉 Scaling deployments to zero..."
# Scale all deployments to 0
kubectl scale deployment whisper-service --replicas=0 -n whisper-service
kubectl scale deployment redis --replicas=0 -n whisper-service

echo "⏱️  Waiting for pods to terminate..."
kubectl wait --for=delete pod --all -n whisper-service --timeout=120s

echo "🛑 All workloads stopped!"
echo "💡 Your cluster nodes will scale down automatically (GKE Autopilot)"
echo "💾 Container images and persistent volumes are preserved"
echo ""
echo "📊 Cost savings:"
echo "   - Compute: ~90-95% reduction"
echo "   - Storage: PVCs still incur small costs (~$0.10/GB/month)"
echo "   - Networking: Load balancer still active (~$18/month)"
echo ""
echo "🔄 To resume: run ./resume-cluster.sh"
