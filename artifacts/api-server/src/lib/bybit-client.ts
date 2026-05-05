import crypto from "crypto";

const BASE = "https://api.bybit.com";

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function bybitGet(path: string, params: Record<string, string> = {}): Promise<any> {
  // Proxy mode: tunnel signed requests through the bybit-proxy service
  // (keys live in the proxy, not here — better security separation)
  const proxyUrl = process.env.BYBIT_PROXY_URL;
  const proxySecret = process.env.PROXY_SECRET ?? "";
  if (proxyUrl) {
    const r = await fetch(`${proxyUrl.replace(/\/$/, "")}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": proxySecret },
      body: JSON.stringify({ method: "GET", path, params, proxySecret }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Bybit proxy ${r.status}`);
    const data = await r.json() as any;
    if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
    return data.result;
  }

  // Direct mode: api-server has the keys itself
  const key    = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  if (!key || !secret) throw new Error("No Bybit credentials (set BYBIT_PROXY_URL or BYBIT_API_KEY+SECRET)");

  const ts         = Date.now().toString();
  const recvWindow = "5000";
  const qs         = new URLSearchParams(params).toString();
  const sigPayload = ts + key + recvWindow + qs;
  const signature  = sign(sigPayload, secret);

  const url = `${BASE}${path}${qs ? "?" + qs : ""}`;
  const r   = await fetch(url, {
    headers: {
      "X-BAPI-API-KEY":      key,
      "X-BAPI-SIGN":         signature,
      "X-BAPI-SIGN-ALGO":    "HmacSHA256",
      "X-BAPI-TIMESTAMP":    ts,
      "X-BAPI-RECV-WINDOW":  recvWindow,
    },
    signal: AbortSignal.timeout(6000),
  });

  if (!r.ok) throw new Error(`Bybit ${r.status}`);
  const data = await r.json() as any;
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

export function hasCredentials(): boolean {
  // Either direct API keys or proxy URL counts as having credentials
  return !!(
    (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) ||
    process.env.BYBIT_PROXY_URL
  );
}
