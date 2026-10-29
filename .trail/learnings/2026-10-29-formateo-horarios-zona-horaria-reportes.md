---
title: "Formateo determinista de horarios en zona horaria local para reportes de citas y canal de Telegram"
author: Victor
date: 2026-10-29
branch: main
id: l-7129e005
scope: repo
status: active
src: agent
touches:
  - src/services/reports/nl-dimensions.ts
  - src/services/reports/intents/listado-citas.ts
  - src/services/reports/intents/citas-sin-desenlace.ts
  - src/services/reports/nl-narrative-service.ts
  - src/services/telegram/formatter.ts
  - __tests__/nl-dimensions.test.ts
  - __tests__/nl-intents.test.ts
  - __tests__/telegram-formatter.test.ts
  - __tests__/nl-narrative-verification.test.ts
---

## Decided
- Las intenciones que listan citas (`listado_citas` y `citas_sin_desenlace`) deben convertir los campos `start_time` y `end_time` (almacenados en UTC en Postgres) a la zona horaria del negocio (`period.timezone`) usando `formatToZonedTime` de `src/services/reports/nl-dimensions.ts`.
- El arnés de generación de narrativa (`nl-narrative-service.ts`) debe recibir los horarios ya calculados en la zona horaria local dentro de `DATOS` y declarar `Zona horaria del negocio` en el prompt. De este modo, `verifyNarrativeNumbers` verifica exitosamente las horas locales (ej. 16:00) sin descartar la redacción.
- El formateador de Telegram (`formatter.ts`) recibe `response.period.timezone` y convierte cualquier cadena ISO datetime en `renderDataBlock` a la zona horaria local para evitar desplegar marcas de tiempo UTC crudas.

## Tried and ruled out
- Dejar los timestamps en UTC y pedirle al LLM que haga la conversión de zona horaria en su narrativa: viola la regla de cálculos deterministas, produce alucinaciones de horario por desfases o DST, y hace que `verifyNarrativeNumbers` descarte la narrativa al no encontrar la hora convertida (ej. 16) dentro del bloque DATOS (que solo contenía 22).

