#!/usr/bin/env bash

# =============================================================================
# DATAGOL API — Reanudar Instancia de Cloud Run tras pause-service-dev.sh
# =============================================================================
# Restaura el servicio a estado operativo:
# 1. --max-instances=10 : Permite atender concurrencia.
# 2. --min-instances=1  : Instancia caliente para llamadas de voz (AGENTS.md §3)
#                         (puede sobreescribirse con GCP_MIN_INSTANCES=0).
# 3. --ingress=all      : Reabre el tráfico público para webhooks y tool calls.
# =============================================================================

set -euo pipefail

REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
SERVICE_NAME="${GCP_SERVICE_NAME:-datagol-api}"
MIN_INSTANCES="${GCP_MIN_INSTANCES:-1}"
MAX_INSTANCES="${GCP_MAX_INSTANCES:-10}"

echo "================================================================="
echo "▶️  Reanudando Datagol API en Cloud Run"
echo "📍 Proyecto GCP:  $PROJECT_ID"
echo "📍 Región:        $REGION"
echo "📦 Servicio:      $SERVICE_NAME"
echo "📊 Instancias:    min=$MIN_INSTANCES max=$MAX_INSTANCES"
echo "================================================================="

if ! command -v gcloud &>/dev/null; then
    echo "❌ Error: gcloud CLI no está instalado o no está en el PATH." >&2
    exit 1
fi

# Si min-instances >= 1, asignamos CPU Always Allocated (--no-cpu-throttling) para latencia cero.
# Si min-instances == 0, activamos cpu-throttling para que solo cobre durante peticiones.
CPU_FLAG="--no-cpu-throttling"
if [ "$MIN_INSTANCES" -eq 0 ]; then
    CPU_FLAG="--cpu-throttling"
fi

echo "⚙️  Actualizando servicio con $CPU_FLAG e ingress=all..."
gcloud run services update "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --min-instances="$MIN_INSTANCES" \
    --max-instances="$MAX_INSTANCES" \
    --ingress=all \
    $CPU_FLAG \
    --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")

echo "================================================================="
echo "✅ Servicio reanudado exitosamente."
echo "🔗 URL: $SERVICE_URL"
echo "🔍 Probando endpoint de salud (/health y /ready)..."
echo "================================================================="

curl -sS "$SERVICE_URL/health" || true
echo ""
curl -sS "$SERVICE_URL/ready" || true
echo ""
