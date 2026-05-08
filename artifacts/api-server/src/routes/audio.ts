/**
 * Endpoints de audio:
 *  - POST /audio/transcribe — recibe audio (multipart/form-data o base64)
 *    y devuelve texto via OpenAI Whisper.
 *  - POST /audio/synthesize — recibe texto y devuelve MP3 via OpenAI TTS
 *    (voz "nova" — femenina cálida, encaja con la voz de Tanit).
 *
 * Reusan la OPENAI_API_KEY que ya está en Railway env.
 */
import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const OPENAI_API_KEY = process.env["OPENAI_API_KEY"];
if (!OPENAI_API_KEY) {
  logger.warn("[audio] OPENAI_API_KEY no está definida. Audio endpoints van a fallar.");
}

// ─── POST /audio/transcribe ─────────────────────────────────────────────────
// Body: multipart/form-data con campo "audio" (Blob/File) — o JSON con
// { audio_base64: string, mimeType: string }.
// Devuelve: { ok: true, text: string }
router.post("/audio/transcribe", async (req, res): Promise<void> => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY no configurada" });
    return;
  }

  try {
    let audioBuffer: Buffer | null = null;
    let mimeType = "audio/webm";

    // Caso JSON con base64
    const ct = req.headers["content-type"] ?? "";
    if (ct.startsWith("application/json")) {
      const body = (req.body ?? {}) as { audio_base64?: string; mimeType?: string };
      if (!body.audio_base64) {
        res.status(400).json({ ok: false, error: "audio_base64 requerido" });
        return;
      }
      audioBuffer = Buffer.from(body.audio_base64, "base64");
      mimeType = body.mimeType ?? mimeType;
    } else {
      // multipart — usamos express raw body si está, o leemos el stream.
      // express.json no parsea multipart, así que aquí asumimos que el
      // cliente mande JSON. Mantenemos el flujo simple.
      res.status(400).json({
        ok: false,
        error: "Content-Type debe ser application/json con audio_base64",
      });
      return;
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      res.status(400).json({ ok: false, error: "audio vacío" });
      return;
    }
    if (audioBuffer.length > 25 * 1024 * 1024) {
      res.status(413).json({ ok: false, error: "audio > 25MB no soportado por Whisper" });
      return;
    }

    // Construir multipart form para OpenAI Whisper
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

    if (!r.ok) {
      const errText = await r.text();
      logger.warn({ status: r.status, errText: errText.slice(0, 300) }, "[audio] whisper failed");
      res.status(502).json({ ok: false, error: `OpenAI ${r.status}: ${errText.slice(0, 300)}` });
      return;
    }

    const data = (await r.json()) as { text?: string };
    res.json({ ok: true, text: data.text ?? "" });
  } catch (e) {
    logger.error({ err: e }, "[audio] transcribe error");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── POST /audio/synthesize ─────────────────────────────────────────────────
// Body: { text: string, voice?: 'nova'|'shimmer'|'fable'|'alloy'|'echo'|'onyx' }
// Devuelve: audio/mpeg binario para que el cliente lo reproduzca con <audio>.
router.post("/audio/synthesize", async (req, res): Promise<void> => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY no configurada" });
    return;
  }

  try {
    const body = (req.body ?? {}) as { text?: string; voice?: string };
    const text = (body.text ?? "").trim();
    if (!text) {
      res.status(400).json({ ok: false, error: "text requerido" });
      return;
    }
    if (text.length > 4096) {
      res.status(413).json({ ok: false, error: "text > 4096 chars (límite OpenAI TTS)" });
      return;
    }

    // Voz por default: "nova" — femenina, cálida, encaja con Tanit.
    const voice = (body.voice ?? "nova").toLowerCase();
    const allowed = ["nova", "shimmer", "fable", "alloy", "echo", "onyx"];
    const safeVoice = allowed.includes(voice) ? voice : "nova";

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: safeVoice,
        input: text,
        response_format: "mp3",
        speed: 1.0,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      logger.warn({ status: r.status, errText: errText.slice(0, 300) }, "[audio] tts failed");
      res.status(502).json({ ok: false, error: `OpenAI ${r.status}: ${errText.slice(0, 300)}` });
      return;
    }

    const arrayBuffer = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (e) {
    logger.error({ err: e }, "[audio] synthesize error");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
