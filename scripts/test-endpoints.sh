#!/usr/bin/env bash

# =============================================================================
# DATAGOL 2026 — Script de Validación Integral de Endpoints de ElevenLabs
# =============================================================================
# Valida el correcto funcionamiento de las 3 familias de endpoints:
#   1. Tool Calls en Vivo (/tools/:webhookToken/*) con header 'x-tool-secret'.
#   2. Post-Call Webhook (/webhooks/elevenlabs/:webhookToken) con firma HMAC.
#   3. Signed URLs (/api/elevenlabs/signed-url) para sesiones WebRTC.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

if ! command -v pnpm &>/dev/null; then
    echo "❌ Error: pnpm no está instalado o no está en el PATH." >&2
    exit 1
fi

pnpm tsx scripts/test-endpoints-runner.ts "$@"
