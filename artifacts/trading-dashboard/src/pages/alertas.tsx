import { useState } from "react";
import { Layout } from "@/components/layout";
import { BellIcon, CheckIcon, AlertIcon, SendIcon, PhoneIcon, LinkIcon, CopyIcon, ChevronRightIcon, ShieldIcon } from "@/components/TradeIcons";
import { BASE_URL } from "@/lib/api";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="shrink-0 flex flex-col items-center">
        <div className="w-8 h-8 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center">
          <span className="text-sm font-bold text-primary font-mono">{n}</span>
        </div>
        <div className="w-px flex-1 bg-border mt-2" />
      </div>
      <div className="pb-6 flex-1">
        <h3 className="font-semibold text-foreground mb-2">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 bg-background/70 border border-border rounded-lg px-3 py-2 font-mono text-sm">
      <span className="flex-1 text-primary">{code}</span>
      <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="text-muted-foreground hover:text-foreground transition-colors">
        {copied ? <CheckIcon className="w-4 h-4 text-[#00C9A7]" /> : <CopyIcon className="w-4 h-4" />}
      </button>
    </div>
  );
}

export default function Alertas() {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId]     = useState("");
  const [testing, setTesting]   = useState(false);
  const [result, setResult]     = useState<{ ok: boolean; message?: string; error?: string } | null>(null);

  async function handleTest() {
    if (!botToken.trim() || !chatId.trim()) {
      setResult({ ok: false, error: "Completa el token del bot y el Chat ID primero." });
      return;
    }
    setTesting(true); setResult(null);
    try {
      const res = await fetch(`${BASE_URL}api/alerts/telegram/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim(), chatId: chatId.trim() }),
      });
      const data = await res.json();
      setResult(data);
    } catch {
      setResult({ ok: false, error: "No se pudo conectar al servidor." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Layout>
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <BellIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-foreground">Alertas Telegram</h1>
            <p className="text-sm text-muted-foreground">Recibe señales en tu celular aunque no estés en la app</p>
          </div>
        </div>

        {/* What you'll get */}
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-foreground text-sm">Qué recibirás en Telegram</h2>
          <div className="space-y-2">
            {[
              { emoji: "🦈", text: "Señal Tiburón activada (score >85, 100x leverage)" },
              { emoji: "🚀", text: "Señal Ultra muy fuerte (score >80)" },
              { emoji: "🔀", text: "Divergencia RSI crítica detectada" },
              { emoji: "📈", text: "Patrón de vela con alta probabilidad" },
            ].map(({ emoji, text }) => (
              <div key={text} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <span>{emoji}</span>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Setup guide */}
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="font-semibold text-foreground text-sm mb-5">Guía de configuración (5 minutos)</h2>

          <div>
            <Step n={1} title="Crea tu bot en Telegram">
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <ChevronRightIcon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span>Abre Telegram y busca <strong className="text-foreground">@BotFather</strong></span>
                </li>
                <li className="flex items-start gap-2">
                  <ChevronRightIcon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span>Envíale el comando:</span>
                </li>
              </ol>
              <div className="mt-2"><CopyCode code="/newbot" /></div>
              <p className="text-xs text-muted-foreground mt-2">Pon cualquier nombre, como "Money Maker Alerts". BotFather te dará un <strong className="text-foreground">token</strong> que parece: <span className="font-mono text-primary">1234567890:ABCdef...</span></p>
            </Step>

            <Step n={2} title="Obtén tu Chat ID">
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <ChevronRightIcon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span>Busca <strong className="text-foreground">@userinfobot</strong> en Telegram y presiona Start</span>
                </li>
                <li className="flex items-start gap-2">
                  <ChevronRightIcon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span>Te responderá con tu <strong className="text-foreground">Id</strong> — ese número es tu Chat ID</span>
                </li>
              </ol>
            </Step>

            <Step n={3} title="Prueba la conexión aquí">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Bot Token</label>
                  <input
                    type="text" value={botToken} onChange={e => setBotToken(e.target.value)}
                    placeholder="1234567890:ABCdefGHI..."
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/40" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Chat ID</label>
                  <input
                    type="text" value={chatId} onChange={e => setChatId(e.target.value)}
                    placeholder="123456789"
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/40" />
                </div>

                <button onClick={handleTest} disabled={testing}
                  className="flex items-center gap-2 bg-primary text-primary-foreground font-semibold rounded-lg py-2 px-4 text-sm transition-all hover:bg-primary/90 disabled:opacity-50">
                  {testing ? (
                    <><div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />Enviando...</>
                  ) : (
                    <><SendIcon className="w-4 h-4" />Enviar mensaje de prueba</>
                  )}
                </button>

                {result && (
                  <div className={`flex items-start gap-2.5 rounded-lg p-3 text-sm ${result.ok ? "bg-[#00C9A7]/10 border border-[#00C9A7]/30" : "bg-red-500/10 border border-red-500/30"}`}>
                    {result.ok
                      ? <CheckIcon className="w-4 h-4 text-[#00C9A7] mt-0.5 shrink-0" />
                      : <AlertIcon className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />}
                    <span className={result.ok ? "text-[#00C9A7]" : "text-red-300"}>{result.ok ? result.message : result.error}</span>
                  </div>
                )}
              </div>
            </Step>

            <Step n={4} title="Activa en producción (una vez listo)">
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Para que las alertas persistan (no se pierdan al reiniciar el servidor), agrega los secrets:</p>
                <div className="space-y-1.5">
                  <CopyCode code="TELEGRAM_BOT_TOKEN" />
                  <CopyCode code="TELEGRAM_CHAT_ID" />
                </div>
                <p className="text-xs">Ve a la configuración del proyecto → Secrets, y agrega ambos con los valores de arriba.</p>
              </div>
            </Step>
          </div>
        </div>

        {/* Security note */}
        <div className="flex items-start gap-3 bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
          <ShieldIcon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="text-amber-400 font-semibold">Nota de seguridad:</span> El token del bot solo lo ingresás aquí para la prueba — no se guarda en el código. Para uso permanente se debe guardar como secret encriptado.
          </p>
        </div>

        {/* Telegram link */}
        <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-colors group">
          <div className="flex items-center gap-3">
            <PhoneIcon className="w-5 h-5 text-primary" />
            <div>
              <div className="font-semibold text-sm text-foreground">Abrir @BotFather en Telegram</div>
              <div className="text-xs text-muted-foreground">t.me/BotFather</div>
            </div>
          </div>
          <LinkIcon className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </a>

      </div>
    </Layout>
  );
}
