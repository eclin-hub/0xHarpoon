"use strict";
/* Graphiques complémentaires : courbe des taux, barres par strike, grande courbe simple. */
(() => {
  const el = Ch.el, C = Ch.C;
  const defs = () => null;
  // lignes sur un axe de catégories (ex. échéances de la courbe des taux)
  Ch.curve = (host, cats, series, { height = 260, fmt = (v) => v.toFixed(2) + " %" } = {}) => {
    host.replaceChildren(); const W = Math.max(320, host.clientWidth || 600), H = height, m = { l: 50, r: 16, t: 14, b: 28 };
    const all = series.flatMap((s) => s.vals).filter(Number.isFinite); if (!all.length) return host.append(el("div", { class: "empty" }, "Pas de données."));
    const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.15 || 0.2, y0 = lo - pad, y1 = hi + pad;
    const X = (i) => m.l + (i / (cats.length - 1)) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, height: H, role: "img" }, defs());
    for (let i = 0; i <= 4; i++) { const v = y0 + ((y1 - y0) * i) / 4; svg.append(el("g", { class: "grid" }, el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), el("text", { x: m.l - 6, y: Y(v) + 3, "text-anchor": "end" }, fmt(v)))); }
    cats.forEach((c, i) => svg.append(el("text", { x: X(i), y: H - 8, "text-anchor": "middle" }, c)));
    for (const s of series) {
      svg.append(el("path", { d: s.vals.map((v, i) => (i ? "L" : "M") + X(i) + "," + Y(v)).join(" "), fill: "none", stroke: s.color, "stroke-width": s.w || 2, "stroke-dasharray": s.dash || null, opacity: s.dash ? 0.75 : 1 }));
      s.vals.forEach((v, i) => { const c = el("circle", { cx: X(i), cy: Y(v), r: s.dash ? 3 : 4.5, fill: s.color, style: "cursor:default" }); c.addEventListener("pointermove", (e) => Ch.showTip(e, [el("b", {}, `${s.name} · ${cats[i]}`), fmt(v)])); c.addEventListener("pointerleave", Ch.hideTip); svg.append(c); });
    }
    host.append(svg);
  };
  // open interest par prix d'exercice : calls et puts côte à côte, avec repères verticaux
  Ch.strikes = (host, rows, { height = 300, marks = [], fmtK = String, fmtV = (v) => v.toFixed(0) } = {}) => {
    host.replaceChildren(); if (!rows.length) return host.append(el("div", { class: "empty" }, "Pas de données."));
    const W = Math.max(320, host.clientWidth || 640), H = height, m = { l: 52, r: 10, t: 22, b: 30 }, maxV = Math.max(1, ...rows.map((r) => Math.max(r.call, r.put)));
    const bw = (W - m.l - m.r) / rows.length, Y = (v) => m.t + (1 - v / maxV) * (H - m.t - m.b), svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, height: H, role: "img" }, defs());
    for (let i = 0; i <= 4; i++) { const v = (maxV * i) / 4; svg.append(el("g", { class: "grid" }, el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), el("text", { x: m.l - 6, y: Y(v) + 3, "text-anchor": "end" }, fmtV(v)))); }
    const every = Math.ceil(rows.length / 10);
    rows.forEach((r, i) => {
      const x = m.l + i * bw;
      for (const [k, col, dx, lbl] of [["call", C.up, 0.08, "Calls"], ["put", C.down, 0.5, "Puts"]]) { if (!r[k]) continue; const b = el("rect", { x: x + bw * dx, y: Y(r[k]), width: Math.max(1, bw * 0.4), height: H - m.b - Y(r[k]), fill: col, opacity: 0.85, rx: 1.5 });
        b.addEventListener("pointermove", (e) => Ch.showTip(e, [el("b", {}, "Strike " + fmtK(r.k)), `${lbl} : ${fmtV(r[k])}`])); b.addEventListener("pointerleave", Ch.hideTip); svg.append(b); }
      if (i % every === 0) svg.append(el("text", { x: x + bw / 2, y: H - 10, "text-anchor": "middle" }, fmtK(r.k)));
    });
    const ks = rows.map((r) => r.k), xOf = (k) => { let i = ks.findIndex((s) => s >= k); if (i < 0) i = ks.length - 1; if (i === 0) return m.l + bw / 2; const f = (k - ks[i - 1]) / (ks[i] - ks[i - 1] || 1); return m.l + (i - 1 + f) * bw + bw / 2; };
    for (const mk of marks) { const x = xOf(mk.k); svg.append(el("line", { x1: x, x2: x, y1: m.t, y2: H - m.b, stroke: mk.color, "stroke-width": 1.5, "stroke-dasharray": "5 4" }), el("text", { x, y: m.t - 8, "text-anchor": "middle", style: `fill:${mk.color}` }, mk.label)); }
    host.append(svg);
  };
})();
