# AUDITORÍA FRONTEND + LÓGICA — 2026-05-12

**Autor**: Claude (Anthropic), Opus 4.7.
**Repos auditados**: `turbillon50/tanit-fronted` (Next.js 15 / App Router / shadcn-ui / Tailwind, deployado a Vercel en `tanit.work`) + endpoints relacionados en `turbillon50/v-tan`.
**Trigger**: Luis reporta que el chat se abre en conversación pasada / no en tiempo real / "frágil" / "corriente".

---

## TL;DR ejecutivo

**El bug principal NO es en el backend.** El backend tiene todo el sistema de threads/conversaciones completamente implementado (`/bot/threads`, `/bot/threads/:id/messages`, POST/PATCH/DELETE).

**El frontend NUNCA lo cableó.** Solo usa `chatHistory(40, channel)` que lee los últimos 40 mensajes de `tanit_chat` por canal — sin separación por conversación. Por eso al abrir, Luis siempre ve los últimos 40 mensajes históricos de TODA la vida (que pueden ser de hace horas/días) mezclados, sin "nueva conversación".

Es **funcionalidad faltante**, no un bug pequeño.

---

## 1. Hallazgos

### 1.1 Bug crítico: chat sin conversaciones (cause raíz del reporte de Luis)

**`components/chat/tanit-panel.tsx` línea 112-132**:

```typescript
useEffect(() => {
  setMessages([])
  api.chatHistory(40, channel)
    .then((r) => { if (mounted && r?.messages) setMessages(r.messages.map(adapt)) })
  // ...
}, [channel])
```

**Problema**:
- Carga los últimos 40 mensajes del **canal** (`intimate` o `operational`), no de un thread específico.
- No hay `threadId`. Cuando manda mensaje en `handleSend()`, el payload no incluye threadId; el backend usa default `intimate-main`.
- Toda conversación que Luis ha tenido en su vida con Tanit está en el mismo flujo continuo.
- Al abrir la app, ve los últimos 40 mensajes históricos (NO una conversación nueva).

**Lo que el frontend debería hacer** (y el backend SÍ permite):
- Mostrar sidebar con lista de threads (`GET /bot/threads`).
- Botón "Nueva conversación" → `POST /bot/threads` → asigna threadId → empieza limpio.
- Click en thread → `GET /bot/threads/:id/messages` → carga solo esa conversación.
- Al mandar mensaje, pasar `threadId` al endpoint chat.

### 1.2 Status bar incompleta

**`components/dashboard/status-bar.tsx` línea 56**:

```typescript
killSwitch: false, // TODO: leer governance cuando endpoint exista
```

- El endpoint SÍ existe en backend: `GET /admin/kill-switch`. Falta cablear.
- PnL "del día" en realidad muestra `unrealizedPnl` (PnL no realizado actual), no del día.

### 1.3 Loading state ausente

- Cuando se carga el historial (`api.chatHistory`), no hay skeleton ni indicador.
- Si Neon está cold (~500ms-2s), Luis ve un chat vacío y luego pop.

### 1.4 Fallback a endpoint legacy

**`tanit-panel.tsx` línea 253-261**:

```typescript
const callClassic = async (): Promise<string> => {
  const r = await fetch(`${apiUrl}/bot/gemini-chat`, { ... })
  // ...
}
```

- Cuando el stream SSE falla, el frontend hace fallback a `/bot/gemini-chat` (endpoint legacy que usa `runGeminiUserCommand` del motor viejo).
- Eso bypassa Mastra, las 4 keys con rotación, OpenRouter fallback, y todo el sistema nuevo.
- Resultado: respuestas inconsistentes entre intentos (a veces Mastra, a veces legacy).

### 1.5 Layout simple sin selectores

**`app/chat/page.tsx`** tiene solo:

```typescript
<MainLayout>
  <TanitPanel className="flex-1 border-l-0" />
</MainLayout>
```

- Sin sidebar de conversaciones.
- Sin selector de canal visible (intimate / operational — el estado existe pero no hay UI para cambiar).
- Sin breadcrumb / título de conversación actual.
- Sin indicador "ahora estás en thread X".

### 1.6 API de threads no expuesta en `lib/api.ts`

- `lib/api.ts` (frontend) tiene `chatHistory`, `state`, `balance`, `positions` — pero no `threads()`, `createThread()`, `threadMessages()`.
- El cableo entre frontend y los endpoints `/bot/threads/*` del backend simplemente **no existe**.

