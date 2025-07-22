#!/bin/bash
set -e

PROJECT_ID="clouddockercontainers"  
CLUSTER_NAME="whisper-cluster"
REGION="us-central1"

echo "Login......."
gcloud auth login

echo "Configure Project"
gcloud config set project clouddockercontainers

echo "🚀 Starting Whisper Service deployment to GKE Autopilot..."

# Enable required APIs
echo "📋 Enabling required GCP APIs..."
gcloud services enable container.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable containerregistry.googleapis.com
gcloud services enable compute.googleapis.com

# Create GKE Autopilot cluster
echo "🏗️  Creating GKE Autopilot cluster..."
gcloud container clusters create-auto $CLUSTER_NAME \
    --region=$REGION \
    --project=$PROJECT_ID \
    --release-channel=regular

# Get cluster credentials
echo "🔐 Getting cluster credentials..."
gcloud container clusters get-credentials $CLUSTER_NAME \
    --region=$REGION \
    --project=$PROJECT_ID

# Reserve static IP
echo "🌐 Reserving static IP..."
gcloud compute addresses create whisper-ip \
    --global \
    --project=$PROJECT_ID

# Get the reserved IP
STATIC_IP=$(gcloud compute addresses describe whisper-ip \
    --global \
    --project=$PROJECT_ID \
    --format="value(address)")

echo "📝 Reserved IP: $STATIC_IP"

# Build and push Docker image
echo "🐳 Building and pushing Docker image..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/whisper-service:latest

# Update Kubernetes manifests with project ID
echo "📝 Updating Kubernetes manifests..."
sed -i "s/YOUR_PROJECT_ID/$PROJECT_ID/g" k8s/whisper-deployment.yaml

sed -i "s/YOUR_STATIC_IP/$STATIC_IP/g" k8s/whisper-service.yaml

# Deploy to Kubernetes
echo "☸️  Deploying to Kubernetes..."
# Deploy in order: namespace, PVC, then everything else
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/redis-pvc.yaml
kubectl apply -f k8s/redis-deployment.yaml
kubectl apply -f k8s/redis-service.yaml

# Wait for Redis to be ready
echo "⏳ Waiting for Redis to be ready..."
kubectl rollout status deployment/redis -n whisper-service

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