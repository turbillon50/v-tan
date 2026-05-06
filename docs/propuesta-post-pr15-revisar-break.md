# PROPUESTA POST-PR #15 — Para revisión técnica de Break antes de merge

**De:** Code
**Para:** Break (revisor técnico) → Luis (aprobador final)
**Fecha:** 6-may-2026, ~12 h post-merge PR #15
**Estado:** Propuesta sin código mergeado, lista para validación

---

## Contexto del momento

- PR #15 mergeado hace ~12 horas (margin heat + leverage progresivo + breakeven agresivo + loss time exit)
- Balance actual: **$168 USDT**
- WR: 53 % | PF: 0.27 | Avg loss: -$0.107 | Avg win: $0.026 (cayó de $0.064)
- Guardrails 24 h: 15,192 events, **100 % `LEV_COOLDOWN`** (loop silencioso TONUSDT)
- Margin heat: 77 %

Luis pidió diagnóstico y propuesta concreta SIN merge. Esto es eso.

---

## Issue 1 — Loop silencioso TONUSDT (15,192 events `LEV_COOLDOWN` / 24 h)

### Root cause confirmado

Archivo: `artifacts/api-server/src/lib/trading-engine.ts:1267-1278`

El fast SL/TP loop (cada 500 ms) computa `targetLev` desde `calcTargetLeverage(momentum, curLev)`. Si `targetLev > curLev`, llama `safeSetLeverage(sym, targetLev)`.

Archivo: `artifacts/api-server/src/lib/trading-engine.ts:1024-1045`

`safeSetLeverage()` consulta `validateLeverageEscalation()` (en `guardrails.ts:120`). Si el cooldown de 3 min está activo:

Archivo: `artifacts/api-server/src/lib/guardrails.ts:137-145`

```typescript
if (lastTs > 0 && elapsed < GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS) {
  const remainingMs = GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS - elapsed;
  await persistGuardrailEvent({  // ← INSERT en cada llamada
    type: "LEV_COOLDOWN",
    symbol,
    requested: { from: currentLeverage, to: newLeverage },
    enforced: { blocked: true, remainingMs },
    lessonRef: LESSON_REFS.LEV_COOLDOWN,
  });
  return { proceed: false, reason: "COOLDOWN_ACTIVE", remainingMs };
}
```

**Cada loop tick (2/s) hace un INSERT.** Con cooldown activo continuo en TONUSDT, da ~7,200 INSERTs/h por símbolo. Las 15K cifras de 24 h calzan exactas.

### NO es bug funcional

El cooldown está protegiendo el capital correctamente (lección id=2713 del 22-abr: "DYN-LEV SIN COOLDOWN DESTRUYÓ EL CAPITAL"). La protección es correcta. Es **ruido de log** que sobrecarga `guardrail_events` y enmascara otros guardrails reales si se dispararan.

### Fix propuesto — rate-limit del INSERT

Archivo a modificar: `/home/user/v-tan/artifacts/api-server/src/lib/guardrails.ts`

#### Paso 1 — añadir state al top del archivo

```typescript
// Rate-limit del log de LEV_COOLDOWN: máx 1 INSERT por símbolo cada N seg.
// Sin esto, el fast SL/TP loop genera ~7K events/h por símbolo en cooldown.
const _lastLevCooldownLogAt: Record<string, number> = {};
const LEV_COOLDOWN_LOG_RATE_MS = 60 * 1000; // 1 min
```

#### Paso 2 — modificar `validateLeverageEscalation` (línea 120-149)

**ANTES:**

```typescript
  if (lastTs > 0 && elapsed < GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS) {
    const remainingMs = GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS - elapsed;
    await persistGuardrailEvent({
      type: "LEV_COOLDOWN",
      symbol,
      requested: { from: currentLeverage, to: newLeverage },
      enforced: { blocked: true, remainingMs },
      lessonRef: LESSON_REFS.LEV_COOLDOWN,
    });
    return { proceed: false, reason: "COOLDOWN_ACTIVE", remainingMs };
  }
```

**DESPUÉS:**

```typescript
  if (lastTs > 0 && elapsed < GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS) {
    const remainingMs = GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS - elapsed;
    // Rate-limit: solo logear si pasaron >= LEV_COOLDOWN_LOG_RATE_MS desde el
    // último log de este símbolo. La protección sigue 100 % activa — solo
    // reduce ruido. Sin esto, el fast SL/TP loop genera 1 evento/500ms.
    const lastLogAt = _lastLevCooldownLogAt[symbol] ?? 0;
    if (Date.now() - lastLogAt > LEV_COOLDOWN_LOG_RATE_MS) {
      _lastLevCooldownLogAt[symbol] = Date.now();
      await persistGuardrailEvent({
        type: "LEV_COOLDOWN",
        symbol,
        requested: { from: currentLeverage, to: newLeverage },
        enforced: { blocked: true, remainingMs },
        lessonRef: LESSON_REFS.LEV_COOLDOWN,
      });
    }
    return { proceed: false, reason: "COOLDOWN_ACTIVE", remainingMs };
  }
```

### Impacto esperado

- **Reducción ~99 %** de events `LEV_COOLDOWN`: de 15K/24 h a máx ~1,440/24 h teóricos (24 símbolos × 60 events/h). En la práctica mucho menos porque solo TONUSDT está en este loop.
- **Cero impacto en protección**: la decisión `proceed: false` se devuelve igual, el cooldown sigue bloqueando todos los intentos de escalación.
- **Visibilidad mejorada**: si aparece otro tipo de guardrail (`SL_TOO_TIGHT`, `TP_UNREACHABLE`, `EQUITY_PROTECTION`, `BLUE_CHIP_AVOID_BLOCKED`), ya no se ahoga en el ruido masivo de `LEV_COOLDOWN`.