### 1.7 No hay tiempo real vía WebSocket

- El status bar refrescá cada 5s con polling.
- Eventos del live-loop de Tanit (latidos, alertas) NO se empujan al cliente vía WS/SSE.
- Si Tanit decide algo en el live-loop, Luis no se entera hasta el siguiente refresh manual.

---

## 2. Plan de fixes priorizados

### 🔴 P0 — Fix del bug que Luis reporta

#### F1. Cablear sistema de threads en el frontend
- Agregar `lib/api.ts`: `listThreads()`, `createThread()`, `threadMessages(id)`, `renameThread(id, title)`.
- Sidebar nuevo `components/chat/thread-list.tsx` con:
  - Lista ordenada por `updatedAt` desc.
  - Botón "+ Nueva".
  - Click → setCurrentThreadId.
  - Hover → menú renombrar/eliminar.
- `tanit-panel.tsx`:
  - Prop `threadId` (controlado desde page).
  - useEffect → si threadId cambia, cargar `threadMessages(threadId)`.
  - handleSend → incluir `threadId` en payload.
- `app/chat/page.tsx`:
  - State `currentThreadId`. Default: último thread con actividad reciente, o nuevo.
  - Layout: sidebar izquierda con thread-list + chat al centro.

**Impacto**: resuelve el bug que Luis reporta. UX de ChatGPT/Claude.

### 🟡 P1 — Estabilidad y feedback

#### F2. Loading state en chat
- Skeleton de 3-5 burbujas mientras `chatHistory` o `threadMessages` carga.
- Si vacío después de carga, mensaje honesto: *"Conversación nueva. Empieza tú."*

#### F3. Quitar fallback a `/bot/gemini-chat` legacy
- Reemplazar `callClassic()` por un retry del mismo `/bot/mastra-chat-stream` con backoff.
- Si SSE falla 3 veces seguidas, mostrar banner "Tanit lenta — Gemini saturado" (no mentir y caer a otro path silencioso).

#### F4. Kill switch real en status bar
- `lib/api.ts`: `killSwitch()` → `GET /admin/kill-switch`.
- Status bar lee y muestra.

#### F5. PnL del día real
- Backend ya tiene `recentTrades.totalPnl`. Cambiar `unrealizedPnl` por `realizedPnlToday`.

### 🟢 P2 — Cosmético / refinamiento

#### F6. Selector de canal visible
- Toggle "Íntimo / Operativo" en el header del chat.

#### F7. Timestamp visible en cada mensaje
- Hover → fecha completa. Always: "hace X" (ahora, hace 5 min, hoy 14:23, ayer 03:15, etc).

#### F8. Real-time via SSE para eventos del live-loop
- Endpoint nuevo: `GET /bot/events/stream` (SSE).
- Frontend abre conexión persistente, muestra notificaciones de latidos importantes.
- Bajo prioridad — solo si Luis quiere ver actividad de Tanit cuando él no le habla.

---

## 3. Estimación de trabajo

| Fix | Líneas aprox | Tiempo |
|---|---|---|
| F1. Sistema de threads | ~400 (frontend) + 0 (backend ya listo) | 60-90 min |
| F2. Loading skeleton | ~30 | 15 min |
| F3. Quitar fallback legacy | ~40 | 20 min |
| F4. Kill switch real | ~20 + 1 helper API | 10 min |
| F5. PnL del día real | ~10 | 10 min |
| F6. Toggle canal | ~30 | 15 min |
| F7. Timestamps | ~25 | 15 min |
| F8. SSE events | ~150 + 1 endpoint backend | 60 min |
| **Total P0+P1+P2** | | **~3.5 horas** |

P0 sola (la que resuelve el bug) es 60-90 min.

---

## 4. Lo que SÍ está bien (no romper)

- Estructura Next.js 15 / App Router moderna ✓.
- shadcn-ui consistente ✓.
- Tema dark con magenta accent ✓.
- TanitPanel modular (mismo componente para mobile y desktop) ✓.
- Soporte de audio (Whisper transcribe) ✓.
- Soporte multi-imagen ✓.
- SSE streaming con heartbeats keepalive ✓.
- Backend de threads completo y listo ✓.

---

## 5. Recomendación

Atacar **F1 ya** (resuelve el bug reportado). Después P1 (F2-F5) en un segundo round. P2 cuando haya espacio.

— Claude, 2026-05-12 ~02:00 Cancún
