"use strict";
/* QuantVaultLab — les 7 outils interactifs de portefeuille factoriel et de stress-test.
   Chaque outil expose mount(hôte, Q) -> { draw(), tick?() } ; Q est l'état partagé (poids, levier, couverture, stress, modèle). */
const QT = (() => {
  const A = QM.ASSETS, F = QM.FACTORS, N = QM.N, K = QM.K, pc = (x, d = 1) => (x * 100).toFixed(d) + " %";
  const canvas = (host, hgt) => { const c = document.createElement("canvas"); c.style.display = "block"; c._cap = document.createElement("p"); c._cap.className = "qnote"; host.append(c, c._cap); c._h = hgt; return c; };
  const segBtns = (items, get, set, redraw) => { const box = h("div", { class: "seg" }); const paint = () => box.replaceChildren(...items.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(get() === k), onclick: () => { set(k); paint(); redraw(); } }, l))); paint(); return box; };
  const tip = (e, title, lines) => Ch.showTip(e, [h("b", {}, title), ...lines.map((l) => h("div", {}, l))]);

  /* ---------- 1. Sankey : capital → facteurs → CVaR ---------- */
  function sankey(host, Q) {
    const cv = canvas(host, 580); let nodes = [], hover = null;
    function draw() {
      const { ctx, w, h } = QC.fit(cv, cv._h), pf = Q.pf, st = Q.st, padT = 40, padB = 10, xL = Math.min(150, w * 0.17), xR = w - xL - 12, xC = w / 2 - 7, nodeW = 12;
      // flux gauche -> centre : part de chaque moteur de risque dans l'actif, pondérée par le capital
      const fin = A.map((_, i) => { const parts = st.L[i].map((l, k) => Math.abs(l) * st.fvol[k]); parts.push(st.idio[i]); const s = parts.reduce((a, b) => a + b, 0); return parts.map((p) => Q.w[i] * p / s); });
      // flux centre -> droite : contribution exacte à la variance (donc à la CVaR) par actif et par facteur
      const raw = A.map((_, i) => [...pf.rcAK[i], pf.rcI[i]]), G = raw.flat().reduce((a, b) => a + Math.abs(b), 0) || 1, fout = raw.map((r) => r.map((v) => Math.abs(v) / G));
      const inK = Array.from({ length: K + 1 }, (_, k) => fin.reduce((s, r) => s + r[k], 0)), outK = Array.from({ length: K + 1 }, (_, k) => fout.reduce((s, r) => s + r[k], 0)), outA = fout.map((r) => r.reduce((a, b) => a + b, 0));
      const avail = h - padT - padB, gapA = 3, gapC = 16, sc = Math.min((avail - gapA * (N - 1)), (avail - gapC * K) / inK.map((v, k) => Math.max(v, outK[k])).reduce((a, b) => a + b, 0));
      nodes = []; const yL = [], yR = [], yC = []; let y = padT; for (let i = 0; i < N; i++) { yL.push(y); y += Q.w[i] * sc + gapA; } y = padT; for (let i = 0; i < N; i++) { yR.push(y); y += outA[i] * sc + gapA; }
      const hc = inK.map((v, k) => Math.max(v, outK[k]) * sc), totC = hc.reduce((a, b) => a + b, 0) + gapC * K; y = padT + Math.max(0, (avail - totC) / 2); for (let k = 0; k <= K; k++) { yC.push(y); y += hc[k] + gapC; }
      const col = (k) => (k < K ? F[k].color : "#7c87b8"), offL = new Array(N).fill(0), offCi = new Array(K + 1).fill(0), offCo = new Array(K + 1).fill(0), offR = new Array(N).fill(0);
      const ribbon = (x0, y0, x1, y1, t, color, a) => { if (t < 0.3) return; const mx = (x0 + x1) / 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1); ctx.lineTo(x1, y1 + t); ctx.bezierCurveTo(mx, y1 + t, mx, y0 + t, x0, y0 + t); ctx.closePath(); ctx.globalAlpha = a; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1; };
      const on = (i, k, side) => !hover || (hover.type === "asset" && hover.i === i && hover.side === side) || (hover.type === "factor" && hover.k === k);
      for (let i = 0; i < N; i++) for (let k = 0; k <= K; k++) { const t = fin[i][k] * sc; ribbon(xL + nodeW, yL[i] + offL[i], xC, yC[k] + offCi[k], t, col(k), on(i, k, "L") ? (hover ? 0.75 : 0.34) : 0.05); offL[i] += t; offCi[k] += t; }
      for (let k = 0; k <= K; k++) for (let i = 0; i < N; i++) { const t = fout[i][k] * sc, neg = raw[i][k] < 0; ribbon(xC + 14, yC[k] + offCo[k], xR, yR[i] + offR[i], t, neg ? "#5a6490" : col(k), on(i, k, "R") ? (hover ? 0.8 : 0.4) : 0.05); offCo[k] += t; offR[i] += t; }
      ctx.font = QC.FONT_S;
      for (let i = 0; i < N; i++) { const c = QM.CLS_COL[A[i].cls], hl = Math.max(1.5, Q.w[i] * sc), hr = Math.max(1.5, outA[i] * sc);
        ctx.fillStyle = c; ctx.fillRect(xL, yL[i], nodeW, hl); ctx.fillRect(xR, yR[i], nodeW, hr); nodes.push({ type: "asset", side: "L", i, x: 0, y: yL[i] - 1, w: xL + nodeW, h: hl + 3 }, { type: "asset", side: "R", i, x: xR, y: yR[i] - 1, w: w - xR, h: hr + 3 });
        ctx.fillStyle = Q.w[i] > 0.004 ? "#e8ecff" : "#5a6490"; ctx.textAlign = "right"; if (hl >= 7 || Q.w[i] > 0.02) ctx.fillText(`${A[i].t} ${pc(Q.w[i], 0)}`, xL - 6, yL[i] + hl / 2 + 4);
        ctx.textAlign = "left"; if (hr >= 7 || outA[i] > 0.02) { ctx.fillStyle = pf.rcA[i] < 0 ? "#2bffb0" : "#e8ecff"; ctx.fillText(`${A[i].t} ${pc(pf.rcA[i] * pf.es, 1)}`, xR + nodeW + 6, yR[i] + hr / 2 + 4); } }
      for (let k = 0; k <= K; k++) { ctx.fillStyle = col(k); ctx.shadowColor = col(k); ctx.shadowBlur = 12; ctx.fillRect(xC, yC[k], 14, Math.max(2, hc[k])); ctx.shadowBlur = 0; nodes.push({ type: "factor", k, x: xC - 40, y: yC[k], w: 94, h: Math.max(8, hc[k]) });
        ctx.fillStyle = "#e8ecff"; ctx.textAlign = "center"; ctx.fillText(k < K ? F[k].id : "SPÉCIFIQUE", xC + 7, yC[k] - 5); }
      ctx.fillStyle = "#a3acd6"; ctx.textAlign = "left"; ctx.fillText("CAPITAL INVESTI", 4, 12); ctx.textAlign = "center"; ctx.fillText("FACTEURS LATENTS  (entrée : exposition · sortie : risque)", w / 2, 12); ctx.textAlign = "right"; ctx.fillText("CONTRIBUTION À LA CVaR 99 %", w - 4, 12);
      cv._d = { fin, fout, raw, inK, outK, outA };
    }
    cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, n = nodes.find((n) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h), key = n ? n.type + (n.side || "") + (n.i ?? n.k) : null;
      if (key !== (hover ? hover.type + (hover.side || "") + (hover.i ?? hover.k) : null)) { hover = n || null; draw(); }
      if (!n) return Ch.hideTip(); const d = cv._d, pf = Q.pf;
      if (n.type === "asset") tip(e, A[n.i].t, [`Poids en capital : ${pc(Q.w[n.i])}`, `Part de la CVaR : ${pc(pf.rcA[n.i])} (${pc(pf.rcA[n.i] * pf.es, 2)} de perte)`, `Rapport risque / capital : ${Q.w[n.i] > 1e-4 ? (pf.rcA[n.i] / Q.w[n.i]).toFixed(2) + "×" : "–"}`, ...F.map((f, k) => `${f.id} : ${pc(pf.rcAK[n.i][k])}`)]);
      else tip(e, n.k < K ? `${F[n.k].id} · ${F[n.k].name}` : "Risque spécifique", [`Exposition du capital : ${pc(d.inK[n.k])}`, `Part du risque extrême : ${pc(n.k < K ? pf.rcF[n.k] : pf.idioShare)}`, n.k < K ? `Volatilité du facteur : ${pc(Q.st.fvol[n.k])}` : "Diversifiable"]); });
    cv.addEventListener("pointerleave", () => { hover = null; Ch.hideTip(); draw(); });
    return { draw };
  }

  /* ---------- 2. Frontière efficiente factorielle 3D ---------- */
  function frontier(host, Q) {
    const cv = canvas(host, 460), v3 = new QC.View3D(cv, () => draw()), r = QM.rng(11), cloud = [];
    for (let i = 0; i < 320; i++) { const conc = 0.4 + 2.6 * r.u(), w = A.map(() => Math.exp(conc * r.g())); if (i % 3 === 0) for (let j = 0; j < N; j++) if (r.u() < 0.55) w[j] = 0; if (w.every((x) => !x)) w[0] = 1; cloud.push(QM.norm(w)); }
    for (const f of Object.values(QM.PRESETS)) cloud.push(f());
    function draw() {
      const { ctx, w, h } = QC.fit(cv, cv._h); v3.frame(w, h);
      const pts = cloud.map((wt) => { const p = QM.portfolio(wt, Q.lev, Q.hedge, Q.st); return [p.es, p.entropy, p.mu]; }), me = [Q.pf.es, Q.pf.entropy, Q.pf.mu], all = [...pts, me];
      const rg = [0, 1, 2].map((d) => { const v = all.map((p) => p[d]); let lo = Math.min(...v), hi = Math.max(...v); const pad = (hi - lo) * 0.06 || 0.01; return [lo - pad, hi + pad]; }), nm = (p) => p.map((v, d) => (v - rg[d][0]) / (rg[d][1] - rg[d][0]));
      v3.axes(ctx, { x: { label: "CVaR 99 % (1 mois)", min: pc(rg[0][0], 0), max: pc(rg[0][1], 0) }, y: { label: "Entropie factorielle", min: pc(rg[1][0], 0), max: pc(rg[1][1], 0) }, z: { label: "Rendement espéré", min: pc(rg[2][0], 0), max: pc(rg[2][1], 0) } });
      const np = pts.map(nm), G = 15, Z = Array.from({ length: G }, (_, i) => Array.from({ length: G }, (_, j) => { let best = -1; const gx = i / (G - 1), gy = j / (G - 1); for (const q of np) { const d2 = (q[0] - gx) ** 2 + (q[1] - gy) ** 2, v = q[2] - 7 * d2; if (v > best) best = v; } return Math.max(0, best); }));
      v3.surface(ctx, Z, null, 0.42);
      const order = np.map((q, i) => [v3.p(...q), i]).sort((a, b) => b[0][2] - a[0][2]); for (const [P, i] of order) { ctx.fillStyle = QC.ramp(np[i][2], 0.9); ctx.beginPath(); ctx.arc(P[0], P[1], 2.4, 0, 7); ctx.fill(); }
      const bins = 12, best = new Array(bins).fill(null); np.forEach((q) => { const b = Math.min(bins - 1, Math.floor(q[0] * bins)); if (!best[b] || q[2] > best[b][2]) best[b] = q; }); let run = -1; const env = best.filter(Boolean).filter((q) => (q[2] > run ? ((run = q[2]), true) : false));
      v3.path(ctx, env, "#ffc247", 2.4); const m = nm(me); v3.dot(ctx, m[0], m[1], m[2], "#22e6ff", 7, "portefeuille actif");
      cv._cap.textContent = `${cloud.length} portefeuilles simulés (points), nappe : meilleur rendement atteignable, trait ambre : trajectoire optimale. Glisser pour tourner.`;
    }
    return { draw };
  }

  /* ---------- 3. Paysage de robustesse : fenêtre d'estimation × glissement de corrélation ---------- */
  // Pour chaque cellule : on estime bêtas et rendements avec l'erreur d'échantillonnage d'une fenêtre de W jours, on optimise
  // le portefeuille sur ces estimations, puis on l'évalue (a) sur les estimations elles-mêmes et (b) sur le vrai modèle, corrélations décalées.
  function robust(host, Q) {
    let mode = "oos", cacheKey = "", grid = null, failed = null; const info = h("div", { class: "qnote" });
    host.append(h("div", { class: "toolbar", style: "margin-bottom:6px" }, segBtns([["oos", "Hors échantillon (réel)"], ["is", "Dans l'échantillon (illusion)"], ["gap", "Écart illusion − réalité"]], () => mode, (k) => (mode = k), () => draw())), info);
    const cv = canvas(host, 440), v3 = new QC.View3D(cv, () => draw(), -0.6, 0.5), r = QM.rng(23), nb = A.map(() => F.map(() => r.g())), nm = A.map(() => r.g()), G = 18;
    const WIN = Array.from({ length: G }, (_, i) => Math.round(20 * Math.pow(25, i / (G - 1)))), SH = Array.from({ length: G }, (_, j) => -0.3 + 0.6 * j / (G - 1));
    const fin = Number.isFinite, ratio = (p) => { const v = p.mu / Math.max(0.02, p.es); return fin(v) ? v : NaN; };
    // nettoyage numérique : valeurs non finies remplacées par la médiane des voisines, puis écrêtage aux centiles 2 et 98
    function clean(M) {
      const n = M.length, m = M[0].length, out = M.map((row) => [...row]), all = M.flat().filter(fin).sort((a, b) => a - b); if (!all.length) return { Z: M.map((row) => row.map(() => 0)), lo: 0, hi: 1, bad: n * m };
      const q = (p) => all[Math.min(all.length - 1, Math.max(0, Math.round(p * (all.length - 1))))], lo = q(0.02), hi = q(0.98), med = q(0.5); let bad = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { let v = out[i][j]; if (!fin(v)) { bad++; const nb_ = []; for (const [a, c] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) if (a >= 0 && c >= 0 && a < n && c < m && fin(M[a][c])) nb_.push(M[a][c]); v = nb_.length ? nb_.sort((x, y) => x - y)[nb_.length >> 1] : med; } out[i][j] = Math.min(hi, Math.max(lo, v)); }
      return { Z: out, lo, hi: hi > lo ? hi : lo + 1e-6, bad };
    }
    function compute() {
      const key = [Q.s, Q.scenKey, Q.lev, Q.hedge, Q.w.map((x) => x.toFixed(3)).join()].join("|"); if (key === cacheKey) return; cacheKey = key; failed = null;
      try {
        const st0 = Q.st, IS = QM.zeros(G, G), OOS = QM.zeros(G, G), truth = SH.map((d) => QM.state(Q.s, Q.scen, d));
        for (let i = 0; i < G; i++) { const W = WIN[i], Lh = st0.L.map((row, a) => row.map((l, k) => l + nb[a][k] * (st0.idio[a] / st0.fvol[k]) / Math.sqrt(W))), muh = st0.mu.map((m, a) => m + nm[a] * st0.sd[a] / Math.sqrt(W / 252));
          const cov = QM.mul(QM.mul(Lh, st0.fcov), QM.T(Lh)); for (let a = 0; a < N; a++) cov[a][a] += st0.idio[a] ** 2 + 1e-8;
          let raw = QM.mv(QM.inv(cov), muh).map((x) => (fin(x) ? Math.max(0, x) : 0)); const wopt = raw.some((x) => x > 0) ? QM.norm(raw) : [...Q.w], wc = Q.w.map((x, a) => 0.3 * x + 0.7 * wopt[a]);
          const ris = ratio(QM.portfolio(wc, Q.lev, Q.hedge, { ...st0, L: Lh, mu: muh, cov }));
          for (let j = 0; j < G; j++) { OOS[i][j] = ratio(QM.portfolio(wc, Q.lev, Q.hedge, truth[j])); IS[i][j] = ris; } }
        grid = { IS, OOS, GAP: IS.map((row, i) => row.map((v, j) => v - OOS[i][j])) };
      } catch (e) { failed = e.message || String(e); grid = null; }
    }
    function draw() {
      compute(); const { ctx, w, h: hh } = QC.fit(cv, cv._h); v3.frame(w, hh);
      if (!grid) { ctx.font = QC.FONT; ctx.fillStyle = "#ffc247"; ctx.textAlign = "center"; ctx.fillText("Surface indisponible : " + (failed || "calcul en cours"), w / 2, hh / 2); return; }
      const M = mode === "oos" ? grid.OOS : mode === "is" ? grid.IS : grid.GAP, c = clean(M), Z = c.Z.map((row) => row.map((v) => (v - c.lo) / (c.hi - c.lo)));
      v3.axes(ctx, { x: { label: "Fenêtre d'estimation des bêtas (jours)", min: WIN[0], max: WIN[G - 1] }, y: { label: "Glissement de corrélation", min: "−0,30", max: "+0,30" }, z: { label: mode === "gap" ? "Écart de ratio" : "Rendement / CVaR", min: c.lo.toFixed(2), max: c.hi.toFixed(2) } });
      v3.surface(ctx, Z);
      // repère : sommet de la surface affichée
      let bi = 0, bj = 0; for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) if (c.Z[i][j] > c.Z[bi][bj]) { bi = i; bj = j; }
      v3.dot(ctx, bi / (G - 1), bj / (G - 1), Z[bi][bj], "#fff", 5, `sommet : ${WIN[bi]} j, ${SH[bj] >= 0 ? "+" : ""}${SH[bj].toFixed(2)}`);
      QC.legend(ctx, w - 170, 22, 150, c.lo.toFixed(2), c.hi.toFixed(2), mode === "gap" ? "Illusion − réalité" : "Rendement / CVaR");
      const o = clean(grid.OOS), flat = o.Z.flat(), mx = Math.max(...flat), mn = Math.min(...flat), share = flat.filter((v) => v >= mn + 0.8 * (mx - mn)).length / flat.length, avg = (X) => { const f = X.flat().filter(fin); return f.reduce((a, b) => a + b, 0) / (f.length || 1); }, gap = avg(grid.IS) - avg(grid.OOS);
      info.replaceChildren(h("span", { class: "chip " + (share > 0.3 ? "up" : "warn") }, share > 0.3 ? "Plateau robuste" : "Pic étroit : risque de suroptimisation"), h("span", {}, ` ${pc(share, 0)} de la surface réelle reste à moins de 20 % de son sommet. Le ratio estimé dépasse le ratio réel de ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} en moyenne${c.bad ? ` · ${c.bad} cellule(s) non convergente(s) corrigée(s)` : ""}.`));
      cv._cap.textContent = "Chaque surface a sa propre échelle de couleur (centiles 2 à 98). À gauche, les fenêtres courtes : les bêtas sont mal estimés, le portefeuille optimisé paraît excellent sur ses propres données et déçoit ensuite. Glisser pour tourner.";
    }
    return { draw };
  }

  /* ---------- 4. Arbre couvrant minimal + contagion ---------- */
  function mst(host, Q) {
    const cv = canvas(host, 470), r = QM.rng(5), pos = A.map((_, i) => ({ x: 0.5 + 0.3 * Math.cos(i * 2.4) + 0.02 * r.g(), y: 0.5 + 0.3 * Math.sin(i * 2.4) + 0.02 * r.g(), vx: 0, vy: 0 })); let edges = [], wave = null, lastKey = "";
    function kruskal() { const key = Q.s + "|" + Q.scenKey; if (key === lastKey) return; lastKey = key; const c = Q.st.corr, all = []; for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) all.push([Math.sqrt(2 * (1 - c[i][j])), i, j]); all.sort((a, b) => a[0] - b[0]);
      const par = A.map((_, i) => i), find = (x) => (par[x] === x ? x : (par[x] = find(par[x]))); edges = []; for (const [d, i, j] of all) { const a = find(i), b = find(j); if (a !== b) { par[a] = b; edges.push({ i, j, d, rho: c[i][j] }); if (edges.length === N - 1) break; } } }
    function tick() { kruskal(); const k = 0.0016; for (let i = 0; i < N; i++) { let fx = (0.5 - pos[i].x) * 0.01, fy = (0.5 - pos[i].y) * 0.01; for (let j = 0; j < N; j++) if (i !== j) { const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y, d2 = dx * dx + dy * dy + 1e-4; fx += k * dx / d2 * 0.06; fy += k * dy / d2 * 0.06; } pos[i].fx = fx; pos[i].fy = fy; }
      for (const e of edges) { const a = pos[e.i], b = pos[e.j], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1e-3, rest = 0.035 + e.d * 0.115, f = (d - rest) * 0.09; a.fx += f * dx / d; a.fy += f * dy / d; b.fx -= f * dx / d; b.fy -= f * dy / d; }
      for (const p of pos) { p.vx = (p.vx + p.fx) * 0.82; p.vy = (p.vy + p.fy) * 0.82; p.x = Math.max(0.05, Math.min(0.95, p.x + p.vx)); p.y = Math.max(0.07, Math.min(0.93, p.y + p.vy)); } draw(); }
    function start(src) { const adj = A.map(() => []); for (const e of edges) { adj[e.i].push([e.j, e.rho]); adj[e.j].push([e.i, e.rho]); } const imp = new Array(N).fill(null), depth = new Array(N).fill(0); imp[src] = -0.10; const q = [src];
      while (q.length) { const u = q.shift(); for (const [v, rho] of adj[u]) if (imp[v] == null) { imp[v] = imp[u] * rho * Q.st.sd[v] / Q.st.sd[u]; depth[v] = depth[u] + 1; q.push(v); } } wave = { src, imp, depth, t0: performance.now() }; }
    function draw() {
      const { ctx, w, h } = QC.fit(cv, cv._h), X = (p) => p.x * w, Y = (p) => p.y * h, tw = wave ? (performance.now() - wave.t0) / 520 : 0; if (wave && tw > 14) wave = null;
      QC.grid(ctx, 0, 0, w, h, 12, 8);
      for (const e of edges) { const a = pos[e.i], b = pos[e.j]; let lit = 0; if (wave) { const d0 = Math.min(wave.depth[e.i], wave.depth[e.j]); lit = Math.max(0, Math.min(1, tw - d0)); }
        ctx.strokeStyle = e.rho >= 0 ? `rgba(34,230,255,${0.25 + 0.5 * Math.abs(e.rho)})` : `rgba(255,61,134,${0.3 + 0.5 * Math.abs(e.rho)})`; ctx.lineWidth = 1 + 2.5 * Math.abs(e.rho); ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
        if (lit > 0) { const from = wave.depth[e.i] <= wave.depth[e.j] ? a : b, to = from === a ? b : a; ctx.strokeStyle = "#ffc247"; ctx.shadowColor = "#ffc247"; ctx.shadowBlur = 12; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X(from), Y(from)); ctx.lineTo(QC.lerp(X(from), X(to), lit), QC.lerp(Y(from), Y(to), lit)); ctx.stroke(); ctx.shadowBlur = 0; } }
      const deg = new Array(N).fill(0); for (const e of edges) { deg[e.i]++; deg[e.j]++; } ctx.font = QC.FONT;
      for (let i = 0; i < N; i++) { const p = pos[i], c = QM.CLS_COL[A[i].cls], rad = Math.min(20, 5 + 1.1 * deg[i] + 14 * Q.w[i]), hit = wave && tw >= wave.depth[i];
        ctx.shadowColor = hit ? "#ffc247" : c; ctx.shadowBlur = hit ? 22 : 10; ctx.fillStyle = hit ? "#ffc247" : c; ctx.beginPath(); ctx.arc(X(p), Y(p), rad, 0, 7); ctx.fill(); ctx.shadowBlur = 0; ctx.fillStyle = "#060911"; ctx.beginPath(); ctx.arc(X(p), Y(p), rad - 2.5, 0, 7); ctx.fill();
        ctx.fillStyle = "#e8ecff"; ctx.textAlign = "center"; ctx.fillText(A[i].t, X(p), Y(p) - rad - 5); if (hit) { ctx.fillStyle = wave.imp[i] < 0 ? "#ff3d86" : "#2bffb0"; ctx.fillText((wave.imp[i] > 0 ? "+" : "") + (wave.imp[i] * 100).toFixed(1) + " %", X(p), Y(p) + rad + 14); } }
      const len = edges.reduce((s, e) => s + e.d, 0), cap = `Longueur de l'arbre : ${len.toFixed(2)} (plus il est court, plus tout bouge ensemble). Cliquez un nœud pour simuler un choc de −10 % et voir sa propagation.`; if (cv._cap.textContent !== cap) cv._cap.textContent = cap;
    }
    cv.addEventListener("click", (e) => { const rc = cv.getBoundingClientRect(), x = (e.clientX - rc.left) / rc.width, y = (e.clientY - rc.top) / rc.height; let best = -1, bd = 0.004; pos.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.y - y) ** 2 * (rc.height / rc.width) ** 2; if (d < bd) { bd = d; best = i; } }); if (best >= 0) start(best); });
    return { draw, tick };
  }

  /* ---------- 5. Matrice de bascule de corrélation ---------- */
  function heat(host, Q) {
    let regime = "delta", basis = "assets", cells = null; const draw_ = () => draw();
    host.append(h("div", { class: "toolbar", style: "margin-bottom:6px" }, segBtns([["calm", "Régime calme (95 % des jours)"], ["stress", "Stress extrême (5 % pires jours)"], ["delta", "Δ contagion (stress − calme)"]], () => regime, (k) => (regime = k), draw_), segBtns([["assets", "17 actifs"], ["factors", "5 facteurs"]], () => basis, (k) => (basis = k), draw_)));
    const cv = canvas(host, 470);
    function draw() {
      const { ctx, w, h } = QC.fit(cv, cv._h), calm = QM.state(0, QM.SCEN.none), str = QM.state(Math.max(Q.s, 1), Q.scen), Ca = basis === "assets" ? calm.corr : calm.fcorr, Cs = basis === "assets" ? str.corr : str.fcorr, labs = basis === "assets" ? A.map((a) => a.t) : F.map((f) => f.id), n = labs.length;
      const m = { l: 62, t: 46, r: 12, b: 12 }, sz = Math.min((w - m.l - m.r) / n, (h - m.t - m.b) / n), ox = m.l + ((w - m.l - m.r) - sz * n) / 2; cells = { ox, oy: m.t, sz, n, labs, Ca, Cs }; ctx.font = QC.FONT_S;
      for (let i = 0; i < n; i++) { ctx.fillStyle = "#a3acd6"; ctx.textAlign = "right"; ctx.fillText(labs[i], ox - 6, m.t + i * sz + sz / 2 + 3); ctx.save(); ctx.translate(ox + i * sz + sz / 2 + 3, m.t - 6); ctx.rotate(-Math.PI / 4); ctx.textAlign = "left"; ctx.fillText(labs[i], 0, 0); ctx.restore();
        for (let j = 0; j < n; j++) { const v = regime === "calm" ? Ca[i][j] : regime === "stress" ? Cs[i][j] : Cs[i][j] - Ca[i][j]; ctx.fillStyle = i === j && regime !== "delta" ? "rgba(255,255,255,0.07)" : QC.diverge(regime === "delta" ? v * 1.6 : v, 0.95); ctx.fillRect(ox + j * sz + 1, m.t + i * sz + 1, sz - 2, sz - 2);
          if (sz > 30) { ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.textAlign = "center"; ctx.fillText((v >= 0 && regime === "delta" ? "+" : "") + v.toFixed(2), ox + j * sz + sz / 2, m.t + i * sz + sz / 2 + 3); } } }
      const off = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off.push([Ca[i][j], Cs[i][j]]); const avg = (k) => off.reduce((s, o) => s + Math.abs(o[k]), 0) / off.length;
      ctx.fillStyle = "#a3acd6"; ctx.textAlign = "left"; ctx.fillText(`|ρ| moyen : calme ${avg(0).toFixed(2)} → stress ${avg(1).toFixed(2)}`, 6, 12);
    }
    cv.addEventListener("pointermove", (e) => { if (!cells) return; const r = cv.getBoundingClientRect(), j = Math.floor((e.clientX - r.left - cells.ox) / cells.sz), i = Math.floor((e.clientY - r.top - cells.oy) / cells.sz); if (i < 0 || j < 0 || i >= cells.n || j >= cells.n) return Ch.hideTip();
      tip(e, `${cells.labs[i]} × ${cells.labs[j]}`, [`Calme : ${cells.Ca[i][j].toFixed(3)}`, `Stress : ${cells.Cs[i][j].toFixed(3)}`, `Δ contagion : ${(cells.Cs[i][j] - cells.Ca[i][j] >= 0 ? "+" : "") + (cells.Cs[i][j] - cells.Ca[i][j]).toFixed(3)}`]); });
    cv.addEventListener("pointerleave", Ch.hideTip);
    return { draw };
  }

  /* ---------- 6. Cônes de trajectoires à sauts (Bates : volatilité stochastique + sauts de Poisson) ---------- */
  function cones(host, Q) {
    const cv = canvas(host, 420), NP = 1200, NS = 52, r = QM.rng(99), Z1 = new Float32Array(NP * NS), Z2 = new Float32Array(NP * NS), U = new Float32Array(NP * NS), ZJ = new Float32Array(NP * NS);
    for (let i = 0; i < NP * NS; i++) { Z1[i] = r.g(); Z2[i] = r.g(); U[i] = r.u(); ZJ[i] = r.g(); }
    function draw() {
      const { ctx, w, h: hh } = QC.fit(cv, cv._h), pf = Q.pf, s = Q.s, dt = 1 / NS, th = pf.vol * pf.vol, kap = 3, xi = 0.3 + 0.9 * s, rho = -0.65, lam = 0.3 + 5 * s, mj = (-0.04 - 0.07 * s) * Math.min(2.5, Q.lev), sj = 0.04 + 0.04 * s, comp = lam * (Math.exp(mj + sj * sj / 2) - 1), mu = pf.mu;
      const P = Array.from({ length: NS + 1 }, () => new Float32Array(NP)), Hd = Array.from({ length: NS + 1 }, () => new Float32Array(NP)), cov = pf.cover, Kp = 100 * (1 - QM.FLOOR);
      for (let p = 0; p < NP; p++) { let v = th, S = 100; P[0][p] = 100; Hd[0][p] = 100; for (let t = 0; t < NS; t++) { const k = p * NS + t, z1 = Z1[k], z2 = rho * z1 + Math.sqrt(1 - rho * rho) * Z2[k], vp = Math.max(v, 1e-6);
          let ret = (mu - comp - vp / 2) * dt + Math.sqrt(vp * dt) * z1; if (U[k] < lam * dt) ret += mj + sj * ZJ[k]; S = Math.max(0.5, S * Math.exp(ret)); v = Math.max(1e-6, v + kap * (th - vp) * dt + xi * Math.sqrt(vp * dt) * z2); P[t + 1][p] = S; Hd[t + 1][p] = S + cov * Math.max(0, Kp - S); } }
      const qs = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95], Qv = qs.map(() => new Float32Array(NS + 1)), tail = new Float32Array(NS + 1), hq = new Float32Array(NS + 1);
      for (let t = 0; t <= NS; t++) { const a = Float32Array.from(P[t]).sort(), b = Float32Array.from(Hd[t]).sort(); qs.forEach((q, i) => (Qv[i][t] = a[Math.floor(q * (NP - 1))])); let m = 0; const n1 = Math.max(1, Math.floor(NP * 0.01)); for (let i = 0; i < n1; i++) m += a[i]; tail[t] = m / n1; hq[t] = b[Math.floor(0.01 * (NP - 1))]; }
      const m = { l: 46, r: 12, t: 14, b: 26 }, lo = Math.max(0, Math.min(tail[NS], 60) - 5), hi = Math.min(400, Qv[5][NS] * 1.05), X = (t) => m.l + (t / NS) * (w - m.l - m.r), Y = (v) => m.t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (hh - m.t - m.b);
      QC.grid(ctx, m.l, m.t, w - m.r, hh - m.b, 12, 5); ctx.font = QC.FONT_S; ctx.fillStyle = "#a3acd6"; ctx.textAlign = "right"; for (let i = 0; i <= 5; i++) { const v = lo + (hi - lo) * i / 5; ctx.fillText(v.toFixed(0), m.l - 6, Y(v) + 3); } ctx.textAlign = "center"; for (let mo = 0; mo <= 12; mo += 2) ctx.fillText(mo + " m", X(mo / 12 * NS), hh - 8);
      const band = (a, b, c) => { ctx.beginPath(); for (let t = 0; t <= NS; t++) ctx[t ? "lineTo" : "moveTo"](X(t), Y(Qv[b][t])); for (let t = NS; t >= 0; t--) ctx.lineTo(X(t), Y(Qv[a][t])); ctx.closePath(); ctx.fillStyle = c; ctx.fill(); };
      band(1, 5, "rgba(34,230,255,0.10)"); band(2, 4, "rgba(34,230,255,0.22)"); const line = (arr, c, wd, dash) => { ctx.strokeStyle = c; ctx.lineWidth = wd; ctx.setLineDash(dash || []); ctx.shadowColor = c; ctx.shadowBlur = dash ? 0 : 8; ctx.beginPath(); for (let t = 0; t <= NS; t++) ctx[t ? "lineTo" : "moveTo"](X(t), Y(arr[t])); ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0; };
      line(Qv[3], "#22e6ff", 2.2); line(Qv[0], "#ff3d86", 1.4, [4, 3]); line(tail, "#ff3d86", 2); if (cov > 0) line(hq, "#2bffb0", 2.2);
      if (pf.margin != null) { const yM = Y(100 * (1 - pf.margin)); ctx.strokeStyle = "#ff3344"; ctx.lineWidth = 1.5; ctx.setLineDash([8, 5]); ctx.beginPath(); ctx.moveTo(m.l, yM); ctx.lineTo(w - m.r, yM); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "#ff3344"; ctx.textAlign = "right"; ctx.fillText(`APPEL DE MARGE / LIQUIDATION (−${pc(pf.margin, 0)})`, w - m.r - 4, yM - 5); }
      let hitM = 0; if (pf.margin != null) { const lvl = 100 * (1 - pf.margin); for (let p = 0; p < NP; p++) { for (let t = 1; t <= NS; t++) if ((cov > 0 ? Hd : P)[t][p] <= lvl) { hitM++; break; } } }
      cv._info = { med: Qv[3][NS], q5: Qv[1][NS], tail: tail[NS], hq: hq[NS], hitM: hitM / NP, lam };
      host._leg.replaceChildren(...[["#22e6ff", `Médiane ${Qv[3][NS].toFixed(0)}`], ["rgba(34,230,255,0.5)", "25–75 % et 5–95 %"], ["#ff3d86", `Queue 1 % : ${tail[NS].toFixed(0)}`], cov > 0 ? ["#2bffb0", `Avec puts : centile 1 % à ${hq[NS].toFixed(0)}`] : null, pf.margin != null ? ["#ff3344", `Liquidation sur 12 mois : ${pc(hitM / NP, 1)} des trajectoires`] : null].filter(Boolean).map(([c, t]) => h("span", {}, h("i", { style: `background:${c}` }), t)), h("span", { class: "dim" }, `${NP} trajectoires · ${lam.toFixed(1)} sauts/an attendus`));
    }
    host._leg = h("div", { class: "legend", style: "margin-top:8px" }); host.append(host._leg);
    return { draw };
  }

  /* ---------- 7. Surface de bêta conditionnel ---------- */
  function betaSurf(host, Q) {
    let k = 0; host.append(h("div", { class: "toolbar", style: "margin-bottom:6px" }, segBtns(F.map((f, i) => [i, f.id]), () => k, (v) => (k = v), () => draw())));
    const cv = canvas(host, 440), v3 = new QC.View3D(cv, () => draw(), -0.85, 0.45), G = 18;
    // sensibilité conditionnelle : convexe en VIX pour la liquidité et la volatilité, liée aux taux réels pour la duration
    const cond = (i, kk, vix, rr) => { const vn = (vix - 10) / 70, l = QM.L0[i][kk]; if (kk === 0) return l * (1 + 1.3 * Math.pow(vn, 1.6) + 0.06 * rr); if (kk === 4) return l * (1 + 1.8 * Math.pow(vn, 1.4)); if (kk === 1) return l * (1 + 0.22 * rr + 0.4 * vn) + (l < 0 ? -0.05 * rr * rr : 0); if (kk === 2) return l * (1 - 0.35 * vn - 0.07 * Math.max(0, rr - 2)); return l * (1 + 0.5 * vn); };
    const beta = (vix, rr) => { let b = 0; for (let i = 0; i < N; i++) b += Q.w[i] * cond(i, k, vix, rr); return b * Q.lev; };
    function draw() {
      const { ctx, w, h } = QC.fit(cv, cv._h); v3.frame(w, h); const B = Array.from({ length: G }, (_, i) => Array.from({ length: G }, (_, j) => beta(10 + 70 * i / (G - 1), -1 + 7 * j / (G - 1)))), flat = B.flat(), lo = Math.min(...flat), hi = Math.max(...flat), sp = hi - lo || 1;
      v3.axes(ctx, { x: { label: "VIX", min: "10", max: "80" }, y: { label: "Taux réels", min: "−1 %", max: "+6 %" }, z: { label: `β du portefeuille à ${F[k].id}`, min: lo.toFixed(2), max: hi.toFixed(2) } }); v3.surface(ctx, B.map((r) => r.map((v) => (v - lo) / sp)));
      const vix = 12 + 60 * Q.s, rr = 1.5 + 1.5 * Q.s * (Q.scenKey === "rates" ? 2 : 0.4), b = beta(vix, rr); v3.dot(ctx, (vix - 10) / 70, (rr + 1) / 7, (b - lo) / sp, "#fff", 6, `état actuel : β = ${b.toFixed(2)}`);
      QC.legend(ctx, w - 170, 22, 150, lo.toFixed(2), hi.toFixed(2), "β conditionnel"); cv._cap.textContent = `Convexité cachée : le β du portefeuille passe de ${beta(12, 1.5).toFixed(2)} par temps calme à ${beta(80, 1.5).toFixed(2)} quand le VIX atteint 80. Glisser pour tourner.`;
    }
    return { draw };
  }

  const LIST = [
    { id: "sankey", n: 1, title: "Flux de transformation : capital → facteurs → risque extrême", sub: "L'illusion de diversification : 17 lignes en capital, mais quelques facteurs seulement portent la perte.", mount: sankey, wide: true },
    { id: "frontier", n: 2, title: "Frontière efficiente factorielle 3D", sub: "Rendement espéré contre CVaR 99 % et diversification réelle (entropie des facteurs).", mount: frontier },
    { id: "robust", n: 3, title: "Paysage de robustesse", sub: "Le ratio rendement / CVaR résiste-t-il à l'erreur d'estimation des bêtas et à un glissement des corrélations ?", mount: robust },
    { id: "mst", n: 4, title: "Arbre couvrant minimal et contagion", sub: "Kruskal sur d = √(2(1 − ρ)). En stress, le réseau se contracte autour des nœuds systémiques.", mount: mst },
    { id: "heat", n: 5, title: "Bascule de corrélation et factor crowding", sub: "Ce qui est décorrélé par temps calme l'est-il encore les pires jours ?", mount: heat },
    { id: "cones", n: 6, title: "Cônes de trajectoires à sauts (Bates)", sub: "dS/S = μ dt + σₜ dWₜ + J dNₜ sur 12 mois, avec couverture par puts et seuil d'appel de marge.", mount: cones, wide: true },
    { id: "beta", n: 7, title: "Surface de bêta conditionnel", sub: "Comment la sensibilité du portefeuille à un facteur se déforme selon le VIX et les taux réels.", mount: betaSurf },
  ];
  return { LIST };
})();
