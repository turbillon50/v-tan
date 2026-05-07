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
function getMasterKey(): Buffer {
  if (_derivedKey) return _derivedKey;
  const masterStr = process.env.TANIT_MASTER_KEY;
  if (!masterStr || masterStr.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TANIT_MASTER_KEY no configurada — requerida en producción para descifrar llaves");
    }
    // Fallback dev-only (no usar en producción)
    console.warn("[crypto-keys] TANIT_MASTER_KEY ausente, usando fallback dev (INSEGURO)");
    _derivedKey = scryptSync("tanit-dev-fallback-master", SALT, KEY_LEN);
    return _derivedKey;
  }
  _derivedKey = scryptSync(masterStr, SALT, KEY_LEN);
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
