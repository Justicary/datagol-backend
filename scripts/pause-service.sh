#!/usr/bin/env bash

# =============================================================================
# DATAGOL API — Pausar Instancia de Cloud Run (ahorro de costos)
# =============================================================================
# Cloud Run no tiene un botón de "pausa" nativo. Lo que sí permite es que un
# servicio quede en 0 instancias posibles (--max-instances=0): ningún request
# puede ejecutarse (responden 503), así que no hay tiempo de cómputo que
# facturar. Es la forma correcta de "apagar" el servicio sin borrarlo — la
# imagen, la revisión y la configuración quedan intactas para reanudar con
# scripts/resume-service.sh.
#
# ⚠️  Mientras está pausado: el webhook de post-llamada de ElevenLabs, los
# tool calls en vivo y el widget de demo del frontend van a fallar (503). No
# lo uses si hay una llamada real en curso o esperada.
# =============================================================================

set -euo pipefail

REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
SERVICE_NAME="${GCP_SERVICE_NAME:-datagol-api}"

echo "================================================================="
echo "⏸️  Pausando Datagol API en Cloud Run"
echo "📍 Proyecto GCP:  $PROJECT_ID"
echo "📍 Región:        $REGION"
echo "📦 Servicio:      $SERVICE_NAME"
echo "================================================================="

if ! command -v gcloud &>/dev/null; then
    echo "❌ Error: gcloud CLI no está instalado o no está en el PATH." >&2
    exit 1
fi

gcloud run services update "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --min-instances=0 \
    --ingress=internal \
    --quiet

echo "================================================================="
echo "✅ Servicio pausado — 0 instancias permitidas, sin costo de cómputo."
echo "   El webhook de ElevenLabs, los tool calls y el widget de demo"
echo "   responderán 503 mientras esté así."
echo "🔁 Para reanudar: ./scripts/resume-service.sh"
echo "================================================================="
