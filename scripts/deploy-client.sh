#!/usr/bin/env bash

# =============================================================================
# DATAGOL — SCRIPT DE DESPLIEGUE A CLOUD RUN PARA CLIENTE
# =============================================================================
# Desplaza el backend en el proyecto de GCP del cliente, utilizando su propio
# crédito promocional ($500 USD) y sus variables de entorno aisladas.
#
# Uso:
#   ./scripts/deploy-client.sh <slug_cliente> [archivo_env_yaml]
#
# Ejemplo:
#   ./scripts/deploy-client.sh dental-valle env-vars-dental-valle.yaml
# =============================================================================

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "❌ Uso: ./scripts/deploy-client.sh <slug_cliente> [archivo_env_yaml]" >&2
    echo "Ejemplo: ./scripts/deploy-client.sh dental-valle env-vars-dental-valle.yaml" >&2
    exit 1
fi

CLIENT_SLUG="$1"
ENV_YAML_FILE="${2:-env-vars-${CLIENT_SLUG}.yaml}"
SERVICE_NAME="${CLIENT_SLUG}-api"

# Obtener configuración actual de GCP
ACTIVE_PROFILE=$(gcloud config configurations list --filter="is_active:true" --format="value(name)" || echo "desconocido")
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "")
REGION=$(gcloud config get-value compute/region 2>/dev/null || echo "us-central1")
REGION="${REGION:-us-central1}"

if [ -z "$PROJECT_ID" ]; then
    echo "❌ Error: No hay ningún proyecto GCP configurado en el perfil activo." >&2
    echo "Usa: ./scripts/gcp-profile-manager.sh para seleccionar el perfil del cliente." >&2
    exit 1
fi

if [ ! -f "$ENV_YAML_FILE" ]; then
    echo "❌ Error: No se encontró el archivo de variables '$ENV_YAML_FILE'." >&2
    echo "Asegúrate de haber ejecutado previamente el script de aprovisionamiento:" >&2
    echo "  npx tsx scripts/provision-client.ts ..." >&2
    exit 1
fi

IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/datagol-repo/$SERVICE_NAME:latest"

echo "================================================================="
echo "🚀 INICIANDO DESPLIEGUE PARA CLIENTE: $CLIENT_SLUG"
echo "👤 Perfil GCP Activo: $ACTIVE_PROFILE"
echo "📍 Proyecto GCP:      $PROJECT_ID"
echo "📍 Región:            $REGION"
echo "📦 Servicio:          $SERVICE_NAME"
echo "📄 Variables:         $ENV_YAML_FILE"
echo "================================================================="

# 1. Habilitar APIs necesarias en el proyecto del cliente (si es primer despliegue)
echo "⚙️  Verificando APIs de Google Cloud..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet || true

# 2. Crear repositorio de Artifact Registry si no existe
echo "📦 Verificando repositorio en Artifact Registry..."
gcloud artifacts repositories create datagol-repo \
    --repository-format=docker \
    --location="$REGION" \
    --description="Repositorio de imágenes Datagol" \
    --quiet 2>/dev/null || true

# 3. Compilación de la imagen en Cloud Build del cliente
echo "🔨 Compilando imagen en Google Cloud Build..."
gcloud builds submit . \
    --tag="$IMAGE_URI" \
    --project="$PROJECT_ID" \
    --quiet

echo "✅ Imagen construida e ingresada exitosamente."

# 4. Despliegue en Cloud Run
echo "🚀 Desplegando en Cloud Run (min-instances=1 para 0 cold starts)..."
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
    --no-cpu-throttling \
    --env-vars-file="$ENV_YAML_FILE" \
    --quiet

# 5. Obtener URL y validar
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")

echo "================================================================="
echo "🎉 ¡Despliegue del cliente completado exitosamente!"
echo "🔗 URL del Backend: $SERVICE_URL"
echo "🔍 Probando endpoint de salud..."
echo "================================================================="

curl -sS "$SERVICE_URL/health" || true
echo ""
echo "✅ ¡Listo para conectar el frontend del cliente!"
