/**
 * Fragmentos de system prompt sugeridos para configurar en el agente de
 * ElevenLabs (FASE G, docs/tasks/catalogo-productos-grupos-cred.md). No se
 * inyectan desde el backend — ElevenLabs no expone una API para fijar el
 * system prompt del agente en runtime por conversación, y de cualquier
 * forma este texto es para el Dashboard → Agent → Prompt, configuración de
 * onboarding, no un valor por-tenant que este código deba calcular.
 */
export const PRODUCT_CATALOG_SYSTEM_PROMPT_SNIPPET = `
Cuando el cliente pregunte por el precio o la disponibilidad de un producto:
- Usa la herramienta de productos ANTES de mencionar cualquier precio o
  disponibilidad. Nunca respondas con un precio que no venga de esa
  consulta.
- Nunca inventes ni recuerdes un precio de un turno anterior de esta misma
  conversación — los precios cambian, y lo que dijiste hace un minuto puede
  ya no ser el precio vigente. Vuelve a consultar la herramienta cada vez.
- Cuando la herramienta te diga la disponibilidad, repite exactamente esa
  matización — nunca digas "sí tenemos" ni des una cantidad de piezas. Si la
  herramienta no pudo consultar el precio, ofrece tomar los datos del
  cliente para confirmarle después; nunca inventes un precio para no dejarlo
  sin respuesta.
- Ofrece como máximo dos o tres productos por turno de conversación, igual
  que con los horarios de citas — una lista larga es difícil de seguir por
  voz.
- Di el precio en palabras naturales ("son ciento cincuenta pesos, con IVA
  incluido"), nunca leyendo los dígitos uno por uno.
`.trim();

/**
 * Bloque de instrucciones de COTIZACIONES para el System Prompt del agente
 * conversacional (docs/tasks/procedimiento-cotizaciones.md, FASE D).
 */
export const QUOTATION_SYSTEM_PROMPT_SNIPPET = `
COTIZACIONES:
- Si el contacto es recurrente o menciona una cotización previa, invoca primero \`quotation_cart_view\` para verificar si tiene un carrito guardado y pregúntale si desea continuarlo.
- Antes de agregar una partida con \`quotation_cart_set_item\`, confirma el producto/servicio/plan y la cantidad exacta con el cliente. Usa siempre la cantidad total absoluta para ese SKU.
- Cuando agregues un plan que incluya \`suggestedComplement\` (mantenimiento mensual), ofrécelo como complemento opcional; nunca lo agregues sin que el cliente lo acepte.
- Para servicios y planes, nunca menciones existencias ni inventario; solo menciona disponibilidad para productos físicos inventariables.
- Nunca ofrezcas ni apliques descuentos por tu cuenta; los descuentos solo los autoriza un asesor humano desde el panel.
- Antes de emitir con \`quotation_finalize\`, repasa las partidas y lee siempre \`spokenTotal\` en palabras naturales, pidiendo confirmación explícita del cliente y el canal de envío (correo electrónico o WhatsApp).
- Si \`quotation_finalize\` reporta \`priceChanges\`, avisa con transparencia al cliente qué partida actualizó su precio antes de despedirte.
`.trim();

/**
 * Inyecta o reemplaza la sección `COTIZACIONES:` dentro de un System Prompt
 * existente sin duplicar ocurrencias previas (mismo patrón que `injectPlansSectionIntoPrompt`).
 */
export function injectQuotationsSectionIntoPrompt(
    currentPrompt: string,
    newQuotationsBlock: string = QUOTATION_SYSTEM_PROMPT_SNIPPET
): string {
    const trimmedBlock = newQuotationsBlock.trim();
    const sectionRegex =
        /(?:^|\n\s*)(?:#{1,3}\s*)?COTIZACIONES:?\s*\n[\s\S]*?(?=(\n\s*(?:#{1,3}\s+)?[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s_]{2,}(?::|\s*\n)|$))/gi;

    if (sectionRegex.test(currentPrompt)) {
        let firstReplaced = false;
        const cleaned = currentPrompt.replace(sectionRegex, (match) => {
            if (!firstReplaced) {
                firstReplaced = true;
                const hasLeadingNewline = match.startsWith('\n');
                return `${hasLeadingNewline ? '\n\n' : ''}${trimmedBlock}`;
            }
            return '';
        });
        return cleaned.trim();
    }

    return `${currentPrompt.trim()}\n\n${trimmedBlock}`.trim();
}
