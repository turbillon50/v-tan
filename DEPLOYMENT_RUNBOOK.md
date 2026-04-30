# Deployment Runbook (GitHub + Cursor + Vercel + Railway + Neon)

## 1) Arquitectura objetivo

- Frontend (`artifacts/trading-dashboard`) -> Vercel
- Backend API (`artifacts/api-server`) -> Railway
- Proxy Bybit (`proxy`) -> Railway
- Base de datos principal (memoria Tanit) -> Neon Postgres

## 2) Variables por plataforma

### Railway (API + proxy)

- `DATABASE_URL`
- `SESSION_SECRET`
- `APP_PASSWORD`
- `GEMINI_API_KEY`
- `PERPLEXITY_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `BYBIT_API_KEY`
- `BYBIT_API_SECRET`
- `PROXY_SECRET`
- `BYBIT_PROXY_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_ALLOWED_USER_IDS` (opcional)

### Vercel (frontend)

- `VITE_API_URL` (URL publica del API en Railway)

### Local (Cursor)

- Copiar `.env.example` -> `.env.local` y llenar valores reales.

## 3) Orden de preparacion (una sola vez)

1. Crear Neon DB y obtener `DATABASE_URL`.
2. Cargar secretos de backend en Railway.
3. Configurar servicio API en Railway (root `artifacts/api-server`).
4. Configurar servicio proxy en Railway (root `proxy`).
5. Confirmar URL final del API en Railway.
6. Configurar `VITE_API_URL` en Vercel.
7. Conectar repo GitHub privado a Vercel para deploy automatico.

## 4) Flujo de despliegue continuo

1. Cambios en Cursor.
2. `git add`, `git commit`, `git push`.
3. Vercel despliega frontend automaticamente.
4. Railway despliega API/proxy automaticamente.
5. Verificar `/api/healthz` y dashboard.

## 5) Verificacion minima de go-live

- Frontend carga sin errores.
- `/api/healthz` responde 200.
- Bot puede leer/escribir memoria en DB nueva.
- Telegram envia alertas.
- Fallback IA operativo (Gemini -> Claude -> OpenAI -> Perplexity).
- No hay secretos en repo ni en commits.

## 6) Estabilidad posterior (prioridad alta)

- Rotar secretos cada 30-60 dias.
- Activar backups y restore point en Neon.
- Monitoreo y alertas en Railway/Vercel.
- Registrar errores de API y tareas criticas de Tanit.
