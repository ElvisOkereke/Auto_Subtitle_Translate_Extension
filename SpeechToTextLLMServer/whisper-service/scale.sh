#!/bin/bash

REPLICAS=${1:-3}

echo "📈 Scaling whisper-service to $REPLICAS replicas..."

kubectl scale deployment whisper-service \
    --replicas=$REPLICAS \
    -n whisper-service

kubectl rollout status deployment/whisper-service -n whisper-service

echo "✅ Scaling complete!"
kubectl get pods -n whisper-service