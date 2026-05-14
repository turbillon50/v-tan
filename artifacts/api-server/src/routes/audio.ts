/**
 * Endpoints de audio + imagen — TODO via Gemini (un solo vendor, una sola key).
 *
 *  - POST /audio/transcribe — audio base64 → texto (Gemini 2.5 Flash multimodal)
 *  - POST /audio/synthesize — texto → WAV (Gemini 2.5 Flash TTS, voz "Kore")
 *  - POST /image/generate   — prompt → PNG (Gemini 2.5 Flash Image, "nano banana")
 *
 * Antes /audio/transcribe usaba Whisper y /audio/synthesize usaba TTS-1 de
 * OpenAI. Cuando se agotó la cuota de OpenAI la voz dejó de funcionar.
 * Ahora todo va por Gemini con OpenAI como fallback opcional para Whisper
 * (porque la calidad de Whisper sigue siendo top — pero solo si hay saldo).
 *
 * Variables: GEMINI_API_KEY (obligatorio); OPENAI_API_KEY (opcional, fallback).
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

// Asegura la tabla de galería existe. Idempotente. Se ejecuta al primer
// request — más simple que migrations para 1 tabla.
let galleryTableEnsured = false;
async function ensureGalleryTable(): Promise<void> {
  if (galleryTableEnsured) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tanit_generated_images (
        id BIGSERIAL PRIMARY KEY,
        prompt TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/png',
        image_base64 TEXT NOT NULL,
        size_bytes INTEGER,
        provider TEXT,
        resource_id TEXT DEFAULT 'luis',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_tanit_generated_images_created_at
         ON tanit_generated_images (created_at DESC)`,
    );
    galleryTableEnsured = true;
  } catch (e) {
    logger.warn({ err: e }, "[image] no se pudo crear tabla tanit_generated_images");
  }
}

const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const OPENAI_API_KEY = process.env["OPENAI_API_KEY"];
const OPENROUTER_API_KEY = process.env["OPENROUTER_API_KEY"];
if (!GEMINI_API_KEY && !OPENROUTER_API_KEY) {
  logger.warn("[audio] ni GEMINI_API_KEY ni OPENROUTER_API_KEY definidas — voz e imagen no funcionarán.");
} else if (!GEMINI_API_KEY) {
  logger.warn("[audio] GEMINI_API_KEY no definida — usando OpenRouter como proveedor de voz.");
}

/**
 * Construye un header WAV PCM lineal 16-bit mono. Gemini TTS devuelve
 * audio crudo PCM (mimeType "audio/L16;rate=24000"); el browser no puede
 * reproducir eso directo, así que le pegamos el header WAV de 44 bytes.
 */
