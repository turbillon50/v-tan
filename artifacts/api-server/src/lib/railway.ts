/**
 * Railway API client — Tanit consulta sus propios deployments y logs.
 *
 * Usa GraphQL contra https://backboard.railway.app/graphql/v2
 * Requiere RAILWAY_API_TOKEN (Account Token de Luis).
 *
 * IDs hardcodeados desde la URL del proyecto en producción:
 *   Project:  11a1d862-64fd-4b9f-81ef-fa85facf340a
 *   Service:  fb201f06-ffc8-410b-9a3d-66aae5f4a241  (api.tanit.work)
 *   Env:      72faea6a-53d2-4a76-b173-be9f18c4c4c7  (production)
 *
 * Si Luis cambia los IDs, override con env vars:
 *   RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENV_ID
 */

const RW_API = "https://backboard.railway.app/graphql/v2";
const TOKEN = process.env.RAILWAY_API_TOKEN;
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID ?? "11a1d862-64fd-4b9f-81ef-fa85facf340a";
const SERVICE_ID = process.env.RAILWAY_SERVICE_ID ?? "fb201f06-ffc8-410b-9a3d-66aae5f4a241";
const ENV_ID = process.env.RAILWAY_ENV_ID ?? "72faea6a-53d2-4a76-b173-be9f18c4c4c7";

function rwHeaders(): HeadersInit {
  if (!TOKEN) throw new Error("RAILWAY_API_TOKEN no está configurado en env.");
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function rwQuery<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const r = await fetch(RW_API, {
    method: "POST",
    headers: rwHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`Railway ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.errors) throw new Error(`Railway GraphQL: ${JSON.stringify(j.errors)}`);
  return j.data as T;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  staticUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
  meta: Record<string, unknown> | null;
}

export async function listDeployments(limit = 10): Promise<RailwayDeployment[]> {
  const q = `query D($projectId: String!, $envId: String!, $serviceId: String!, $first: Int!) {
    deployments(
      input: { projectId: $projectId, environmentId: $envId, serviceId: $serviceId },
      first: $first
    ) { edges { node { id status staticUrl createdAt meta } } }
  }`;
  const data = await rwQuery<{ deployments: { edges: Array<{ node: any }> } }>(q, {
    projectId: PROJECT_ID, envId: ENV_ID, serviceId: SERVICE_ID, first: limit,
  });
  return data.deployments.edges.map((e) => ({
    id: e.node.id,
    status: e.node.status,
    staticUrl: e.node.staticUrl ?? null,
    createdAt: e.node.createdAt,
    finishedAt: null,
    meta: e.node.meta ?? null,
  }));
}

export async function getDeploymentLogs(deploymentId: string, lines = 200): Promise<string[]> {
  const q = `query L($id: String!, $limit: Int!) {
    deploymentLogs(deploymentId: $id, limit: $limit) { message timestamp severity }
  }`;
  const data = await rwQuery<{ deploymentLogs: Array<{ message: string; timestamp: string; severity: string }> }>(q, {
    id: deploymentId, limit: lines,
  });
  return data.deploymentLogs.map((l) => `[${l.timestamp}] [${l.severity ?? "info"}] ${l.message}`);
}

export async function redeployService(): Promise<{ ok: boolean; deploymentId?: string; error?: string }> {
  const q = `mutation R($serviceId: String!, $environmentId: String!) {
    serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
  }`;
  try {
    const data = await rwQuery<{ serviceInstanceRedeploy: boolean | string }>(q, {
      serviceId: SERVICE_ID, environmentId: ENV_ID,
    });
    return { ok: true, deploymentId: typeof data.serviceInstanceRedeploy === "string" ? data.serviceInstanceRedeploy : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function restartService(): Promise<{ ok: boolean; error?: string }> {
  const q = `mutation R($serviceId: String!, $environmentId: String!) {
    serviceInstanceRestart(serviceId: $serviceId, environmentId: $environmentId)
  }`;
  try {
    await rwQuery(q, { serviceId: SERVICE_ID, environmentId: ENV_ID });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
