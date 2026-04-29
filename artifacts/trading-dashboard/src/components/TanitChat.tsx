import { useState, useEffect, useRef, useCallback } from "react";
import { BASE_URL } from "@/lib/api";

type ChatMessage = {
  role: "user" | "ai";
  text: string;
  actions?: string[];
  imagePreview?: string;
  imagePreviews?: string[];
  ts: number;
};

const TEAL   = "#00E5CC";
const PURPLE = "#8B5CF6";
const AMBER  = "#F5A623";
const ROSE   = "#F23645";

function TanitOrb({ size = 40, pulse = false }: { size?: number; pulse?: boolean }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      position: "relative",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        position: "absolute", inset: 0, borderRadius: "50%",
        border: `1px solid rgba(0,229,204,0.22)`,
        animation: pulse ? "tanit-ring-out 2s ease-in-out infinite" : "none",
      }} />
      <div style={{
        position: "absolute", inset: Math.floor(size * 0.12),
        borderRadius: "50%",
        border: `1px solid rgba(0,229,204,0.35)`,
        animation: pulse ? "tanit-ring-out 2s ease-in-out 0.4s infinite" : "none",
      }} />
      <div style={{
        width: size * 0.55, height: size * 0.55,
        borderRadius: "50%",
        background: "linear-gradient(135deg, #00E5CC 0%, #00A882 45%, #7C4DFF 100%)",
        boxShadow: pulse
          ? "0 0 20px rgba(0,229,204,0.5), 0 0 40px rgba(0,229,204,0.2)"
          : "0 0 14px rgba(0,229,204,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: pulse ? "tanit-core-breathe 2s ease-in-out infinite" : "none",
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: "'Plus Jakarta Sans', system-ui",
          fontWeight: 800, fontSize: size * 0.22,
          color: "#020810", letterSpacing: "-0.3px",
        }}>T</span>
      </div>
    </div>
  );
}

