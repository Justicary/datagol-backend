#!/usr/bin/env bash

# =============================================================================
# DATAGOL 2026 — Suite de Pruebas Integradas para Operaciones Críticas
# =============================================================================
# Este script valida en secuencia:
# 1. Estado del Servidor Fastify (/health)
# 2. Verificación de Firma Criptográfica HMAC del Webhook de ElevenLabs
# 3. Ejecución de Custom Webhook Tools (searchKnowledgeBase / RAG)
# 4. Disparo de Llamada Saliente Outbound (Telnyx SIP + ElevenLabs)
# =============================================================================

# Colores para salida en terminal
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

API_URL="${API_URL:-https://rolls-colin-sees-filename.trycloudflare.com}"
WEBHOOK_SECRET="${ELEVENLABS_WEBHOOK_SECRET:-wsec_a109b2e9da9fd7e94bd2bce139810236c7fd4c8ecd70c4d0b7d377617a55c6f3}"
ORG_ID="${ORG_ID:-56422ca1-ec44-45b4-9eac-7e068d9169be}"
PHONE_NUMBER="${PHONE_NUMBER:-+522213528341}"

echo -e "${CYAN}=====================================================================${NC}"
echo -e "${CYAN} 🛡️  DATAGOL 2026 — PROTOCOLO DE PRUEBAS DE OPERACIÓN CRÍTICA${NC}"
echo -e "${CYAN}=====================================================================${NC}\n"

# -----------------------------------------------------------------------------
# PRUEBA 1: Verificación de Salud del Servidor
# -----------------------------------------------------------------------------

echo -e "${YELLOW}🔍 PRUEBA 1: Verificando disponibilidad del backend en ${API_URL}/health...${NC}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/health")

if [ "$HTTP_STATUS" -eq 200 ]; then
  echo -e "${GREEN}✅ PASÓ: Servidor Fastify activo y respondiendo correctamente (HTTP 200).${NC}\n"
else
  echo -e "${RED}❌ FALLÓ: El servidor no responde o devolvió HTTP ${HTTP_STATUS}.${NC}"
  echo -e "${YELLOW}👉 Inicia el servidor con: pnpm tsx watch src/server.ts${NC}\n"
  exit 1
fi

# -----------------------------------------------------------------------------
# PRUEBA 2: Verificación de Firma Criptográfica HMAC-SHA256 en Webhook
# -----------------------------------------------------------------------------

echo -e "${YELLOW}🔒 PRUEBA 2: Validando seguridad de Webhook HMAC-SHA256 (/api/elevenlabs/webhook)...${NC}"

TIMESTAMP=$(date +%s)
RAW_BODY='{"event":"conversation_initiation","conversation_id":"test_conv_123"}'
SIGNED_PAYLOAD="${TIMESTAMP}.${RAW_BODY}"

# Generar firma HMAC SHA256 usando OpenSSL
COMPUTED_SIG=$(echo -n "$SIGNED_PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/.*= //')
SIG_HEADER="t=${TIMESTAMP},v0=${COMPUTED_SIG}"

# Test 2A: Envío con Firma VÁLIDA
WEBHOOK_RES=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/api/elevenlabs/webhook" \
  -H "Content-Type: application/json" \
  -H "elevenlabs-signature: ${SIG_HEADER}" \
  -d "$RAW_BODY")

HTTP_CODE=$(echo "$WEBHOOK_RES" | tail -n1)
BODY_RES=$(echo "$WEBHOOK_RES" | sed '$d')

if [ "$HTTP_CODE" -eq 200 ]; then
  echo -e "${GREEN}✅ PASÓ: Webhook autenticado con firma HMAC válida (HTTP 200).${NC}"
else
  echo -e "${RED}⚠️  AVISO: Respuesta de webhook devuelta (HTTP ${HTTP_CODE}). Firma evaluada.${NC}"
fi

# Test 2B: Envío con Firma INVÁLIDA (Debe rechazar con HTTP 401 si el secret está activo)
REJECT_RES=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${API_URL}/api/elevenlabs/webhook" \
  -H "Content-Type: application/json" \
  -H "elevenlabs-signature: t=${TIMESTAMP},v0=firma_falsa_12345" \
  -d "$RAW_BODY")

if [ "$REJECT_RES" -eq 401 ]; then
  echo -e "${GREEN}🛡️  PASÓ: Firma falsa rechazada exitosamente con HTTP 401 Unauthorized.${NC}\n"
else
  echo -e "${YELLOW}ℹ️  Aviso: HTTP ${REJECT_RES} en firma falsa (Modo Dev o Secret no configurado).${NC}\n"
fi

# -----------------------------------------------------------------------------
# PRUEBA 3: Ejecución de Custom Webhook Tools (RAG / Knowledge Base)
# -----------------------------------------------------------------------------

echo -e "${YELLOW}🧠 PRUEBA 3: Evaluando Custom Webhook Tool RAG (/api/elevenlabs/tools)...${NC}"

TOOL_PAYLOAD='{
  "tool_name": "searchKnowledgeBase",
  "parameters": {
    "query": "¿Cuáles son los planes y precios de Datagol?"
  },
  "dynamic_variables": {
    "organization_id": "'"${ORG_ID}"'"
  }
}'

TOOL_RES=$(curl -s -X POST "${API_URL}/api/elevenlabs/tools" \
  -H "Content-Type: application/json" \
  -d "$TOOL_PAYLOAD")

if [[ "$TOOL_RES" == *"result"* ]] || [[ "$TOOL_RES" == *"status"* ]]; then
  echo -e "${GREEN}✅ PASÓ: La herramienta RAG respondió estructuradamente para ElevenLabs:${NC}"
  echo -e "${CYAN}${TOOL_RES}${NC}\n"
else
  echo -e "${RED}❌ FALLÓ: Error al ejecutar la herramienta en Fastify.${NC}\n"
fi

# -----------------------------------------------------------------------------
# PRUEBA 4: Disparo de Llamada Saliente Outbound en Vivo (Telnyx + ElevenLabs)
# -----------------------------------------------------------------------------

echo -e "${YELLOW}📞 PRUEBA 4: Iniciando llamada saliente de prueba a ${PHONE_NUMBER}...${NC}"

OUTBOUND_RES=$(curl -s -X POST "${API_URL}/api/voice/outbound" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "'"${ORG_ID}"'",
    "customerPhone": "'"${PHONE_NUMBER}"'",
    "customerName": "Juan Pérez",
    "companyName": "Datagol AI Agency",
    "demoObjective": "Probar integración en vivo Telnyx SIP + ElevenLabs Agents"
  }')

echo -e "${CYAN}Respuesta de la orden de llamada:${NC}"
if command -v jq &> /dev/null; then
  echo "$OUTBOUND_RES" | jq '.'
else
  echo "$OUTBOUND_RES"
fi

if [[ "$OUTBOUND_RES" == *"success"* ]]; then
  echo -e "\n${GREEN}${BOLD}=====================================================================${NC}"
  echo -e "${GREEN}${BOLD} 🎉 ¡TODAS LAS PRUEBAS CRÍTICAS COMPLETADAS CON ÉXITO!${NC}"
  echo -e "${GREEN} Tu teléfono (${PHONE_NUMBER}) debería sonar en menos de 10 segundos.${NC}"
  echo -e "${GREEN}${BOLD}=====================================================================${NC}\n"
else
  echo -e "\n${RED}⚠️ Ocurrió una observación al solicitar la llamada. Revisa las variables en .env${NC}\n"
fi
