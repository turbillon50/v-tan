interface IconProps {
  className?: string;
  size?: number;
  color?: string;
}

/* ── M2M LOGO — full wordmark ─────────────────────────────── */
export function AllLogoIcon({ className, size = 32 }: IconProps) {
  const id = `m2m-g-${size}`;
  return (
    <svg className={className} width={size * 2.4} height={size} viewBox="0 0 96 36" fill="none">
      <defs>
        <linearGradient id={id} x1="30" y1="0" x2="66" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00FFE5"/>
          <stop offset="50%" stopColor="#00D4B4"/>
          <stop offset="100%" stopColor="#00BCD4"/>
        </linearGradient>
      </defs>
      <text x="0" y="28" fill="#ffffff" fontWeight="300" fontSize="30"
        fontFamily="'Inter','Plus Jakarta Sans',system-ui" letterSpacing="-0.5">M</text>
      <text x="28" y="28" fill={`url(#${id})`} fontWeight="600" fontSize="30"
        fontFamily="'Inter','Plus Jakarta Sans',system-ui">2</text>
      <text x="44" y="28" fill="#ffffff" fontWeight="300" fontSize="30"
        fontFamily="'Inter','Plus Jakarta Sans',system-ui" letterSpacing="-0.5">M</text>
    </svg>
  );
}

export function M2MLogoFull({ size = 42 }: { size?: number }) {
  const sc = size / 42;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}
      className="m2m-logo-entrance">
      <svg width={96 * sc} height={42 * sc} viewBox="0 0 96 42" fill="none">
        <defs>
          <linearGradient id="m2m-full-g" x1="28" y1="0" x2="68" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00FFE5"/>
            <stop offset="50%" stopColor="#00D4B4"/>
            <stop offset="100%" stopColor="#00BCD4"/>
          </linearGradient>
        </defs>
        <text x="0" y="33" fill="#ffffff" fontWeight="300" fontSize="36"
          fontFamily="'Inter','Plus Jakarta Sans',system-ui" letterSpacing="-0.5">M</text>
        <text x="30" y="33" fill="url(#m2m-full-g)" fontWeight="600" fontSize="36"
          fontFamily="'Inter','Plus Jakarta Sans',system-ui">2</text>
        <text x="50" y="33" fill="#ffffff" fontWeight="300" fontSize="36"
          fontFamily="'Inter','Plus Jakarta Sans',system-ui" letterSpacing="-0.5">M</text>
      </svg>
    </div>
  );
}

type SvgIconProps = { className?: string; size?: number; color?: string; style?: React.CSSProperties };

/* ── NAV ICONS — Bybit-style, thin stroke ─────────────────── */
export function PanelIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <rect x="3" y="3" width="8" height="9" rx="1.5"/>
      <rect x="13" y="3" width="8" height="5" rx="1.5"/>
      <rect x="13" y="10" width="8" height="11" rx="1.5"/>
      <rect x="3" y="14" width="8" height="7" rx="1.5"/>
    </svg>
  );
}

export function HistorialIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
      <line x1="8" y1="17" x2="12" y2="17"/>
    </svg>
  );
}

export function CurveIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}

export function RiskShieldIcon({ className, size = 20, color }: IconProps) {
  const c = color ?? "currentColor";
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L20 6v7c0 4.5-3.5 8-8 9C7.5 21 4 17.5 4 13V6Z"/>
      <polyline points="9 12 11 14 15 10"/>
    </svg>
  );
}

/* ── UTILITY ICONS ─────────────────────────────────────────── */
export function TerminalIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <polyline points="4 17 10 11 4 5"/>
      <line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
  );
}

export function BotIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <path d="M12 2v4"/>
      <rect x="4" y="6" width="16" height="12" rx="2"/>
      <circle cx="9" cy="12" r="1.5" fill={color} stroke="none"/>
      <circle cx="15" cy="12" r="1.5" fill={color} stroke="none"/>
      <path d="M9 16h6"/>
      <path d="M2 10v4M22 10v4"/>
    </svg>
  );
}

export function CapitalIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <line x1="12" y1="1" x2="12" y2="23"/>
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  );
}

export function BacktestIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}

export function AlertaIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  );
}

export function FurtivoIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

export function ManualIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      <line x1="9" y1="7" x2="15" y2="7"/>
      <line x1="9" y1="11" x2="13" y2="11"/>
    </svg>
  );
}

export function SettingsIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

export function BriefingIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </svg>
  );
}

export function StrategyIcon({ size = 20, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={`relative inline-flex ${className ?? ""}`}>
      <span className="live-dot-outer" />
      <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: "#00D4B4" }}/>
    </span>
  );
}

export function SharkIcon({ className, size = 20 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M2 18C6 18 8 4 12 4C13 4 14 8 15 10C17 7 19 6 22 6L22 18Z" opacity="0.9"/>
    </svg>
  );
}

export function SignalIcon({ className, size = 20 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="2" y="16" width="4" height="6" rx="1" opacity="0.3"/>
      <rect x="7" y="11" width="4" height="11" rx="1" opacity="0.55"/>
      <rect x="12" y="6" width="4" height="16" rx="1" opacity="0.8"/>
      <rect x="17" y="2" width="4" height="20" rx="1"/>
    </svg>
  );
}

export function InfoIcon({ size = 16, color = "currentColor", className, style }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  );
}

export function CrystalPlusIcon({ size = 24, open = false }: { size?: number; open?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="rgba(178,255,248,0.92)" strokeWidth="2" strokeLinecap="round"
      style={{
        transition: "transform 0.4s cubic-bezier(0.22,1,0.36,1)",
        transform: open ? "rotate(45deg)" : "rotate(0deg)",
        filter: "drop-shadow(0 0 6px rgba(0,212,180,0.4))",
        position: "relative", zIndex: 2,
      }}>
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}
