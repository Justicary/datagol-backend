#!/usr/bin/env bash

# =============================================================================
# DATAGOL API — Script de Despliegue Automatizado a GCP Cloud Run
# =============================================================================
# Proyecto GCP: datagol-dev
# Servicio:     datagol-api
# Región:       us-central1
# Dominio:      api.datagol.net
# =============================================================================

set -euo pipefail

# Configuración por defecto (modificable vía variables de entorno)
REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
REPO_NAME="${GCP_REPO_NAME:-datagol-repo}"
SERVICE_NAME="${GCP_SERVICE_NAME:-datagol-api}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$SERVICE_NAME:$IMAGE_TAG"
ENV_FILE="${ENV_FILE:-.env}"

echo "================================================================="
echo "🚀 Iniciando despliegue de Datagol API en GCP Cloud Run"
echo "📍 Proyecto GCP:  $PROJECT_ID"
echo "📍 Región:        $REGION"
echo "📦 Servicio:      $SERVICE_NAME"
echo "🖼️  Imagen:       $IMAGE_URI"
echo "================================================================="

# 1. Verificaciones previas
if ! command -v gcloud &>/dev/null; then
    echo "❌ Error: gcloud CLI no está instalado o no está en el PATH." >&2
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Error: Archivo de entorno '$ENV_FILE' no encontrado." >&2
    exit 1
fi

# 2. Generar archivo YAML temporal de variables de entorno para Cloud Run
TMP_ENV_YAML=$(mktemp /tmp/cloudrun-env.XXXXXX.yaml)
trap 'rm -f "$TMP_ENV_YAML"' EXIT

echo "🔒 Preparando variables de entorno desde '$ENV_FILE'..."
node -e "
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('$ENV_FILE'));
const lines = [];

for (const [key, value] of Object.entries(envConfig)) {
    if (key === 'PORT' || key.startsWith('#')) continue;
    const escapedValue = JSON.stringify(String(value));
    lines.push(\`\${key}: \${escapedValue}\`);
}

fs.writeFileSync('$TMP_ENV_YAML', lines.join('\n'), 'utf8');
"

# 3. Compilación e Ingesta de la Imagen en GCP Artifact Registry
echo "🔨 Compilando imagen Docker en GCP Cloud Build..."
gcloud builds submit . \
    --tag="$IMAGE_URI" \
    --project="$PROJECT_ID" \
    --quiet

echo "✅ Imagen construida e ingresada exitosamente."

# 4. Despliegue a Cloud Run (min-instances=1 innegociable para cero cold starts en llamadas de voz)
echo "🚀 Desplegando servicio en GCP Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
    --image="$IMAGE_URI" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --min-instances=1 \
    --max-instances=10 \
    --memory=512Mi \
    --cpu=1 \
    --env-vars-file="$TMP_ENV_YAML" \
    --quiet

# 5. Obtener URL desplegada y probar endpoint de salud
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")

echo "================================================================="
echo "🎉 ¡Despliegue completado con éxito!"
echo "🔗 URL de Cloud Run: $SERVICE_URL"
echo "🔍 Probando endpoint de salud (/health)..."
echo "================================================================="

curl -sS "$SERVICE_URL/health" || true
echo ""
echo "🎉 Web Deployment Complete!"

# Auto-prune old images to save costs (si el script existe y es ejecutable)
if [ -x "./scripts/prune-images.sh" ]; then
    ./scripts/prune-images.sh
fi