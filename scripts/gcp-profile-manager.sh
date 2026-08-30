#!/usr/bin/env bash

# =============================================================================
# DATAGOL — GESTOR DE PERFILES Y MULTICUENTAS DE GOOGLE CLOUD (GCP)
# =============================================================================
# Permite administrar múltiples cuentas y proyectos de clientes en WSL2
# utilizando 'gcloud config configurations'.
#
# Uso interactivo:
#   ./scripts/gcp-profile-manager.sh
#
# Uso directo:
#   ./scripts/gcp-profile-manager.sh list
#   ./scripts/gcp-profile-manager.sh create <nombre_perfil> <project_id> [region]
#   ./scripts/gcp-profile-manager.sh switch <nombre_perfil>
# =============================================================================

set -euo pipefail

function print_header() {
    echo "================================================================="
    echo "☁️  DATAGOL — Gestor de Multicuentas Google Cloud (GCP)"
    echo "================================================================="
}

function list_profiles() {
    print_header
    echo "📋 Perfiles configurados en esta laptop (WSL2):"
    echo ""
    gcloud config configurations list
    echo ""
}

function switch_profile() {
    local profile_name="$1"
    print_header
    echo "🔄 Cambiando al perfil: '$profile_name'..."
    gcloud config configurations activate "$profile_name"
    echo ""
    echo "✅ Perfil activo:"
    gcloud config list
}

function create_profile() {
    local profile_name="$1"
    local project_id="$2"
    local region="${3:-us-central1}"

    print_header
    echo "➕ Creando nuevo perfil para cliente: '$profile_name'..."
    gcloud config configurations create "$profile_name" || true

    echo "🔐 Autenticando cuenta de Google para este cliente..."
    echo "   (Se abrirá el navegador para iniciar sesión)"
    gcloud auth login

    echo "⚙️  Configurando proyecto y región..."
    gcloud config set project "$project_id"
    gcloud config set compute/region "$region"
    gcloud config set run/region "$region"

    echo ""
    echo "================================================================="
    echo "🎉 ¡Perfil '$profile_name' creado y activado con éxito!"
    echo "📍 Proyecto: $project_id"
    echo "📍 Región:   $region"
    echo "================================================================="
}

# Modo argumentos
if [ $# -gt 0 ]; then
    case "$1" in
        list)
            list_profiles
            exit 0
            ;;
        switch)
            if [ -z "${2:-}" ]; then
                echo "❌ Error: Especifica el nombre del perfil. Ej: ./scripts/gcp-profile-manager.sh switch dental-valle" >&2
                exit 1
            fi
            switch_profile "$2"
            exit 0
            ;;
        create)
            if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
                echo "❌ Error: Faltan argumentos. Ej: ./scripts/gcp-profile-manager.sh create dental-valle dental-valle-prod [us-central1]" >&2
                exit 1
            fi
            create_profile "$2" "$3" "${4:-us-central1}"
            exit 0
            ;;
        *)
            echo "❌ Comando desconocido: $1"
            echo "Comandos válidos: list, switch <perfil>, create <perfil> <project_id> [region]"
            exit 1
            ;;
    esac
fi

# Modo Interactivo
print_header
echo "Selecciona una opción:"
echo "1) Listar perfiles existentes"
echo "2) Cambiar de perfil / cliente activo"
echo "3) Crear nuevo perfil para un cliente nuevo"
echo "4) Salir"
echo ""
read -p "Opción [1-4]: " option

case "$option" in
    1)
        list_profiles
        ;;
    2)
        echo ""
        gcloud config configurations list
        echo ""
        read -p "Ingresa el nombre del perfil al que deseas cambiar: " prof
        switch_profile "$prof"
        ;;
    3)
        read -p "Nombre del perfil (ej. dental-valle): " prof
        read -p "ID del Proyecto GCP del cliente (ej. dental-valle-prod): " proj
        read -p "Región [us-central1]: " reg
        reg="${reg:-us-central1}"
        create_profile "$prof" "$proj" "$reg"
        ;;
    4)
        echo "Saliendo..."
        exit 0
        ;;
    *)
        echo "Opción inválida."
        exit 1
        ;;
esac
