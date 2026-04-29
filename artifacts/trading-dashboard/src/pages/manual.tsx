import { Layout } from "@/components/layout";
import { useState } from "react";

const GREEN  = "#00D4AA";
const AMBER  = "#F59E0B";
const PURPLE = "#818CF8";
const RED    = "#F23645";
const DIM    = "#64748B";

const TIERS = [
  { range: "82 – 100", label: "PLATINUM", color: GREEN,  bg: "rgba(0,212,170,0.07)",  border: "rgba(0,212,170,0.25)",  desc: "Todas las condiciones alineadas. Entrada de máxima convicción. Entra con el 100% de tu capital asignado al modo." },
  { range: "68 – 81",  label: "ORO",      color: AMBER,  bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.25)", desc: "Señal sólida. La mayoría de condiciones cumplen. Entra con tu capital normal. Este tier es el pan de cada día." },
  { range: "58 – 67",  label: "REDUCIDA", color: PURPLE, bg: "rgba(129,140,248,0.06)", border: "rgba(129,140,248,0.20)", desc: "Señal débil. Solo para traders experimentados con posición reducida. No recomendado si estás empezando." },
  { range: "1 – 57",   label: "ESPERA",   color: DIM,    bg: "rgba(100,116,139,0.05)", border: "rgba(100,116,139,0.15)", desc: "No hay condiciones suficientes. El sistema te protege: no entres. El ciclo que no pierdes también suma." },
];

const MODES = [
  { label: "Conservador", lev: "10x", cap: "1%", sl: "ATR×2.0", color: GREEN,   risk: 1, desc: "El punto de entrada perfecto. Pérdidas controladas, ganancias consistentes. Ideal para los primeros 30 días." },
  { label: "Arriesgado",  lev: "20x", cap: "5%", sl: "ATR×1.5", color: AMBER,   risk: 2, desc: "El modo más popular. Balance óptimo entre riesgo y ganancia. Para cuando ya entiendes cómo funciona el score." },
  { label: "Ultra",       lev: "75x", cap: "10%", sl: "ATR×1.0", color: PURPLE, risk: 3, desc: "Apalancamiento alto. Solo cuando el score es PLATINUM y la sesión es London/NY. Experiencia requerida." },
  { label: "Tiburón",     lev: "100x", cap: "15%", sl: "ATR×0.5", color: "#FF6B35", risk: 4, desc: "Muy agresivo. Una operación puede doblar o liquidar tu capital. Solo si tienes experiencia probada." },
  { label: "Megalodón",   lev: "125x", cap: "20%", sl: "ATR×0.3", color: RED,   risk: 5, desc: "No es el más agresivo por imprudente — es el más eficiente. SL ultra-apretado, TP escalonados. Score mínimo: 80." },
];

const SESSIONS = [
  { label: "Asia",           hours: "00–08 UTC",  color: "#60A5FA", quality: "Moderada",   tip: "Volumen bajo. BTC y stablecoins. Bueno para posiciones de menor riesgo o para preparar la entrada Londres." },
  { label: "Londres",        hours: "07–16 UTC",  color: AMBER,     quality: "Alta",        tip: "Los institucionales europeos mueven el mercado. Se establecen las tendencias del día. Segunda mejor ventana." },
  { label: "Nueva York",     hours: "13–22 UTC",  color: RED,       quality: "Muy alta",    tip: "La sesión más volátil. Grandes movimientos en ambas direcciones. Señales de alta calidad cuando el score es fuerte." },
  { label: "Overlap",        hours: "13–16 UTC",  color: GREEN,     quality: "Maxima",      tip: "Londres + NY activas simultáneamente. Máxima liquidez del día. Las señales aquí tienen el bonus mas alto (+8 pts)." },
];

