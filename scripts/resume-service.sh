#!/usr/bin/env bash

# =============================================================================
# DATAGOL API — Reanudar Instancia de Cloud Run tras scripts/pause-service.sh
# =============================================================================
# Restaura los mismos valores de producción que usa scripts/deploy.sh
# (--min-instances=1 innegociable para cero cold starts en llamadas de voz,
# AGENTS.md §3). No reconstruye ni redespliega la imagen — solo vuelve a
# permitir que el servicio aloje instancias, sobre la misma revisión que ya
# estaba corriendo antes de pausar.
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

gcloud run services update "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --min-instances="$MIN_INSTANCES" \
    --max-instances="$MAX_INSTANCES" \
    --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")

echo "================================================================="
echo "✅ Servicio reanudado."
echo "🔍 Probando endpoint de salud (/health y /ready)..."
echo "================================================================="

curl -sS "$SERVICE_URL/health" || true
echo ""
curl -sS "$SERVICE_URL/ready" || true
echo ""