function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** Extrae sampleRate de un mimeType tipo "audio/L16;rate=24000". */
function sampleRateFromMime(mime: string, fallback = 24000): number {
  const m = mime.match(/rate=(\d+)/);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

// ─── POST /audio/transcribe ─────────────────────────────────────────────────
// Body: { audio_base64: string, mimeType?: string }
// Devuelve: { ok: true, text: string, provider: 'gemini'|'openai' }
//
// Estrategia: Gemini multimodal primero (más barato, audio nativo). Si Gemini
// falla y hay OPENAI_API_KEY con saldo, fallback a Whisper.
router.post("/audio/transcribe", async (req, res): Promise<void> => {
  try {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.startsWith("application/json")) {
      res.status(400).json({
        ok: false,
        error: "Content-Type debe ser application/json con audio_base64",
      });
      return;
    }
    const body = (req.body ?? {}) as { audio_base64?: string; mimeType?: string };
    if (!body.audio_base64) {
      res.status(400).json({ ok: false, error: "audio_base64 requerido" });
      return;
    }
    const audioBuffer = Buffer.from(body.audio_base64, "base64");
    const mimeType = body.mimeType ?? "audio/webm";
    if (audioBuffer.length === 0) {
      res.status(400).json({ ok: false, error: "audio vacío" });
      return;
    }
    if (audioBuffer.length > 20 * 1024 * 1024) {
      res.status(413).json({ ok: false, error: "audio > 20MB" });
      return;
    }

    // 1) Intento Gemini 2.5 Flash multimodal con audio inline
    if (GEMINI_API_KEY) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: "Transcribe el siguiente audio al español tal y como lo escuches. Devuelve SOLO el texto transcrito, sin comillas, sin notas, sin explicaciones, sin signos extra.",
                    },
                    {
                      inline_data: {
                        mime_type: mimeType,
                        data: body.audio_base64,
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 2048,
              },
            }),
          },
        );
        if (r.ok) {
          const j = (await r.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const parts = j.candidates?.[0]?.content?.parts ?? [];
          const text = parts
            .map((p) => p.text ?? "")
            .join("")
            .trim();
          if (text) {
            res.json({ ok: true, text, provider: "gemini" });
            return;
          }
          logger.warn("[audio] gemini transcribe vacío, intento fallback");
        } else {
          const errTxt = await r.text().catch(() => "");
          logger.warn(
            { status: r.status, errTxt: errTxt.slice(0, 300) },
            "[audio] gemini transcribe failed",
          );
        }
      } catch (e) {
        logger.warn({ err: e }, "[audio] gemini transcribe threw, intento fallback");
      }
    }

    // 2) Fallback OpenRouter → whisper-1 (cuota independiente de Gemini y OpenAI directo)
    if (OPENROUTER_API_KEY) {
      try {
        const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : "mp3";
        const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
        const form = new FormData();
        form.append("file", blob, `audio.${ext}`);
        form.append("model", "openai/whisper-1");
        form.append("language", "es");
        form.append("response_format", "json");

        const r = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
          body: form,
        });
        if (r.ok) {
          const data = (await r.json()) as { text?: string };
          if (data.text) {
            res.json({ ok: true, text: data.text, provider: "openrouter" });
            return;
          }
        }
        const errTxt = await r.text().catch(() => "");
        logger.warn(
          { status: r.status, errTxt: errTxt.slice(0, 300) },
          "[audio] openrouter transcribe fallback failed",
        );
      } catch (e) {
        logger.warn({ err: e }, "[audio] openrouter transcribe threw, intento OpenAI directo");
      }
    }

    // 3) Fallback OpenAI Whisper directo (sólo si la cuenta tiene saldo)
    if (OPENAI_API_KEY) {
      try {
        const form = new FormData();
        const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : "mp3";
        const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
        form.append("file", blob, `audio.${ext}`);
        form.append("model", "whisper-1");
        form.append("language", "es");
        form.append("response_format", "json");

        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: form,
        });
        if (r.ok) {
          const data = (await r.json()) as { text?: string };
          res.json({ ok: true, text: data.text ?? "", provider: "openai" });
          return;
        }
        const errTxt = await r.text().catch(() => "");
        logger.warn(
          { status: r.status, errTxt: errTxt.slice(0, 300) },
          "[audio] whisper fallback failed",
        );
      } catch (e) {
        logger.warn({ err: e }, "[audio] whisper fallback threw");
      }
    }

    res.status(502).json({
      ok: false,
      error:
        GEMINI_API_KEY || OPENROUTER_API_KEY
          ? "Todos los proveedores de transcripción fallaron (Gemini, OpenRouter, OpenAI)"
          : "Sin API keys configuradas (GEMINI_API_KEY u OPENROUTER_API_KEY requerida)",
    });
  } catch (e) {
    logger.error({ err: e }, "[audio] transcribe error");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── POST /audio/synthesize ─────────────────────────────────────────────────
// Body: { text: string, voice?: 'Kore'|'Puck'|'Charon'|'Fenrir'|... }
// Devuelve: audio/wav binario (Gemini TTS devuelve PCM L16 24kHz, lo
// envolvemos en WAV para que el browser lo reproduzca directo con <audio>).
router.post("/audio/synthesize", async (req, res): Promise<void> => {
  try {
    const body = (req.body ?? {}) as { text?: string; voice?: string };
    const text = (body.text ?? "").trim();
    if (!text) {
      res.status(400).json({ ok: false, error: "text requerido" });
      return;
    }
    if (text.length > 4096) {
      res.status(413).json({ ok: false, error: "text > 4096 chars" });
      return;
    }

    // Voces Gemini: Kore (femenina cálida), Puck, Charon, Fenrir, Aoede, Leda…
    // Mapeo retrocompatible: si el cliente manda 'nova' (OpenAI), traducimos.
    const voiceMap: Record<string, string> = {
      nova: "Kore",
      shimmer: "Aoede",
      fable: "Leda",
      alloy: "Puck",
      echo: "Charon",
      onyx: "Fenrir",
    };
    const voiceInput = (body.voice ?? "Kore").trim();
    const safeVoice = voiceMap[voiceInput.toLowerCase()] ?? voiceInput;

    if (GEMINI_API_KEY) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: safeVoice },
                  },
                },
              },
            }),
          },
        );
        if (r.ok) {
          const j = (await r.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
              };
            }>;
          };
          const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
          const dataB64 = part?.inlineData?.data;
          const mime = part?.inlineData?.mimeType ?? "audio/L16;rate=24000";
          if (dataB64) {
            const pcm = Buffer.from(dataB64, "base64");
            const wav = pcmToWav(pcm, sampleRateFromMime(mime), 1, 16);
            res.setHeader("Content-Type", "audio/wav");
            res.setHeader("Content-Length", String(wav.length));
            res.setHeader("Cache-Control", "private, max-age=3600");
            res.setHeader("X-TTS-Provider", "gemini");
            res.send(wav);
            return;
          }
          logger.warn("[audio] gemini tts vacío, intento fallback OpenAI");
        } else {
          const errTxt = await r.text().catch(() => "");
          logger.warn(
            { status: r.status, errTxt: errTxt.slice(0, 300) },
            "[audio] gemini tts failed",
          );
        }
      } catch (e) {
        logger.warn({ err: e }, "[audio] gemini tts threw, fallback");
      }
    }

    // Fallback OpenRouter TTS (cuota independiente de Gemini y OpenAI directo)
    if (OPENROUTER_API_KEY) {
      try {
        const orVoice = voiceMap[voiceInput.toLowerCase()] ? voiceInput.toLowerCase() : "nova";
        const r = await fetch("https://openrouter.ai/api/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/tts-1",
            voice: orVoice,
            input: text,
            response_format: "mp3",
            speed: 1.0,
          }),
        });
        if (r.ok) {
          const arrayBuffer = await r.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Length", String(buffer.length));
          res.setHeader("Cache-Control", "private, max-age=3600");
          res.setHeader("X-TTS-Provider", "openrouter");
          res.send(buffer);
          return;
        }
        const errTxt = await r.text().catch(() => "");
        logger.warn(
          { status: r.status, errTxt: errTxt.slice(0, 300) },
          "[audio] openrouter tts fallback failed",
        );
      } catch (e) {
        logger.warn({ err: e }, "[audio] openrouter tts fallback threw");
      }
    }

    // Fallback OpenAI TTS-1 directo (si hay saldo)
    if (OPENAI_API_KEY) {
      try {
        const r = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "tts-1",
            voice: "nova",
            input: text,
            response_format: "mp3",
            speed: 1.0,
          }),
        });
        if (r.ok) {
          const arrayBuffer = await r.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Length", String(buffer.length));
          res.setHeader("Cache-Control", "private, max-age=3600");
          res.setHeader("X-TTS-Provider", "openai");
          res.send(buffer);
          return;
        }
      } catch (e) {
        logger.warn({ err: e }, "[audio] openai tts fallback threw");
      }
    }

    res.status(502).json({
      ok: false,
      error:
        GEMINI_API_KEY || OPENROUTER_API_KEY
          ? "Todos los proveedores TTS fallaron (Gemini, OpenRouter, OpenAI)"
          : "Sin API keys configuradas (GEMINI_API_KEY u OPENROUTER_API_KEY requerida)",
    });
  } catch (e) {
    logger.error({ err: e }, "[audio] synthesize error");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── POST /image/generate ───────────────────────────────────────────────────
// Body: { prompt: string }
// Devuelve: image/png binario generado con Imagen 3 vía Gemini API.
//
// Probamos en cascada los modelos de imagen disponibles. En mayo 2026:
//   1) imagen-3.0-generate-002 (endpoint :predict)
//   2) imagen-3.0-generate-001 (endpoint :predict)
//   3) gemini-2.0-flash-exp con responseModalities [TEXT,IMAGE] (preview)
// Devolvemos la primera que funcione. Esto inmuniza contra renames del
// catálogo de modelos de Google.
router.post("/image/generate", async (req, res): Promise<void> => {
  if (!GEMINI_API_KEY) {
    res.status(500).json({ ok: false, error: "GEMINI_API_KEY no configurada" });
    return;
  }
  try {
    await ensureGalleryTable();
    const body = (req.body ?? {}) as { prompt?: string };
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      res.status(400).json({ ok: false, error: "prompt requerido" });
      return;
    }
    if (prompt.length > 2000) {
      res.status(413).json({ ok: false, error: "prompt > 2000 chars" });
      return;
    }

    const errors: string[] = [];

    // Helper: persiste la imagen exitosa en BD antes de devolverla al client.
    const persistAndSend = async (
      buffer: Buffer,
      mime: string,
      provider: string,
    ): Promise<void> => {
      try {
        await pool.query(
          `INSERT INTO tanit_generated_images
            (prompt, mime_type, image_base64, size_bytes, provider, resource_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            prompt,
            mime,
            buffer.toString("base64"),
            buffer.length,
            provider,
            "luis",
          ],
        );
      } catch (e) {
        logger.warn({ err: e }, "[image] no se pudo persistir imagen");
      }
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("X-Image-Provider", provider);
      res.send(buffer);
    };

    // 1) Imagen 4 (endpoint :predict)
    for (const model of [
      "imagen-4.0-fast-generate-001",
      "imagen-4.0-generate-001",
      "imagen-4.0-ultra-generate-001",
    ]) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instances: [{ prompt }],
              parameters: { sampleCount: 1, aspectRatio: "1:1" },
            }),
          },
        );
        if (r.ok) {
          const j = (await r.json()) as {
            predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
          };
          const pred = j.predictions?.[0];
          const dataB64 = pred?.bytesBase64Encoded;
          const mime = pred?.mimeType ?? "image/png";
          if (dataB64) {
            const buffer = Buffer.from(dataB64, "base64");
            await persistAndSend(buffer, mime, `gemini:${model}`);
            return;
          }
        } else {
          const errTxt = await r.text().catch(() => "");
          errors.push(`${model}: ${r.status} ${errTxt.slice(0, 120)}`);
          logger.warn(
            { model, status: r.status, errTxt: errTxt.slice(0, 300) },
            "[image] imagen failed",
          );
        }
      } catch (e) {
        errors.push(`${model}: ${(e as Error).message}`);
      }
    }

    // 2) Gemini con multimodal output (responseModalities ["TEXT","IMAGE"]).
    //    Modelos verificados disponibles vía /image/list-models.
    for (const model of [
      "gemini-2.5-flash-image",
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
    ]) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
              },
            }),
          },
        );
        if (r.ok) {
          const j = (await r.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{
                  text?: string;
                  inlineData?: { mimeType?: string; data?: string };
                }>;
              };
            }>;
          };
          const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
          const dataB64 = part?.inlineData?.data;
          const mime = part?.inlineData?.mimeType ?? "image/png";
          if (dataB64) {
            const buffer = Buffer.from(dataB64, "base64");
            await persistAndSend(buffer, mime, `gemini:${model}`);
            return;
          }
        } else {
          const errTxt = await r.text().catch(() => "");
          errors.push(`${model}: ${r.status} ${errTxt.slice(0, 120)}`);
          logger.warn(
            { model, status: r.status, errTxt: errTxt.slice(0, 300) },
            "[image] gemini image-gen failed",
          );
        }
      } catch (e) {
        errors.push(`${model}: ${(e as Error).message}`);
      }
    }

    res.status(502).json({
      ok: false,
      error: "ningún modelo de Gemini devolvió imagen",
      attempts: errors,
    });
  } catch (e) {
    logger.error({ err: e }, "[image] generate error");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── GET /image/gallery ─────────────────────────────────────────────────────
// Lista las imágenes generadas, sin el base64 (sólo metadata) para que la
// galería cargue rápido. La data binaria se sirve por separado vía /image/:id.
router.get("/image/gallery", async (req, res): Promise<void> => {
  try {
    await ensureGalleryTable();
    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
    const r = await pool.query(
      `SELECT id,
              prompt,
              mime_type AS "mimeType",
              size_bytes AS "sizeBytes",
              provider,
              created_at::text AS "createdAt"
         FROM tanit_generated_images
        WHERE resource_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [(req.query.resourceId as string) ?? "luis", limit],
    );
    res.json({ ok: true, count: r.rows.length, images: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── GET /image/:id ─────────────────────────────────────────────────────────
// Sirve la imagen binaria por id. Útil tanto para abrir desde la galería como
// para usarla como adjunto en un mensaje futuro.
router.get("/image/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ ok: false, error: "id inválido" });
      return;
    }
    const r = await pool.query<{
      mime_type: string;
      image_base64: string;
    }>(
      `SELECT mime_type, image_base64 FROM tanit_generated_images WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) {
      res.status(404).json({ ok: false, error: "imagen no encontrada" });
      return;
    }
    const buffer = Buffer.from(row.image_base64, "base64");
    res.setHeader("Content-Type", row.mime_type || "image/png");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── DELETE /image/:id ──────────────────────────────────────────────────────
router.delete("/image/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ ok: false, error: "id inválido" });
      return;
    }
    const r = await pool.query(`DELETE FROM tanit_generated_images WHERE id = $1`, [id]);
    res.json({ ok: true, deleted: r.rowCount ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── GET /image/list-models ─────────────────────────────────────────────────
// Debug: lista modelos disponibles para esta API key. Útil para confirmar
// si el GEMINI_API_KEY tiene acceso a imagen (requiere proyecto GCP con
// billing en algunos casos).
router.get("/image/list-models", async (_req, res): Promise<void> => {
  if (!GEMINI_API_KEY) {
    res.status(500).json({ ok: false, error: "GEMINI_API_KEY no configurada" });
    return;
  }
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}&pageSize=200`,
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ ok: false, error: `Gemini ${r.status}`, body: txt.slice(0, 500) });
      return;
    }
    const j = (await r.json()) as {
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    const all = j.models ?? [];
    const imageCapable = all.filter(
      (m) =>
        (m.name?.includes("image") || m.name?.includes("imagen")) &&
        Array.isArray(m.supportedGenerationMethods),
    );
    res.json({
      ok: true,
      total: all.length,
      imageCapable: imageCapable.map((m) => ({
        name: m.name,
        methods: m.supportedGenerationMethods,
      })),
      allNames: all.map((m) => m.name).slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