const STEPS = [
  { n: "01", title: "Abre el Panel y elige tu símbolo", body: "Selecciona la criptomoneda que quieres operar en la barra de símbolos (BTC, ETH, SOL, BNB...). El sistema analizará en tiempo real." },
  { n: "02", title: "Espera el Ciclo de Convicción correcto", body: "Observa el cuadro grande del Panel. Cuando muestre PLATINUM u ORO, hay señal válida. Si dice ESPERA, no hagas nada — el sistema te está protegiendo." },
  { n: "03", title: "Configura tu modo de riesgo en Algo Bot", body: "Ve a Algo Bot y elige un modo. Empieza con Conservador. Define qué sesiones quieres operar. Presiona Iniciar." },
  { n: "04", title: "Ejecuta la entrada manualmente o en Furtivo", body: "Manual: el Panel te da precio, TP1/TP2/TP3 y SL exactos. Furtivo: el motor lo hace automático en Sandbox primero, luego Modo Real." },
  { n: "05", title: "Deja correr la posición", body: "Una vez dentro, no toques el SL. El sistema calculó los niveles con ATR (volatilidad real). Cerrar antes del TP por nervios es la causa #1 de pérdidas." },
  { n: "06", title: "Revisa Capital y ajusta", body: "Después de 5–10 operaciones, revisa la sección Capital. Si tu win rate supera 55% y el promedio de ganancia supera el de pérdida, puedes subir un modo de riesgo." },
];

const SECTIONS = [
  {
    label: "Panel",
    color: GREEN,
    what: "El cerebro de la app. Muestra la señal activa, el score, el tier, dirección y todos los niveles de entrada.",
    how: "Revísalo cada vez que empiece una sesión activa. La señal se actualiza cada 45 segundos. No necesitas estar pegado a la pantalla.",
  },
  {
    label: "Terminal",
    color: "#60A5FA",
    what: "Dashboard de mercado con precios en tiempo real, balance de tu cuenta Bybit e indicadores globales.",
    how: "Úsalo para contexto. Ver tu balance real y el estado del mercado cripto en general.",
  },
  {
    label: "Algo Bot",
    color: AMBER,
    what: "Configuración del robot de señales. Aquí defines el modo de riesgo y qué sesiones vas a operar.",
    how: "Configura una vez, deja correr. El bot monitorea el mercado y genera señales según tus parámetros.",
  },
  {
    label: "Capital",
    color: PURPLE,
    what: "Tracking de tu balance en Bybit. Muestra el crecimiento de tu cuenta en el tiempo.",
    how: "Revísalo cada semana. Si tu capital creció, considera subir gradualmente el porcentaje asignado.",
  },
  {
    label: "Furtivo",
    color: "#FF6B35",
    what: "Motor autónomo. Opera automáticamente usando señales reales en Sandbox (virtual) o Modo Real (tu cuenta Bybit).",
    how: "Empieza en Sandbox al menos 2 semanas. Cuando entiendas los resultados y confíes en el sistema, activa Modo Real.",
  },
  {
    label: "Backtest",
    color: "#C084FC",
    what: "Prueba estrategias con datos históricos sin arriesgar dinero real.",
    how: "Antes de cambiar tu modo de riesgo, corre un backtest con el nuevo modo para ver qué hubiera pasado históricamente.",
  },
  {
    label: "Alertas",
    color: "#FB923C",
    what: "Notificaciones Telegram. Te avisa cuando hay una señal PLATINUM o señal fuerte aunque no tengas la app abierta.",
    how: "Configura una vez con tu bot de Telegram. Recibirás alertas en tiempo real directamente en tu celular.",
  },
];

function RiskBar({ level }: { level: number }) {
  return (
    <div className="flex gap-0.5">
      {[1,2,3,4,5].map(i => (
        <div key={i} className="h-1.5 w-3 rounded-sm" style={{
          background: i <= level
            ? (level <= 2 ? GREEN : level === 3 ? AMBER : RED)
            : "rgba(255,255,255,0.08)"
        }} />
      ))}
    </div>
  );
}

