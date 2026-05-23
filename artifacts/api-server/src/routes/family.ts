import { Router, type IRouter, type Request } from "express";
import { Pool, type QueryResult } from "pg";
import { logger } from "../lib/logger";

const router: IRouter = Router();

let pool: Pool | null = null;
let schemaReady = false;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool = new Pool({
    connectionString: url,
    ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

async function ensureFamilySchema(): Promise<void> {
  if (schemaReady) return;
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS family_messages (
      id                BIGSERIAL PRIMARY KEY,
      message_id        TEXT UNIQUE NOT NULL,
      channel           TEXT NOT NULL,
      sender            TEXT NOT NULL,
      sender_kind       TEXT NOT NULL,
      content           TEXT NOT NULL,
      payload           JSONB,
      reply_to          TEXT,
      mentions          JSONB NOT NULL DEFAULT '[]'::jsonb,
      family_created_at TIMESTAMPTZ NOT NULL,
      received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acked_at          TIMESTAMPTZ
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_family_messages_channel_received ON family_messages (channel, received_at DESC)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_family_messages_sender_received ON family_messages (sender, received_at DESC)`,
  );
  schemaReady = true;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type AuthResult = { ok: true } | { ok: false; reason: string; code: number };

function validateBearer(req: Request): AuthResult {
  const expected = process.env.FAMILY_AGENT_TOKEN ?? "";
  if (!expected) return { ok: false, reason: "FAMILY_AGENT_TOKEN not set", code: 503 };
  const header = (req.headers.authorization as string | undefined) ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const presented = m?.[1] ?? "";
  if (!presented || !timingSafeEq(presented, expected)) {
    return { ok: false, reason: "invalid Authorization Bearer token", code: 401 };
  }
  return { ok: true };
}

async function ackToFamily(
  ackUrl: string,
  messageId: string,
  externalRef: string | null,
  errorMsg?: string,
): Promise<void> {
  if (!ackUrl) return;
  const token = process.env.FAMILY_AGENT_TOKEN ?? "";
  const handle = process.env.FAMILY_AGENT_HANDLE ?? "tanit";
  try {
    await fetch(ackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messageId,
        agent: handle,
        ...(externalRef ? { externalRef } : {}),
        ...(errorMsg ? { error: errorMsg } : {}),
      }),
    });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : e }, "[family] ack failed");
  }
}

router.post("/family-incoming", async (req, res) => {
  const auth = validateBearer(req);
  if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.reason });

  const body = req.body as Record<string, unknown> | undefined;
  const messageId = body?.messageId as string | undefined;
  const channel = body?.channel as string | undefined;
  const sender = body?.sender as string | undefined;
  const content = body?.content as string | undefined;
  if (!messageId || !channel || !sender || !content) {
    return res.status(422).json({
      ok: false,
      error: "messageId, channel, sender and content are required",
    });
  }

  const senderKind = (body?.senderKind as string | undefined) ?? "unknown";
  const payload = body?.payload ?? null;
  const replyTo = (body?.replyTo as string | null | undefined) ?? null;
  const mentions = Array.isArray(body?.mentions) ? (body?.mentions as unknown[]) : [];
  const createdAt = (body?.createdAt as string | undefined) ?? new Date().toISOString();
  const ackUrl = (body?.ackUrl as string | undefined) ?? "";

  try {
    await ensureFamilySchema();
    const db = getPool();
    const result: QueryResult<{ id: number }> = await db.query(
      `
        INSERT INTO family_messages
          (message_id, channel, sender, sender_kind, content, payload, reply_to,
           mentions, family_created_at, acked_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (message_id) DO UPDATE SET acked_at = NOW()
        RETURNING id
      `,
      [
        messageId,
        channel,
        sender,
        senderKind,
        content,
        JSON.stringify(payload),
        replyTo,
        JSON.stringify(mentions),
        createdAt,
      ],
    );

    const externalRef = `family_messages:${result.rows[0]!.id}`;
    if (ackUrl) void ackToFamily(ackUrl, messageId, externalRef);
    return res.json({ ok: true, externalRef });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "unknown error";
    logger.error({ err: errorMsg }, "[family] persist failed");
    if (ackUrl) void ackToFamily(ackUrl, messageId, null, errorMsg);
    return res.status(500).json({ ok: false, error: errorMsg });
  }
});

router.get("/family-incoming/health", (_req, res) => {
  res.json({
    configured: Boolean(process.env.FAMILY_AGENT_TOKEN),
    handle: process.env.FAMILY_AGENT_HANDLE ?? "tanit",
    baseUrl: process.env.FAMILY_BASE_URL ?? "https://family.vercel.app",
    schemaReady,
  });
});

export default router;
