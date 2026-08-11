#!/usr/bin/env bash
# =============================================================================
# DATAGOL — Script de Limpieza Automática de Imágenes y Revisiones
# =============================================================================
# Elimina imágenes sin etiqueta (untagged) en Artifact Registry y revisiones
# antiguas inactivas en Cloud Run para optimizar costos de almacenamiento.
# =============================================================================

set -uo pipefail

REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
REPO_NAME="${GCP_REPO_NAME:-datagol-repo}"
KEEP_REVISIONS=3

echo "🧹 Iniciando limpieza de imágenes y revisiones antiguas..."
echo "📍 Región: $REGION"
echo "📦 Repositorio: $REPO_NAME"

cleanup_artifacts() {
    local IMAGE_NAME=$1
    echo "---------------------------------------------------"
    echo "🔍 Consultando Artifact Registry para: $IMAGE_NAME"
    
    # 1. Obtener todas las versiones (digests)
    local ALL_DIGESTS
    ALL_DIGESTS=$(gcloud artifacts versions list \
        --package="$IMAGE_NAME" \
        --repository="$REPO_NAME" \
        --location="$REGION" \
        --format="value(name)" 2>/dev/null || echo "")

    # 2. Obtener versiones etiquetadas
    local TAGGED_DIGESTS
    TAGGED_DIGESTS=$(gcloud artifacts tags list \
        --package="$IMAGE_NAME" \
        --repository="$REPO_NAME" \
        --location="$REGION" \
        --format="value(version)" 2>/dev/null | sort -u || echo "")

    if [ -z "$ALL_DIGESTS" ]; then
        echo "ℹ️  No se encontraron versiones en Artifact Registry para $IMAGE_NAME."
        return
    fi

    echo "🗑️  Analizando versiones en registro..."
    local DELETED_COUNT=0
    for digest in $ALL_DIGESTS; do
        if echo "$TAGGED_DIGESTS" | grep -q "$digest"; then
            echo "   - Conservando imagen etiquetada: $digest"
        else
            echo "   - Eliminando versión huérfana (untagged): $digest..."
            gcloud artifacts versions delete "$digest" \
                --package="$IMAGE_NAME" \
                --repository="$REPO_NAME" \
                --location="$REGION" \
                --quiet --delete-tags 2>/dev/null || echo "   ⚠️  No se pudo eliminar $digest"
            DELETED_COUNT=$((DELETED_COUNT + 1))
        fi
    done

    if [ "$DELETED_COUNT" -eq 0 ]; then
        echo "✅ No se encontraron versiones huérfanas para $IMAGE_NAME."
    else
        echo "✅ Limpieza de registros completada para $IMAGE_NAME ($DELETED_COUNT eliminadas)."
    fi
}

cleanup_revisions() {
    local APP_NAME=$1
    local SERVICE_NAME
    if [[ "$APP_NAME" == datagol-* ]]; then
        SERVICE_NAME="$APP_NAME"
    else
        SERVICE_NAME="datagol-$APP_NAME"
    fi
    
    echo "---------------------------------------------------"
    echo "🔍 Consultando Revisiones de Cloud Run para: $SERVICE_NAME"

    local REVISIONS
    REVISIONS=$(gcloud run revisions list \
        --service="$SERVICE_NAME" \
        --region="$REGION" \
        --project="$PROJECT_ID" \
        --format="value(name)" \
        --sort-by="~metadata.creationTimestamp" 2>/dev/null || echo "")

    if [ -z "$REVISIONS" ]; then
        echo "ℹ️  No se encontraron revisiones para el servicio $SERVICE_NAME."
        return
    fi

    local COUNT=0
    for rev in $REVISIONS; do
        COUNT=$((COUNT + 1))
        
        if [ "$COUNT" -le "$KEEP_REVISIONS" ]; then
            echo "   - Conservando revisión reciente: $rev"
            continue
        fi

        echo "   - Eliminando revisión antigua: $rev..."
        gcloud run revisions delete "$rev" --region="$REGION" --project="$PROJECT_ID" --quiet || echo "   ⚠️  No se pudo eliminar $rev (puede estar recibiendo tráfico o activa)"
    done
    
    echo "✅ Limpieza de revisiones completada para $SERVICE_NAME."
}

# Ejecutar limpieza para api, admin y web
for app in "api" "admin" "web"; do
    cleanup_artifacts "$app"
    cleanup_revisions "$app"
done

echo "---------------------------------------------------"
echo "🎉 ¡Limpieza general completada!"
echo "💰 Artifact Registry y Cloud Run optimizados."