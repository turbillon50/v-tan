/**
 * econ-calendar.ts
 * Calendario económico macro de alto impacto (Forex Factory, sin API key).
 * Detecta ventanas de riesgo para pausar nuevas entradas automáticamente.
 */

export interface EconEvent {
  title:   string;
  country: string;
  dateUtc: Date;
  impact:  "High" | "Medium" | "Low";
}

interface CalendarCache {
  events:    EconEvent[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hora — el calendario no cambia seguido
const DANGER_WINDOW_BEFORE_MS = 30 * 60 * 1000;   // 30 min antes del evento
const DANGER_WINDOW_AFTER_MS  = 15 * 60 * 1000;   // 15 min después del evento

let _cache: CalendarCache | null = null;

function parseEventDate(dateStr: string, timeStr: string): Date | null {
  try {
    // Forex Factory format: date = "Apr 10, 2026", time = "8:30am" or "All Day" or ""
    if (!dateStr) return null;
    const fullStr = timeStr && timeStr !== "All Day" && timeStr !== ""
      ? `${dateStr} ${timeStr}`
      : `${dateStr} 12:00pm`;
    const d = new Date(fullStr + " UTC");
    if (isNaN(d.getTime())) {
      // Fallback: try ISO date if dateStr is already ISO
      const iso = new Date(dateStr);
      return isNaN(iso.getTime()) ? null : iso;
    }
    return d;
  } catch {
    return null;
  }
}

async function fetchCalendar(): Promise<EconEvent[]> {
  try {
    const res = await fetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const raw = await res.json() as any[];
    const events: EconEvent[] = [];

    for (const item of raw) {
      const impact = item.impact as string;
      if (!["High"].includes(impact)) continue;          // solo alto impacto
      if (!["USD", "US"].includes(item.country ?? "")) continue; // solo USD

      const dateUtc = parseEventDate(item.date ?? "", item.time ?? "");
      if (!dateUtc) continue;

      events.push({
        title:   String(item.title ?? "Evento USD"),
        country: String(item.country ?? "USD"),
        dateUtc,
        impact:  "High",
      });
    }

    return events;
  } catch {
    return [];
  }
}

async function getCachedEvents(): Promise<EconEvent[]> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.events;
  }
  const events = await fetchCalendar();
  _cache = { events, fetchedAt: Date.now() };
  return events;
}

/**
 * Chequea si el cache está fresco o lo refresca si expiró antes de responder.
 * Async — garantiza que el resultado siempre usa datos actualizados.
 */
export async function checkDangerZone(): Promise<boolean> {
  // Si el cache está vencido (o nunca se cargó), refrescar ahora
  if (!_cache || Date.now() - _cache.fetchedAt >= CACHE_TTL_MS) {
    try {
      const events = await fetchCalendar();
      _cache = { events, fetchedAt: Date.now() };
    } catch {
      // Si falla el refresco, usar cache anterior (si existe) como fallback conservador
    }
  }
  if (!_cache) return false;
  const now = Date.now();
  return _cache.events.some(ev => {
    const evMs   = ev.dateUtc.getTime();
    const msUntil = evMs - now;
    const msAfter  = now - evMs;
    return (msUntil >= 0 && msUntil <= DANGER_WINDOW_BEFORE_MS) ||
           (msAfter  >= 0 && msAfter  <= DANGER_WINDOW_AFTER_MS);
  });
}

/**
 * Versión síncrona — solo válida después de que el cache esté cargado.
 * Úsala solo en contextos donde ya llamaste `checkDangerZone()` o `initEconCalendar()`.
 */
export function isInDangerZone(): boolean {
  if (!_cache) return false;
  const now = Date.now();
  return _cache.events.some(ev => {
    const evMs = ev.dateUtc.getTime();
    const msUntil = evMs - now;
    const msAfter  = now - evMs;
    return (msUntil >= 0 && msUntil <= DANGER_WINDOW_BEFORE_MS) ||
           (msAfter  >= 0 && msAfter  <= DANGER_WINDOW_AFTER_MS);
  });
}

/**
 * Retorna eventos de alto impacto en las próximas 48h.
 */
export async function getUpcomingHighImpactEvents(): Promise<EconEvent[]> {
  const events = await getCachedEvents();
  const now = Date.now();
  const cutoff = now + 48 * 60 * 60 * 1000;
  return events
    .filter(ev => ev.dateUtc.getTime() >= now - DANGER_WINDOW_AFTER_MS && ev.dateUtc.getTime() <= cutoff)
    .sort((a, b) => a.dateUtc.getTime() - b.dateUtc.getTime());
}

function fmtTimeRemaining(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/**
 * Texto resumido para el prompt de Tanit.
 */
export async function getCalendarSummaryForTanit(): Promise<string> {
  try {
    const events = await getUpcomingHighImpactEvents();
    if (events.length === 0) return "✅ Sin eventos macro de alto impacto en las próximas 48h";
    const now = Date.now();
    const lines = events.slice(0, 4).map(ev => {
      const ms = ev.dateUtc.getTime() - now;
      if (ms < 0) {
        return `⚠️ ${ev.title} (USD) — hace ${fmtTimeRemaining(-ms)} [POST-EVENTO]`;
      }
      const prefix = ms < DANGER_WINDOW_BEFORE_MS ? "🔴" : "🟡";
      return `${prefix} ${ev.title} (USD) — en ${fmtTimeRemaining(ms)} (${ev.dateUtc.toUTCString().slice(17,22)} UTC)`;
    });
    return lines.join("\n");
  } catch {
    return "Calendario macro no disponible";
  }
}

/** Inicializa el cache (llamar al arrancar el motor) */
export async function initEconCalendar(): Promise<void> {
  try {
    await getCachedEvents();
    console.log("[econ-cal] Calendario económico cargado:", _cache?.events.length ?? 0, "eventos de alto impacto USD");
  } catch {}
}
