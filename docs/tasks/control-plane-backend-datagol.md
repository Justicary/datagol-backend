# TASK — Plano de control y licenciamiento (BACKEND)

**Proyecto:** `datagol-api`
**Precondición:** `migracion-control-plane.sql` aplicada **únicamente** en el proyecto Supabase de `api.datagol.net`.
**Referencia obligatoria:** `AGENTS.md` de este repositorio

---

## Arquitectura

El mismo repositorio produce dos comportamientos según `CONTROL_PLANE`:

| Bandera | Dónde corre | Qué registra |
|---|---|---|
| `CONTROL_PLANE=true` | `api.datagol.net` | Rutas de `/control/**` + todo lo operativo |
| `CONTROL_PLANE=false` | Cada instalación cliente | Solo lo operativo + cliente de licencia |

**Riesgo:** un error de configuración expondría rutas de control en una instalación cliente. La mitigación es obligatoria y va en las pruebas (ver Fase E).

---

## Dos principios que gobiernan el diseño

**1. La licencia nunca apaga la voz.** Si la verificación falla —tu servidor caído, red del cliente intermitente— la recepcionista 24/7 debe seguir contestando. La degradación es por etapas y la atención telefónica queda fuera de todas ellas.

**2. El latido lleva solo agregados.** Recibir nombres, teléfonos o transcripciones de los contactos de tus clientes convertiría a Datagol en responsable de tratamiento bajo la LFPDPPP para personas que nunca fueron sus clientes. Es una restricción legal, no una preferencia.

---

## FASE A — Firma y emisión de licencias (control plane)

### A.1 Llaves de firma

Par asimétrico (EdDSA preferido, RS256 aceptable). **La llave privada vive en el gestor de secretos**, nunca en la base ni en el repositorio. La pública se distribuye con cada instalación como variable de entorno.

Versiona la llave (`key_version`) desde el primer día. Rotarla después sin versión es imposible sin invalidar toda la flota.

### A.2 Contenido del token

JWT firmado con: identificador y slug del despliegue, `plan_key`, lista de features habilitadas, fecha de emisión y expiración, versión de llave, y huella de la instalación.

Vigencia sugerida: 90 días, renovada automáticamente en cada latido exitoso. Vigencia corta con renovación automática da control real sin depender de conectividad momentánea.

### A.3 Endpoints exclusivos

```
POST   /control/licenses                    -- emitir
POST   /control/licenses/:id/revoke         -- revocar con motivo
POST   /control/licenses/:id/rotate         -- rotar sin revocar
GET    /control/licenses/:id
```

Solo `is_platform_admin()`. Toda operación escribe en `deployment_events`.

**La emisión ocurre al firmar el contrato**, no de un inventario pregenerado. Un pozo de llaves obliga a administrar inventario sin ningún beneficio.

---

## FASE B — Cliente de licencia (todas las instalaciones)

### B.1 Verificación local

Al arranque y cada hora, verificar la firma del token **con la llave pública, sin red**. Si la firma es válida y no expiró, la instalación opera con normalidad aunque `api.datagol.net` esté inalcanzable.

Sin token, o con firma inválida: la instalación **arranca igual** pero en estado degradado máximo, registrando el motivo. Nunca rehúsa arrancar — un contenedor que no levanta por licencia es una llamada perdida.

### B.2 Latido

Diario, vía pg-boss. Envía:

✅ Versión instalada, estado de servicios, latencia p95, errores agregados
✅ Conteos del periodo: conversaciones, citas, prospectos
✅ Consumo agregado en USD por proveedor
✅ Features activas, asientos usados

❌ Nada de `leads`, `contacts`, `appointments`, transcripciones, teléfonos ni correos

**Construye el payload con un esquema Zod cerrado** (`.strict()`), no ensamblando objetos libres. El esquema es la garantía de que nunca se filtre PII por un cambio futuro.

Responde con un token renovado. Si el latido falla, reintenta con retroceso exponencial sin bloquear nada.

### B.3 Degradación por etapas

