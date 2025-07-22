#!/bin/bash

echo "📊 Whisper Service Status"
echo "========================"

# Cluster status
echo "🏗️  Cluster Status:"
gcloud container clusters describe whisper-cluster \
    --region=us-central1 \
    --format="value(status,currentNodeCount,nodePoolDefaults.nodeConfigDefaults.machineType)"

echo ""

# Pod status
echo "☸️  Pod Status:"
kubectl get pods -n whisper-service -o wide

echo ""

# Service status
echo "🌐 Service Status:"
kubectl get svc -n whisper-service

echo ""

# Ingress status
echo "🔗 Ingress Status:"
kubectl get ingress -n whisper-service

echo ""

# HPA status
echo "📈 Auto-scaling Status:"
kubectl get hpa -n whisper-service

echo ""

# Recent logs
echo "📋 Recent Logs (last 50 lines):"
kubectl logs -n whisper-service deployment/whisper-service --tail=50