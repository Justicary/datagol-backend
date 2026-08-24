import crypto from 'crypto';
import dotenv from 'dotenv';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { getSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

dotenv.config();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

interface TestResult {
    name: string;
    passed: boolean;
    statusCode: number;
    expectedStatus: number;
    durationMs: number;
    details?: string;
    responseBody?: unknown;
}

function computeHmacSignature(rawBody: string, secret: string, timestamp: number): string {
    const signedPayload = `${timestamp}.${rawBody}`;
    const hmacHex = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    return `t=${timestamp},v1=${hmacHex}`;
}

interface HttpResponseData {
    status?: string;
    message?: string;
    error?: string;
    available?: boolean;
    slots?: string[];
    rescheduled?: boolean;
    booked?: boolean;
    signedUrl?: string;
    [key: string]: unknown;
}

async function runHttpRequest(
    url: string,
    options: {
        method: string;
        headers?: Record<string, string>;
        body?: string;
    }
): Promise<{ status: number; durationMs: number; data: HttpResponseData | null }> {
    const start = process.hrtime.bigint();
    try {
        const res = await fetch(url, {
            method: options.method,
            headers: options.headers || {},
            body: options.body,
        });
        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        let data: HttpResponseData | null = null;
        const text = await res.text();
        try {
            data = text ? (JSON.parse(text) as HttpResponseData) : null;
        } catch {
            data = { raw: text };
        }
        return { status: res.status, durationMs, data };
    } catch (err: unknown) {
        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        const message = err instanceof Error ? err.message : String(err);
        return { status: 0, durationMs, data: { error: message } };
    }
}

async function main() {
    const args = process.argv.slice(2);
    let targetUrl = process.env.API_URL || 'https://api.datagol.net';
    let orgId = process.env.ORG_ID || '56422ca1-ec44-45b4-9eac-7e068d9169be';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) targetUrl = args[++i];
        else if (args[i] === '--org' && args[i + 1]) orgId = args[++i];
    }

    targetUrl = targetUrl.replace(/\/+$/, '');

    console.log(`\n${CYAN}${BOLD}=====================================================================${NC}`);
    console.log(`${CYAN}${BOLD} 🧪 VALIDACIÓN INTEGRAL DE ENDPOINTS DE ELEVENLABS — DATAGOL API${NC}`);
    console.log(`${CYAN}${BOLD}=====================================================================${NC}`);
    console.log(`📍 ${BOLD}Servidor Destino:${NC} ${targetUrl}`);
    console.log(`🏢 ${BOLD}Organización ID :${NC} ${orgId}`);

    // 1. Obtener organización y secretos de Supabase/Vault
    console.log(`\n${YELLOW}🔑 1. Recuperando configuración y secretos desde Vault...${NC}`);
    const { data: org, error: orgErr } = await supabaseAdmin
        .from('organizations')
        .select('id, name, webhook_token, cal_event_type_id, status')
        .eq('id', orgId)
        .single();

    if (orgErr || !org) {
        console.error(`${RED}❌ Error: No se encontró la organización en la base de datos (${orgErr?.message}).${NC}`);
        process.exit(1);
    }

    const webhookToken = org.webhook_token;
    if (!webhookToken) {
        console.error(`${RED}❌ Error: La organización no tiene 'webhook_token' configurado.${NC}`);
        process.exit(1);
    }

    const toolSecret = await getSecret(orgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET);
    const signingSecret = await getSecret(orgId, SECRET_KEYS.WEBHOOK_SIGNING_SECRET);

    console.log(`   • Organización : ${BOLD}${org.name}${NC} (${org.status})`);
    console.log(`   • Webhook Token: ${BOLD}${webhookToken.substring(0, 12)}...${webhookToken.substring(webhookToken.length - 8)}${NC}`);
    console.log(`   • Cal Event ID : ${org.cal_event_type_id || 'No asignado'}`);
    console.log(`   • Tool Secret  : ${toolSecret ? `${GREEN}Configurado (${toolSecret.substring(0, 6)}...)${NC}` : `${RED}NO CONFIGURADO${NC}`}`);
    console.log(`   • Sign Secret  : ${signingSecret ? `${GREEN}Configurado (${signingSecret.substring(0, 6)}...)${NC}` : `${RED}NO CONFIGURADO${NC}`}`);

    const results: TestResult[] = [];

    // Helper para registrar y mostrar resultado
    function recordResult(r: TestResult) {
        results.push(r);
        const icon = r.passed ? `${GREEN}✓ PASS${NC}` : `${RED}✗ FAIL${NC}`;
        const latency = `${r.durationMs.toFixed(1)}ms`;
        console.log(`   ${icon} [${r.statusCode}] (${latency}) ${r.name}`);
        if (!r.passed && r.details) {
            console.log(`      ${RED}Detalle:${NC} ${r.details}`);
        }
    }

    // 2. Probar Health Check
    console.log(`\n${YELLOW}📡 2. Verificando conectividad básica (/health)...${NC}`);
    const health = await runHttpRequest(`${targetUrl}/health`, { method: 'GET' });
    recordResult({
        name: 'GET /health',
        passed: health.status === 200 && health.data?.status === 'ok',
        statusCode: health.status,
        expectedStatus: 200,
        durationMs: health.durationMs,
        details: JSON.stringify(health.data),
    });

    // 3. Familia 1: Tool Calls en Vivo
    console.log(`\n${YELLOW}🛠️  3. Probando Familia 1: Tool Calls en Vivo (/tools/:token/*)...${NC}`);

    // 3.1 checkAvailability sin secreto (espera 401)
    const availNoAuth = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime: new Date().toISOString(), endTime: new Date(Date.now() + 86400000).toISOString() }),
    });
    recordResult({
        name: 'POST /tools/availability [Sin secreto -> Rechaza 401]',
        passed: availNoAuth.status === 401,
        statusCode: availNoAuth.status,
        expectedStatus: 401,
        durationMs: availNoAuth.durationMs,
    });

    // 3.2 checkAvailability con secreto inválido (espera 401)
    const availBadAuth = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': 'secreto_totalmente_invalido_xyz' },
        body: JSON.stringify({ startTime: new Date().toISOString(), endTime: new Date(Date.now() + 86400000).toISOString() }),
    });
    recordResult({
        name: 'POST /tools/availability [Secreto inválido -> Rechaza 401]',
        passed: availBadAuth.status === 401,
        statusCode: availBadAuth.status,
        expectedStatus: 401,
        durationMs: availBadAuth.durationMs,
    });

    // 3.3 checkAvailability con secreto válido y formato ISO estándar (espera 200)
    const now = new Date();
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const availValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            startTime: now.toISOString(),
            endTime: tomorrow.toISOString(),
            timeZone: 'America/Mexico_City',
        }),
    });
    recordResult({
        name: 'POST /tools/availability [Formato ISO UTC -> Responde 200]',
        passed: availValid.status === 200 && typeof availValid.data?.available === 'boolean',
        statusCode: availValid.status,
        expectedStatus: 200,
        durationMs: availValid.durationMs,
        details: availValid.data ? `Mensaje: "${availValid.data.message}" | Slots: [${(availValid.data.slots || []).join(', ')}]` : undefined,
    });

    // 3.4 checkAvailability con formato generado por LLM de ElevenLabs (fecha local sin 'Z' ej. 2026-08-17T11:00:00)
    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
    const mondayStr = nextMonday.toISOString().split('T')[0];
    const availLlmFormat = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            startTime: `${mondayStr}T09:00:00`,
            endTime: `${mondayStr}T18:00:00`,
            timeZone: 'America/Mexico_City',
        }),
    });
    recordResult({
        name: 'POST /tools/availability [Formato LLM ElevenLabs (Local ISO) -> Responde 200]',
        passed: availLlmFormat.status === 200 && typeof availLlmFormat.data?.available === 'boolean',
        statusCode: availLlmFormat.status,
        expectedStatus: 200,
        durationMs: availLlmFormat.durationMs,
        details: availLlmFormat.data ? `Mensaje: "${availLlmFormat.data.message}" | Slots: [${(availLlmFormat.data.slots || []).join(', ')}]` : undefined,
    });

    // 3.5 bookAppointment validación de requerimientos (espera 400 si faltan datos requeridos)
    const bookingInvalid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/booking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            customerName: 'Cliente Prueba',
            // Sin teléfono ni correo ni conversationId
        }),
    });
    recordResult({
        name: 'POST /tools/booking [Faltan campos requeridos -> Rechaza 400]',
        passed: bookingInvalid.status === 400,
        statusCode: bookingInvalid.status,
        expectedStatus: 400,
        durationMs: bookingInvalid.durationMs,
    });

    // 3.6 rescheduleAppointment con secreto válido (espera 200 con mensaje verbalizable)
    const rescheduleValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            customerName: 'Prueba Automatizada',
            customerEmail: 'test-endpoint@example.invalid',
            newStartTime: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        }),
    });
    recordResult({
        name: 'POST /tools/reschedule [Secreto válido -> Responde 200]',
        passed: rescheduleValid.status === 200,
        statusCode: rescheduleValid.status,
        expectedStatus: 200,
        durationMs: rescheduleValid.durationMs,
        details: rescheduleValid.data ? `Mensaje: "${rescheduleValid.data.message}"` : undefined,
    });

    // 3.7 getProducts (Catálogo de productos y precios) con secreto válido (espera 200 con results)
    const productsValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            skus: ['SKU-TEST-001', 'SKU-TEST-002'],
        }),
    });
    recordResult({
        name: 'POST /tools/products [Secreto válido -> Responde 200]',
        passed: productsValid.status === 200 && Array.isArray(productsValid.data?.results),
        statusCode: productsValid.status,
        expectedStatus: 200,
        durationMs: productsValid.durationMs,
        details: productsValid.data ? `Resultados: ${JSON.stringify(productsValid.data.results)}` : undefined,
    });

    // 3.8 getAppointmentDetails (Consulta de citas) con secreto válido (espera 200 con found y message)
    const appointmentValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/appointment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            customerEmail: 'test-endpoint@example.invalid',
        }),
    });
    recordResult({
        name: 'POST /tools/appointment [Secreto válido -> Responde 200]',
        passed: appointmentValid.status === 200 && typeof appointmentValid.data?.found === 'boolean',
        statusCode: appointmentValid.status,
        expectedStatus: 200,
        durationMs: appointmentValid.durationMs,
        details: appointmentValid.data ? `Mensaje: "${appointmentValid.data.message}"` : undefined,
    });

    // 3.9 getLocations (Sucursales / Direcciones) con secreto válido (espera 200 con locations y message)
    const locationsValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({}),
    });
    recordResult({
        name: 'POST /tools/locations [Secreto válido -> Responde 200]',
        passed: locationsValid.status === 200 && typeof locationsValid.data?.message === 'string',
        statusCode: locationsValid.status,
        expectedStatus: 200,
        durationMs: locationsValid.durationMs,
        details: locationsValid.data ? `Mensaje: "${locationsValid.data.message}"` : undefined,
    });

    // 3.10 cancelAppointment (Cancelación de cita) con secreto válido (espera 200 con cancelled y message)
    const cancelValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            customerName: 'Contacto Inexistente',
            customerEmail: 'no-existe@example.invalid',
        }),
    });
    recordResult({
        name: 'POST /tools/cancel [Secreto válido -> Responde 200]',
        passed: cancelValid.status === 200 && typeof cancelValid.data?.cancelled === 'boolean',
        statusCode: cancelValid.status,
        expectedStatus: 200,
        durationMs: cancelValid.durationMs,
        details: cancelValid.data ? `Mensaje: "${cancelValid.data.message}"` : undefined,
    });

    // 3.11 searchInbox (Email search) con secreto válido (espera 200 con message verbalizable)
    const emailValid = await runHttpRequest(`${targetUrl}/tools/${webhookToken}/email/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tool-secret': toolSecret || '' },
        body: JSON.stringify({
            subject: 'Consulta',
        }),
    });
    recordResult({
        name: 'POST /tools/email/search [Secreto válido -> Responde 200]',
        passed: emailValid.status === 200 && typeof emailValid.data?.message === 'string',
        statusCode: emailValid.status,
        expectedStatus: 200,
        durationMs: emailValid.durationMs,
        details: emailValid.data ? `Mensaje: "${emailValid.data.message}"` : undefined,
    });

    // 4. Familia 2: Post-Call Webhook
    console.log(`\n${YELLOW}📬 4. Probando Familia 2: Post-Call Webhook (/webhooks/elevenlabs/:token)...${NC}`);

    const mockWebhookBody = JSON.stringify({
        type: 'post_call_transcription',
        event_timestamp: Math.floor(Date.now() / 1000),
        data: {
            agent_id: 'agent_test_validation_agent',
            conversation_id: `conv_test_validation_${Date.now()}`,
            transcript: [
                { role: 'agent', message: 'Hola, bienvenido a Datagol.' },
                { role: 'user', message: 'Hola, quiero informes de automatización.' },
            ],
            analysis: {
                transcript_summary: 'Llamada de validación de endpoints automatizada.',
                data_collection_results: {
                    nombre_completo_prospecto: 'Contacto de Prueba',
                    telefono_contacto_prospecto: '+522221234567',
                    motivo_consulta: 'Prueba de endpoints y webhook',
                },
            },
            metadata: {
                call_duration_secs: 25,
                start_time_unix_secs: Math.floor(Date.now() / 1000) - 30,
            },
        },
    });

    // 4.1 Sin firma HMAC (espera 401)
    const whNoAuth = await runHttpRequest(`${targetUrl}/webhooks/elevenlabs/${webhookToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: mockWebhookBody,
    });
    recordResult({
        name: 'POST /webhooks/elevenlabs [Sin firma HMAC -> Rechaza 401]',
        passed: whNoAuth.status === 401,
        statusCode: whNoAuth.status,
        expectedStatus: 401,
        durationMs: whNoAuth.durationMs,
    });

    // 4.2 Con firma HMAC inválida (espera 401)
    const whBadAuth = await runHttpRequest(`${targetUrl}/webhooks/elevenlabs/${webhookToken}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'elevenlabs-signature': `t=${Math.floor(Date.now() / 1000)},v1=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff`,
        },
        body: mockWebhookBody,
    });
    recordResult({
        name: 'POST /webhooks/elevenlabs [Firma HMAC inválida -> Rechaza 401]',
        passed: whBadAuth.status === 401,
        statusCode: whBadAuth.status,
        expectedStatus: 401,
        durationMs: whBadAuth.durationMs,
    });

    // 4.3 Con firma HMAC válida (espera 200)
    if (signingSecret) {
        const ts = Math.floor(Date.now() / 1000);
        const validSignatureHeader = computeHmacSignature(mockWebhookBody, signingSecret, ts);

        const whValid = await runHttpRequest(`${targetUrl}/webhooks/elevenlabs/${webhookToken}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'elevenlabs-signature': validSignatureHeader,
            },
            body: mockWebhookBody,
        });
        recordResult({
            name: 'POST /webhooks/elevenlabs [Firma HMAC válida -> Responde 200]',
            passed: whValid.status === 200 && (whValid.data?.status === 'accepted' || whValid.data?.status === 'duplicate'),
            statusCode: whValid.status,
            expectedStatus: 200,
            durationMs: whValid.durationMs,
            details: whValid.data ? `Estado: "${whValid.data.status}"` : undefined,
        });
    } else {
        recordResult({
            name: 'POST /webhooks/elevenlabs [Firma HMAC válida]',
            passed: false,
            statusCode: 0,
            expectedStatus: 200,
            durationMs: 0,
            details: 'No se pudo probar porque webhook_signing_secret no está configurado en Vault',
        });
    }

    // 5. Familia 3: Sesiones y Signed URLs
    console.log(`\n${YELLOW}🔑 5. Probando Familia 3: Signed URLs (/api/elevenlabs/signed-url)...${NC}`);
    const signedUrlRes = await runHttpRequest(`${targetUrl}/api/elevenlabs/signed-url`, {
        method: 'GET',
    });
    recordResult({
        name: 'GET /api/elevenlabs/signed-url [Genera Signed URL WebSocket]',
        passed: signedUrlRes.status === 200 && signedUrlRes.data?.status === 'success' && Boolean(signedUrlRes.data?.signedUrl),
        statusCode: signedUrlRes.status,
        expectedStatus: 200,
        durationMs: signedUrlRes.durationMs,
        details: signedUrlRes.data?.signedUrl ? `Signed URL: ${signedUrlRes.data.signedUrl.substring(0, 45)}...` : undefined,
    });

    // 6. Resumen General
    const totalPassed = results.filter((r) => r.passed).length;
    const totalTests = results.length;
    const allPassed = totalPassed === totalTests;

    console.log(`\n${CYAN}${BOLD}=====================================================================${NC}`);
    if (allPassed) {
        console.log(`${GREEN}${BOLD} 🎉 ¡TODAS LAS VALIDACIONES PASARON EXITOSAMENTE! (${totalPassed}/${totalTests})${NC}`);
        console.log(`${GREEN} Tu backend está 100% sincronizado y listo para operar con ElevenLabs.${NC}`);
    } else {
        console.log(`${RED}${BOLD} ⚠️ ALGUNAS PRUEBAS FALLARON (${totalPassed}/${totalTests} aprobadas)${NC}`);
        console.log(`${YELLOW} Revisa los detalles de cada prueba arriba para corregir la discrepancia.${NC}`);
    }
    console.log(`${CYAN}${BOLD}=====================================================================${NC}\n`);

    process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
    console.error(`\n${RED}Excepción fatal ejecutando validación:${NC}`, err);
    process.exit(1);
});
