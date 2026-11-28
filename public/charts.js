"use strict";
/* Petits graphiques SVG maison : jauge, courbes, donut, histogramme, nuage de points. Aucune dépendance. */
const Ch = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const SVG_TAGS = new Set(["svg", "g", "path", "line", "rect", "circle", "text", "defs", "linearGradient", "stop", "filter", "feGaussianBlur", "feMerge", "feMergeNode", "title", "polyline", "clipPath"]);
  function el(tag, attrs, ...kids) {
    const e = SVG_TAGS.has(tag) ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "class") e.setAttribute("class", v); else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const C = { up: "#3ecf8e", down: "#f2616d", cyan: "#4cc9f0", violet: "#9d8cff", amber: "#f2b84b", dim: "#5f6879", muted: "#8f99ab" };
  // définitions partagées (halo, dégradé de jauge) : un seul bloc toujours rendu, pour que les vues masquées ne cassent pas les références
  const glowDefs = () => null;
  const blur = (id) => el("filter", { id, x: "-50%", y: "-50%", width: "200%", height: "200%" }, el("feGaussianBlur", { stdDeviation: "3", result: "b" }), el("feMerge", {}, el("feMergeNode", { in: "b" }), el("feMergeNode", { in: "SourceGraphic" })));
  document.body.append(el("svg", { width: 0, height: 0, "aria-hidden": "true", style: "position:absolute;width:0;height:0;overflow:hidden" }, el("defs", {}, blur("glow"), blur("glow2"),
    el("linearGradient", { id: "gg", x1: "0", x2: "1" }, el("stop", { offset: "0", "stop-color": "#ff3d86" }), el("stop", { offset: "0.5", "stop-color": "#ffc247" }), el("stop", { offset: "1", "stop-color": "#2bffb0" })))));

  /* ---- infobulle commune ---- */
  let tipEl;
  function tip() { return tipEl || (tipEl = document.body.appendChild(el("div", { class: "tip", role: "status" }))); }
  function showTip(evt, content) {
    const t = tip(); t.replaceChildren(...[content].flat().map((c) => (c.nodeType ? c : document.createTextNode(c)))); t.classList.add("on");
    const r = t.getBoundingClientRect(); let x = evt.clientX + 14, y = evt.clientY + 14;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14; if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - 14;
    t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => tipEl && tipEl.classList.remove("on");

  /* ---- jauge −1 .. +1 ---- */
  function gauge(value, { w = 320 } = {}) {
    const h = w * 0.58, cx = w / 2, cy = w * 0.52, r = w * 0.42, sw = w * 0.07;
    const pt = (a, rr = r) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
    const arc = (a0, a1, rr = r) => { const [x0, y0] = pt(a0, rr), [x1, y1] = pt(a1, rr); return `M${x0},${y0} A${rr},${rr} 0 0 1 ${x1},${y1}`; };
    const ang = Math.PI - (Math.max(-1, Math.min(1, value)) + 1) / 2 * Math.PI; // π (gauche) → 0 (droite)
    const [nx, ny] = pt(ang, r - sw * 1.2), col = value >= 0.15 ? C.up : value <= -0.15 ? C.down : C.amber;
    const ticks = [-1, -0.5, 0, 0.5, 1].map((v) => { const a = Math.PI - (v + 1) / 2 * Math.PI, [x0, y0] = pt(a, r + sw * 0.8), [x1, y1] = pt(a, r + sw * 1.25), [tx, ty] = pt(a, r + sw * 2.3);
      return el("g", {}, el("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: C.dim, "stroke-width": 1.5 }), el("text", { x: tx, y: ty + 3, "text-anchor": "middle" }, v > 0 ? "+" + v * 100 : String(v * 100))); });
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Jauge de sentiment " + Math.round(value * 100) + " %" },
      glowDefs(),
      el("path", { d: arc(Math.PI, 0), fill: "none", stroke: "rgba(255,255,255,0.07)", "stroke-width": sw, "stroke-linecap": "round" }),
      el("path", { d: arc(Math.PI, 0), fill: "none", stroke: "url(#gg)", "stroke-width": sw, "stroke-linecap": "round", opacity: 0.9 }),
      ticks,
      el("g", { class: "needle", style: "transition: transform .9s cubic-bezier(.2,.9,.2,1); transform-origin: " + cx + "px " + cy + "px" },
        el("line", { x1: cx, y1: cy, x2: nx, y2: ny, stroke: col, "stroke-width": 3, "stroke-linecap": "round" })),
      el("circle", { cx, cy, r: sw * 0.55, fill: "#0a0d12", stroke: col, "stroke-width": 3 }));
    return svg;
  }

  /* ---- mini-courbe ---- */
  function spark(values, { w = 120, h = 34, color = C.cyan, min, max } = {}) {
    if (!values || values.length < 2) return el("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, width: w, height: h }, el("line", { x1: 0, x2: w, y1: h / 2, y2: h / 2, stroke: C.dim, "stroke-dasharray": "3 4" }));
    const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 3 - ((v - lo) / span) * (h - 6)]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    return el("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img" }, glowDefs(),
      el("path", { d: d + ` L${w - 2},${h} L2,${h} Z`, fill: color, opacity: 0.12 }), el("path", { d, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linejoin": "round" }),
      el("circle", { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 2.8, fill: color }));
  }

  /* ---- courbes temporelles multi-séries avec réticule ---- */
  function line(host, series, { height = 260, min = -1, max = 1, auto = false, fmt = (v) => (v * 100).toFixed(0) + " %", zero = true, timeFmt } = {}) {
    host.replaceChildren();
    const all = series.flatMap((s) => s.pts); if (all.length < 2) { host.append(el("div", { class: "empty" }, "Pas encore assez de points. L'historique se construit en continu (un point par minute).")); return; }
    if (auto) { const vs = all.map((p) => p[1]); let lo = Math.min(...vs, 0), hi = Math.max(...vs, 0); const pad = Math.max(0.1, (hi - lo) * 0.15); min = Math.max(-1, lo - pad); max = Math.min(1, hi + pad); if (max - min < 0.4) { const c = (max + min) / 2; min = Math.max(-1, c - 0.2); max = Math.min(1, c + 0.2); } }
    const W = Math.max(320, host.clientWidth || 640), H = height, m = { l: 44, r: 14, t: 12, b: 26 };
    const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0])) || t0 + 1;
    const X = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - min) / (max - min)) * (H - m.t - m.b);
    const tf = timeFmt || ((t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }));
    const g = el("g", { class: "grid" });
    for (let i = 0; i <= 4; i++) { const v = min + ((max - min) * i) / 4; g.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), el("text", { x: m.l - 6, y: Y(v) + 3, "text-anchor": "end" }, fmt(v))); }
    for (let i = 0; i <= 4; i++) { const t = t0 + ((t1 - t0) * i) / 4; g.append(el("text", { x: X(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" }, tf(t))); }
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, height: H, role: "img" }, glowDefs(), g);
    if (zero && min < 0 && max > 0) svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: C.dim, "stroke-dasharray": "4 4" }));
    for (const s of series) {
      if (s.pts.length < 2) continue;
      const d = s.pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(" ");
      if (s.fill) svg.append(el("path", { d: d + ` L${X(s.pts.at(-1)[0])},${Y(Math.max(min, 0))} L${X(s.pts[0][0])},${Y(Math.max(min, 0))} Z`, fill: s.color, opacity: 0.1 }));
      svg.append(el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.w || 2, "stroke-linejoin": "round", opacity: s.opacity ?? 1 }));
    }
    const cross = el("line", { y1: m.t, y2: H - m.b, stroke: C.cyan, "stroke-width": 1, opacity: 0 }), dots = series.map((s) => el("circle", { r: 4, fill: s.color, opacity: 0 }));
    svg.append(cross, ...dots);
    const hit = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const rb = svg.getBoundingClientRect(), px = ((e.clientX - rb.left) / rb.width) * W, t = t0 + ((px - m.l) / (W - m.l - m.r)) * (t1 - t0);
      const rows = [];
      series.forEach((s, i) => { if (!s.pts.length) return; let best = s.pts[0]; for (const p of s.pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; dots[i].setAttribute("cx", X(best[0])); dots[i].setAttribute("cy", Y(best[1])); dots[i].setAttribute("opacity", 1);
        rows.push(el("div", {}, el("i", { style: `display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px` }), `${s.name} : `, el("b", { style: "display:inline;font-size:.78rem" }, fmt(best[1])))); cross.setAttribute("x1", X(best[0])); cross.setAttribute("x2", X(best[0])); });
      cross.setAttribute("opacity", 0.5); showTip(e, [el("b", {}, tf(t)), ...rows]);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0)); hideTip(); });
    svg.append(hit); host.append(svg);
  }

  /* ---- donut ---- */
  function donut(parts, { size = 150, thick = 16, center } = {}) {
    const tot = parts.reduce((s, p) => s + p.v, 0) || 1, r = size / 2 - thick, cx = size / 2; let a = -Math.PI / 2;
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img" }, glowDefs(), el("circle", { cx, cy: cx, r, fill: "none", stroke: "rgba(255,255,255,0.06)", "stroke-width": thick }));
    for (const p of parts) {
      const da = (p.v / tot) * Math.PI * 2; if (da <= 0) continue;
      const big = da > Math.PI ? 1 : 0, x0 = cx + r * Math.cos(a), y0 = cx + r * Math.sin(a), x1 = cx + r * Math.cos(a + da - 0.001), y1 = cx + r * Math.sin(a + da - 0.001);
      const path = el("path", { d: `M${x0},${y0} A${r},${r} 0 ${big} 1 ${x1},${y1}`, fill: "none", stroke: p.color, "stroke-width": thick, style: "transition: stroke-width .15s; cursor: default" });
      path.addEventListener("pointerenter", () => path.setAttribute("stroke-width", thick + 4)); path.addEventListener("pointermove", (e) => showTip(e, [el("b", {}, p.label), p.fmt ? p.fmt(p.v) : String(p.v)]));
      path.addEventListener("pointerleave", () => { path.setAttribute("stroke-width", thick); hideTip(); }); svg.append(path); a += da;
    }
    if (center) svg.append(el("text", { x: cx, y: cx + 4, "text-anchor": "middle", style: "font-size:13px;fill:#e8ecff;font-family:var(--font-display)" }, center));
    return svg;
  }

  /* ---- histogramme des liquidations autour du prix ---- */
  function liqHist(host, { mark, list }, { range = 0.3, bins = 40, height = 280, fmtPx = (v) => String(+v.toPrecision(5)), fmtN = (v) => "$" + (v / 1e6).toFixed(1) + " M" } = {}) {
    host.replaceChildren();
    const lo = mark * (1 - range), hi = mark * (1 + range), step = (hi - lo) / bins, L = new Array(bins).fill(0), S = new Array(bins).fill(0);
    for (const x of list) { if (x.px < lo || x.px >= hi) continue; const i = Math.floor((x.px - lo) / step); (x.side === "long" ? L : S)[i] += x.n; }
    const maxV = Math.max(1, ...L, ...S), W = Math.max(320, host.clientWidth || 640), H = height, m = { l: 54, r: 10, t: 12, b: 28 };
    const bw = (W - m.l - m.r) / bins, Y = (v) => m.t + (1 - v / maxV) * (H - m.t - m.b);
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Carte des liquidations" }, glowDefs());
    for (let i = 0; i <= 4; i++) { const v = (maxV * i) / 4; svg.append(el("g", { class: "grid" }, el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), el("text", { x: m.l - 6, y: Y(v) + 3, "text-anchor": "end" }, v ? fmtN(v) : "0"))); }
    for (let i = 0; i < bins; i++) {
      const px0 = lo + i * step, px1 = px0 + step, x = m.l + i * bw;
      for (const [arr, col, lbl] of [[L, C.down, "Longs liquidés"], [S, C.cyan, "Shorts liquidés"]]) {
        if (!arr[i]) continue;
        const r = el("rect", { x: x + 1, y: Y(arr[i]), width: Math.max(1, bw - 2), height: H - m.b - Y(arr[i]), fill: col, opacity: 0.85, rx: 2, style: "transition: opacity .15s, filter .15s" });
        r.addEventListener("pointerenter", () => { r.setAttribute("opacity", 1); });
        r.addEventListener("pointermove", (e) => showTip(e, [el("b", {}, `${fmtPx(px0)} → ${fmtPx(px1)}`), `${lbl} : ${fmtN(arr[i])}`, el("div", { class: "muted" }, ((px0 + step / 2) / mark - 1 >= 0 ? "+" : "") + (((px0 + step / 2) / mark - 1) * 100).toFixed(1) + " % du prix")]));
        r.addEventListener("pointerleave", () => { r.setAttribute("opacity", 0.85); r.removeAttribute("filter"); hideTip(); }); svg.append(r);
      }
    }
    const mx = m.l + ((mark - lo) / (hi - lo)) * (W - m.l - m.r);
    svg.append(el("line", { x1: mx, x2: mx, y1: m.t, y2: H - m.b, stroke: C.amber, "stroke-width": 1.5, "stroke-dasharray": "5 4" }), el("text", { x: mx, y: H - 8, "text-anchor": "middle", style: "fill:#ffc247" }, "prix " + fmtPx(mark)));
    for (const f of [0, 0.25, 0.75, 1]) svg.append(el("text", { x: m.l + f * (W - m.l - m.r), y: H - 8, "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle" }, fmtPx(lo + (hi - lo) * f)));
    host.append(svg);
  }

  /* ---- nuage de points (funding × biais des baleines) ---- */
  function scatter(host, pts, { height = 340, xLabel, yLabel, xFmt, yFmt, xMax, onClick } = {}) {
    host.replaceChildren(); if (!pts.length) { host.append(el("div", { class: "empty" }, "Pas de données.")); return; }
    const W = Math.max(320, host.clientWidth || 640), H = height, m = { l: 48, r: 16, t: 14, b: 38 };
    const xm = xMax || Math.max(0.1, ...pts.map((p) => Math.abs(p.x))) * 1.15, X = (v) => m.l + ((v + xm) / (2 * xm)) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v + 1) / 2) * (H - m.t - m.b);
    const rmax = Math.max(...pts.map((p) => p.r)) || 1;
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, height: H, role: "img" }, glowDefs());
    svg.append(el("rect", { x: X(0), y: m.t, width: X(xm) - X(0), height: Y(0) - m.t, fill: C.amber, opacity: 0.05 }), el("rect", { x: m.l, y: Y(0), width: X(0) - m.l, height: H - m.b - Y(0), fill: C.amber, opacity: 0.05 }));
    svg.append(el("line", { x1: X(0), x2: X(0), y1: m.t, y2: H - m.b, stroke: C.dim }), el("line", { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: C.dim }));
    for (const v of [-1, -0.5, 0.5, 1]) svg.append(el("text", { x: m.l - 6, y: Y(v) + 3, "text-anchor": "end" }, yFmt(v)));
    for (const f of [-1, -0.5, 0.5, 1]) svg.append(el("text", { x: X(xm * f), y: H - 22, "text-anchor": "middle" }, xFmt(xm * f)));
    svg.append(el("text", { x: W / 2, y: H - 4, "text-anchor": "middle" }, xLabel), el("text", { x: m.l + 6, y: m.t + 10, "text-anchor": "start" }, "↑ " + yLabel));
    svg.append(el("text", { x: W - m.r - 4, y: m.t + 12, "text-anchor": "end", style: "fill:#ffc247" }, "foule long des deux côtés"), el("text", { x: m.l + 4, y: H - m.b - 6, "text-anchor": "start", style: "fill:#ffc247" }, "foule short des deux côtés"));
    for (const p of pts) {
      const cx = X(Math.max(-xm, Math.min(xm, p.x))), cy = Y(p.y), r = 5 + Math.sqrt(p.r / rmax) * 14, col = p.y >= 0.2 ? C.up : p.y <= -0.2 ? C.down : C.muted;
      const c = el("circle", { cx, cy, r, fill: col, opacity: 0.55, stroke: col, "stroke-width": 1.5, style: "cursor:pointer; transition: opacity .15s" });
      c.addEventListener("pointerenter", () => { c.setAttribute("opacity", 0.95); }); c.addEventListener("pointermove", (e) => showTip(e, p.tip));
      c.addEventListener("pointerleave", () => { c.setAttribute("opacity", 0.55); c.removeAttribute("filter"); hideTip(); }); if (onClick) c.addEventListener("click", () => onClick(p));
      svg.append(c, el("text", { x: cx, y: cy + 3, "text-anchor": "middle", style: "fill:#fff;font-size:9px;pointer-events:none" }, p.label));
    }
    host.append(svg);
  }

  function countUp(node, to, fmt = (v) => v.toFixed(0), ms = 700) {
    const from = Number(node.dataset.v ?? 0); node.dataset.v = to;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) { node.textContent = fmt(to); return; }
    const t0 = performance.now(); const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); node.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step);
  }
  return { el, C, gauge, spark, line, donut, liqHist, scatter, showTip, hideTip, countUp };
})();
