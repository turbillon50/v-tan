/**
 * Vercel API client — Tanit consulta el deploy del frontend (tanit.work).
 *
 * REST: https://api.vercel.com
 * Requiere VERCEL_TOKEN.
 *
 * Si el proyecto del frontend no se llama "tanit", override con
 * VERCEL_PROJECT_ID o VERCEL_PROJECT_NAME.
 */

const V_API = "https://api.vercel.com";
const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const PROJECT_NAME = process.env.VERCEL_PROJECT_NAME;
const TEAM_ID = process.env.VERCEL_TEAM_ID;

function vHeaders(): HeadersInit {
  if (!TOKEN) throw new Error("VERCEL_TOKEN no está configurado en env.");
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
}

function teamQuery(): string {
  return TEAM_ID ? `&teamId=${TEAM_ID}` : "";
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: string;        // BUILDING, READY, ERROR, CANCELED, QUEUED
  createdAt: number;
  ready: number | null;
  source: string | null;
  meta: Record<string, unknown>;
}

export async function listVercelDeployments(limit = 10): Promise<VercelDeployment[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (PROJECT_ID) params.set("projectId", PROJECT_ID);
  if (TEAM_ID) params.set("teamId", TEAM_ID);
  const url = `${V_API}/v6/deployments?${params.toString()}`;
  const r = await fetch(url, { headers: vHeaders() });
  if (!r.ok) throw new Error(`Vercel ${r.status}: ${await r.text()}`);
  const j = await r.json();
  let deployments = (j.deployments ?? []) as Array<any>;
  // Si filtramos por nombre, hacemos client-side
  if (PROJECT_NAME && !PROJECT_ID) {
    deployments = deployments.filter((d) => d.name === PROJECT_NAME);
  }
  return deployments.slice(0, limit).map((d) => ({
    uid: d.uid,
    name: d.name,
    url: d.url,
    state: d.state ?? d.readyState ?? "UNKNOWN",
    createdAt: d.created ?? d.createdAt,
    ready: d.ready ?? null,
    source: d.source ?? null,
    meta: d.meta ?? {},
  }));
}

export async function getVercelDeployment(uid: string): Promise<VercelDeployment & { error?: string }> {
  const url = `${V_API}/v13/deployments/${uid}?${teamQuery().slice(1)}`;
  const r = await fetch(url, { headers: vHeaders() });
  if (!r.ok) throw new Error(`Vercel ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return {
    uid: d.id ?? d.uid,
    name: d.name,
    url: d.url,
    state: d.readyState ?? d.state ?? "UNKNOWN",
    createdAt: d.createdAt,
    ready: d.ready ?? null,
    source: d.source ?? null,
    meta: d.meta ?? {},
    error: d.errorMessage ?? undefined,
  };
}

export async function getVercelDeploymentEvents(uid: string, limit = 200): Promise<string[]> {
  const url = `${V_API}/v3/deployments/${uid}/events?limit=${limit}${teamQuery()}`;
  const r = await fetch(url, { headers: vHeaders() });
  if (!r.ok) throw new Error(`Vercel ${r.status}: ${await r.text()}`);
  const events = await r.json();
  if (!Array.isArray(events)) return [];
  return events
    .filter((e: any) => e?.text || e?.payload?.text)
    .map((e: any) => `[${e.created ? new Date(e.created).toISOString() : "?"}] ${e.text ?? e.payload?.text ?? ""}`);
}
