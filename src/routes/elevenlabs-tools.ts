import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';

interface ElevenLabsToolRequest {
  tool_name?: string;
  name?: string;
  parameters?: Record<string, any>;
  args?: Record<string, any>;
  conversation_id?: string;
  dynamic_variables?: Record<string, any>;
}

export async function elevenLabsToolsRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/elevenlabs/tools
   * Manejador centralizado de llamadas a herramientas (Tool Calling) desde ElevenLabs ConvAI
   */
  fastify.post('/api/elevenlabs/tools', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as ElevenLabsToolRequest) || {};

    // Normalizar nombre de herramienta y parámetros
    const toolName = body.tool_name || body.name || '';
    const params = body.parameters || body.args || {};
    // AGENTS.md §5.1: prohibido asumir una organización por defecto. Ruta
    // legacy pendiente de migrar a routes/tools/:webhookToken/** — hasta esa
    // migración, sin dynamic_variables.organization_id la petición se
    // rechaza en vez de operar silenciosamente sobre la organización de
    // producción (hallazgo de seguridad corregido, ver informe de Fase 5).
    const orgId = body.dynamic_variables?.organization_id || body.dynamic_variables?.organizationId || null;

    if (!orgId) {
      request.log.error({ toolName, msg: 'Rechazado: /api/elevenlabs/tools sin organization_id en dynamic_variables' });
      return reply.status(400).send({
        result: 'Error de configuración interno: no se pudo identificar la organización.',
        status: 'error',
      });
    }

    request.log.info({ toolName, params, msg: 'Petición de herramienta de ElevenLabs (ruta legacy)' });

    try {
      let resultText = '';

      switch (toolName) {
        // ---------------------------------------------------------------------
        // 1. Búsqueda Vectorial RAG en Supabase pgvector
        // ---------------------------------------------------------------------
        case 'searchKnowledgeBase': {
          const query = params.query || '';

          if (!query) {
            resultText = 'No se proporcionó una consulta para buscar en la base de conocimientos.';
            break;
          }

          // Generar embedding con OpenAI
          const openaiRes = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'text-embedding-3-small',
              input: query,
            }),
          });

          const openaiData = (await openaiRes.json()) as any;
          const embedding = openaiData?.data?.[0]?.embedding;

          if (embedding) {
            // Invocar la función RPC match_documents en Supabase
            const { data: docs } = await supabaseAdmin.rpc('match_documents', {
              query_embedding: embedding,
              match_count: 3,
              filter_org_id: orgId,
            });

            if (docs && docs.length > 0) {
              resultText = docs.map((d: any) => `${d.title || 'Documento'}: ${d.content}`).join('\n---\n');
            } else {
              resultText = 'No se encontró información específica en la base de datos.';
            }
          } else {
            resultText = 'Información estándar de la empresa disponible.';
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 2. Consulta de Disponibilidad en Cal.com v2
        // ---------------------------------------------------------------------
        case 'checkAvailability': {
          const startTime = params.startTime || new Date().toISOString();
          const endTime =
            params.endTime || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const calApiKey = process.env.CAL_API_KEY;
          const eventTypeId = process.env.CAL_EVENT_TYPE_ID || '6470745';

          const calRes = await fetch(
            `https://api.cal.com/v2/slots/available?eventTypeId=${eventTypeId}&startTime=${startTime}&endTime=${endTime}&timeZone=America/Mexico_City`,
            {
              headers: { Authorization: `Bearer ${calApiKey}` },
            }
          );

          if (calRes.ok) {
            const calData = (await calRes.json()) as any;
            const slots = calData?.data?.slots || {};
            const dateKeys = Object.keys(slots);
            if (dateKeys.length > 0) {
              const formattedSlots = dateKeys
                .slice(0, 3)
                .map((dateKey) => `${dateKey}: ${slots[dateKey].map((s: any) => s.time || s.start).join(', ')}`)
                .join('; ');
              resultText = `Horarios disponibles encontrados: ${formattedSlots}`;
            } else {
              resultText = 'No hay horarios disponibles para ese rango de fechas.';
            }
          } else {
            resultText = 'Se presentó un problema al verificar la agenda en vivo.';
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 3. Reserva de Citas en Cal.com v2 + Inserción en Supabase DB
        // ---------------------------------------------------------------------
        case 'bookAppointment': {
          const { customerName, customerEmail, customerPhone, startTime } = params;
          const calApiKey = process.env.CAL_API_KEY;
          const eventTypeId = Number(process.env.CAL_EVENT_TYPE_ID || '6470745');

          const calRes = await fetch('https://api.cal.com/v2/bookings', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${calApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              eventTypeId,
              start: startTime,
              responses: {
                name: customerName,
                email: customerEmail || `${customerPhone || 'cliente'}@datagol.temp`,
                location: { optionValue: 'phone', value: customerPhone },
              },
              timeZone: 'America/Mexico_City',
            }),
          });

          const calBooking = (await calRes.json()) as any;

          if (calRes.ok) {
            // Guardar registro de la cita en Supabase
            await supabaseAdmin.from('appointments').insert({
              organization_id: orgId,
              customer_name: customerName,
              customer_email: customerEmail || null,
              customer_phone: customerPhone,
              start_time: startTime,
              end_time: new Date(new Date(startTime).getTime() + 30 * 60000).toISOString(),
              cal_booking_id: calBooking?.data?.id || `cal_${Date.now()}`,
              status: 'confirmed',
            });

            resultText = `Cita confirmada con éxito para ${customerName} el día y hora seleccionados.`;
          } else {
            resultText = 'No se pudo agendar la cita. Por favor intenta con otro horario.';
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 4. Reprogramación de Citas
        // ---------------------------------------------------------------------
        case 'rescheduleAppointment': {
          const { customerPhone, newStartTime } = params;

          // Buscar última cita del cliente en Supabase
          const { data: apt } = await supabaseAdmin
            .from('appointments')
            .select('*')
            .eq('organization_id', orgId)
            .eq('customer_phone', customerPhone)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          if (apt) {
            await supabaseAdmin
              .from('appointments')
              .update({
                start_time: newStartTime,
                end_time: new Date(new Date(newStartTime).getTime() + 30 * 60000).toISOString(),
                status: 'rescheduled',
              })
              .eq('id', apt.id);

            resultText = `La cita de ${apt.customer_name} ha sido reprogramada con éxito para ${newStartTime}.`;
          } else {
            resultText = 'No se encontró una cita previa con este número telefónico para modificar.';
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 5. Guardar/Actualizar Información del Contacto/Prospecto (Lead Capture)
        // ---------------------------------------------------------------------
        case 'saveContactInfo':
        case 'collectLeadData': {
          const customerName = params.customerName || params.name || '';
          const customerEmail = params.customerEmail || params.email || '';
          const customerPhone = params.customerPhone || params.phone || '';

          if (customerName || customerEmail || customerPhone) {
            const convId = body.conversation_id || `conv_${Date.now()}`;
            
            // Verificar si la llamada ya existe en call_logs
            const { data: existingLog } = await supabaseAdmin
              .from('call_logs')
              .select('id')
              .eq('provider_call_id', convId)
              .maybeSingle();

            if (existingLog) {
              await supabaseAdmin
                .from('call_logs')
                .update({
                  customer_name: customerName || undefined,
                  customer_email: customerEmail || undefined,
                  caller_phone: customerPhone || undefined,
                })
                .eq('id', existingLog.id);
            } else {
              // Insertar registro inicial del prospecto
              const initialPayload: Record<string, any> = {
                organization_id: orgId,
                provider_call_id: convId,
                customer_name: customerName || 'Prospecto WebCall',
                customer_email: customerEmail || null,
                caller_phone: customerPhone || 'WebCall',
                call_type: 'webCall',
                status: 'in_progress',
                summary: 'Información de contacto recopilada durante la llamada.',
              };

              const { error: insertErr } = await supabaseAdmin.from('call_logs').insert(initialPayload);
              if (insertErr && insertErr.code === 'PGRST204') {
                delete initialPayload.customer_name;
                delete initialPayload.customer_email;
                await supabaseAdmin.from('call_logs').insert(initialPayload);
              }
            }
            resultText = `Información de contacto registrada correctamente para ${customerName || customerEmail || customerPhone}.`;
          } else {
            resultText = 'No se proporcionaron datos de contacto válidos.';
          }
          break;
        }

        default:
          resultText = `Herramienta '${toolName}' ejecutada.`;
      }

      // Estructura de respuesta aceptada por ElevenLabs ConvAI
      return reply.send({
        result: resultText,
        status: 'success',
      });
    } catch (err: any) {
      request.log.error({ err, toolName }, 'Error ejecutando herramienta');
      return reply.send({
        result: 'Ocurrió una interrupción al consultar los sistemas de la empresa.',
        status: 'error',
      });
    }
  });
}

export default elevenLabsToolsRoutes;