export function TanitChat() {
  const [botStatus, setBotStatus]   = useState<any>(null);
  const isRunning                   = !!botStatus?.active;
  const [togglePending, setTogglePending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/status`);
        if (r.ok && !cancelled) setBotStatus(await r.json());
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const onToggle = async () => {
    setTogglePending(true);
    try {
      await fetch(`${BASE_URL}api/bot/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !isRunning }),
      });
    } catch {} finally { setTogglePending(false); }
  };

  const [input, setInput]         = useState("");
  const [interimText, setInterimText] = useState("");
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [sending, setSending]     = useState(false);
  const [chatOpen, setChatOpen]   = useState(false);
  const [expanded, setExpanded]   = useState(false);
  const [listening, setListening] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [tanitMode, setTanitMode] = useState<"casual" | "profesional">(() =>
    (localStorage.getItem("tanit_mode") as "casual" | "profesional") ?? "casual"
  );
  const [pendingImages, setPendingImages] = useState<{
    base64: string; mimeType: string; preview: string;
  }[]>([]);

  const toggleMode = () => {
    const next = tanitMode === "casual" ? "profesional" : "casual";
    setTanitMode(next);
    localStorage.setItem("tanit_mode", next);
  };

  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const chatRef    = useRef<HTMLDivElement>(null);
  const recognRef  = useRef<any>(null);
  const fileRef    = useRef<HTMLInputElement>(null);

  /* ── imagen desde archivo ── */
  const loadImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target?.result as string;
      const base64 = dataUrl.split(",")[1];
      setPendingImages(prev => [...prev, { base64, mimeType: file.type, preview: dataUrl }]);
      setExpanded(true);
      setTimeout(() => inputRef.current?.focus(), 150);
    };
    reader.readAsDataURL(file);
  };

  const loadMultipleFiles = (files: FileList) => {
    Array.from(files).forEach(loadImageFile);
  };

  /* ── paste de screenshot desde portapapeles ── */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let found = false;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) { e.preventDefault(); loadImageFile(file); found = true; }
        }
      }
      if (found) return;
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    if (historyLoaded) return;
    (async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/tanit-history`);
        if (r.ok) {
          const d = await r.json();
          if (d.messages && d.messages.length > 0) {
            const loaded: ChatMessage[] = d.messages
              .filter((m: any) => !m.content?.startsWith("[SISTEMA —") && !m.content?.startsWith("CICLO_AUTO_EVOLUCIÓN"))
              .map((m: any) => ({
                role: m.role === "user" ? "user" as const : "ai" as const,
                text: m.content,
                actions: m.actions ? m.actions.split("; ") : undefined,
                ts: new Date(m.createdAt).getTime(),
              }));
            setMessages(loaded);
            setChatOpen(true);
          }
        }
      } catch {}
      setHistoryLoaded(true);
    })();
  }, [historyLoaded]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, expanded]);

  useEffect(() => {
    if (expanded && inputRef.current) setTimeout(() => inputRef.current?.focus(), 150);
  }, [expanded]);

  const send = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim();
    if ((!msg && pendingImages.length === 0) || sending) return;
    if (listening) { recognRef.current?.stop(); setListening(false); setInterimText(""); }
    const imgsToSend = [...pendingImages];
    setInput("");
    setInterimText("");
    setPendingImages([]);
    setSending(true);
    setChatOpen(true);
    setExpanded(true);
    const displayMsg = msg || (imgsToSend.length === 1 ? "📸 [imagen adjunta]" : `📸 [${imgsToSend.length} imágenes adjuntas]`);
    setMessages(prev => [...prev, {
      role: "user",
      text: displayMsg,
      imagePreviews: imgsToSend.length > 0 ? imgsToSend.map(i => i.preview) : undefined,
      ts: Date.now(),
    }]);
    try {
      const body: any = { message: msg || "Analiza estas imágenes.", mode: tanitMode };
      if (imgsToSend.length === 1) {
        body.imageBase64   = imgsToSend[0].base64;
        body.imageMimeType = imgsToSend[0].mimeType;
      } else if (imgsToSend.length > 1) {
        body.images = imgsToSend.map(i => ({ base64: i.base64, mimeType: i.mimeType }));
      }
      const r = await fetch(`${BASE_URL}api/bot/gemini-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setMessages(prev => [...prev, {
        role: "ai",
        text: d.reply ?? "Sin respuesta.",
        actions: d.actionsExecuted ?? [],
        ts: Date.now(),
      }]);
    } catch {
      setMessages(prev => [...prev, { role: "ai", text: "Error de conexión.", ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, listening, tanitMode, pendingImages]);

  const toggleVoice = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;

    if (listening) {
      recognRef.current?.stop();
      setListening(false);
      setInterimText("");
      return;
    }

    setExpanded(true);
    const r = new SR();
    r.lang = "es-MX";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart  = () => setListening(true);
    r.onend    = () => { setListening(false); setInterimText(""); };
    r.onerror  = () => { setListening(false); setInterimText(""); };
    r.onresult = (e: any) => {
      let finalText = "";
      let interimT  = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText  += e.results[i][0].transcript;
        else                       interimT   += e.results[i][0].transcript;
      }
      if (finalText) setInput(prev => (prev + " " + finalText).trim());
      setInterimText(interimT);
    };

    recognRef.current = r;
    r.start();
  }, [listening]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const hasMsgs = chatOpen && messages.length > 0;
  const displayText = listening && interimText ? interimText : "";

  return (
    <>
      <div className="tanit-bar-root">

        {hasMsgs && expanded && (
          <div style={{
            pointerEvents: "auto",
            width: "100%",
            padding: "0",
          }}>
            <div style={{
              background: "rgba(6,4,15,0.97)",
              backdropFilter: "blur(32px) saturate(160%)",
              borderRadius: "20px 20px 0 0",
              border: "1px solid rgba(255,255,255,0.06)",
              borderBottom: "none",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
            }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 14px 6px",
              }}>
                <span style={{
                  fontFamily: "'Plus Jakarta Sans', system-ui",
                  fontSize: 9, fontWeight: 700, letterSpacing: "0.2em",
                  color: "rgba(0,229,204,0.35)",
                }}>TANIT</span>
                <button
                  onClick={() => setExpanded(false)}
                  style={{
                    border: "none", background: "transparent",
                    color: "rgba(255,255,255,0.2)", cursor: "pointer",
                    fontSize: 12, padding: "2px 6px",
                    borderRadius: 6,
                  }}>✕</button>
              </div>

              <div ref={chatRef} style={{
                maxHeight: 340,
                overflowY: "auto",
                padding: "4px 14px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                scrollbarWidth: "none",
              }}>
                {messages.map((m, i) => (
                  <div key={i} style={{
                    display: "flex",
                    justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                    alignItems: "flex-end",
                    gap: 8,
                  }}>
                    {m.role === "ai" && (
                      <TanitOrb size={26} />
                    )}
                    <div style={{
                      maxWidth: "80%",
                      padding: (m.imagePreviews?.length || m.imagePreview) ? "6px 6px 8px 6px" : "8px 12px",
                      borderRadius: m.role === "user" ? "14px 14px 3px 14px" : "14px 14px 14px 3px",
                      background: m.role === "user"
                        ? "linear-gradient(135deg, rgba(0,229,204,0.14), rgba(124,77,255,0.08))"
                        : "rgba(255,255,255,0.04)",
                      border: m.role === "user"
                        ? "1px solid rgba(0,229,204,0.20)"
                        : "1px solid rgba(255,255,255,0.06)",
                      fontSize: 13,
                      color: m.role === "user" ? "#e0fff8" : "rgba(255,255,255,0.78)",
                      lineHeight: 1.5,
                      fontFamily: "'Plus Jakarta Sans', system-ui",
                      boxShadow: m.role === "user"
                        ? "0 2px 16px rgba(0,229,204,0.08)"
                        : "none",
                    }}>
                      {/* múltiples imágenes */}
                      {m.imagePreviews && m.imagePreviews.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                          {m.imagePreviews.map((src, j) => (
                            <img key={j} src={src} alt="adjunto"
                              style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(0,229,204,0.15)" }}
                            />
                          ))}
                        </div>
                      )}
                      {/* imagen única legacy */}
                      {!m.imagePreviews && m.imagePreview && (
                        <img
                          src={m.imagePreview}
                          alt="screenshot"
                          style={{
                            display: "block",
                            width: "100%", maxWidth: 220,
                            borderRadius: 10, marginBottom: m.text && m.text !== "📸 [imagen adjunta]" ? 6 : 0,
                            border: "1px solid rgba(0,229,204,0.15)",
                          }}
                        />
                      )}
                      {!m.text.startsWith("📸 [imagen") && <span style={{ padding: (m.imagePreviews?.length || m.imagePreview) ? "0 6px" : undefined }}>{m.text}</span>}
                      {m.role === "ai" && m.actions && m.actions.length > 0 && (
                        <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {m.actions.map((a, j) => (
                            <span key={j} style={{
                              fontSize: 9, padding: "2px 7px", borderRadius: 8,
                              background: "rgba(0,229,204,0.07)",
                              color: TEAL,
                              border: "1px solid rgba(0,229,204,0.18)",
                              fontFamily: "'Plus Jakarta Sans', system-ui",
                              fontWeight: 600,
                            }}>✓ {a}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                    <TanitOrb size={26} pulse />
                    <div style={{
                      padding: "10px 14px",
                      borderRadius: "14px 14px 14px 3px",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      display: "flex", gap: 5, alignItems: "center",
                    }}>
                      {[0,1,2].map(i => (
                        <span key={i} style={{
                          width: 5, height: 5, borderRadius: "50%",
                          background: TEAL, opacity: 0.6,
                          display: "inline-block",
                          animation: `tanit-dot 1.2s ease-in-out ${i*0.18}s infinite`,
                        }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div style={{
          pointerEvents: "auto",
          background: "rgba(6,4,15,0.96)",
          backdropFilter: "blur(32px) saturate(180%)",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          boxShadow: "0 -1px 0 rgba(0,229,204,0.04), 0 -20px 60px rgba(0,0,0,0.3)",
        }}>
          <div style={{
            width: "100%",
            padding: "10px 16px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}>

            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: expanded
                ? "rgba(255,255,255,0.03)"
                : "linear-gradient(135deg, rgba(0,229,204,0.05) 0%, rgba(124,77,255,0.04) 100%)",
              borderRadius: 18,
              border: expanded
                ? "1px solid rgba(255,255,255,0.08)"
                : "1px solid rgba(0,229,204,0.14)",
              padding: "8px 10px 8px 10px",
              cursor: expanded ? "default" : "text",
              boxShadow: expanded
                ? "none"
                : "0 4px 24px rgba(0,0,0,0.25), 0 1px 0 rgba(255,255,255,0.03)",
              transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
              minHeight: 50,
            }}
              onClick={() => { if (!expanded) setExpanded(true); }}
            >
              <TanitOrb size={36} pulse={listening || sending} />

              <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
                {expanded ? (
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder={listening ? "Escuchando... habla con calma" : "Escribe o habla con Tanit..."}
                    rows={1}
                    style={{
                      width: "100%",
                      resize: "none",
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      color: "#e8f4ff",
                      fontSize: 14,
                      lineHeight: "22px",
                      fontFamily: "'Plus Jakarta Sans', system-ui",
                      caretColor: TEAL,
                      maxHeight: 80,
                      overflowY: "auto",
                      scrollbarWidth: "none",
                    }}
                  />
                ) : (
                  <div style={{
                    fontSize: 14,
                    color: "rgba(255,255,255,0.30)",
                    fontFamily: "'Plus Jakarta Sans', system-ui",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    lineHeight: "22px",
                    paddingTop: 6,
                  }}>
                    {messages.length > 0
                      ? messages[messages.length - 1].text.slice(0, 50) + (messages[messages.length - 1].text.length > 50 ? "…" : "")
                      : "Habla con Tanit..."}
                  </div>
                )}
                {listening && interimText && (
                  <div style={{
                    position: "absolute", bottom: -16, left: 0,
                    fontSize: 10, color: "rgba(0,229,204,0.5)",
                    fontFamily: "'Plus Jakarta Sans', system-ui",
                    fontStyle: "italic",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    maxWidth: "100%",
                  }}>{interimText}</div>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>

                {/* Fotos / screenshots — multiple */}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={e => { if (e.target.files?.length) loadMultipleFiles(e.target.files); e.target.value = ""; }}
                />
                <button
                  onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
                  title="Adjuntar fotos o screenshots (múltiple)"
                  style={{
                    width: 34, height: 34, borderRadius: 11,
                    border: pendingImages.length > 0
                      ? "1px solid rgba(0,229,204,0.50)"
                      : "1px solid rgba(255,255,255,0.08)",
                    background: pendingImages.length > 0
                      ? "rgba(0,229,204,0.12)"
                      : "rgba(255,255,255,0.04)",
                    color: pendingImages.length > 0 ? TEAL : "rgba(255,255,255,0.35)",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, transition: "all 0.2s", flexShrink: 0,
                    position: "relative",
                  }}>
                  📎
                  {pendingImages.length > 1 && (
                    <span style={{
                      position: "absolute", top: -4, right: -4,
                      width: 14, height: 14, borderRadius: "50%",
                      background: TEAL, color: "#030810",
                      fontSize: 8, fontWeight: 800,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>{pendingImages.length}</span>
                  )}
                </button>

                {/* Micrófono */}
                <button
                  onClick={e => { e.stopPropagation(); toggleVoice(); }}
                  style={{
                    width: 34, height: 34,
                    borderRadius: 11,
                    border: listening
                      ? `1px solid rgba(0,229,204,0.40)`
                      : "1px solid rgba(255,255,255,0.08)",
                    background: listening
                      ? "rgba(0,229,204,0.10)"
                      : "rgba(255,255,255,0.04)",
                    color: listening ? TEAL : "rgba(255,255,255,0.35)",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14,
                    transition: "all 0.2s",
                    animation: listening ? "tanit-ring-out 1.8s ease-in-out infinite" : "none",
                    flexShrink: 0,
                  }}>
                  {listening ? "⏹" : "🎙"}
                </button>

                {/* Enviar */}
                <button
                  onClick={e => { e.stopPropagation(); send(); }}
                  disabled={(!input.trim() && !interimText && pendingImages.length === 0) || sending}
                  style={{
                    width: 34, height: 34,
                    borderRadius: 11,
                    border: "none",
                    background: (input.trim() || interimText || pendingImages.length > 0) && !sending
                      ? "linear-gradient(135deg, #00E5CC, #00A882)"
                      : "rgba(255,255,255,0.05)",
                    color: (input.trim() || interimText || pendingImages.length > 0) && !sending ? "#030810" : "rgba(255,255,255,0.15)",
                    cursor: (input.trim() || interimText || pendingImages.length > 0) && !sending ? "pointer" : "default",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 800,
                    boxShadow: (input.trim() || interimText || pendingImages.length > 0) && !sending
                      ? "0 2px 12px rgba(0,229,204,0.35)"
                      : "none",
                    transition: "all 0.2s",
                    flexShrink: 0,
                  }}>
                  ↑
                </button>
              </div>
            </div>

            {/* Thumbnails de imágenes pendientes — múltiple */}
            {pendingImages.length > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 8px",
                background: "rgba(0,229,204,0.05)",
                border: "1px solid rgba(0,229,204,0.15)",
                borderRadius: 12,
                flexWrap: "wrap",
              }}>
                {pendingImages.map((img, idx) => (
                  <div key={idx} style={{ position: "relative", flexShrink: 0 }}>
                    <img
                      src={img.preview}
                      alt={`foto ${idx + 1}`}
                      style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(0,229,204,0.2)", display: "block" }}
                    />
                    <button
                      onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== idx))}
                      style={{
                        position: "absolute", top: -5, right: -5,
                        width: 16, height: 16, borderRadius: "50%", border: "none",
                        background: "rgba(242,54,69,0.9)", color: "#fff",
                        cursor: "pointer", fontSize: 8, fontWeight: 800,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        lineHeight: 1,
                      }}>✕</button>
                  </div>
                ))}
                <div style={{ flex: 1, minWidth: 80 }}>
                  <div style={{ fontFamily: "'Plus Jakarta Sans', system-ui", fontSize: 11, color: TEAL, fontWeight: 600 }}>
                    {pendingImages.length === 1 ? "1 imagen lista" : `${pendingImages.length} imágenes listas`}
                  </div>
                  <div style={{ fontFamily: "'Plus Jakarta Sans', system-ui", fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                    Escribe algo o envía directo
                  </div>
                </div>
                <button
                  onClick={() => setPendingImages([])}
                  style={{
                    width: 22, height: 22, borderRadius: 6, border: "none",
                    background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)",
                    cursor: "pointer", fontSize: 11, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>✕</button>
              </div>
            )}

            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 2px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  onClick={onToggle}
                  disabled={togglePending}
                  style={{
                    height: 24, padding: "0 10px",
                    borderRadius: 8,
                    border: isRunning
                      ? "1px solid rgba(0,229,204,0.30)"
                      : "1px solid rgba(245,166,35,0.30)",
                    background: isRunning
                      ? "rgba(0,229,204,0.06)"
                      : "rgba(245,166,35,0.07)",
                    color: isRunning ? TEAL : AMBER,
                    cursor: togglePending ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", gap: 5,
                    opacity: togglePending ? 0.5 : 1,
                    fontSize: 9, fontWeight: 700,
                    fontFamily: "'Plus Jakarta Sans', system-ui",
                    letterSpacing: "0.08em",
                    transition: "all 0.2s",
                  }}>
                  <div style={{
                    width: 5, height: 5, borderRadius: "50%",
                    background: isRunning ? TEAL : AMBER,
                    boxShadow: isRunning ? `0 0 5px ${TEAL}` : `0 0 5px ${AMBER}`,
                    animation: isRunning ? "tanit-dot-live 1.5s ease-in-out infinite" : "none",
                  }} />
                  {isRunning ? "BOT ACTIVO" : "BOT PAUSADO"}
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {expanded && hasMsgs && (
                  <button
                    onClick={() => setExpanded(false)}
                    style={{
                      height: 24, padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.07)",
                      background: "rgba(255,255,255,0.03)",
                      color: "rgba(255,255,255,0.28)",
                      cursor: "pointer",
                      fontSize: 9, fontWeight: 600,
                      fontFamily: "'Plus Jakarta Sans', system-ui",
                      letterSpacing: "0.06em",
                    }}>
                    OCULTAR
                  </button>
                )}

                <button
                  onClick={toggleMode}
                  title={tanitMode === "casual" ? "Cambiar a modo profesional" : "Cambiar a modo casual"}
                  style={{
                    height: 24, padding: "0 10px",
                    borderRadius: 8,
                    border: tanitMode === "profesional"
                      ? "1px solid rgba(245,166,35,0.30)"
                      : "1px solid rgba(139,92,246,0.25)",
                    background: tanitMode === "profesional"
                      ? "rgba(245,166,35,0.07)"
                      : "rgba(139,92,246,0.06)",
                    color: tanitMode === "profesional" ? "#F5A623" : PURPLE,
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 4,
                    fontSize: 9, fontWeight: 700,
                    fontFamily: "'Plus Jakarta Sans', system-ui",
                    letterSpacing: "0.07em",
                    transition: "all 0.2s",
                  }}>
                  {tanitMode === "profesional" ? "💼 PROFESIONAL" : "💬 CASUAL"}
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      <style>{`
        @keyframes tanit-dot {
          0%,100% { opacity:0.25; transform:scale(0.7); }
          50% { opacity:1; transform:scale(1.15); }
        }
        @keyframes tanit-dot-live {
          0%,100% { opacity:0.7; transform:scale(1); }
          50% { opacity:1; transform:scale(1.4); }
        }
        @keyframes tanit-ring-out {
          0%,100% { transform:scale(1); opacity:0.6; }
          50% { transform:scale(1.06); opacity:1; }
        }
        @keyframes tanit-core-breathe {
          0%,100% { box-shadow: 0 0 14px rgba(0,229,204,0.35); }
          50% { box-shadow: 0 0 28px rgba(0,229,204,0.6), 0 0 50px rgba(0,229,204,0.2); }
        }
        @keyframes tanit-mic-pulse {
          0%,100% { box-shadow: 0 0 0 rgba(255,107,107,0.3); }
          50% { box-shadow: 0 0 12px rgba(255,107,107,0.5); }
        }
        div[style*="overflow-y: auto"]::-webkit-scrollbar { display:none; }
      `}</style>
    </>
  );
}
