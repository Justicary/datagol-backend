#!/usr/bin/env bash

# =============================================================================
# DATAGOL API — Reanudar Instancia en Modo DESARROLLO (Bajo Demanda - Costo $0)
# =============================================================================
# Configuración optimizada para pruebas y desarrollo:
# 1. --min-instances=0  : El servicio escala a 0 instancias en reposo.
# 2. --cpu-throttling   : CPU asignada solo durante peticiones (cubierto por Free Tier).
# 3. --ingress=all       : Abre tráfico público para webhooks y tool calls.
# 4. --max-instances=10 : Permite escalar si se ejecutan pruebas de carga.
# =============================================================================

set -euo pipefail

REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
SERVICE_NAME="${GCP_SERVICE_NAME:-datagol-api}"
MAX_INSTANCES="${GCP_MAX_INSTANCES:-10}"

echo "================================================================="
echo "▶️  Reanudando Datagol API en Modo DESARROLLO (Bajo Demanda)"
echo "📍 Proyecto GCP:  $PROJECT_ID"
echo "📍 Región:        $REGION"
echo "📦 Servicio:      $SERVICE_NAME"
echo "📊 Configuración: min=0 max=$MAX_INSTANCES (CPU bajo demanda / Costo \$0)"
echo "================================================================="

if ! command -v gcloud &>/dev/null; then
    echo "❌ Error: gcloud CLI no está instalado o no está en el PATH." >&2
    exit 1
fi

echo "⚙️  Configurando Cloud Run en modo Bajo Demanda con ingress=all..."
gcloud run services update "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --min-instances=0 \
    --max-instances="$MAX_INSTANCES" \
    --cpu-throttling \
    --ingress=all \
    --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")

echo "================================================================="
echo "✅ Servicio reanudado en Modo Desarrollo (Bajo Demanda)."
echo "   • min-instances: 0 (escala a 0 en reposo)"
echo "   • cpu-throttling: activado (factura solo tiempo de procesamiento)"
echo "   • ingress: all (tráfico público habilitado)"
echo "🔗 URL: $SERVICE_URL"
echo "🔍 Probando endpoint de salud (/health)..."
echo "================================================================="

curl -sS "$SERVICE_URL/health" || true
echo ""
