# SaaS API Reseller — Handoff

> Branch `claude/saas-api-reseller-platform-Oc8Vz`

La PWA principal del producto vive en otro repo de la organización:

- **Repo**: `turbillon50/api-comerce`
- **Rama**: `claude/saas-api-reseller-platform-Oc8Vz`
- **Ubicación dentro del repo**: `app/` (Next.js 15 App Router)

## ¿Qué rol juega `v-tan` en este producto?

`v-tan` aloja el sistema **Tanit** y está bien posicionado para ser el motor
del **Agente Prism** (el operador residente con memoria persistente que vive
en `/dashboard/agent` de la PWA).

Hoy la PWA implementa Prism así:

- UI conversacional en `api-comerce/app/src/app/dashboard/agent/page.tsx`
- Memoria persistente en `localStorage` (Zustand) — fragmentos clasificados
  como `fact / preference / todo / metric`
- Edge route `/api/agent` que envía la memoria como bloque `system` y llama
  a `anthropic/claude-sonnet-4.6` vía OpenRouter (con mock si no hay key)

## Plan para mover Prism a Tanit (`v-tan`)

1. Exponer en `v-tan` un endpoint `/agent/run` con la misma forma que el
   actual `/api/agent` (messages + memory).
2. Persistir la memoria del agente en la base de datos de Tanit en lugar de
   localStorage. Usar las "almas" existentes (ver `tanit-alma-completa.json`)
   como inspiración del shape.
3. Conectar herramientas: el agente debería poder **ejecutar acciones**
   sobre la PWA (crear blends, mover pesos, emitir keys) — exponer esas
   acciones como tools en el runtime de Tanit.
4. Hacer que `api-comerce/app/src/app/api/agent/route.ts` proxee a
   `v-tan` cuando `TANIT_AGENT_URL` esté definido; mantener el fallback
   OpenRouter para entornos sin Tanit.

Nada de esto es bloqueante para que la PWA funcione hoy.
