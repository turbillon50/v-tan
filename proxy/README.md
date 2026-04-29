# Bybit Proxy — ALL Trading Studio

Mini servidor intermediario que firma llamadas a la API de Bybit.
Se despliega en Railway en 5 minutos. La app principal en Replit sigue funcionando igual.

## Variables de entorno requeridas en Railway

| Variable | Descripción |
|---|---|
| `BYBIT_API_KEY` | Tu API key de Bybit |
| `BYBIT_API_SECRET` | Tu API secret de Bybit |
| `PROXY_SECRET` | Contraseña que protege el proxy (invéntate una) |

## Deploy en Railway

1. railway.app → New Project → Deploy from GitHub
2. Sube solo la carpeta `/proxy` del repo
3. Agrega las 3 variables de entorno
4. Railway te da una URL: `https://xxx.railway.app`
5. Guarda esa URL como `BYBIT_PROXY_URL` en Replit
6. Guarda tu PROXY_SECRET también en Replit

## Endpoint

```
POST /proxy
Headers: x-proxy-secret: TU_PROXY_SECRET
Body: { "method": "GET", "path": "/v5/account/wallet-balance", "params": { "accountType": "UNIFIED", "coin": "USDT" } }
```
