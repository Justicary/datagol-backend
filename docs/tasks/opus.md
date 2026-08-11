Verifica si existe o en su caso implementa la agregación de métricas por canal en el backend.
El objetivo es preparar el endpoint que consumirá se después datagol-frontend.

1. VISTA DE MÉTRICAS POR CANAL
   Crea una vista o función que, por organización y periodo, devuelva
   segmentado por leads.channel:
   - conversaciones totales
   - prospectos capturados (leads con al menos nombre o algún método de contacto)
   - prospectos calientes
   - citas agendadas
   - costo total en MXN y USD

   La atribución de costo se hace uniendo usage_events con leads por
   conversation_id, NO infiriendo el canal del unit_type. Los tokens
   de LLM se consumen en ambos canales y su unit_type no lo distingue.

   Decide y documenta qué hacer con el consumo que no empata con
   ningún lead (huérfano). No lo descartes en silencio: si no cuadra
   con la factura del proveedor, la conciliación deja de servir.

2. MÉTRICAS DERIVADAS
   - costo por prospecto capturado, por canal
   - costo por cita agendada, por canal
   - tasa de conversión a cita, por canal

3. CONTACTOS CROSS-CANAL
   Cuántos contactos han interactuado por más de un canal. Ya tienes
   un caso real: +522213528341 aparece en voz y en WhatsApp.

4. ENDPOINT
   GET /api/organizations/:id/metrics?from=&to=
   Con los umbrales de prueba habituales y su contraparte de éxito.

Agrupa los unit_types dinámicos de LLM (llm_input_token_<modelo>) bajo
una sola categoría en la salida. Exponer una fila por modelo al cliente
no le sirve.