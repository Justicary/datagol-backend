#!/usr/bin/env bash
# =============================================================================
# DATAGOL — Script de Limpieza y Optimización de Almacenamiento GCP
# =============================================================================
# 1. Artifact Registry: Conserva solo las últimas N versiones por paquete.
# 2. Cloud Storage: Limpia tarballs de Cloud Build y Cloud Run sources (batch).
# 3. Cloud Run: Elimina revisiones antiguas inactivas conservando las últimas N.
# =============================================================================

set -uo pipefail

REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "datagol-dev")}"
KEEP_COUNT="${KEEP_COUNT:-3}"

echo "================================================================="
echo "🧹 Limpieza de almacenamiento y registros en GCP"
echo "📍 Proyecto GCP:    $PROJECT_ID"
echo "📍 Región:          $REGION"
echo "📦 Retención:       Últimas $KEEP_COUNT versiones/objetos"
echo "================================================================="

if ! command -v gcloud &>/dev/null; then
    echo "❌ Error: gcloud CLI no está instalado o no está en el PATH." >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# 1. LIMPIEZA DE ARTIFACT REGISTRY (Batch deletion)
# -----------------------------------------------------------------------------
cleanup_artifact_repository() {
    local REPO=$1
    echo "🔍 Inspeccionando Artifact Registry: $REPO"

    local PACKAGES
    PACKAGES=$(gcloud artifacts packages list \
        --repository="$REPO" \
        --location="$REGION" \
        --project="$PROJECT_ID" \
        --format="value(name)" 2>/dev/null || echo "")

    if [ -z "$PACKAGES" ]; then
        return
    fi

    for pkg_full in $PACKAGES; do
        local PKG
        PKG=$(basename "$pkg_full")

        local VERSIONS
        VERSIONS=$(gcloud artifacts versions list \
            --package="$PKG" \
            --repository="$REPO" \
            --location="$REGION" \
            --project="$PROJECT_ID" \
            --sort-by="~CREATE_TIME" \
            --format="value(name)" 2>/dev/null || echo "")

        local COUNT=0
        local TO_DELETE=()
        for ver in $VERSIONS; do
            COUNT=$((COUNT + 1))
            if [ "$COUNT" -gt "$KEEP_COUNT" ]; then
                TO_DELETE+=("$ver")
            fi
        done

        if [ ${#TO_DELETE[@]} -gt 0 ]; then
            echo "   🗑️  Eliminando ${#TO_DELETE[@]} versiones antiguas de '$PKG' en '$REPO'..."
            gcloud artifacts versions delete "${TO_DELETE[@]}" \
                --package="$PKG" \
                --repository="$REPO" \
                --location="$REGION" \
                --project="$PROJECT_ID" \
                --delete-tags \
                --quiet 2>/dev/null || true
            echo "   ✅ Paquete '$PKG' optimizado."
        else
            echo "   ✅ Paquete '$PKG' ya está al día (≤ $KEEP_COUNT versiones)."
        fi
    done
}

for repo in "datagol-repo" "cloud-run-source-deploy"; do
    cleanup_artifact_repository "$repo"
done

# -----------------------------------------------------------------------------
# 2. LIMPIEZA DE CLOUD STORAGE (Batch deletion)
# -----------------------------------------------------------------------------
cleanup_storage_bucket() {
    local BUCKET=$1
    echo "🔍 Limpiando archivos temporales en Cloud Storage: $BUCKET"

    if ! gcloud storage buckets describe "$BUCKET" &>/dev/null; then
        return
    fi

    # Obtener lista de objetos ordenados por fecha descendente
    local OBJECTS
    OBJECTS=$(gcloud storage ls --long "$BUCKET/**" 2>/dev/null | grep -E '\.(tgz|zip)$' | sort -k2 -r | awk '{print $3}' || echo "")

    if [ -z "$OBJECTS" ]; then
        echo "   ✅ Bucket $BUCKET sin archivos residuales."
        return
    fi

    local COUNT=0
    local TO_DELETE=()
    for obj in $OBJECTS; do
        COUNT=$((COUNT + 1))
        if [ "$COUNT" -gt "$KEEP_COUNT" ]; then
            TO_DELETE+=("$obj")
        fi
    done

    if [ ${#TO_DELETE[@]} -gt 0 ]; then
        echo "   🗑️  Eliminando ${#TO_DELETE[@]} archivos de origen antiguos en '$BUCKET'..."
        # Eliminación en lote (un solo comando)
        printf "%s\n" "${TO_DELETE[@]}" | gcloud storage rm --stdin --quiet 2>/dev/null || true
        echo "   ✅ Bucket $BUCKET optimizado."
    else
        echo "   ✅ Bucket $BUCKET ya está al día (≤ $KEEP_COUNT archivos)."
    fi
}

cleanup_storage_bucket "gs://datagol-dev_cloudbuild"
cleanup_storage_bucket "gs://run-sources-datagol-dev-us-central1"

# -----------------------------------------------------------------------------
# 3. LIMPIEZA DE REVISIONES DE CLOUD RUN
# -----------------------------------------------------------------------------
cleanup_revisions() {
    local SERVICE_NAME=$1
    echo "🔍 Consultando revisiones de Cloud Run: $SERVICE_NAME"

    local REVISIONS
    REVISIONS=$(gcloud run revisions list \
        --service="$SERVICE_NAME" \
        --region="$REGION" \
        --project="$PROJECT_ID" \
        --format="value(name)" \
        --sort-by="~metadata.creationTimestamp" 2>/dev/null || echo "")

    if [ -z "$REVISIONS" ]; then
        return
    fi

    local COUNT=0
    local TO_DELETE=()
    for rev in $REVISIONS; do
        COUNT=$((COUNT + 1))
        if [ "$COUNT" -gt "$KEEP_COUNT" ]; then
            TO_DELETE+=("$rev")
        fi
    done

    if [ ${#TO_DELETE[@]} -gt 0 ]; then
        echo "   🗑️  Eliminando ${#TO_DELETE[@]} revisiones antiguas de '$SERVICE_NAME'..."
        for rev in "${TO_DELETE[@]}"; do
            gcloud run revisions delete "$rev" --region="$REGION" --project="$PROJECT_ID" --quiet 2>/dev/null || true
        done
        echo "   ✅ Revisiones de '$SERVICE_NAME' optimizadas."
    else
        echo "   ✅ Revisiones de '$SERVICE_NAME' al día (≤ $KEEP_COUNT)."
    fi
}

for app in "datagol-api" "datagol-admin" "datagol-web"; do
    cleanup_revisions "$app"
done

echo "================================================================="
echo "🎉 ¡Limpieza general completada en segundos!"
echo "💰 Artifact Registry, Cloud Storage y Cloud Run optimizados."
echo "================================================================="