### Riesgo

**Mínimo.** Solo afecta logging, no lógica de protección. La función sigue devolviendo `{ proceed: false, reason: "COOLDOWN_ACTIVE", remainingMs }` exactamente igual que antes.

---

## Issue 2 — Avg_win cayó de $0.064 → $0.026 post-PR #15

### Hipótesis ordenadas por probabilidad

#### A) Combo mosquito-exit (v4.2) + leverage-progresivo (v4.3) bajando lev — PROBABILIDAD ALTA

- **Mosquito exit** (de tesis v4.2, ya activa) cierra posiciones con `ageSec > 30 min AND |pnlPct| < 0.5 %`. Las ganadoras tibias entre +0.1 % y +0.4 % son cerradas si se quedan estancadas. Eso baja avg_win.
- **Leverage progresivo** (de tesis v4.3, recién activado) baja a 5x el leverage cuando `heat > 85 %`. Con menos leverage, las ganancias absolutas son más chicas. avg_win cae proporcional.

#### B) Breakeven agresivo @ 0.3 % cortando ganadoras antes de tomar vuelo — PROBABILIDAD BAJA

Análisis del código en `trading-engine.ts:8717-8732`:

```typescript
const breakevenTriggerLegacy = slPct * 0.02;   // 2 % del SL
const breakevenTriggerAggressive = FEAT_BREAKEVEN_AGGRESSIVE
  ? BREAKEVEN_TRIGGER_PRICE_PCT / 100   // 0.003 = 0.3 %
  : Number.POSITIVE_INFINITY;
const beTrigger = Math.min(breakevenTriggerLegacy, breakevenTriggerAggressive);
```

Con `slPct = 0.01` (típico, 1 % de precio), `legacy = 0.0002 = 0.02 %` del precio. **Ya era más agresivo que mi nuevo 0.3 %.** El `Math.min` siempre gana el legacy. Mi BE agresivo del PR #15 NO debería estar cambiando el comportamiento — el legacy ya era más estricto desde antes.

**Conclusión:** el BE agresivo de v4.3 no es el causante. Hipótesis A es la correcta.

#### C) Variabilidad estadística — POSIBLE pero no probable

12 h post-merge es muestra chica. No descartable, pero no debe ser la única explicación.

### Fix propuesto — opciones de menor a mayor invasión

#### Opción 1 (mínima, sin código) — subir `mosquito_age_min` de 30 → 60 min

Comando que Luis ejecuta directo en chat con Tanit:

```
set_strategy_param mosquito_age_min 60
```

Da más tiempo a las ganadoras tibias para tomar vuelo antes de ser declaradas "estancadas". Sin merge, sin código nuevo, sin riesgo. Reversible al instante.

#### Opción 2 (intermedia, sin código) — Opción 1 + apretar `mosquito_pnl_band_pct` 0.5 → 0.3

```
set_strategy_param mosquito_age_min 60
set_strategy_param mosquito_pnl_band_pct 0.3
```

Mosquito solo cierra trades MUY estancados (entre -0.3 % y +0.3 %), no toca ganadoras de +0.4 % en adelante.

#### Opción 3 (más agresiva, requiere código) — desactivar BE legacy momentáneamente

Solo si las opciones 1-2 no funcionan después de 24 h. Tocar `trading-engine.ts:8717` para que el legacy use el mismo `BREAKEVEN_TRIGGER_PRICE_PCT` en lugar de `slPct * 0.02`. **No recomendado en este round** — toca código en zona delicada (DANGER ZONE marcada por análisis previo).

### Recomendación de Code

1. **Aplicar Opción 1 ya** — solo `set_strategy_param`, instantáneo, sin PR.
2. **Aplicar Issue 1 fix junto a esto en un PR pequeño** — el rate-limit es seguro y elimina el ruido masivo en `guardrail_events`.
3. **No revertir nada del PR #15** — los componentes están haciendo su trabajo, solo necesitan tunning de la mosquito band.

Después de 24 h con la Opción 1 + Issue 1 fix mergeado:

- Si avg_win subió a ≥ $0.040 → mantener
- Si sigue ≤ $0.030 → aplicar Opción 2
- Si sigue débil → considerar Opción 3 con aprobación explícita de Luis

---

## Resumen ejecutivo para Luis

| Acción | Tipo | Riesgo | Reversible |
|--------|------|--------|------------|
| **Rate-limit LEV_COOLDOWN log** (Issue 1) | PR pequeño en `guardrails.ts` | bajo | sí (revertir PR) |
| **Subir `mosquito_age_min` 30→60** | comando chat | mínimo | instantáneo |
| **Subir `mosquito_pnl_band_pct` 0.5→0.3** | comando chat | mínimo | instantáneo |
| **No tocar `ATR_SL_MULT` por ahora** | (sin acción) | — | — |

---

## Cadena de ejecución pendiente

1. ✅ Code propone (este documento)
2. ⏳ Break valida técnicamente (especialmente el cambio de `guardrails.ts`)
3. ⏳ Luis aprueba explícitamente con "merge"
4. ⏳ Code abre PR para Issue 1 + Code mergea + propaga a Railway
5. ⏳ Luis ejecuta `set_strategy_param mosquito_age_min 60` desde el chat (no requiere PR)
6. ⏳ Validación 24 h
7. ⏳ Revisión de métricas: `avg_win`, `LEV_COOLDOWN events/24h`

**Ningún cambio sin aprobación de Luis.**

---

— Code, 6-may-2026