| Días sin latido | Comportamiento |
|---|---|
| 0–7 | Normal |
| 8–14 | Aviso en el dashboard. Operación intacta. |
| 15–30 | Aviso persistente. Se desactivan reportes, outbound y exportación. |
| +30 | Dashboard bloqueado. **Voz, WhatsApp y agendamiento siguen funcionando.** |

Los umbrales vienen del token, no del código.

**Prueba obligatoria:** con la licencia expirada, revocada y sin latido durante 60 días, una llamada entrante se contesta y agenda correctamente. Si esa prueba falla, el diseño está mal implementado.

---

## FASE C — Registro comercial (control plane)

```
POST/GET/PATCH  /control/customers
POST/GET/PATCH  /control/deployments
POST            /control/deployments/:id/status
GET             /control/deployments/:id/tasks
PATCH           /control/deployments/:id/tasks/:taskKey
GET             /control/fleet                 -- v_fleet_health
GET             /control/revenue               -- v_recurring_revenue
```

Al pasar un despliegue a `aprovisionando`, instanciar las tareas desde `provisioning_task_templates`, filtrando las que no apliquen al plan contratado.

Todo cambio de estado escribe en `deployment_events`.

---

## FASE D — Contrato y firma

```
POST /control/deployments/:id/contract        -- generar PDF y hash
POST /control/contracts/:id/send-otp          -- código al firmante
POST /control/contracts/:id/sign              -- verificar OTP y firmar
GET  /control/contracts/:id/pdf               -- URL firmada
```

Captura obligatoria: hash SHA-256 del PDF exacto, versión de plantilla, identidad del firmante verificada por código, marca de tiempo, IP, user agent y geolocalización si se autoriza.

El PDF final se almacena en bucket privado. Un contrato con `signed_at` no se modifica — el trigger de la base ya lo impide; la API debe devolver un error claro en vez de un fallo de constraint.

**Nota:** la validez de la firma electrónica en México depende de la calidad de la evidencia. Esto debe revisarlo un abogado antes del primer contrato real. Evalúa el sellado NOM-151 y, si el volumen lo justifica, un proveedor de firma establecido.

---

## FASE E — Página de estatus compartida

```
GET /status/:statusToken        -- sin sesión, solo lectura
```

Resuelve el despliegue por `status_token`, devuelve avance de provisión y tareas con su responsable y estado.

**Requisitos de seguridad:**
- Sin datos fiscales, montos, notas internas ni credenciales
- Solo `trade_name`, avance y lista de tareas
- Límite de tasa por token e IP
- El token es opaco y rotable

Es la pieza que responde la pregunta del cliente —"¿en qué va mi instalación?"— sin que llame a soporte. Y le muestra qué depende de él: RFC, plantillas de Meta, información del negocio.

---

## FASE F — Aislamiento de la bandera

- Con `CONTROL_PLANE=false`, ninguna ruta de `/control/**` se registra.
- Las tablas del control plane no se crean en migraciones de instalaciones cliente.
- Validación de entorno al arranque: si la bandera está encendida pero faltan las llaves de firma, **la aplicación falla de inmediato** con mensaje claro.

**Prueba obligatoria:** arrancar con la bandera apagada y verificar que toda ruta de `/control/**` devuelva 404. Es la prueba que evita el peor escenario de esta tarea.

---

## Pruebas

- **La central:** licencia expirada, revocada y 60 días sin latido → la llamada entrante se contesta y agenda
- Con la bandera apagada, `/control/**` no existe
- El payload del latido rechaza cualquier campo de PII
- Token con firma inválida no otorga permisos; la instalación arranca igual
- Token firmado con llave de otra versión se rechaza
- Cada etapa de degradación desactiva lo correspondiente y nada más
- Contrato firmado no se puede modificar
- Firma sin OTP verificado se rechaza
- `/status/:token` no expone montos ni datos fiscales
- Token de estatus inválido devuelve 404, no un mensaje que revele existencia
- La emisión de licencia deja registro en `deployment_events`
- Cada rechazo con su contraparte de éxito

Al terminar: `pnpm stryker run` sobre el servicio de licencias y el constructor del payload del latido. Umbral ≥90% sobre score **total**.