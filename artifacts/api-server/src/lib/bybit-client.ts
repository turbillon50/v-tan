import crypto from "crypto";
import { getKey } from "./api-keys-provider";

const BASE = "https://api.bybit.com";

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function bybitGet(path: string, params: Record<string, string> = {}): Promise<any> {
  // PR #39 — modo directo es el camino preferido. El proxy ya no es obligatorio
  // (queda como fallback opcional si BYBIT_PROXY_URL está seteado y FORCE_PROXY=1).
  const useProxy = !!process.env.BYBIT_PROXY_URL && process.env.FORCE_PROXY === "1";
  if (useProxy) {
    const proxyUrl = process.env.BYBIT_PROXY_URL!;
    const proxySecret = (await getKey("proxy_secret")) ?? "";
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

  // Direct mode: api-server reads keys from DB (fallback env via provider)
  const key    = await getKey("bybit_key");
  const secret = await getKey("bybit_secret");
  if (!key || !secret) throw new Error("No Bybit credentials (configura bybit_key/bybit_secret en tanit_api_keys o env)");

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
  // PR #39 — ahora la fuente principal es la DB. Sólo comprobamos env como
  // señal de bootstrap; en runtime real getKey() resuelve DB-or-env.
  return !!(
    (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) ||
    process.env.BYBIT_PROXY_URL
  );
}
