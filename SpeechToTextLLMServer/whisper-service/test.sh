#!/bin/bash
set -e

PROJECT_ID="clouddockercontainers"  
CLUSTER_NAME="whisper-cluster"
REGION="us-central1"

# Deploy Whisper service
kubectl apply -f k8s/whisper-deployment.yaml
kubectl apply -f k8s/whisper-service.yaml
kubectl apply -f k8s/horizontal-pod-autoscaler.yaml

# Wait for deployment
echo "⏳ Waiting for deployment to be ready..."
kubectl wait --for=condition=available --timeout=600s deployment/whisper-service -n whisper-service

# Wait for LoadBalancer to get external IP
echo "⏳ Waiting for LoadBalancer IP..."
kubectl wait --for=jsonpath='{.status.loadBalancer.ingress[0].ip}' --timeout=300s service/whisper-service -n whisper-service

# Get service status
echo "📊 Deployment Status:"
kubectl get pods -n whisper-service
kubectl get services -n whisper-service

# Get the actual external IP
EXTERNAL_IP=$(kubectl get service whisper-service -n whisper-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "✅ Deployment complete!"
echo "🔗 Your API is available at: http://$EXTERNAL_IP"
echo "📋 Notes:"
echo "   - Using HTTP (not HTTPS) since no domain/SSL certificate"
echo "   - Update your Chrome extension with: http://$EXTERNAL_IP"
echo "   - External IP: $EXTERNAL_IP"