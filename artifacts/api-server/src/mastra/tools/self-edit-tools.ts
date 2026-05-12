/**
 * Self-edit tools — Tanit modifica su propio código.
 *
 * Capacidades expuestas al agent:
 *  - leer_mi_codigo(path)        — lee cualquier archivo del repo
 *  - listar_mi_codigo(directorio) — explora estructura
 *  - escribir_mi_codigo(path, contenido, mensaje)
 *                                  → escribe + commit + push
 *                                  → dispara auto-deploy en Railway
 *  - abrir_pr_self_edit(titulo, descripcion)
 *                                  → opcional: PR a main para revisión humana
 *
 * Lista negra dura está en `lib/self-edit.ts` — Tanit NO puede editarla
 * ni puede editar archivos que la harían no funcional (auth, db, build,
 * agent core, este mismo archivo, kill switch, governance).
 *
 * Cualquier intento de escritura sobre path bloqueado retorna error
 * inmediato sin tocar GitHub.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";
import {
  readFileFromRepo,
  listDirFromRepo,
  writeFileToRepo,
  openPullRequestToMain,
  checkPathAllowed,
} from "../../lib/self-edit";

async function persistSelfEdit(args: {
  action: string;
  path: string | null;
  ok: boolean;
  detail: string;
  thesis: string | null;
}): Promise<number | null> {
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO tanit_decisions
         (decision_type, symbol, context, verdict, thesis, executed, execution_error, model_used)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, 'tanit-self-edit')
       RETURNING id`,
      [
        `self_edit_${args.action}`,
        JSON.stringify({ path: args.path, detail: args.detail }),
        args.ok ? "executed" : "rejected",
        args.thesis,
        args.ok,
        args.ok ? null : args.detail,
      ],
    );
    return r.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ─── LEER CÓDIGO ─────────────────────────────────────────────────────────────

export const leerMiCodigo = createTool({
  id: "leer_mi_codigo",
  description:
    "Lee un archivo cualquiera de tu propio código fuente (repo v-tan). Úsalo para estudiar cómo está implementada una tool antes de modificarla, o para entender un módulo. Path relativo desde la raíz del repo, ej: 'artifacts/api-server/src/mastra/tools/bybit-write-tools.ts'.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path relativo del archivo en el repo."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    path: z.string(),
    content: z.string().nullable(),
    sha: z.string().nullable(),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    const path = String(ctx.path);
    const r = await readFileFromRepo(path);
    if (!r.ok) {
      return { ok: false, path, content: null, sha: null, error: r.error };
    }
    return { ok: true, path, content: r.content, sha: r.sha, error: null };
  },
});

// ─── LISTAR DIRECTORIO ──────────────────────────────────────────────────────

export const listarMiCodigo = createTool({
  id: "listar_mi_codigo",
  description:
    "Lista archivos y subdirectorios en un directorio del repo. Úsalo para explorar dónde están los tools, qué hay en mastra/, etc. Vacío = raíz del repo.",
  inputSchema: z.object({
    directorio: z.string().describe("Path del directorio. Vacío para raíz."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    directorio: z.string(),
    entries: z.array(z.object({
      name: z.string(),
      path: z.string(),
      type: z.string(),
    })),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    const dir = String(ctx.directorio ?? "");
    const r = await listDirFromRepo(dir);
    if (!r.ok) return { ok: false, directorio: dir, entries: [], error: r.error };
    return { ok: true, directorio: dir, entries: r.entries, error: null };
  },
});

// ─── ESCRIBIR (commit + push + auto-deploy) ─────────────────────────────────

export const escribirMiCodigo = createTool({
  id: "escribir_mi_codigo",
  description:
    "Escribe (crea o reemplaza) un archivo en tu repo. Hace commit + push automático a la rama 'tanit/self-edits' que tiene auto-deploy en Railway. ⚠️ HAY LISTA NEGRA: NO puedes tocar archivos que te harían no funcional (auth, db, build, agent core, governance, kill switch, este archivo). Si intentas, recibes error sin tocar nada. La whitelist permite mastra/tools/, lib/tanit-*, routes/tanit*, prompts/, docs/tanit/. SIEMPRE lee_mi_codigo el archivo antes de reescribir para no perder código.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path relativo desde raíz del repo."),
    contenido: z.string().min(1).describe("Contenido completo del archivo (no diff). Si modificas, incluye el archivo entero."),
    mensaje_commit: z.string().min(5).describe("Mensaje del commit en presente: 'agrega tool X', 'corrige bug Y', etc."),
    razon: z.string().min(10).describe("Por qué haces este cambio. Cita la tesis o el contexto."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    path: z.string(),
    commitSha: z.string().nullable(),
    deployTriggered: z.boolean(),
    error: z.string().nullable(),
    decisionId: z.number().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    const path = String(ctx.path);
    const contenido = String(ctx.contenido);
    const mensaje = String(ctx.mensaje_commit);
    const razon = String(ctx.razon);

    // Pre-check antes de tocar GitHub
    const check = checkPathAllowed(path);
    if (!check.allowed) {
      const decisionId = await persistSelfEdit({
        action: "write",
        path,
        ok: false,
        detail: check.reason ?? "blacklist",
        thesis: razon,
      });
      return { ok: false, path, commitSha: null, deployTriggered: false, error: check.reason, decisionId };
    }

    const r = await writeFileToRepo({ path, content: contenido, message: mensaje });
    if (!r.ok) {
      const decisionId = await persistSelfEdit({
        action: "write",
        path,
        ok: false,
        detail: r.error,
        thesis: razon,
      });
      return { ok: false, path, commitSha: null, deployTriggered: false, error: r.error, decisionId };
    }
    const decisionId = await persistSelfEdit({
      action: "write",
      path,
      ok: true,
      detail: `commit ${r.commitSha} en branch tanit/self-edits`,
      thesis: razon,
    });
    return {
      ok: true,
      path,
      commitSha: r.commitSha,
      deployTriggered: true,
      error: null,
      decisionId,
    };
  },
});

// ─── ABRIR PR (opcional: revisión humana) ───────────────────────────────────

export const abrirPrSelfEdit = createTool({
  id: "abrir_pr_self_edit",
  description:
    "Abre un PR de tu rama 'tanit/self-edits' hacia main. Úsalo cuando quieres que Luis revise antes de mergear, o cuando un cambio acumulado merece consolidarse. NO es obligatorio — los pushes a la rama de self-edit ya se deployan solos.",
  inputSchema: z.object({
    titulo: z.string().min(5),
    descripcion: z.string().min(10),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    url: z.string().nullable(),
    numero: z.number().nullable(),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput as any)?.context ?? rawInput as any;
    const r = await openPullRequestToMain({
      title: String(ctx.titulo),
      body: String(ctx.descripcion),
    });
    if (!r.ok) return { ok: false, url: null, numero: null, error: r.error };
    return { ok: true, url: r.url, numero: r.number, error: null };
  },
});

export const selfEditTools = {
  leerMiCodigo,
  listarMiCodigo,
  escribirMiCodigo,
  abrirPrSelfEdit,
};
