import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

// AES-256-GCM con master key derivada por scrypt.
// Formato: base64(iv(12) || tag(16) || ciphertext)
// Si TANIT_MASTER_KEY no está configurada, usa una clave por defecto débil
// (solo para desarrollo) — en producción es OBLIGATORIA.

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT = Buffer.from("tanit-master-salt-v1", "utf8"); // estática: scrypt + same input = same key

let _derivedKey: Buffer | null = null;
// PR #40 — Master key auto-derivada del entorno.
// Prioridad: TANIT_MASTER_KEY explícita → DATABASE_URL (estable y secreto en
// Railway/Neon) → POSTGRES_URL → fallback dev. No requiere setup manual:
// si tienes DB configurada (que la tienes), la master key existe.
// Si rotas DATABASE_URL, las llaves quedan ilegibles — vuelves a migrar
// poniendo las env vars originales y el boot reescribe la tabla.
function pickMaterial(): { source: string; value: string } {
  const explicit = process.env.TANIT_MASTER_KEY;
  if (explicit && explicit.length >= 16) return { source: "TANIT_MASTER_KEY", value: explicit };
  const db = process.env.DATABASE_URL;
  if (db && db.length >= 32) return { source: "DATABASE_URL-derived", value: db };
  const pg = process.env.POSTGRES_URL;
  if (pg && pg.length >= 32) return { source: "POSTGRES_URL-derived", value: pg };
  const neon = process.env.NEON_DATABASE_URL;
  if (neon && neon.length >= 32) return { source: "NEON_DATABASE_URL-derived", value: neon };
  return { source: "DEV_FALLBACK", value: "tanit-dev-fallback-master-INSEGURO" };
}

function getMasterKey(): Buffer {
  if (_derivedKey) return _derivedKey;
  const { source, value } = pickMaterial();
  if (source === "DEV_FALLBACK" && process.env.NODE_ENV === "production") {
    throw new Error("Master key indisponible: ni TANIT_MASTER_KEY ni DATABASE_URL/POSTGRES_URL/NEON_DATABASE_URL configurados");
  }
  if (source === "DEV_FALLBACK") {
    console.warn("[crypto-keys] Usando fallback dev (INSEGURO) — sin DATABASE_URL ni TANIT_MASTER_KEY");
  } else {
    console.log(`[crypto-keys] Master key derivada de ${source}`);
  }
  _derivedKey = scryptSync(value, SALT, KEY_LEN);
  return _derivedKey;
}

export function encryptKey(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptKey(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error("Payload cifrado inválido (muy corto)");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

// Mostrar solo las últimas 4 caracteres de una llave para logging seguro
export function maskKey(key: string): string {
  if (!key) return "(vacío)";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
