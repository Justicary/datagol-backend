#!/usr/bin/env bash

# =============================================================================
# DATAGOL 2026 — Script de Prueba de Llamada Saliente (Outbound Call)
# =============================================================================
# Este script verifica el estado del backend Fastify y dispara una llamada de
# prueba a través de la API de Voz (ElevenLabs ConvAI + Telnyx SIP).
# =============================================================================

# Definición de Colores para la Terminal
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # Sin Color

# Configuración por Defecto
API_URL="${API_URL:-http://localhost:3000}"
ORG_ID="${ORG_ID:-56422ca1-ec44-45b4-9eac-7e068d9169be}"
PHONE_NUMBER="${PHONE_NUMBER:-+522213528341}"
CUSTOMER_NAME="${CUSTOMER_NAME:-Eduardo Mancera}"
COMPANY_NAME="${COMPANY_NAME:-Datagol AI Agency}"
DEMO_OBJECTIVE="${DEMO_OBJECTIVE:-Probar llamada saliente en vivo con ElevenLabs y Telnyx}"

echo -e "${CYAN}=====================================================================${NC}"
echo -e "${CYAN} 🚀 DATAGOL 2026 — TEST DE LLAMADA OUTBOUND EN LÍNEA DE COMANDOS${NC}"
echo -e "${CYAN}=====================================================================${NC}\n"

# 1. Verificación de Salud del Servidor Backend Fastify
echo -e "${YELLOW}🔍 1. Verificando estado del servidor en ${API_URL}/health...${NC}"
HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/health")

if [ "$HEALTH_CHECK" -eq 200 ]; then
  echo -e "${GREEN}✅ Servidor Fastify activo y respondiendo correctamente (HTTP 200).${NC}\n"
else
  echo -e "${RED}❌ Error: El servidor en ${API_URL} no responde o devolvió código ${HEALTH_CHECK}.${NC}"
  echo -e "${YELLOW}👉 Asegúrate de ejecutar 'pnpm tsx watch src/server.ts' en datagol-backend.${NC}\n"
  exit 1
fi

# 2. Resumen de Parámetros de la Llamada
echo -e "${YELLOW}📋 2. Parámetros de la prueba:${NC}"
echo -e "   • Organización ID : ${CYAN}${ORG_ID}${NC}"
echo -e "   • Teléfono Destino: ${CYAN}${PHONE_NUMBER}${NC}"
echo -e "   • Nombre Cliente  : ${CYAN}${CUSTOMER_NAME}${NC}"
echo -e "   • Empresa         : ${CYAN}${COMPANY_NAME}${NC}"
echo -e "   • Objetivo Demo   : ${CYAN}${DEMO_OBJECTIVE}${NC}\n"

# 3. Disparo de la Petición al Backend Fastify (/api/voice/outbound)
echo -e "${YELLOW}📡 3. Enviando orden de llamada saliente a POST ${API_URL}/api/voice/outbound...${NC}"

RESPONSE=$(curl -s -X POST "${API_URL}/api/voice/outbound" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "'"${ORG_ID}"'",
    "customerPhone": "'"${PHONE_NUMBER}"'",
    "customerName": "'"${CUSTOMER_NAME}"'",
    "companyName": "'"${COMPANY_NAME}"'",
    "demoObjective": "'"${DEMO_OBJECTIVE}"'"
  }')

echo -e "\n${YELLOW}📥 Respuesta del servidor:${NC}"
if command -v jq &> /dev/null; then
  echo "$RESPONSE" | jq '.'
else
  echo "$RESPONSE"
fi

# 4. Diagnóstico del Resultado
if [[ "$RESPONSE" == *"success"* ]]; then
  echo -e "\n${GREEN}=====================================================================${NC}"
  echo -e "${GREEN} 🎉 ¡LLAMADA ENVIADA CON ÉXITO A LA COLA DE ELEVENLABS!${NC}"
  echo -e "${GREEN} Tu teléfono (${PHONE_NUMBER}) debería sonar en menos de 10 segundos.${NC}"
  echo -e "${GREEN}=====================================================================${NC}\n"
else
  echo -e "\n${RED}=====================================================================${NC}"
  echo -e "${RED} ⚠️ Ocurrió un problema al procesar la llamada saliente.${NC}"
  echo -e "${RED} Revisa los logs en la terminal de Fastify para más detalles.${NC}"
  echo -e "${RED}=====================================================================${NC}\n"
fi