export default function Manual() {
  const [activeSection, setActiveSection] = useState<string | null>(null);

  return (
    <Layout>
      <div className="max-w-2xl mx-auto space-y-8 pb-12">

        {/* Hero */}
        <div className="rounded-2xl p-6 border" style={{ background: "rgba(0,212,170,0.04)", borderColor: "rgba(0,212,170,0.15)" }}>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "rgba(0,212,170,0.12)", border: "1px solid rgba(0,212,170,0.25)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00D4AA" strokeWidth="2" strokeLinecap="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                <line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/>
              </svg>
            </div>
            <div>
              <h1 className="font-display font-black text-xl text-foreground tracking-tight">Guía Completa</h1>
              <p className="text-xs text-muted-foreground font-mono tracking-wide">Money Maker · Curso de uso</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Aquí aprendes exactamente qué significa cada número, cuándo entrar, cuándo no entrar, y cómo este sistema puede generarte retornos consistentes del 5–20% mensual con gestión de riesgo real.
          </p>
        </div>

        {/* INICIO RAPIDO */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Inicio Rápido — 6 Pasos</h2>
          <div className="space-y-2">
            {STEPS.map(s => (
              <div key={s.n} className="flex gap-4 rounded-xl p-4 border border-border bg-card">
                <div className="font-mono font-black text-sm shrink-0 w-6 pt-0.5" style={{ color: GREEN }}>{s.n}</div>
                <div>
                  <div className="font-semibold text-sm text-foreground mb-1">{s.title}</div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* EL SCORE */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">El Score — Qué Significa Cada Número</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            El score va de 1 a 100. Es la suma de todos los indicadores técnicos del mercado: RSI, MACD, EMAs, patrones de vela, volumen, sesión activa y dominancia de BTC. A mayor score, más condiciones están alineadas a tu favor.
          </p>
          <div className="space-y-2">
            {TIERS.map(t => (
              <div key={t.label} className="rounded-xl p-4 border" style={{ background: t.bg, borderColor: t.border }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <div className="font-mono font-black text-lg leading-none" style={{ color: t.color }}>{t.range}</div>
                    <span className="text-[10px] font-black tracking-widest px-2 py-0.5 rounded-full"
                      style={{ background: t.color + "20", color: t.color, border: `1px solid ${t.color}30` }}>
                      {t.label}
                    </span>
                  </div>
                  <div className="w-2 h-2 rounded-full" style={{ background: t.color }} />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{t.desc}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl p-3 border border-border bg-card/50 text-xs text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">Regla de oro:</span> Si el score no llega a 68 (ORO), no entres. El sistema está diseñado para que la paciencia sea tu ventaja competitiva. Los traders que respetan el score tienen win rates del 60–70%.
          </div>
        </section>

        {/* SESIONES */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Las Sesiones — Cuándo Opera el Dinero Real</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            El mercado cripto opera 24/7 pero el volumen institucional (el dinero real) solo aparece en ciertos horarios. Operar fuera de sesión es como pescar en un lago seco.
          </p>
          <div className="space-y-2">
            {SESSIONS.map(s => (
              <div key={s.label} className="rounded-xl p-4 border border-border bg-card">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                    <span className="font-bold text-sm text-foreground">{s.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{s.hours}</span>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ color: s.color, background: s.color + "15", border: `1px solid ${s.color}25` }}>
                    {s.quality}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{s.tip}</p>
              </div>
            ))}
          </div>
        </section>

        {/* MODOS */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Modos de Riesgo — Tu Perfil de Operación</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            El apalancamiento multiplica tus ganancias — y tus pérdidas. Empieza siempre en Conservador. Sube de modo solo cuando tengas al menos 20 operaciones documentadas con win rate positivo.
          </p>
          <div className="space-y-2">
            {MODES.map(m => (
              <div key={m.label} className="rounded-xl p-4 border border-border bg-card">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full" style={{ background: m.color }} />
                    <span className="font-bold text-sm" style={{ color: m.color }}>{m.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{m.lev} · {m.cap} capital</span>
                  </div>
                  <RiskBar level={m.risk} />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed mb-2">{m.desc}</p>
                <div className="flex gap-2 text-[10px] font-mono">
                  <span className="px-2 py-0.5 rounded border border-border text-muted-foreground">SL {m.sl}</span>
                  <span className="px-2 py-0.5 rounded border border-border text-muted-foreground">Capital {m.cap}</span>
                  <span className="px-2 py-0.5 rounded border border-border text-muted-foreground">Lev {m.lev}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* TP / SL */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Take Profit y Stop Loss — Cómo Gestionar la Operación</h2>
          <div className="space-y-2">
            {[
              { label: "TP1 — 33% de tu posición", color: GREEN, desc: "El primer objetivo de precio. Cuando el mercado llega aquí, cierras un tercio. Ya aseguraste ganancia. El resto puede seguir corriendo." },
              { label: "TP2 — 33% de tu posición", color: AMBER, desc: "Segundo objetivo. Más ganancia asegurada. El riesgo ahora es cero: aunque el mercado revierta, ya estás en verde." },
              { label: "TP3 — 34% de tu posición", color: PURPLE, desc: "El objetivo máximo. Si el mercado llega aquí, cerraste la posición completa con el mejor resultado posible." },
              { label: "SL — Stop Loss",            color: RED,    desc: "Calculado con ATR (volatilidad real). Si el precio llega aquí, sales automáticamente. NUNCA muevas el SL en tu contra. Es la diferencia entre una pérdida pequeña y una liquidación." },
            ].map(item => (
              <div key={item.label} className="flex gap-4 rounded-xl p-4 border border-border bg-card">
                <div className="w-1 shrink-0 rounded-full" style={{ background: item.color }} />
                <div>
                  <div className="font-semibold text-sm mb-1" style={{ color: item.color }}>{item.label}</div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* SECCIONES */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Qué Hace Cada Sección</h2>
          <div className="space-y-2">
            {SECTIONS.map(s => (
              <button key={s.label} onClick={() => setActiveSection(activeSection === s.label ? null : s.label)}
                className="w-full text-left rounded-xl p-4 border border-border bg-card transition-all hover:border-white/15">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                    <span className="font-bold text-sm text-foreground">{s.label}</span>
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    className="text-muted-foreground transition-transform"
                    style={{ transform: activeSection === s.label ? "rotate(180deg)" : "none" }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
                {activeSection === s.label && (
                  <div className="mt-3 space-y-2 text-xs text-muted-foreground leading-relaxed border-t border-border pt-3">
                    <p><span className="font-semibold text-foreground">Qué es: </span>{s.what}</p>
                    <p><span className="font-semibold text-foreground">Cómo usarlo: </span>{s.how}</p>
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* REGLAS DE ORO */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Las 5 Reglas de Oro</h2>
          <div className="rounded-2xl p-5 border space-y-4" style={{ background: "rgba(0,212,170,0.03)", borderColor: "rgba(0,212,170,0.12)" }}>
            {[
              { n: "I",   rule: "No entres si el score es menor a 68.", why: "El sistema te protege. La disciplina de no operar en condiciones malas es lo que separa a los traders rentables." },
              { n: "II",  rule: "No muevas el Stop Loss en tu contra.", why: "Moverlo hacia atrás convierte una pérdida controlada en una posible liquidación. Confía en el ATR." },
              { n: "III", rule: "Respeta el tamaño de posición de tu modo.", why: "Apostar más de lo que tu modo indica destruye la gestión de riesgo. Consistencia > heroísmo." },
              { n: "IV",  rule: "Empieza en Sandbox antes de usar dinero real.", why: "Conoce el sistema con capital virtual. Cuando veas resultados positivos consistentes, activa Modo Real." },
              { n: "V",   rule: "Opera en sesión activa — preferiblemente Overlap.", why: "La liquidez importa. Sin volumen institucional, las señales son menos confiables y los spreads son mayores." },
            ].map(r => (
              <div key={r.n} className="flex gap-4">
                <div className="font-mono font-black text-xs pt-0.5 shrink-0 w-5" style={{ color: GREEN }}>{r.n}</div>
                <div>
                  <div className="font-semibold text-sm text-foreground mb-0.5">{r.rule}</div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{r.why}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* OBJETIVO DE RENDIMIENTO */}
        <section className="space-y-3">
          <h2 className="font-display font-bold text-base text-foreground tracking-tight">Objetivo de Rendimiento</h2>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Conservador", target: "5–8%", period: "mensual", color: GREEN },
              { label: "Arriesgado",  target: "10–15%", period: "mensual", color: AMBER },
              { label: "Ultra/Megalodón", target: "15–20%+", period: "mensual", color: RED },
            ].map(r => (
              <div key={r.label} className="rounded-xl p-3 border border-border bg-card text-center">
                <div className="font-mono font-black text-base" style={{ color: r.color }}>{r.target}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{r.period}</div>
                <div className="text-[9px] text-muted-foreground/60 mt-1 font-mono">{r.label}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Estos rangos asumen disciplina en la gestión de riesgo, respetar el score mínimo de 68, y operar en sesiones activas. Los resultados varían según las condiciones del mercado. El interés compuesto hace el resto: 10% mensual = 214% anual.
          </p>
        </section>

      </div>
    </Layout>
  );
}
