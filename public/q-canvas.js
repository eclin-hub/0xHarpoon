"use strict";
/* QC — rendu Canvas 2D haute densité pour le Quant Vault : mise à l'échelle devicePixelRatio, palettes, vue 3D rotative. */
const QC = (() => {
  // ajuste la taille réelle du canvas à sa taille CSS × devicePixelRatio ; renvoie le contexte en unités CSS
  function fit(canvas, cssH) {
    const dpr = Math.min(3, window.devicePixelRatio || 1), w = Math.max(280, canvas.parentElement.clientWidth || 600), hh = cssH;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); canvas.style.width = w + "px"; canvas.style.height = hh + "px"; }
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, hh); return { ctx, w, h: hh };
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const STOPS = [[8, 20, 70], [20, 90, 170], [34, 230, 255], [43, 255, 176], [255, 194, 71], [255, 110, 90]];
  const ramp = (t, a = 1) => { t = Math.max(0, Math.min(0.9999, t)) * (STOPS.length - 1); const i = Math.floor(t), f = t - i, c = STOPS[i], d = STOPS[i + 1]; return `rgba(${Math.round(lerp(c[0], d[0], f))},${Math.round(lerp(c[1], d[1], f))},${Math.round(lerp(c[2], d[2], f))},${a})`; };
  const diverge = (v, a = 1) => { const t = Math.max(-1, Math.min(1, v)), k = Math.abs(t); return t >= 0 ? `rgba(${Math.round(lerp(18, 43, k))},${Math.round(lerp(26, 255, k))},${Math.round(lerp(48, 176, k))},${a})` : `rgba(${Math.round(lerp(18, 255, k))},${Math.round(lerp(26, 61, k))},${Math.round(lerp(48, 134, k))},${a})`; };
  const FONT = '11px "Martian Mono", ui-monospace, Menlo, monospace', FONT_S = '10px "Martian Mono", ui-monospace, Menlo, monospace';
  function grid(ctx, x0, y0, x1, y1, nx = 6, ny = 5) { ctx.strokeStyle = "rgba(140,170,255,0.08)"; ctx.lineWidth = 1; ctx.beginPath(); for (let i = 0; i <= nx; i++) { const x = x0 + ((x1 - x0) * i) / nx; ctx.moveTo(x, y0); ctx.lineTo(x, y1); } for (let j = 0; j <= ny; j++) { const y = y0 + ((y1 - y0) * j) / ny; ctx.moveTo(x0, y); ctx.lineTo(x1, y); } ctx.stroke(); }

  /* ---------- vue 3D : coordonnées normalisées dans le cube [0,1]³ (x à droite, y en profondeur, z vers le haut) ---------- */
  class View3D {
    constructor(canvas, redraw, yaw = -0.72, pitch = 0.42) {
      this.yaw = yaw; this.pitch = pitch; let drag = null; canvas.style.cursor = "grab"; canvas.style.touchAction = "none";
      canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; });
      canvas.addEventListener("pointermove", (e) => { if (!drag) return; this.yaw = drag.yaw + (e.clientX - drag.x) * 0.008; this.pitch = Math.max(0.05, Math.min(1.35, drag.pitch + (e.clientY - drag.y) * 0.006)); redraw(); });
      const end = () => { drag = null; canvas.style.cursor = "grab"; }; canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    }
    frame(w, h) { this.cx = w / 2; this.cy = h / 2 + h * 0.07; this.S = Math.min(w * 0.42, h * 0.74); this.cyaw = Math.cos(this.yaw); this.syaw = Math.sin(this.yaw); this.cp = Math.cos(this.pitch); this.sp = Math.sin(this.pitch); }
    p(x, y, z) { const X = x - 0.5, Y = y - 0.5, Z = (z - 0.5) * 0.8, xr = X * this.cyaw - Y * this.syaw, yr = X * this.syaw + Y * this.cyaw, d = yr * this.cp - Z * this.sp, up = yr * this.sp + Z * this.cp; return [this.cx + this.S * xr, this.cy - this.S * up, d]; }
    // boîte de repère, graduations et noms d'axes
    axes(ctx, ax) {
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(140,170,255,0.16)"; ctx.beginPath();
      for (let i = 0; i <= 4; i++) { const t = i / 4; let a = this.p(t, 0, 0), b = this.p(t, 1, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); a = this.p(0, t, 0); b = this.p(1, t, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke(); ctx.strokeStyle = "rgba(140,170,255,0.35)"; ctx.beginPath();
      for (const [a, b] of [[[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 0, 1]]]) { const A = this.p(...a), B = this.p(...b); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); } ctx.stroke();
      ctx.font = FONT_S; ctx.fillStyle = "#a3acd6";
      const lab = (pt, text, al) => { ctx.textAlign = al || "center"; ctx.fillText(text, pt[0], pt[1]); };
      lab(this.p(0.5, -0.16, 0), ax.x.label); lab(this.p(0, -0.06, 0), ax.x.min); lab(this.p(1, -0.06, 0), ax.x.max);
      lab(this.p(-0.2, 0.5, 0), ax.y.label); lab(this.p(-0.07, 0, 0), ax.y.min); lab(this.p(-0.07, 1, 0), ax.y.max);
      lab(this.p(-0.03, -0.03, 1.1), ax.z.label); lab(this.p(-0.05, -0.05, 0.02), ax.z.min, "right"); lab(this.p(-0.05, -0.05, 1), ax.z.max, "right");
    }
    // nappe : Z[i][j] ∈ [0,1] (i selon x, j selon y), couleur selon C[i][j] (défaut : Z) ; algorithme du peintre
    surface(ctx, Z, C, alpha = 0.92) {
      const nx = Z.length, ny = Z[0].length, quads = [];
      for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) { const z = [Z[i][j], Z[i + 1][j], Z[i + 1][j + 1], Z[i][j + 1]]; if (z.some((v) => !Number.isFinite(v))) continue;
        const P = [this.p(i / (nx - 1), j / (ny - 1), z[0]), this.p((i + 1) / (nx - 1), j / (ny - 1), z[1]), this.p((i + 1) / (nx - 1), (j + 1) / (ny - 1), z[2]), this.p(i / (nx - 1), (j + 1) / (ny - 1), z[3])];
        const c = C ? (C[i][j] + C[i + 1][j] + C[i + 1][j + 1] + C[i][j + 1]) / 4 : (z[0] + z[1] + z[2] + z[3]) / 4; quads.push({ P, d: (P[0][2] + P[1][2] + P[2][2] + P[3][2]) / 4, c }); }
      quads.sort((a, b) => b.d - a.d); ctx.lineWidth = 0.6;
      for (const q of quads) { ctx.beginPath(); ctx.moveTo(q.P[0][0], q.P[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(q.P[k][0], q.P[k][1]); ctx.closePath(); ctx.fillStyle = ramp(q.c, alpha); ctx.fill(); ctx.strokeStyle = "rgba(6,9,17,0.55)"; ctx.stroke(); }
    }
    dot(ctx, x, y, z, color, r = 5, label) { const P = this.p(x, y, z), B = this.p(x, y, 0); ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(P[0], P[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.shadowColor = color; ctx.shadowBlur = 16; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(P[0], P[1], r, 0, 7); ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke();
      if (label) { ctx.font = FONT; ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.fillText(label, P[0] + r + 5, P[1] - r); } }
    path(ctx, pts, color, width = 2) { if (pts.length < 2) return; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.beginPath(); pts.forEach((q, i) => { const P = this.p(...q); i ? ctx.lineTo(P[0], P[1]) : ctx.moveTo(P[0], P[1]); }); ctx.stroke(); ctx.shadowBlur = 0; }
  }
  // barre de légende de la palette
  function legend(ctx, x, y, w, lo, hi, title) { for (let i = 0; i < w; i++) { ctx.fillStyle = ramp(i / w); ctx.fillRect(x + i, y, 1.5, 7); } ctx.font = FONT_S; ctx.fillStyle = "#a3acd6"; ctx.textAlign = "left"; ctx.fillText(lo, x, y + 19); ctx.textAlign = "right"; ctx.fillText(hi, x + w, y + 19); if (title) { ctx.textAlign = "left"; ctx.fillText(title, x, y - 5); } }
  return { fit, ramp, diverge, grid, View3D, legend, FONT, FONT_S, lerp };
})();
