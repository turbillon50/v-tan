import { useState, useEffect } from "react";

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<"in" | "hold" | "out">("in");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("hold"), 200);
    const t2 = setTimeout(() => setPhase("out"), 1600);
    const t3 = setTimeout(() => onDone(), 2100);

    let start: number | null = null;
    const duration = 2200;
    const raf = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      setProgress(p);
      if (p < 1) requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  const visible = phase !== "out";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "radial-gradient(ellipse 80% 60% at 50% 40%, #0d1628 0%, #080c14 55%, #050810 100%)",
      display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
      gap: 0,
      opacity: visible ? 1 : 0,
      transition: "opacity 0.65s cubic-bezier(0.4,0,0.2,1)",
      pointerEvents: visible ? "auto" : "none",
    }}>

      <div style={{
        position: "absolute", inset: 0, overflow: "hidden",
        pointerEvents: "none",
      }}>
        <div style={{
          position: "absolute",
          width: 600, height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(0,229,204,0.06) 0%, transparent 70%)",
          top: "50%", left: "50%",
          transform: "translate(-50%,-50%)",
          animation: "splash-orb-pulse 3s ease-in-out infinite",
        }} />
        <div style={{
          position: "absolute",
          width: 900, height: 900,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(124,77,255,0.04) 0%, transparent 65%)",
          top: "50%", left: "50%",
          transform: "translate(-50%,-50%)",
          animation: "splash-orb-pulse 4s ease-in-out 0.5s infinite",
        }} />
      </div>

      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 0,
        opacity: phase === "in" ? 0 : 1,
        transform: phase === "in" ? "scale(0.88) translateY(12px)" : "scale(1) translateY(0)",
        transition: "all 0.85s cubic-bezier(0.22,1,0.36,1)",
      }}>

        <div style={{ position: "relative", width: 100, height: 100, marginBottom: 8 }}>
          <div style={{
            position: "absolute", inset: 0,
            borderRadius: "50%",
            border: "1px solid rgba(0,229,204,0.12)",
            animation: "splash-ring 2.8s ease-in-out infinite",
          }} />
          <div style={{
            position: "absolute", inset: 8,
            borderRadius: "50%",
            border: "1px solid rgba(0,229,204,0.20)",
            animation: "splash-ring 2.8s ease-in-out 0.3s infinite",
          }} />
          <div style={{
            position: "absolute", inset: 18,
            borderRadius: "50%",
            border: "1.5px solid rgba(0,229,204,0.35)",
            animation: "splash-ring 2.8s ease-in-out 0.6s infinite",
          }} />
          <div style={{
            position: "absolute", inset: 28,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #00E5CC 0%, #00A882 50%, #7C4DFF 100%)",
            boxShadow: "0 0 40px rgba(0,229,204,0.4), 0 0 80px rgba(0,229,204,0.15)",
            display: "flex", alignItems: "center", justifyContent: "center",
            animation: "splash-core-pulse 2s ease-in-out infinite",
          }}>
            <span style={{
              fontFamily: "'Plus Jakarta Sans', system-ui",
              fontWeight: 700, fontSize: 18,
              color: "#020810",
              letterSpacing: "-0.5px",
            }}>T</span>
          </div>
        </div>

        <div style={{
          fontFamily: "'Plus Jakarta Sans', system-ui",
          fontSize: 38, fontWeight: 200,
          color: "#ffffff",
          letterSpacing: "-2px",
          lineHeight: 1,
          display: "flex", alignItems: "baseline", gap: 0,
        }}>
          <span>M</span>
          <span style={{
            background: "linear-gradient(135deg, #00E676 0%, #00BCD4 50%, #7C4DFF 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            fontWeight: 300,
          }}>2</span>
          <span>M</span>
        </div>

        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <div style={{
            fontFamily: "'Plus Jakarta Sans', system-ui",
            fontWeight: 700, fontSize: 9,
            color: "rgba(0,229,204,0.55)",
            letterSpacing: "0.32em",
          }}>MONEY MAKER</div>
          <div style={{
            fontFamily: "'Plus Jakarta Sans', system-ui",
            fontWeight: 400, fontSize: 8,
            color: "rgba(255,255,255,0.20)",
            letterSpacing: "0.22em",
          }}>IA TRADING · HYBRID ENGINE</div>
        </div>

        <div style={{
          marginTop: 6, display: "flex", alignItems: "center", gap: 4,
          opacity: 0.6,
        }}>
          <div style={{
            width: 4, height: 4, borderRadius: "50%",
            background: "#00E5CC",
            animation: "splash-dot 1.4s ease-in-out infinite",
          }} />
          <div style={{
            fontFamily: "'Plus Jakarta Sans', system-ui",
            fontSize: 9, fontWeight: 500,
            color: "rgba(0,229,204,0.5)",
            letterSpacing: "0.1em",
          }}>TANIT · AI COMMANDER</div>
        </div>
      </div>

      <div style={{
        position: "absolute",
        bottom: 48, left: "50%",
        transform: "translateX(-50%)",
        width: 160,
      }}>
        <div style={{
          width: "100%", height: 1.5,
          background: "rgba(255,255,255,0.06)",
          borderRadius: 2,
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: `${progress * 100}%`,
            background: "linear-gradient(90deg, #00E5CC, #7C4DFF)",
            borderRadius: 2,
            boxShadow: "0 0 8px rgba(0,229,204,0.5)",
            transition: "width 0.05s linear",
          }} />
        </div>
      </div>

      <style>{`
        @keyframes splash-orb-pulse {
          0%,100% { transform: translate(-50%,-50%) scale(1); opacity:0.8; }
          50% { transform: translate(-50%,-50%) scale(1.1); opacity:1; }
        }
        @keyframes splash-ring {
          0%,100% { transform: scale(1); opacity:0.7; }
          50% { transform: scale(1.04); opacity:1; }
        }
        @keyframes splash-core-pulse {
          0%,100% { box-shadow: 0 0 40px rgba(0,229,204,0.4), 0 0 80px rgba(0,229,204,0.15); }
          50% { box-shadow: 0 0 55px rgba(0,229,204,0.6), 0 0 100px rgba(0,229,204,0.25); }
        }
        @keyframes splash-dot {
          0%,100% { transform: scale(1); opacity:0.6; }
          50% { transform: scale(1.5); opacity:1; }
        }
      `}</style>
    </div>
  );
}
