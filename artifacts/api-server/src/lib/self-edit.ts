/**
 * Self-edit — Tanit puede leer, escribir y desplegar su propio código.
 *
 * Luis: "Le vas a dar a tanit la capacidad de autoprogramarse. Lo único que
 * no tocará es todo lo que la haga funcional."
 *
 * Diseño:
 *  - Lista NEGRA dura: archivos que la harían no funcional (auth, db,
 *    build, kill switch, governance, agent core, este mismo archivo).
 *    Cualquier intento de tocarlos retorna error sin llegar a GitHub.
 *  - Lista BLANCA explícita: tools de Mastra, tesis, alertas, routes
 *    nuevas. Cualquier path bajo estos prefijos es editable.
 *  - Pushea a branch `tanit/self-edits` que tiene auto-deploy en Railway.
 *    Si el build falla, Railway mantiene el último deploy bueno arriba.
 *  - Cada commit/cambio queda en git history bajo author "Tanit (self-edit)"
 *    para distinguir de commits humanos.
 *
 * Requiere env vars:
 *  - GITHUB_TOKEN: PAT de Luis con scope `repo` para v-tan
 *  - GITHUB_REPO: ej "turbillon50/v-tan" (default)
 *  - SELF_EDIT_BRANCH: ej "tanit/self-edits" (default)
 */

const GH_API = "https://api.github.com";
const REPO = process.env.GITHUB_REPO ?? "turbillon50/v-tan";
const BRANCH = process.env.SELF_EDIT_BRANCH ?? "tanit/self-edits";
const TOKEN = process.env.GITHUB_TOKEN;

// ─── Whitelist / Blacklist ──────────────────────────────────────────────────

/** Paths que Tanit NO puede tocar bajo ninguna circunstancia. */
const BLACKLIST_EXACT = new Set<string>([
  // Su propia capacidad de auto-editar (no se desconecta sola)
  "artifacts/api-server/src/lib/self-edit.ts",
  "artifacts/api-server/src/mastra/tools/self-edit-tools.ts",
  // DevOps clients (controlan Railway/Vercel — no se autosabotea)
  "artifacts/api-server/src/lib/railway.ts",
  "artifacts/api-server/src/lib/vercel.ts",
  "artifacts/api-server/src/mastra/tools/devops-tools.ts",
  // El agent core (su esqueleto)
  "artifacts/api-server/src/mastra/agent-tanit.ts",
  "artifacts/api-server/src/mastra/index.ts",
  // Auth / dinero / freno
  "artifacts/api-server/src/lib/bybit-auth.ts",
  "artifacts/api-server/src/lib/api-keys-provider.ts",
  "artifacts/api-server/src/lib/governance.ts",
  "artifacts/api-server/src/lib/autonomy.ts",
  "artifacts/api-server/src/routes/admin.ts",
  // Persistencia BD / pool
  "artifacts/api-server/src/lib/db-persistence.ts",
  "artifacts/api-server/src/lib/logger.ts",
  // Entry point + build
  "artifacts/api-server/src/index.ts",
  "artifacts/api-server/src/server.ts",
  "artifacts/api-server/build.mjs",
  "artifacts/api-server/package.json",
  "artifacts/api-server/tsconfig.json",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "railway.json",
]);

/** Prefijos completos bloqueados. */
const BLACKLIST_PREFIX = [
  "lib/db/",
  ".env",
  ".github/",
  "node_modules/",
  ".next/",
  "dist/",
];

/** Prefijos donde Tanit SÍ puede crear/editar libremente. */
const WHITELIST_PREFIX = [
  "artifacts/api-server/src/mastra/tools/", // tools nuevas o existentes
  "artifacts/api-server/src/lib/tanit-",     // lib tanit-thesis, tanit-alerts, tanit-*
  "artifacts/api-server/src/routes/tanit",   // routes nuevas tanit-*
  "artifacts/api-server/src/prompts/",        // si decide modular prompts
  "docs/tanit/",                              // documentación propia
];

export interface PathCheckResult {
  allowed: boolean;
  reason: string | null;
}

export function checkPathAllowed(path: string): PathCheckResult {
  // Normaliza: quita barra inicial, slashes dobles
  const p = path.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!p || p === "/") return { allowed: false, reason: "Path vacío." };
  if (p.includes("..")) return { allowed: false, reason: "Path con `..` no permitido." };

  // Blacklist exacta
  if (BLACKLIST_EXACT.has(p)) {
    return { allowed: false, reason: `Archivo PROHIBIDO (te haría no funcional): ${p}` };
  }
  // Blacklist prefijo
  for (const pre of BLACKLIST_PREFIX) {
    if (p.startsWith(pre)) {
      return { allowed: false, reason: `Path bajo prefijo PROHIBIDO '${pre}': ${p}` };
    }
  }
  // Whitelist prefijo
  for (const pre of WHITELIST_PREFIX) {
    if (p.startsWith(pre)) return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: `Path '${p}' no está en whitelist. Permitidos: ${WHITELIST_PREFIX.join(", ")}`,
  };
}

// ─── GitHub API helpers ────────────────────────────────────────────────────

interface GhFileResponse {
  type: "file" | "dir" | "submodule" | "symlink";
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;       // base64, only when type=file
  encoding?: string;
}

function ghHeaders(): HeadersInit {
  if (!TOKEN) throw new Error("GITHUB_TOKEN no está configurado en env.");
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tanit-self-edit",
  };
}

