/**
 * DevOps tools — Tanit ve y maneja sus propios deploys (Railway + Vercel).
 *
 * Para auto-programación efectiva: cuando se reescribe a sí misma con
 * `escribir_mi_codigo`, el push dispara redeploy en Railway. Estos tools
 * le permiten:
 *  - confirmar que el deploy salió OK (`consultar_mis_deploys_railway`)
 *  - leer logs si algo falla (`ver_mis_logs_railway`)
 *  - forzar redeploy si es necesario (`redeploy_yo_misma`)
 *  - revisar el estado del frontend Vercel (`consultar_mi_frontend_vercel`)
 *
 * NO tiene tool para REINICIAR el servicio (sería suicidio si está en medio
 * de una conversación) ni para cambiar variables de entorno (las maneja Luis).
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  listDeployments,
  getDeploymentLogs,
  redeployService,
} from "../../lib/railway";
import {
  listVercelDeployments,
  getVercelDeployment,
  getVercelDeploymentEvents,
} from "../../lib/vercel";

// ─── RAILWAY ─────────────────────────────────────────────────────────────────

export const consultarMisDeploysRailway = createTool({
  id: "consultar_mis_deploys_railway",
  description:
    "Lista los últimos deploys del backend (api.tanit.work) en Railway con su status. Úsalo después de un escribir_mi_codigo para confirmar que el deploy salió bien (status=SUCCESS) o falló (FAILED/CRASHED). También para ver qué versión está activa.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).describe("Cuántos deploys traer."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    deployments: z.array(z.object({
      id: z.string(),
      status: z.string(),
      url: z.string().nullable(),
      createdAt: z.string(),
    })),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    const limit = Number(ctx.limit ?? 10);
    try {
      const deps = await listDeployments(limit);
      return {
        ok: true,
        deployments: deps.map((d) => ({
          id: d.id, status: d.status, url: d.staticUrl, createdAt: d.createdAt,
        })),
        error: null,
      };
    } catch (e) {
      return { ok: false, deployments: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const verMisLogsRailway = createTool({
  id: "ver_mis_logs_railway",
  description:
    "Lee las últimas N líneas de logs de un deployment específico de Railway. Si NO sabes el deployment ID, primero llama consultar_mis_deploys_railway para verlos. Útil después de un deploy fallido o cuando algo no funciona en producción.",
  inputSchema: z.object({
    deployment_id: z.string().min(8).describe("ID del deployment de Railway."),
    lines: z.number().int().min(10).max(1000).describe("Cuántas líneas de log traer."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    logs: z.array(z.string()),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    try {
      const logs = await getDeploymentLogs(String(ctx.deployment_id), Number(ctx.lines ?? 200));
      return { ok: true, logs, error: null };
    } catch (e) {
      return { ok: false, logs: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const redeployYoMisma = createTool({
  id: "redeploy_yo_misma",
  description:
    "Fuerza un redeploy del backend Tanit en Railway (re-buildea + reinicia el servicio). Úsalo SOLO cuando hayas confirmado que el último deploy falló o cuando necesites refrescar variables de entorno nuevas. ⚠️ Esto INTERRUMPE momentáneamente la conversación contigo mientras se reinicia.",
  inputSchema: z.object({
    razon: z.string().min(10).describe("Por qué necesitas redeploy ahora."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    deploymentId: z.string().nullable(),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    void ctx;
    const r = await redeployService();
    return { ok: r.ok, deploymentId: r.deploymentId ?? null, error: r.error ?? null };
  },
});

// ─── VERCEL ──────────────────────────────────────────────────────────────────

export const consultarMiFrontendVercel = createTool({
  id: "consultar_mi_frontend_vercel",
  description:
    "Lista los últimos deploys del frontend en Vercel (tanit.work). Úsalo cuando Luis te diga 'la app no carga' o cuando hayas pedido un cambio en el frontend y quieras confirmar que el deploy nuevo está READY (vs BUILDING, ERROR, CANCELED).",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).describe("Cuántos deploys traer."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    deployments: z.array(z.object({
      uid: z.string(),
      url: z.string(),
      state: z.string(),
      createdAt: z.number(),
    })),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    try {
      const deps = await listVercelDeployments(Number(ctx.limit ?? 10));
      return {
        ok: true,
        deployments: deps.map((d) => ({
          uid: d.uid, url: d.url, state: d.state, createdAt: d.createdAt,
        })),
        error: null,
      };
    } catch (e) {
      return { ok: false, deployments: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const verLogsFrontendVercel = createTool({
  id: "ver_logs_frontend_vercel",
  description:
    "Lee los logs de build/runtime de un deployment de Vercel. Si no sabes el UID, primero consultar_mi_frontend_vercel. Útil cuando un deploy de frontend falla y quieres saber por qué.",
  inputSchema: z.object({
    uid: z.string().min(8).describe("UID del deployment Vercel."),
    lines: z.number().int().min(10).max(1000),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    state: z.string().nullable(),
    logs: z.array(z.string()),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    try {
      const dep = await getVercelDeployment(String(ctx.uid));
      const logs = await getVercelDeploymentEvents(String(ctx.uid), Number(ctx.lines ?? 200));
      return { ok: true, state: dep.state, logs, error: dep.error ?? null };
    } catch (e) {
      return { ok: false, state: null, logs: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const devopsTools = {
  consultarMisDeploysRailway,
  verMisLogsRailway,
  redeployYoMisma,
  consultarMiFrontendVercel,
  verLogsFrontendVercel,
};
