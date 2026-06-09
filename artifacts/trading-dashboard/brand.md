# M2M Trading — Brand Identity Module
> Generado automáticamente del codebase. Fuente de verdad para el rearmado VForge.

---

## Identidad

**Producto:** M2M Algorithmic Trading Dashboard  
**Tagline implícito:** Motor autónomo de señales Fibonacci + Whale Hours + Gemini AI  
**Tono visual:** Fintech premium dark-first — profesional, técnico, confianza en lo nocturno  
**Emoción objetivo:** Control total. El mercado visto desde arriba.

---

## Logo

| Asset | Ruta | Uso |
|-------|------|-----|
| Favicon | `public/favicon.svg` | Browser tab |
| Ícono M2M | `public/icon-mm.svg` | 512×512 — PWA, splash |
| Nav icons | `public/icons/nav-*.png` | Sidebar navigation (8 íconos) |
| Tanit form | `public/tanit-form.png` | Identidad Tanit |
| ALL icon | `public/icon-all.png` | Dashboard hero icon |

Gradiente del logo M2M:
```
linear-gradient(135deg, #00FFE5 0%, #00D4B4 50%, #00BCD4 100%)
```

---

## Paleta de Colores

### Colores de Marca (`--m2m-*`)

| Token | Hex | Uso |
|-------|-----|-----|
| `--m2m-teal` | `#00D4B4` | **Primario** — CTAs, accents, líneas activas |
| `--m2m-teal2` | `#00BCD4` | Secundario — gradientes, bordes hover |
| `--m2m-green` | `#0ECB81` | Éxito — trades ganadores, PnL positivo |
| `--m2m-red` | `#F6465D` | Peligro — trades perdedores, alertas críticas |
| `--m2m-amber` | `#F5A623` | Advertencia — SL cerca, drawdown |
| `--m2m-bg` | `#080c14` | **Fondo profundo** — background base |
| `--m2m-surface` | `#0d1421` | Surface — cards, panels |
| `--m2m-panel` | `#0a111e` | Panel — sidebar, overlays |
| `--m2m-border` | `rgba(255,255,255,0.07)` | Bordes primarios |
| `--m2m-border2` | `rgba(255,255,255,0.04)` | Bordes sutiles |
| `--m2m-text` | `#EAECEF` | Texto principal |
| `--m2m-muted` | `#848E9C` | Texto secundario/muted |

### Acento Especial (gradiente tricolor)
```
linear-gradient(135deg, #00E676 0%, #00BCD4 50%, #7C4DFF 100%)
```
Usado en ilustraciones, iconos 3D, hover states premium.

### Colores Semánticos del Trading

| Contexto | Color | Hex |
|----------|-------|-----|
| Win / Gain | Teal-green | `#0ECB81` |
| Loss / Risk | Red-rose | `#F6465D` |
| Warning / SL | Amber | `#F5A623` |
| Neutral / Info | Teal | `#00D4B4` |
| Elite signal | Cyan bright | `#00E5CC` |
| Propose / Pending | Yellow | `#F5C518` |

---

## Tipografía

| Rol | Familia | Pesos | Variable CSS |
|-----|---------|-------|-------------|
| **Sans principal** | Inter | 300–800 | `var(--app-font-sans)` |
| **Sans alternativa** | Plus Jakarta Sans | 300–800 | `var(--app-font-sans)` |
| **Monospace / datos** | JetBrains Mono | 400–700 | `var(--app-font-mono)` |

**Uso:**
- Headings: Inter 700, letter-spacing `-0.02em`
- Body: Inter 400/500, 14px base
- Números / precios / datos: JetBrains Mono 400–600
- Labels uppercase: JetBrains Mono 700, letter-spacing `0.08–0.14em`

---

## Efectos Visuales de Marca

### Glassmorphism (`.card-glass`)
```css
background: var(--m2m-surface);
border: 1px solid rgba(255,255,255,0.07);
box-shadow: 0 1px 3px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(255,255,255,0.02) inset;
border-radius: 12–16px;
```

### Glow Effects
```css
/* Teal glow (primario) */
box-shadow: 0 0 20px rgba(0,212,180,0.3), 0 0 60px rgba(0,212,180,0.08);

/* Green glow (win) */
box-shadow: 0 0 20px rgba(14,203,129,0.25);

/* Red glow (loss) */
box-shadow: 0 0 20px rgba(246,70,93,0.25);
```

### Crystal Buttons
Variables CSS de estado: `--crystal-c1`, `--crystal-c2`, `--crystal-c3`, `--crystal-border`  
Colores base teal, estado win → green, estado loss → red/purple.

### Shimmer Animation
Sweep teal 3%→8%→3% a lo largo de 90° para loading states.

---

## Backgrounds

```
/* Base */
radial-gradient(ellipse 80% 60% at 50% 40%, #0d1628 0%, #080c14 55%, #050810 100%)

/* Teal ambient glow */
radial-gradient(circle, rgba(0,229,204,0.06) 0%, transparent 70%)

/* Purple ambient glow */
radial-gradient(circle, rgba(124,77,255,0.04) 0%, transparent 65%)
```

---

## Dark / Light Mode

| Token | Dark (default) | Light |
|-------|---------------|-------|
| Background | `hsl(220 30% 5%)` ≈ `#080c14` | `hsl(220 20% 97%)` |
| Foreground | `hsl(220 15% 92%)` ≈ `#EAECEF` | `hsl(220 30% 10%)` |
| Primary | `hsl(172 100% 44%)` = teal | `hsl(172 80% 36%)` |

**Default:** Dark mode. La app es dark-first. El light mode es un fallback no prioritario.

---

## Reglas de Aplicación VForge

1. **Colores de marca MANDAN** — nunca violeta/cyan por default VForge si no están en la paleta M2M.
2. **Iconos 3D**: teñidos con teal `#00D4B4` + cyan `#00BCD4` sobre fondo `#080c14`.
3. **Framer Motion**: `spring` stiffness 300–400 para microinteracciones de trading (rápido, preciso).
4. **Texto de datos**: SIEMPRE JetBrains Mono — precios, PnL, leverage, timestamps.
5. **Estado vacío**: diseñado con glassmorphism + icono 3D teal + copy motivacional (0 mocks de datos).
6. **Mobile-first**: breakpoints md: (768px), lg: (1024px). Cards apiladas en mobile.
7. **Sin shadcn en nuevos componentes** — sistema propio sobre CSS variables M2M.

---

*Última actualización: 2026-06-08*