/** Lee un archivo desde la rama de auto-edit (o main si no existe ahí). */
export async function readFileFromRepo(
  path: string
): Promise<{ ok: true; content: string; sha: string } | { ok: false; error: string }> {
  const check = checkPathAllowed(path);
  // Para LECTURA, sí se permite leer cualquier path (incluso blacklist) — Tanit
  // necesita estudiar el código existente para programar bien. La protección
  // está en la ESCRITURA. Ignoramos `check.allowed` aquí.
  void check;

  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${encodeURI(path)}?ref=${BRANCH}`, {
      headers: ghHeaders(),
    });
    if (r.status === 404) {
      // Intenta leer de main como fallback
      const r2 = await fetch(`${GH_API}/repos/${REPO}/contents/${encodeURI(path)}`, {
        headers: ghHeaders(),
      });
      if (!r2.ok) return { ok: false, error: `GitHub ${r2.status}: ${await r2.text()}` };
      const j = (await r2.json()) as GhFileResponse;
      if (j.type !== "file" || !j.content) return { ok: false, error: "No es un archivo." };
      return { ok: true, content: Buffer.from(j.content, "base64").toString("utf-8"), sha: j.sha };
    }
    if (!r.ok) return { ok: false, error: `GitHub ${r.status}: ${await r.text()}` };
    const j = (await r.json()) as GhFileResponse;
    if (j.type !== "file" || !j.content) return { ok: false, error: "No es un archivo." };
    return { ok: true, content: Buffer.from(j.content, "base64").toString("utf-8"), sha: j.sha };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Lista contenido de un directorio. */
export async function listDirFromRepo(
  dir: string
): Promise<{ ok: true; entries: Array<{ name: string; path: string; type: string }> } | { ok: false; error: string }> {
  const cleanDir = dir.replace(/^\/+/, "").replace(/\/+$/, "");
  try {
    const url = cleanDir
      ? `${GH_API}/repos/${REPO}/contents/${encodeURI(cleanDir)}?ref=${BRANCH}`
      : `${GH_API}/repos/${REPO}/contents?ref=${BRANCH}`;
    let r = await fetch(url, { headers: ghHeaders() });
    if (r.status === 404) {
      // fallback a main
      const url2 = cleanDir
        ? `${GH_API}/repos/${REPO}/contents/${encodeURI(cleanDir)}`
        : `${GH_API}/repos/${REPO}/contents`;
      r = await fetch(url2, { headers: ghHeaders() });
    }
    if (!r.ok) return { ok: false, error: `GitHub ${r.status}: ${await r.text()}` };
    const j = (await r.json()) as GhFileResponse[];
    if (!Array.isArray(j)) return { ok: false, error: "No es un directorio." };
    return {
      ok: true,
      entries: j.map((e) => ({ name: e.name, path: e.path, type: e.type })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Asegura que la rama de self-edit existe; si no, la crea desde main. */
async function ensureBranchExists(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/branches/${BRANCH}`, { headers: ghHeaders() });
    if (r.ok) return { ok: true };
    if (r.status !== 404) return { ok: false, error: `GitHub ${r.status}: ${await r.text()}` };
    // No existe — la creamos desde main
    const mainRef = await fetch(`${GH_API}/repos/${REPO}/git/ref/heads/main`, { headers: ghHeaders() });
    if (!mainRef.ok) return { ok: false, error: `No se pudo leer main: ${await mainRef.text()}` };
    const mainJson = await mainRef.json();
    const sha = mainJson?.object?.sha;
    if (!sha) return { ok: false, error: "main sin sha" };
    const create = await fetch(`${GH_API}/repos/${REPO}/git/refs`, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha }),
    });
    if (!create.ok) return { ok: false, error: `Crear branch falló: ${await create.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Escribe (crea o actualiza) un archivo en la rama de self-edit.
 * Esto YA dispara commit + push. El auto-deploy de Railway lo recoge.
 * El check de path se aplica AQUÍ — único punto de escritura.
 */
export async function writeFileToRepo(args: {
  path: string;
  content: string;
  message: string;
}): Promise<{ ok: true; sha: string; commitSha: string } | { ok: false; error: string }> {
  const check = checkPathAllowed(args.path);
  if (!check.allowed) {
    return { ok: false, error: `BLOQUEADO: ${check.reason}` };
  }

  const branchOk = await ensureBranchExists();
  if (!branchOk.ok) return { ok: false, error: branchOk.error ?? "branch no creada" };

  // Lee SHA actual si el archivo ya existe en la rama (para update)
  let currentSha: string | undefined;
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${encodeURI(args.path)}?ref=${BRANCH}`, {
      headers: ghHeaders(),
    });
    if (r.ok) {
      const j = (await r.json()) as GhFileResponse;
      currentSha = j.sha;
    }
  } catch {
    // existe / no existe — seguimos
  }

  try {
    const body: Record<string, unknown> = {
      message: `[tanit-self-edit] ${args.message}`,
      content: Buffer.from(args.content, "utf-8").toString("base64"),
      branch: BRANCH,
      committer: { name: "Tanit (self-edit)", email: "tanit@tanit.work" },
      author: { name: "Tanit (self-edit)", email: "tanit@tanit.work" },
    };
    if (currentSha) body.sha = currentSha;

    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${encodeURI(args.path)}`, {
      method: "PUT",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `GitHub ${r.status}: ${await r.text()}` };
    const j = await r.json();
    return {
      ok: true,
      sha: j.content?.sha ?? "",
      commitSha: j.commit?.sha ?? "",
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Crea un PR de self-edits → main (opcional, para revisión humana). */
export async function openPullRequestToMain(args: {
  title: string;
  body: string;
}): Promise<{ ok: true; url: string; number: number } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/pulls`, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `[tanit-self-edit] ${args.title}`,
        body: args.body,
        head: BRANCH,
        base: "main",
      }),
    });
    if (!r.ok) return { ok: false, error: `GitHub ${r.status}: ${await r.text()}` };
    const j = await r.json();
    return { ok: true, url: j.html_url, number: j.number };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
