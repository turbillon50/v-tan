import { pool } from "@workspace/db";
import { decryptKey, encryptKey, maskKey } from "./crypto-keys";

const TAG = "[api-keys]";

export type Provider =
  | "bybit_key"
  | "bybit_secret"
  | "anthropic"
  | "openai"
  | "gemini"
  | "perplexity"
  | "proxy_secret";

const ENV_FALLBACK: Record<Provider, string[]> = {
  bybit_key:    ["BYBIT_API_KEY"],
  bybit_secret: ["BYBIT_API_SECRET"],
  anthropic:    ["ANTHROPIC_API_KEY"],
  openai:       ["OPENAI_API_KEY"],
  gemini:       ["GEMINI_API_KEY", "AI_INTEGRATIONS_GEMINI_API_KEY"],
  perplexity:   ["PERPLEXITY_API_KEY"],
  proxy_secret: ["PROXY_SECRET"],
};

const ALL_PROVIDERS: Provider[] = [
  "bybit_key", "bybit_secret", "anthropic", "openai", "gemini", "perplexity", "proxy_secret",
];

type KeyRow = {
  provider: string;
  encrypted: string;
  active: boolean;
  note: string | null;
  rotation_count: number;
  last_rotated_at: Date | null;
  updated_at: Date;
};

type CacheEntry = { value: string; active: boolean; cachedAt: number };
const _cache: Record<string, CacheEntry> = {};
const CACHE_TTL_MS = 30_000;

let _tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tanit_api_keys (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      encrypted TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      note TEXT,
      rotation_count INTEGER NOT NULL DEFAULT 0,
      last_rotated_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  _tableEnsured = true;
}

// Boot migration: si la tabla está vacía, copia las env vars actuales a la DB.
// Idempotente — solo migra si no hay filas.
export async function migrateEnvKeysIfEmpty(): Promise<{ migrated: number; skipped: number }> {
  await ensureTable();
  const r = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM tanit_api_keys");
  const existing = parseInt(r.rows[0]?.count ?? "0", 10);
  if (existing > 0) {
    console.log(TAG, `migración omitida: ya hay ${existing} llaves en DB`);
    return { migrated: 0, skipped: existing };
  }
  let migrated = 0;
  for (const provider of ALL_PROVIDERS) {
    const envNames = ENV_FALLBACK[provider];
    let value: string | undefined;
    for (const name of envNames) {
      if (process.env[name]) { value = process.env[name]; break; }
    }
    if (!value) {
      console.log(TAG, `migración: ${provider} sin env var → omitido`);
      continue;
    }
    const enc = encryptKey(value);
    await pool.query(
      `INSERT INTO tanit_api_keys(provider, encrypted, active, note)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (provider) DO NOTHING`,
      [provider, enc, "Migrado automáticamente desde env vars al boot"]
    );
    migrated++;
    console.log(TAG, `migrado ${provider}=${maskKey(value)} desde env`);
  }
  return { migrated, skipped: 0 };
}

export async function getKey(provider: Provider): Promise<string | null> {
  const cached = _cache[provider];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.active ? cached.value : null;
  }
  await ensureTable();
  const r = await pool.query<KeyRow>(
    "SELECT provider, encrypted, active, note, rotation_count, last_rotated_at, updated_at FROM tanit_api_keys WHERE provider = $1",
    [provider]
  );
  const row = r.rows[0];
  if (row) {
    try {
      const value = decryptKey(row.encrypted);
      _cache[provider] = { value, active: row.active, cachedAt: Date.now() };
      return row.active ? value : null;
    } catch (e: any) {
      console.error(TAG, `decrypt falló para ${provider}: ${e?.message ?? e}`);
    }
  }
  // Fallback a env si la DB no tiene la llave
  for (const envName of ENV_FALLBACK[provider]) {
    if (process.env[envName]) return process.env[envName] ?? null;
  }
  return null;
}

export function invalidateCache(provider?: Provider): void {
  if (provider) delete _cache[provider];
  else for (const k of Object.keys(_cache)) delete _cache[k];
}

export type ApiKeyStatus = {
  provider: Provider;
  configured: boolean;
  active: boolean;
  source: "db" | "env" | "missing";
  masked: string;
  rotationCount: number;
  lastRotatedAt: string | null;
  note: string | null;
};

export async function listApiKeys(): Promise<ApiKeyStatus[]> {
  await ensureTable();
  const r = await pool.query<KeyRow>(
    "SELECT provider, encrypted, active, note, rotation_count, last_rotated_at, updated_at FROM tanit_api_keys"
  );
  const dbMap = new Map<string, KeyRow>();
  for (const row of r.rows) dbMap.set(row.provider, row);

  const out: ApiKeyStatus[] = [];
  for (const provider of ALL_PROVIDERS) {
    const row = dbMap.get(provider);
    if (row) {
      let masked = "(no descifrable)";
      try { masked = maskKey(decryptKey(row.encrypted)); } catch {}
      out.push({
        provider,
        configured: true,
        active: row.active,
        source: "db",
        masked,
        rotationCount: row.rotation_count,
        lastRotatedAt: row.last_rotated_at ? row.last_rotated_at.toISOString() : null,
        note: row.note,
      });
      continue;
    }
    let envValue: string | undefined;
    for (const envName of ENV_FALLBACK[provider]) {
      if (process.env[envName]) { envValue = process.env[envName]; break; }
    }
    out.push({
      provider,
      configured: !!envValue,
      active: !!envValue,
      source: envValue ? "env" : "missing",
      masked: envValue ? maskKey(envValue) : "(no configurada)",
      rotationCount: 0,
      lastRotatedAt: null,
      note: envValue ? "Solo en env vars — aún no migrada a DB" : null,
    });
  }
  return out;
}

export async function setApiKey(
  provider: Provider, value: string, note?: string
): Promise<{ rotated: boolean; rotationCount: number }> {
  await ensureTable();
  const enc = encryptKey(value);
  const r = await pool.query<{ rotation_count: number }>(
    `INSERT INTO tanit_api_keys(provider, encrypted, active, note, last_rotated_at)
     VALUES ($1, $2, TRUE, $3, NOW())
     ON CONFLICT (provider) DO UPDATE
       SET encrypted = EXCLUDED.encrypted,
           active = TRUE,
           note = EXCLUDED.note,
           rotation_count = tanit_api_keys.rotation_count + 1,
           last_rotated_at = NOW(),
           updated_at = NOW()
     RETURNING rotation_count`,
    [provider, enc, note ?? null]
  );
  invalidateCache(provider);
  const rotationCount = r.rows[0]?.rotation_count ?? 0;
  console.log(TAG, `setApiKey ${provider}=${maskKey(value)} rotationCount=${rotationCount}`);
  return { rotated: rotationCount > 0, rotationCount };
}

export async function setActive(provider: Provider, active: boolean, note?: string): Promise<boolean> {
  await ensureTable();
  const r = await pool.query(
    `UPDATE tanit_api_keys
       SET active = $2, note = COALESCE($3, note), updated_at = NOW()
     WHERE provider = $1`,
    [provider, active, note ?? null]
  );
  invalidateCache(provider);
  console.log(TAG, `setActive ${provider}=${active}`);
  return (r.rowCount ?? 0) > 0;
}

export async function exportAllDecrypted(): Promise<Record<string, string | null>> {
  await ensureTable();
  const r = await pool.query<KeyRow>("SELECT provider, encrypted FROM tanit_api_keys");
  const out: Record<string, string | null> = {};
  for (const row of r.rows) {
    try { out[row.provider] = decryptKey(row.encrypted); }
    catch { out[row.provider] = null; }
  }
  return out;
}
