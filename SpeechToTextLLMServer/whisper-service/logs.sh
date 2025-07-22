#!/bin/bash
POD_NAME=${1:-""}

if [ -z "$POD_NAME" ]; then
    echo "📋 Available pods:"
    kubectl get pods -n whisper-service
    echo ""
    echo "Usage: ./logs.sh <pod-name>"
    echo "Or use 'all' to tail logs from deployment:"
    echo "./logs.sh all"
    exit 1
fi

if [ "$POD_NAME" = "all" ]; then
    kubectl logs -f deployment/whisper-service -n whisper-service
else
    kubectl logs -f $POD_NAME -n whisper-service
fi