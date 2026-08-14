#!/usr/bin/env bash

# =============================================================================
# DATAGOL API — Pausar Instancia de Cloud Run a Costo $0 en DEV
# =============================================================================
# Para llevar los costos a $0:
# 1. --min-instances=0 : Permite a Cloud Run escalar a 0 instancias en reposo.
# 2. --cpu-throttling  : Desactiva "CPU Always Allocated", asegurando que no haya
#                        reserva de vCPU/RAM facturable.
# 3. --ingress=internal: Bloquea todo tráfico público externo. Al no recibir peticiones,
#                        el conteo de instancias permanece en 0 absoluto.
#
# La imagen, revisión y variables de entorno quedan intactas para reanudar con:
# ./scripts/resume-service.sh
# =============================================================================

set -euo pipefail

REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
SERVICE_NAME="${GCP_SERVICE_NAME:-datagol-api}"

echo "================================================================="
echo "⏸️  Pausando Datagol API en Cloud Run (Costo \$0 en DEV)"
echo "📍 Proyecto GCP:  $PROJECT_ID"
echo "📍 Región:        $REGION"
echo "📦 Servicio:      $SERVICE_NAME"
echo "================================================================="

if ! command -v gcloud &>/dev/null; then
    echo "❌ Error: gcloud CLI no está instalado o no está en el PATH." >&2
    exit 1
fi

echo "⚙️  Aplicando configuración de costo \$0..."
gcloud run services update "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --min-instances=0 \
    --cpu-throttling \
    --ingress=internal \
    --quiet

echo "================================================================="
echo "✅ Servicio pausado a Costo \$0:"
echo "   • min-instances: 0"
echo "   • cpu-throttling: activado (sin costo de CPU/RAM en reposo)"
echo "   • ingress: internal (tráfico público bloqueado, 0 instancias generadas)"
echo ""
echo "🔁 Para reanudar: ./scripts/resume-service.sh"
echo "================================================================="
