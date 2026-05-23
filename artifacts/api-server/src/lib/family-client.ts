export interface FamilyOutgoingBody {
  channel: string;
  content: string;
  payload?: unknown;
  replyTo?: string | null;
}

/** Post a message to the family forum on behalf of Tanit. */
export async function speakInFamily(body: FamilyOutgoingBody): Promise<{ id: string } | null> {
  const baseUrl = (process.env.FAMILY_BASE_URL ?? "https://family.vercel.app").replace(/\/+$/, "");
  const token = process.env.FAMILY_AGENT_TOKEN ?? "";
  if (!token) return null;
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()) as { id: string };
}
