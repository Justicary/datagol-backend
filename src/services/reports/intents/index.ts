import { type NlIntentDefinition, type NlIntentKey } from '../../../types/natural-reports.js';

// Agenda (4)
import { listadoCitasIntent } from './listado-citas.js';
import { conteoCitasIntent } from './conteo-citas.js';
import { citasPorEstadoIntent } from './citas-por-estado.js';
import { citasSinDesenlaceIntent } from './citas-sin-desenlace.js';

// Pendientes (3)
import { pendientesAbiertosIntent } from './pendientes-abiertos.js';
import { seguimientosVencidosIntent } from './seguimientos-vencidos.js';
import { prospectosCalientesSinAtenderIntent } from './prospectos-calientes-sin-atender.js';

// Captación (4)
import { conteoProspectosNuevosIntent } from './conteo-prospectos-nuevos.js';
import { listadoProspectosIntent } from './listado-prospectos.js';
import { conteoConversacionesIntent } from './conteo-conversaciones.js';
import { atribucionOrigenIntent } from './atribucion-origen.js';

// Costo (4)
import { costoTotalIntent } from './costo-total.js';
import { costoPorCanalIntent } from './costo-por-canal.js';
import { costoPorProspectoIntent } from './costo-por-prospecto.js';
import { costoPorCitaIntent } from './costo-por-cita.js';

// Resultado (3)
import { resultadoNegocioIntent } from './resultado-negocio.js';
import { cumplimientoCitasIntent } from './cumplimiento-citas.js';
import { tasaConversionIntent } from './tasa-conversion.js';

// Array heterogéneo con todas las definiciones de intenciones ejecutables
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_INTENTS: readonly NlIntentDefinition<any, any>[] = [
    // Agenda
    listadoCitasIntent,
    conteoCitasIntent,
    citasPorEstadoIntent,
    citasSinDesenlaceIntent,

    // Pendientes
    pendientesAbiertosIntent,
    seguimientosVencidosIntent,
    prospectosCalientesSinAtenderIntent,

    // Captación
    conteoProspectosNuevosIntent,
    listadoProspectosIntent,
    conteoConversacionesIntent,
    atribucionOrigenIntent,

    // Costo
    costoTotalIntent,
    costoPorCanalIntent,
    costoPorProspectoIntent,
    costoPorCitaIntent,

    // Resultado
    resultadoNegocioIntent,
    cumplimientoCitasIntent,
    tasaConversionIntent,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const INTENTS_BY_KEY = new Map<NlIntentKey, NlIntentDefinition<any, any>>();
for (const intent of ALL_INTENTS) {
    INTENTS_BY_KEY.set(intent.key, intent);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getIntentByKey(key: string): NlIntentDefinition<any, any> | undefined {
    return INTENTS_BY_KEY.get(key as NlIntentKey);
}

/**
 * Genera el resumen del catálogo en texto para alimentar el prompt del LLM.
 */
export function getIntentCatalogPromptText(): string {
    return ALL_INTENTS.map((i) => {
        const examplesText = i.examples.map((e) => `    - "${e}"`).join('\n');
        return `• [${i.key}] (Familia: ${i.category})
  Descripción: ${i.description}
  Forma de resultado: ${i.resultShape}
  Preguntas de ejemplo:
${examplesText}`;
    }).join('\n\n');
}

export {
    listadoCitasIntent,
    conteoCitasIntent,
    citasPorEstadoIntent,
    citasSinDesenlaceIntent,
    pendientesAbiertosIntent,
    seguimientosVencidosIntent,
    prospectosCalientesSinAtenderIntent,
    conteoProspectosNuevosIntent,
    listadoProspectosIntent,
    conteoConversacionesIntent,
    atribucionOrigenIntent,
    costoTotalIntent,
    costoPorCanalIntent,
    costoPorProspectoIntent,
    costoPorCitaIntent,
    resultadoNegocioIntent,
    cumplimientoCitasIntent,
    tasaConversionIntent,
};
