"use strict";
/* FactorThesisWorkbench — laboratoire économétrique sur les modèles à facteurs (outils 8, 9, 10).
   Les données sont SIMULÉES à partir du modèle à 5 facteurs du Vault (processus générateur connu) : on peut donc comparer chaque
   estimateur à la vérité. Tous les estimateurs (ACP, Kalman + lissage RTS + EM, MCO, Fama-MacBeth, Newey-West, GRS, GJR-GARCH, Kupiec) sont calculés pour de vrai. */
const QTH = (() => {
  const A = QM.ASSETS, F = QM.FACTORS, N = QM.N, TT = 756, ANN = 252;
  const P = { arch: "dfm", K: 3, phi: 0.5, win: 252, asset: 0, fk: 0, g: { f: 0, a: 0.06, g: 0.14, b: 0.85, dist: "norm" } };
  const FMEAN = [0.05, -0.01, 0.07, 0.02, -0.03];   // primes annuelles vraies des facteurs dans la simulation
  let sim = null, res = null, gj = null, simKey = "";
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, col = (M, j) => M.map((r) => r[j]);
  const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–"), pc = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + " %" : "–");
  const stars = (p) => (p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "");

  /* ---------- processus générateur ---------- */
  function simulate(Q) {
    const key = [Q.s, Q.scenKey, P.phi].join("|"); if (sim && key === simKey) return; simKey = key;
    const st = Q.st, r = QM.rng(2026), Sd = st.fcov.map((row) => row.map((v) => v * (1 - P.phi * P.phi) / ANN)), C = QM.chol(Sd), x = new Array(5).fill(0), R = [], Ft = [], Lt = [];
    for (let t = 0; t < TT; t++) { const z = Array.from({ length: 5 }, () => r.g()), e = QM.mv(C, z); for (let k = 0; k < 5; k++) x[k] = P.phi * x[k] + e[k];
      const f = x.map((v, k) => v + FMEAN[k] / ANN), brk = t > 0.62 * TT ? 1.4 : 1, wob = 1 + 0.2 * Math.sin((2 * Math.PI * 1.5 * t) / TT);
      const L = st.L.map((row) => [row[0] * brk, row[1], row[2] * wob, row[3], row[4] * brk]); Ft.push(f); Lt.push(L);
      R.push(L.map((row, i) => A[i].alpha / ANN + QM.dot(row, f) + (st.idio[i] / Math.sqrt(ANN)) * r.g())); }
    sim = { R, Ft, Lt };
  }

  /* ---------- filtre de Kalman (mises à jour séquentielles, R diagonale) + lissage RTS + EM ---------- */
  function kalman(Z, Lam, Rd, phi, smooth) {
    const T = Z.length, K = Lam[0].length, n = Z[0].length, q = 1 - phi * phi; let f = new Array(K).fill(0), Pm = QM.eye(K); const ff = [], Pf = [], fp = [], Pp = [];
    for (let t = 0; t < T; t++) { f = f.map((v) => phi * v); Pm = Pm.map((row, i) => row.map((v, j) => phi * phi * v + (i === j ? q : 0))); fp.push([...f]); Pp.push(Pm.map((r) => [...r]));
      for (let i = 0; i < n; i++) { const hv = Lam[i], Ph = QM.mv(Pm, hv), S = QM.dot(hv, Ph) + Rd[i], inn = Z[t][i] - QM.dot(hv, f); for (let a = 0; a < K; a++) { f[a] += Ph[a] * inn / S; for (let b = 0; b < K; b++) Pm[a][b] -= Ph[a] * Ph[b] / S; } }
      ff.push([...f]); Pf.push(Pm.map((r) => [...r])); }
    if (!smooth) return { ff, Pf };
    const fs = ff.map((v) => [...v]), Ps = Pf.map((m) => m.map((r) => [...r]));
    for (let t = T - 2; t >= 0; t--) { const J = QM.mul(Pf[t].map((r) => r.map((v) => v * phi)), QM.inv(Pp[t + 1])), d = fs[t + 1].map((v, k) => v - fp[t + 1][k]), Jd = QM.mv(J, d); for (let k = 0; k < K; k++) fs[t][k] = ff[t][k] + Jd[k];
      const D = Ps[t + 1].map((r, i) => r.map((v, j) => v - Pp[t + 1][i][j])), JD = QM.mul(QM.mul(J, D), QM.T(J)); for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) Ps[t][i][j] = Pf[t][i][j] + JD[i][j]; }
    return { ff, Pf, fs, Ps };
  }
  function dfm(Z, K, phi, V, vals) {
    let Lam = V.map((row) => row.slice(0, K).map((v, k) => v * Math.sqrt(Math.max(vals[k], 1e-6)))), Rd = Lam.map((l) => Math.max(0.03, 1 - QM.dot(l, l))), out;
    for (let it = 0; it < 4; it++) { out = kalman(Z, Lam, Rd, phi, true); if (it === 3) break; const T = Z.length, Sff = QM.zeros(K, K); for (let t = 0; t < T; t++) for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) Sff[a][b] += out.fs[t][a] * out.fs[t][b] + out.Ps[t][a][b];
      const Si = QM.inv(Sff); Lam = Lam.map((_, i) => { const zf = new Array(K).fill(0); let zz = 0; for (let t = 0; t < T; t++) { zz += Z[t][i] * Z[t][i]; for (let a = 0; a < K; a++) zf[a] += Z[t][i] * out.fs[t][a]; } const l = QM.mv(Si, zf); Rd[i] = Math.max(0.03, (zz - QM.dot(l, zf)) / T); return l; }); }
    return { Lam, Rd, ...out };
  }

  /* ---------- construction des facteurs selon l'architecture ---------- */
  function factors(Q, w0) {
    const R = sim.R, W = TT - w0, Rw = R.slice(w0), mu = A.map((_, i) => mean(col(Rw, i))), sd = A.map((_, i) => { const c = col(Rw, i); return Math.sqrt(mean(c.map((v) => (v - mu[i]) ** 2))) || 1e-9; });
    const Zall = R.map((row) => row.map((v, i) => (v - mu[i]) / sd[i])), Zw = Zall.slice(w0), Cm = QM.zeros(N, N); for (const z of Zw) for (let i = 0; i < N; i++) for (let j = i; j < N; j++) Cm[i][j] += z[i] * z[j] / W; for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) Cm[i][j] = Cm[j][i];
    const E = QM.eig(Cm); let K = P.K, Fm, names, note = "", kal = null, trueIdx = null;
    if (P.arch === "macro") { const ord = [0, 1, 3, 4, 2].slice(0, K); Fm = sim.Ft.map((f) => ord.map((k) => f[k])); names = ord.map((k) => F[k].id); trueIdx = ord; note = "Facteurs macro-financiers observés (ici : les vrais facteurs de la simulation)."; }
    else if (P.arch === "style") { K = Math.min(K, 4); if (P.K > 4) note = "Le modèle de style compte 4 facteurs : K est limité à 4. ";
      const mk = R.map((row) => mean(row)), Fm_ = R.map(() => [0, 0, 0, 0]); let bet = A.map(() => 1), rank = null;
      for (let t = 0; t < TT; t++) { if (t >= 40 && t % 20 === 0) { const a = Math.max(0, t - 120), m = mk.slice(a, t), mm = mean(m), vm = mean(m.map((v) => (v - mm) ** 2)) || 1e-12; bet = A.map((_, i) => { const c = col(R.slice(a, t), i), mc = mean(c); return mean(c.map((v, s) => (v - mc) * (m[s] - mm))) / vm; });
          const a2 = Math.max(0, t - 60), mom = A.map((_, i) => col(R.slice(a2, t), i).reduce((s, v) => s + v, 0)), vol = A.map((_, i) => { const c = col(R.slice(a2, t), i), mc = mean(c); return Math.sqrt(mean(c.map((v) => (v - mc) ** 2))); });
          const top = (arr, hi) => arr.map((v, i) => [v, i]).sort((x, y) => (hi ? y[0] - x[0] : x[0] - y[0])).slice(0, 5).map((x) => x[1]); rank = { bh: top(bet, 1), bl: top(bet, 0), mw: top(mom, 1), ml: top(mom, 0), vl: top(vol, 0), vh: top(vol, 1) }; }
        const ls = (l, s) => mean(l.map((i) => R[t][i])) - mean(s.map((i) => R[t][i])); Fm_[t] = rank ? [mk[t], ls(rank.bh, rank.bl), ls(rank.mw, rank.ml), ls(rank.vl, rank.vh)] : [mk[t], 0, 0, 0]; }
      Fm = Fm_.map((f) => f.slice(0, K)); names = ["MKT", "BETA (H−L)", "MOM (W−L)", "QUAL (faible vol − forte vol)"].slice(0, K); note += "Facteurs de style construits sur le panel : marché équipondéré, portefeuilles long-short réordonnés tous les 20 jours."; }
    else if (P.arch === "pca") { Fm = Zall.map((z) => Array.from({ length: K }, (_, k) => { let s = 0; for (let i = 0; i < N; i++) s += E.vecs[i][k] * z[i]; return s * 0.01; })); names = Array.from({ length: K }, (_, k) => "PC" + (k + 1)); note = "Composantes principales de la matrice de corrélation (fenêtre d'estimation)."; }
    else { kal = dfm(Zw, K, P.phi, E.vecs, E.vals); const full = kalman(Zall, kal.Lam, kal.Rd, P.phi, false); Fm = full.ff.map((f) => f.map((v) => v * 0.01)); for (let t = 0; t < W; t++) Fm[w0 + t] = kal.fs[t].map((v) => v * 0.01); names = Array.from({ length: K }, (_, k) => "DFM" + (k + 1)); note = "Facteurs latents extraits par filtre de Kalman, lissage RTS et 3 itérations EM (Φ fixé par le curseur). Facteurs non négociables : le test GRS est indicatif."; }
    return { Fm, names, K, note, kal, E, trueIdx, sd, mu };
  }

  /* ---------- estimation complète ---------- */
  function analyse(Q) {
    simulate(Q); const w0 = TT - P.win, T = P.win, fx = factors(Q, w0), K = fx.K, Fw = fx.Fm.slice(w0), Rw = sim.R.slice(w0), X = Fw.map((f) => [1, ...f]);
    const ts = A.map((_, i) => { const y = col(Rw, i), o = QM.ols(X, y), my = mean(y), sst = y.reduce((s, v) => s + (v - my) ** 2, 0), sse = QM.dot(o.e, o.e), r2 = 1 - sse / sst; const inc = []; let prev = 0; for (let k = 1; k <= K; k++) { const ok = QM.ols(Fw.map((f) => [1, ...f.slice(0, k)]), y), r = 1 - QM.dot(ok.e, ok.e) / sst; inc.push(Math.max(0, r - prev)); prev = Math.max(prev, r); }
      return { alpha: o.b[0], beta: o.b.slice(1), e: o.e, r2, r2adj: 1 - (1 - r2) * (T - 1) / (T - K - 1), inc, tAlpha: o.b[0] / Math.sqrt(o.s2 * o.XtXi[0][0]) }; });
    // Fama-MacBeth : coupe transversale à chaque date sur les bêtas de première étape
    const Bx = ts.map((a) => [1, ...a.beta]), Gm = QM.mul(QM.inv(QM.mul(QM.T(Bx), Bx)), QM.T(Bx)), gam = Rw.map((r) => QM.mv(Gm, r)), gbar = Array.from({ length: K + 1 }, (_, k) => mean(col(gam, k))), Lnw = Math.max(1, Math.floor(4 * Math.pow(T / 100, 2 / 9)));
    const nw = gbar.map((m, k) => { const d = col(gam, k).map((v) => v - m); let v = QM.dot(d, d) / T; for (let l = 1; l <= Lnw; l++) { let c = 0; for (let t = l; t < T; t++) c += d[t] * d[t - l]; v += 2 * (1 - l / (Lnw + 1)) * c / T; } return Math.sqrt(Math.max(v, 1e-30) / T); });
    const lam = gbar.map((m, k) => { const t = m / nw[k]; return { est: m * ANN, se: nw[k] * ANN, t, p: 2 * (1 - QM.tCdf(Math.abs(t), T - 1)) }; });
    const mR = A.map((_, i) => mean(col(Rw, i))), pred = Bx.map((b) => QM.dot(b, gbar)), aFM = mR.map((m, i) => m - pred[i]), mm = mean(mR), csR2 = 1 - aFM.reduce((s, a) => s + a * a, 0) / mR.reduce((s, m) => s + (m - mm) ** 2, 0), rmse = Math.sqrt(mean(aFM.map((a) => a * a))) * ANN;
    // GRS
    let grs = null; const df2 = T - N - K, traded = P.arch === "macro" || P.arch === "style"; if (df2 >= 1 && traded) { const Sg = QM.zeros(N, N); for (let t = 0; t < T; t++) for (let i = 0; i < N; i++) { const ei = ts[i].e[t]; for (let j = i; j < N; j++) Sg[i][j] += ei * ts[j].e[t] / (T - K - 1); } for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) Sg[i][j] = Sg[j][i];
      const al = ts.map((a) => a.alpha), muF = Array.from({ length: K }, (_, k) => mean(col(Fw, k))), Om = QM.zeros(K, K); for (const f of Fw) for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) Om[a][b] += (f[a] - muF[a]) * (f[b] - muF[b]) / T;
      const sh = QM.dot(muF, QM.mv(QM.inv(Om), muF)), q = QM.dot(al, QM.mv(QM.inv(Sg), al)), stat = (df2 / N) * q / (1 + sh), p = 1 - QM.fCdf(stat, N, df2); grs = { stat, p, df1: N, df2, sharpe2: sh }; }
    // bêtas dynamiques : MCO glissant et Kalman à marche aléatoire
    const ai = P.asset, y = ai === "PF" ? sim.R.map((r) => QM.dot(r, Q.w)) : col(sim.R, ai), j = Math.min(P.fk, K - 1), Xall = fx.Fm.map((f) => [1, ...f]), roll = [];
    for (let t = P.win; t <= TT; t += 3) { const o = QM.ols(Xall.slice(t - P.win, t), y.slice(t - P.win, t)); roll.push({ t: t - 1, b: o.b[j + 1], se: Math.sqrt(o.s2 * o.XtXi[j + 1][j + 1]) }); }
    const oF = QM.ols(Xall, y), fsd = Math.sqrt(mean(col(fx.Fm, j).map((v) => v * v))) || 1e-6, qb = Math.pow(0.02 * Math.max(0.3, Math.abs(oF.b[j + 1])), 2); let bk = oF.b.map(() => 0), Pk = QM.eye(K + 1).map((r, i) => r.map((v) => v * (i ? 4 : 1e-6))); const kb = [];
    for (let t = 0; t < TT; t++) { for (let a = 1; a <= K; a++) Pk[a][a] += qb; const x = Xall[t], Px = QM.mv(Pk, x), S = QM.dot(x, Px) + oF.s2, inn = y[t] - QM.dot(x, bk); for (let a = 0; a <= K; a++) { bk[a] += Px[a] * inn / S; for (let b = 0; b <= K; b++) Pk[a][b] -= Px[a] * Px[b] / S; } if (t % 3 === 0) kb.push({ t, b: bk[j + 1], se: Math.sqrt(Math.max(0, Pk[j + 1][j + 1])) }); }
    const truth = fx.trueIdx ? sim.Lt.map((L, t) => (ai === "PF" ? L.reduce((s, row, i) => s + Q.w[i] * row[fx.trueIdx[j]], 0) : L[ai][fx.trueIdx[j]])) : null;
    // critères de Bai & Ng sur les valeurs propres de la fenêtre
    const vals = fx.E.vals, ic = []; for (let k = 0; k <= 8; k++) { const V = Math.max(1e-9, vals.slice(k).reduce((s, v) => s + v, 0) / N), pen = (N + T) / (N * T); ic.push({ k, icp1: Math.log(V) + k * pen * Math.log(1 / pen), icp2: Math.log(V) + k * pen * Math.log(Math.min(N, T)), aic: Math.log(V) + k * 2 * (N + T - k) / (N * T), bic: Math.log(V) + k * (N + T - k) * Math.log(N * T) / (N * T) }); }
    const arg = (f) => ic.reduce((b, c) => (c[f] < b[f] ? c : b)).k;
    res = { fx, K, T, w0, ts, lam, Lnw, pred, mR, aFM, csR2, rmse, grs, roll, kb, truth, ic, kstar: { icp1: arg("icp1"), icp2: arg("icp2"), aic: arg("aic"), bic: arg("bic") }, vals, r2adjMean: mean(ts.map((a) => a.r2adj)), j };
    garch(Q);
  }

  /* ---------- Factor-GJR-GARCH ---------- */
  const U = (() => { const r = QM.rng(4242), a = []; for (let i = 0; i < 300 * 6; i++) a.push(Math.min(0.99999, Math.max(1e-5, r.u()))); return a; })();
  function garch(Q) {
    const g = P.g, pers = g.a + g.b + g.g / 2, st = Q.st, qf = g.dist === "norm" ? QM.normInv : g.dist === "t" ? (p) => QM.tInv(p, 5) * Math.sqrt(0.6) : (p) => QM.skewTInv(p), q01 = qf(0.01), agg = g.f === "PF";
    const ks = agg ? [0, 1, 2, 3, 4] : [g.f], om = ks.map((k) => (st.fvol[k] ** 2 / ANN) * 0.02), unc = om.map((o) => (pers < 1 ? o / (1 - pers) : NaN)), b = agg ? Q.pf.b : [1], vI = agg ? (Q.pf.idioShare / (1 - Q.pf.idioShare)) * 0 : 0;
    const s2 = ks.map((_, i) => (pers < 1 ? unc[i] : om[i] / 0.02)), ret = [], vr = [], sv = []; let s2s = null; const omP = () => ks.reduce((s, _, i) => s + b[i] * b[i] * om[i], 0);
    for (let t = 0; t < 300; t++) { let r = 0, v = vI; ks.forEach((_, i) => { const z = qf(U[t * 6 + i]), e = Math.sqrt(s2[i]) * z; r += b[i] * e; v += b[i] * b[i] * s2[i]; s2[i] = Math.min(om[i] + (g.a + (e < 0 ? g.g : 0)) * e * e + g.b * s2[i], 1e3 * om[i] / 0.02); });
      if (s2s == null) s2s = v; if (t >= 50) { ret.push(r); vr.push(v); sv.push(s2s); } s2s = omP() + (g.a + g.g / 2) * r * r + g.b * s2s; }
    const exc = (vv) => ret.filter((r, t) => r < q01 * Math.sqrt(vv[t])).length, kup = (x, n = ret.length, p = 0.01) => { const ph = x / n, l0 = (n - x) * Math.log(1 - p) + x * Math.log(p), l1 = (x ? x * Math.log(ph) : 0) + (n - x ? (n - x) * Math.log(1 - ph) : 0), lr = -2 * (l0 - l1); return { x, lr, p: 1 - QM.chi2Cdf1(lr) }; };
    const uncP = pers < 1 ? ks.reduce((s, _, i) => s + b[i] * b[i] * unc[i], 0) : NaN;
    gj = { pers, q01, ret, vr, sv, kGjr: kup(exc(vr)), kSym: kup(exc(sv)), uncVol: Math.sqrt(uncP * ANN), hl: pers < 1 ? Math.log(0.5) / Math.log(pers) : Infinity, asym: (g.a + g.g) / g.a, om: omP(), base: ks.reduce((s, _, i) => s + b[i] * b[i] * om[i] / 0.02, 0) };
  }

  /* ---------- dessin ---------- */
  function frame(ctx, w, h, xr, yr, o = {}) {
    const m = { l: o.l ?? 46, r: 12, t: o.t ?? 14, b: o.b ?? 26 }, X = (v) => m.l + ((v - xr[0]) / (xr[1] - xr[0] || 1)) * (w - m.l - m.r), Y = (v) => m.t + (1 - (v - yr[0]) / (yr[1] - yr[0] || 1)) * (h - m.t - m.b);
    QC.grid(ctx, m.l, m.t, w - m.r, h - m.b, o.nx ?? 6, 5); ctx.font = QC.FONT_S; ctx.fillStyle = "#a3acd6"; ctx.textAlign = "right"; for (let i = 0; i <= 5; i++) { const v = yr[0] + (yr[1] - yr[0]) * i / 5; ctx.fillText((o.yf || ((x) => x.toFixed(2)))(v), m.l - 5, Y(v) + 3); }
    if (o.xf) { ctx.textAlign = "center"; for (let i = 0; i <= (o.nx ?? 6); i++) { const v = xr[0] + (xr[1] - xr[0]) * i / (o.nx ?? 6); ctx.fillText(o.xf(v), X(v), h - 8); } } if (o.xl) { ctx.textAlign = "right"; ctx.fillText(o.xl, w - m.r, h - 8); } if (o.yl) { ctx.textAlign = "left"; ctx.fillText(o.yl, m.l + 4, m.t + 10); }
    return { X, Y, m };
  }
  const line = (ctx, pts, c, wd = 1.8, dash) => { ctx.strokeStyle = c; ctx.lineWidth = wd; ctx.setLineDash(dash || []); ctx.beginPath(); pts.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](p[0], p[1])); ctx.stroke(); ctx.setLineDash([]); };
  const bandFill = (ctx, up, dn, c) => { ctx.beginPath(); up.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](p[0], p[1])); for (let i = dn.length - 1; i >= 0; i--) ctx.lineTo(dn[i][0], dn[i][1]); ctx.closePath(); ctx.fillStyle = c; ctx.fill(); };
  const FC = ["#22e6ff", "#9a6bff", "#2bffb0", "#ffc247", "#ff3d86"];
  const mk = (host, hgt) => { const c = document.createElement("canvas"); c.style.display = "block"; c._cap = document.createElement("p"); c._cap.className = "qnote"; host.append(c, c._cap); c._h = hgt; return c; };

  function drawScree(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), v = res.vals.slice(0, 8), tot = N, { X, Y, m } = frame(ctx, w, h, [0.4, 8.6], [0, 1], { yf: (x) => (x * 100).toFixed(0) + " %", nx: 8, b: 40 }), bw = (X(1) - X(0)) * 0.6; let cum = 0; const cpts = [];
    v.forEach((l, i) => { const sh = l / tot; cum += sh; ctx.fillStyle = i < res.K ? FC[i % 5] : "rgba(140,170,255,0.25)"; ctx.fillRect(X(i + 1) - bw / 2, Y(sh), bw, Y(0) - Y(sh)); cpts.push([X(i + 1), Y(cum)]); ctx.fillStyle = "#e8ecff"; ctx.textAlign = "center"; ctx.fillText((sh * 100).toFixed(0), X(i + 1), Y(sh) - 4); ctx.fillStyle = "#a3acd6"; ctx.fillText("λ" + (i + 1), X(i + 1), h - 24); });
    line(ctx, cpts, "#fff", 1.6); cpts.forEach((p) => { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fill(); });
    const ks = res.kstar.icp2; if (ks >= 1 && ks <= 8) { ctx.strokeStyle = "#ffc247"; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(X(ks + 0.5), m.t); ctx.lineTo(X(ks + 0.5), Y(0)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "#ffc247"; ctx.textAlign = "left"; ctx.fillText("K* = " + ks + " (ICp2)", X(ks + 0.5) + 4, m.t + 10); }
    cv._cap.textContent = `Le 1er facteur explique ${(v[0] / tot * 100).toFixed(0)} % de la variance totale. Nombre optimal K* : ICp1 = ${res.kstar.icp1}, ICp2 = ${res.kstar.icp2}, AIC = ${res.kstar.aic}, BIC = ${res.kstar.bic} (Bai & Ng, kmax = 8). Avec seulement N = 17 actifs, ICp1 et AIC surestiment K ; ICp2 est le plus fiable ici (la simulation compte 5 vrais facteurs).`; }
  function drawFactors(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), fx = res.fx, T = res.T, K = res.K, kal = fx.kal, ser = Array.from({ length: K }, (_, k) => { if (kal) return kal.fs.map((f) => f[k]); let c = 0; const s = fx.Fm.slice(res.w0).map((f) => (c += f[k])), sd = Math.sqrt(mean(s.map((v) => v * v))) || 1; return s.map((v) => v / sd); });
    const all = ser.flat(), lo = Math.min(...all) - 0.5, hi = Math.max(...all) + 0.5, { X, Y } = frame(ctx, w, h, [0, T - 1], [lo, hi], { xf: (v) => "t" + (v - T + 1 | 0), yf: (v) => v.toFixed(1) });
    if (kal) { const k0 = Math.min(P.fk, K - 1), up = [], dn = [], up2 = [], dn2 = []; for (let t = 0; t < T; t++) { const s = 1.96 * Math.sqrt(Math.max(0, kal.Ps[t][k0][k0])), sf = 1.96 * Math.sqrt(Math.max(0, kal.Pf[t][k0][k0])); up.push([X(t), Y(kal.fs[t][k0] + s)]); dn.push([X(t), Y(kal.fs[t][k0] - s)]); up2.push([X(t), Y(kal.ff[t][k0] + sf)]); dn2.push([X(t), Y(kal.ff[t][k0] - sf)]); }
      bandFill(ctx, up2, dn2, "rgba(255,255,255,0.06)"); bandFill(ctx, up, dn, "rgba(34,230,255,0.18)"); line(ctx, kal.ff.map((f, t) => [X(t), Y(f[k0])]), "rgba(255,255,255,0.55)", 1, [3, 3]); }
    ser.forEach((s, k) => line(ctx, s.map((v, t) => [X(t), Y(v)]), FC[k % 5], k === Math.min(P.fk, K - 1) ? 2.2 : 1.1));
    cv._cap.textContent = kal ? `Trait plein : facteur lissé F(t|T). Pointillé : filtré F(t|t). Bandes à 95 % : ±1,96·√P, bleu pour le lissé, gris pour le filtré (facteur ${fx.names[Math.min(P.fk, K - 1)]}).` : "Facteurs cumulés et normalisés. La bande d'incertitude d'état n'existe que pour le DFM."; }
  function drawVar(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), K = res.K, x0 = 50, x1 = w - 44, rh = (h - 14) / N; ctx.font = QC.FONT_S;
    res.ts.forEach((a, i) => { const y = 8 + i * rh; let x = x0; ctx.fillStyle = "#a3acd6"; ctx.textAlign = "right"; ctx.fillText(A[i].t, x0 - 6, y + rh / 2 + 3); a.inc.forEach((sh, k) => { const ww = sh * (x1 - x0); ctx.fillStyle = FC[k % 5]; ctx.fillRect(x, y + 1, ww, rh - 3); x += ww; }); ctx.fillStyle = "rgba(140,170,255,0.16)"; ctx.fillRect(x, y + 1, x1 - x, rh - 3); ctx.fillStyle = "#e8ecff"; ctx.textAlign = "left"; ctx.fillText((a.r2 * 100).toFixed(0) + " %", x1 + 5, y + rh / 2 + 3); });
    cv._cap.textContent = `Couleurs : part de variance expliquée par chaque facteur (R² incrémental, dans l'ordre F1 à FK). Gris : part idiosyncratique 1 − R². R² ajusté moyen : ${(res.r2adjMean * 100).toFixed(0)} %.`; cv._rows = { x0, x1, rh }; }
  function drawBeta(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), all = [...res.roll.flatMap((r) => [r.b + 2 * r.se, r.b - 2 * r.se]), ...res.kb.slice(20).map((r) => r.b), ...(res.truth || [])], lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.08 || 0.1, { X, Y, m } = frame(ctx, w, h, [0, TT - 1], [lo - pad, hi + pad], { xf: (v) => "j" + Math.round(v), yf: (v) => v.toFixed(2) });
    const bx = X(0.62 * TT); ctx.strokeStyle = "rgba(255,194,71,0.6)"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(bx, m.t); ctx.lineTo(bx, h - m.b); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "#ffc247"; ctx.textAlign = "left"; ctx.fillText("rupture de régime", bx + 4, m.t + 10);
    bandFill(ctx, res.roll.map((r) => [X(r.t), Y(r.b + 2 * r.se)]), res.roll.map((r) => [X(r.t), Y(r.b - 2 * r.se)]), "rgba(154,107,255,0.18)"); const kk = res.kb.slice(15); bandFill(ctx, kk.map((r) => [X(r.t), Y(r.b + 2 * r.se)]), kk.map((r) => [X(r.t), Y(r.b - 2 * r.se)]), "rgba(34,230,255,0.14)");
    if (res.truth) line(ctx, res.truth.map((v, t) => [X(t), Y(v)]), "rgba(255,255,255,0.75)", 1.2, [5, 4]); line(ctx, res.roll.map((r) => [X(r.t), Y(r.b)]), "#9a6bff", 2); line(ctx, kk.map((r) => [X(r.t), Y(r.b)]), "#22e6ff", 2); }
  function drawSML(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), px = res.pred.map((v) => v * ANN), py = res.mR.map((v) => v * ANN), lo = Math.min(...px, ...py), hi = Math.max(...px, ...py), pad = (hi - lo) * 0.1 || 0.05, r = [lo - pad, hi + pad], { X, Y } = frame(ctx, w, h, r, r, { xf: (v) => (v * 100).toFixed(0) + " %", yf: (v) => (v * 100).toFixed(0) + " %", xl: "prédit Σ β̂·λ̂", yl: "rendement moyen réalisé (annuel)" });
    line(ctx, [[X(r[0]), Y(r[0])], [X(r[1]), Y(r[1])]], "rgba(255,255,255,0.6)", 1.2, [5, 4]); cv._pts = [];
    A.forEach((a, i) => { const x = X(px[i]), y = Y(py[i]), al = py[i] - px[i]; ctx.strokeStyle = al >= 0 ? "rgba(43,255,176,0.7)" : "rgba(255,61,134,0.7)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, Y(px[i])); ctx.stroke(); ctx.fillStyle = QM.CLS_COL[a.cls]; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); ctx.fillStyle = "#e8ecff"; ctx.textAlign = "left"; ctx.fillText(a.t, x + 6, y - 5); cv._pts.push({ x, y, i, al }); }); }
  function drawNIC(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), g = P.g, pers = gj.pers, sb = pers < 1 ? gj.om / (1 - pers) : gj.base, f = (x, gam) => (gj.om + (g.a + (x < 0 ? gam : 0)) * x * x * sb + g.b * sb) / sb, xs = Array.from({ length: 121 }, (_, i) => -5 + i / 12), ymax = Math.max(f(-5, g.g), f(5, 0)) * 1.05, { X, Y } = frame(ctx, w, h, [-5, 5], [0, ymax], { xf: (v) => (v > 0 ? "+" : "") + v.toFixed(0) + "σ", yf: (v) => v.toFixed(1) + "×", nx: 10, yl: "variance conditionnelle σ²(t) / σ̄²" });
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(0), Y(ymax)); ctx.stroke(); line(ctx, xs.map((x) => [X(x), Y(f(x, 0))]), "rgba(255,255,255,0.7)", 1.4, [5, 4]); ctx.shadowColor = "#ff3d86"; ctx.shadowBlur = 10; line(ctx, xs.map((x) => [X(x), Y(f(x, g.g))]), "#ff3d86", 2.4); ctx.shadowBlur = 0;
    cv._cap.textContent = `Trait plein : Factor-GJR-GARCH. Pointillé : GARCH(1,1) symétrique (γ = 0). Un choc de −3σ augmente la variance ${(f(-3, g.g) / f(3, g.g)).toFixed(2)}× plus qu'un choc de +3σ.`; }
  function drawVaR(cv) { const { ctx, w, h } = QC.fit(cv, cv._h), r = gj.ret, n = r.length, vg = gj.vr.map((v) => gj.q01 * Math.sqrt(v)), vs = gj.sv.map((v) => gj.q01 * Math.sqrt(v)), lo = Math.min(...r, ...vg, ...vs) * 1.1, hi = Math.max(...r) * 1.15, { X, Y } = frame(ctx, w, h, [0, n - 1], [lo, hi], { xf: (v) => "j" + Math.round(v), yf: (v) => (v * 100).toFixed(1) + " %" }), bw = Math.max(1, (X(1) - X(0)) * 0.7);
    r.forEach((v, t) => { ctx.fillStyle = v >= 0 ? "rgba(43,255,176,0.55)" : "rgba(140,170,255,0.5)"; ctx.fillRect(X(t) - bw / 2, Math.min(Y(0), Y(v)), bw, Math.abs(Y(v) - Y(0))); }); line(ctx, vs.map((v, t) => [X(t), Y(v)]), "rgba(255,255,255,0.7)", 1.3, [5, 4]); ctx.shadowColor = "#ff3d86"; ctx.shadowBlur = 8; line(ctx, vg.map((v, t) => [X(t), Y(v)]), "#ff3d86", 2); ctx.shadowBlur = 0;
    r.forEach((v, t) => { if (v < vg[t]) { ctx.fillStyle = "#ff3344"; ctx.shadowColor = "#ff3344"; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(X(t), Y(v), 4.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0; } }); }

  /* ---------- équations (HTML statique) ---------- */
  const eq = (html) => { const d = document.createElement("div"); d.className = "eq"; d.innerHTML = html; return d; };
  const EQ = {
    ss: `<div><i>R<sub>t</sub></i> = <i>α</i> + <b>Λ</b><sub><i>t</i></sub> <i>F<sub>t</sub></i> + <i>ε<sub>t</sub></i>, &nbsp; <i>ε<sub>t</sub></i> ~ 𝒩(0, <b>Σ</b><sub><i>ε</i></sub>) <span class="eqn">équation d'observation, <i>N</i> = 17 actifs</span></div><div><i>F<sub>t</sub></i> = <b>Φ</b> <i>F</i><sub><i>t</i>−1</sub> + <i>η<sub>t</sub></i>, &nbsp; <i>η<sub>t</sub></i> ~ 𝒩(0, <b>Σ</b><sub><i>η</i></sub>) <span class="eqn">transition VAR(1) des <i>K</i> facteurs latents</span></div>`,
    fm: `<div>𝔼[<i>R<sub>i</sub></i>] = <i>λ</i><sub>0</sub> + Σ<sub><i>k</i>=1..<i>K</i></sub> <i>β<sub>i,k</sub> λ<sub>k</sub></i> + <i>α<sub>i</sub></i> <span class="eqn">Fama-MacBeth, étape 2 : une coupe transversale par date</span></div><div><i>F</i><sub>GRS</sub> = <span class="frac"><span><i>T</i> − <i>N</i> − <i>K</i></span><span><i>N</i></span></span> (1 + <i>μ̂<sub>F</sub></i>′ <b>Ω̂</b><sub><i>F</i></sub><sup>−1</sup> <i>μ̂<sub>F</sub></i>)<sup>−1</sup> <i>α̂</i>′ <b>Σ̂</b><sub><i>ε</i></sub><sup>−1</sup> <i>α̂</i> ~ <i>F</i>(<i>N</i>, <i>T</i> − <i>N</i> − <i>K</i>) <span class="eqn">H<sub>0</sub> : <i>α</i><sub>1</sub> = … = <i>α<sub>N</sub></i> = 0</span></div>`,
    gj: `<div><b>Σ</b><sub><i>t</i></sub> = <b>Λ</b><sub><i>t</i></sub> diag(<i>σ</i><sup>2</sup><sub><i>F</i><sub>1</sub>,<i>t</i></sub>, …, <i>σ</i><sup>2</sup><sub><i>F<sub>K</sub></i>,<i>t</i></sub>) <b>Λ</b><sub><i>t</i></sub>′ + <b>Σ</b><sub><i>ε</i></sub> <span class="eqn"><i>K</i> équations de variance au lieu de <i>N</i>(<i>N</i>+1)/2 = 153</span></div><div><i>σ</i><sup>2</sup><sub><i>F<sub>k</sub></i>,<i>t</i></sub> = <i>ω<sub>k</sub></i> + (<i>α<sub>k</sub></i> + <i>γ<sub>k</sub></i> 𝟙<sub>{<i>η</i><sub><i>k</i>,<i>t</i>−1</sub> &lt; 0}</sub>) <i>η</i><sup>2</sup><sub><i>k</i>,<i>t</i>−1</sub> + <i>β<sub>k</sub> σ</i><sup>2</sup><sub><i>F<sub>k</sub></i>,<i>t</i>−1</sub> <span class="eqn">GJR-GARCH(1,1) par facteur</span></div>`,
  };

  /* ---------- interface ---------- */
  function mount(host, Q) {
    const z = {}, redo = () => { analyse(Q); paint(); }, sg = (items, get, set) => { const b = h("div", { class: "seg" }); const p = () => b.replaceChildren(...items.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(get() === k), onclick: () => { set(k); p(); redo(); } }, l))); p(); b._p = p; return b; };
    const slider = (lab, min, max, step, get, set, f) => { const out = h("b", { class: "mono" }, f(get())), i = h("input", { type: "range", min, max, step, value: get(), "aria-label": lab }); i.addEventListener("input", () => { set(Number(i.value)); out.textContent = f(get()); redo(); }); return h("label", { class: "qslider" }, h("span", {}, lab, " ", out), i); };
    const card = (n, title, sub, ...kids) => h("section", { class: "qpanel" }, h("div", { class: "qhead" }, h("span", { class: "qnum" }, n), h("div", {}, h("h3", {}, title), sub ? h("p", {}, sub) : null)), ...kids);
    const cvbox = (title, hgt) => { const b = h("div", { class: "qsub" }, h("h4", {}, title)); const c = mk(b, hgt); return [b, c]; };
    // --- outil 8
    const [b1, c1] = cvbox("Valeurs propres et critères de Bai & Ng", 300), [b2, c2] = cvbox("Trajectoires des facteurs latents", 300), [b3, c3] = cvbox("Décomposition de la variance par actif", 300); z.note8 = h("p", { class: "qnote" });
    const t8 = card(8, "Spécification, extraction et décomposition des modèles à facteurs", "Modèle statique contre modèle à facteurs dynamiques (DFM) estimé par filtre de Kalman.", eq(EQ.ss),
      h("div", { class: "qctl" }, sg([["macro", "Macro explicite (Chen-Roll-Ross)"], ["style", "Style multi-facteurs"], ["pca", "ACP statistique"], ["dfm", "DFM · Kalman"]], () => P.arch, (k) => (P.arch = k)), sg([1, 2, 3, 4, 5].map((k) => [k, "K = " + k]), () => P.K, (k) => (P.K = k)), sg([[30, "30 j"], [90, "90 j"], [252, "252 j"]], () => P.win, (k) => (P.win = k)), slider("Persistance Φₖₖ", 0.4, 0.99, 0.01, () => P.phi, (v) => (P.phi = v), (v) => v.toFixed(2))),
      z.note8, h("div", { class: "q3" }, b1, b2, b3));
    // --- outil 9
    const [b4, c4] = cvbox("Bêtas dynamiques : MCO glissant contre Kalman", 320), [b5, c5] = cvbox("Droite de marché factorielle (Fama-MacBeth)", 320); z.tbl = h("div", { class: "scroll" }); z.leg9 = h("div", { class: "legend", style: "margin-top:6px" });
    z.asset = h("select", { "aria-label": "Actif étudié", onchange: (e) => { P.asset = e.target.value === "PF" ? "PF" : Number(e.target.value); redo(); } }, A.map((a, i) => h("option", { value: i }, a.t)), h("option", { value: "PF" }, "Portefeuille")); z.fk = h("div", { class: "seg" });
    const copy = h("button", { class: "btn", type: "button", onclick: async () => { const tsv = [...z.tbl.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent).join("\t")).join("\n"); try { await navigator.clipboard.writeText(tsv); copy.textContent = "Copié ✓"; } catch { copy.textContent = "Copie impossible ici"; } setTimeout(() => (copy.textContent = "Copier le tableau"), 1600); } }, "Copier le tableau");
    const t9 = card(9, "Loadings dynamiques, régression de Fama-MacBeth et test GRS", "Les facteurs expliquent-ils la coupe transversale des rendements (APT de Ross) ? Les bêtas sont-ils stables ?", eq(EQ.fm),
      h("div", { class: "qctl" }, h("label", { class: "qslider", style: "min-width:150px" }, h("span", {}, "Actif étudié"), z.asset), z.fk), h("div", { class: "q2" }, h("div", {}, b4, z.leg9), b5), h("div", { class: "qsub" }, h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap" }, h("h4", {}, "Tableau des diagnostics économétriques"), copy), z.tbl));
    // --- outil 10
    const [b6, c6] = cvbox("Courbe d'impact des nouvelles (Engle & Ng, 1993)", 300), [b7, c7] = cvbox("Clustering de volatilité et backtest de VaR 99 % (Kupiec)", 300); z.gm = h("div", { class: "qkpis" }); z.leg10 = h("div", { class: "legend", style: "margin-top:6px" });
    const g = P.g, t10 = card(10, "Factor-GJR-GARCH(1,1) : volatilité asymétrique des facteurs", "La covariance des 17 actifs est reconstruite à partir de la variance conditionnelle de quelques facteurs.", eq(EQ.gj),
      h("div", { class: "qctl" }, sg([...F.map((f, i) => [i, f.id]), ["PF", "Portefeuille agrégé"]], () => g.f, (k) => (g.f = k)), sg([["norm", "Normale"], ["t", "Student-t (ν = 5)"], ["skew", "Skewed-t"]], () => g.dist, (k) => (g.dist = k))),
      h("div", { class: "qctl" }, slider("α (ARCH)", 0.01, 0.25, 0.005, () => g.a, (v) => (g.a = v), (v) => v.toFixed(3)), slider("γ (levier GJR)", 0, 0.35, 0.005, () => g.g, (v) => (g.g = v), (v) => v.toFixed(3)), slider("β (persistance)", 0.5, 0.95, 0.005, () => g.b, (v) => (g.b = v), (v) => v.toFixed(3))), z.gm, h("div", { class: "q2" }, b6, h("div", {}, b7, z.leg10)));
    host.append(h("p", { class: "qwarn" }, "Données simulées : 756 séances tirées du modèle à 5 facteurs du Vault (paramètres stylisés, graine fixe). Le curseur de stress et la persistance Φ modifient le processus générateur. Comme la vérité est connue, on peut juger chaque estimateur. Pour le mémoire, ces sorties illustrent les méthodes ; elles ne remplacent pas une estimation sur données réelles."), t8, t9, t10);
    c5.addEventListener("pointermove", (e) => { const r = c5.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, p = (c5._pts || []).find((q) => Math.hypot(q.x - x, q.y - y) < 9); if (!p) return Ch.hideTip(); Ch.showTip(e, [h("b", {}, A[p.i].t), h("div", {}, `Prédit : ${pc(res.pred[p.i] * ANN)}`), h("div", {}, `Réalisé : ${pc(res.mR[p.i] * ANN)}`), h("div", {}, `Erreur de pricing α : ${pc(p.al)}`), h("div", {}, "β̂ : " + res.ts[p.i].beta.map((b) => b.toFixed(2)).join(" · "))]); }); c5.addEventListener("pointerleave", Ch.hideTip);
    c3.addEventListener("pointermove", (e) => { const r = c3.getBoundingClientRect(), i = Math.floor((e.clientY - r.top - 8) / (c3._rows?.rh || 1)); if (!res || i < 0 || i >= N) return Ch.hideTip(); const a = res.ts[i]; Ch.showTip(e, [h("b", {}, A[i].t), ...a.inc.map((v, k) => h("div", {}, `${res.fx.names[k]} : ${pc(v)}`)), h("div", {}, `Idiosyncratique : ${pc(1 - a.r2)}`), h("div", {}, `α̂ annuel : ${pc(a.alpha * ANN)} (t = ${fmt(a.tAlpha)})`)]); }); c3.addEventListener("pointerleave", Ch.hideTip);

    function paint() {
      if (!res) return; const K = res.K, nm = res.fx.names; if (P.fk >= K) P.fk = K - 1;
      z.note8.textContent = res.fx.note + ` Fenêtre : ${res.T} séances, K = ${K}.`;
      z.fk.replaceChildren(...nm.map((n, k) => h("button", { type: "button", "aria-pressed": String(P.fk === k), onclick: () => { P.fk = k; redo(); } }, "β à " + n)));
      drawScree(c1); drawFactors(c2); drawVar(c3); drawBeta(c4); drawSML(c5); drawNIC(c6); drawVaR(c7);
      z.leg9.replaceChildren(h("span", {}, h("i", { style: "background:#9a6bff" }), `MCO glissant (${P.win} j) ± 2 e.-t.`), h("span", {}, h("i", { style: "background:#22e6ff" }), "Kalman (marche aléatoire) ± 2 e.-t."), res.truth ? h("span", {}, h("i", { style: "background:#fff" }), "vrai β (simulation)") : h("span", { class: "dim" }, "vrai β connu seulement en architecture macro"));
      const row = (...c) => h("tr", {}, c.map((x, i) => h("td", { class: i ? "r mono" : "" }, x))), pv = (p) => (p < 0.001 ? "< 0,001" : p.toFixed(3));
      const G = res.grs, verdict = !G ? (P.arch === "pca" || P.arch === "dfm" ? "non applicable : facteurs extraits des actifs testés, Σ̂ε est singulière" : "non calculable (T − N − K < 1)") : G.p < 0.05 ? "Rejet de H0 : anomalies d'alpha détectées" : "Modèle factoriel non rejeté (H0 conservée)";
      z.tbl.replaceChildren(h("table", { class: "qtable" }, h("thead", {}, h("tr", {}, ["Paramètre", "Estimation", "Écart-type (NW)", "t-stat (HAC)", "p-value"].map((t, i) => h("th", { class: i ? "r" : "" }, t)))), h("tbody", {},
        row("λ₀ (constante, % annuel)", pc(res.lam[0].est, 2), pc(res.lam[0].se, 2), fmt(res.lam[0].t) + stars(res.lam[0].p), pv(res.lam[0].p)), ...nm.map((n, k) => { const l = res.lam[k + 1]; return row(`λ̂ ${n} (prime de risque, % annuel)`, pc(l.est, 2), pc(l.se, 2), fmt(l.t) + stars(l.p), pv(l.p)); }),
        row("Statistique GRS", G ? fmt(G.stat, 3) : "–", "", G ? `F(${G.df1}, ${G.df2})` : "", G ? pv(G.p) : "–"), row("Verdict GRS (seuil 5 %)", verdict, "", "", ""), row("R² ajusté moyen (séries temporelles)", pc(res.r2adjMean), "", "", ""), row("R² en coupe transversale (Fama-MacBeth)", pc(res.csR2), "", "", ""), row("RMSE de pricing √(Σαᵢ²/N), % annuel", pc(res.rmse, 2), "", "", ""), row("Retards Newey-West", String(res.Lnw), "", "", ""), row("Observations T × actifs N", `${res.T} × ${N}`, "", "", ""))),
        h("p", { class: "qnote" }, "*** p < 1 %, ** p < 5 %, * p < 10 %. Écarts-types de Newey-West (noyau de Bartlett) sur la série des λ̂ₜ. L'erreur d'estimation des bêtas de première étape (correction de Shanken) n'est pas prise en compte."));
      const pg = gj, K10 = (l, v, s, c) => h("div", { class: "qkpi" }, h("span", {}, l), h("b", { class: "mono " + (c || "") }, v), s ? h("small", {}, s) : null);
      z.gm.replaceChildren(K10("Persistance α + β + γ/2", fmt(pg.pers, 3), pg.pers < 1 ? "stationnaire" : "IGARCH explosif", pg.pers < 1 ? "up" : "down"), K10("Volatilité inconditionnelle", pg.pers < 1 ? pc(pg.uncVol) : "∞", "annualisée (√252)"), K10("Demi-vie d'un choc", pg.pers < 1 ? fmt(pg.hl, 1) + " j" : "∞", "ln 0,5 / ln(persistance)"), K10("Asymétrie (α + γ) / α", fmt(pg.asym, 2) + "×", "choc négatif contre positif"),
        K10("Kupiec · GJR", `${pg.kGjr.x} dépassements`, `LR = ${fmt(pg.kGjr.lr)} · p = ${fmt(pg.kGjr.p, 3)}`, pg.kGjr.p < 0.05 ? "down" : "up"), K10("Kupiec · GARCH symétrique", `${pg.kSym.x} dépassements`, `LR = ${fmt(pg.kSym.lr)} · p = ${fmt(pg.kSym.p, 3)}`, pg.kSym.p < 0.05 ? "down" : "up"));
      z.leg10.replaceChildren(h("span", {}, h("i", { style: "background:#ff3d86" }), "VaR 99 % Factor-GJR-GARCH"), h("span", {}, h("i", { style: "background:#fff" }), "VaR 99 % GARCH symétrique"), h("span", {}, h("i", { style: "background:#ff3344;border-radius:50%" }), `dépassements (attendus : ${(pg.ret.length * 0.01).toFixed(1)} sur ${pg.ret.length})`));
    }
    return { draw: redo };
  }

  /* ---------- export ---------- */
  function exportData(Q) {
    if (!res) analyse(Q); const nm = res.fx.names, g = P.g;
    return { meta: { date: new Date().toISOString(), avertissement: "Données simulées à partir d'un modèle stylisé à 5 facteurs ; ne pas présenter comme des résultats empiriques.", architecture: P.arch, K: res.K, fenetre: res.T, phi: P.phi, stress: Q.s, scenario: Q.scenKey, facteurs: nm },
      loadings: A.map((a, i) => ({ actif: a.t, alpha_annuel: res.ts[i].alpha * ANN, t_alpha: res.ts[i].tAlpha, ...Object.fromEntries(nm.map((n, k) => ["beta_" + n, res.ts[i].beta[k]])), R2: res.ts[i].r2, R2_ajuste: res.ts[i].r2adj, ...Object.fromEntries(nm.map((n, k) => ["part_variance_" + n, res.ts[i].inc[k]])), part_idiosyncratique: 1 - res.ts[i].r2, rendement_moyen_annuel: res.mR[i] * ANN, rendement_predit_annuel: res.pred[i] * ANN, alpha_FM_annuel: res.aFM[i] * ANN })),
      primes_de_risque: res.lam.map((l, k) => ({ parametre: k ? nm[k - 1] : "lambda0", estimation_annuelle: l.est, ecart_type_NW: l.se, t_HAC: l.t, p_value: l.p })), newey_west_retards: res.Lnw,
      grs: res.grs ? { statistique: res.grs.stat, df1: res.grs.df1, df2: res.grs.df2, p_value: res.grs.p, sharpe2_facteurs: res.grs.sharpe2 } : null, r2_ajuste_moyen: res.r2adjMean, r2_coupe_transversale: res.csR2, rmse_pricing_annuel: res.rmse,
      valeurs_propres: res.vals, bai_ng: res.ic, k_optimal: res.kstar,
      gjr_garch: { facteur: g.f === "PF" ? "portefeuille" : F[g.f].id, alpha: g.a, gamma: g.g, beta: g.b, distribution: g.dist, persistance: gj.pers, vol_inconditionnelle_annuelle: gj.uncVol, demi_vie_jours: gj.hl, ratio_asymetrie: gj.asym, quantile_1pct: gj.q01, kupiec_gjr: gj.kGjr, kupiec_garch_symetrique: gj.kSym } };
  }
  function toCSV(d) { const esc = (v) => (v == null ? "" : typeof v === "number" ? String(v) : '"' + String(v).replace(/"/g, '""') + '"'), tab = (title, rows) => (rows.length ? ["# " + title, Object.keys(rows[0]).join(";"), ...rows.map((r) => Object.values(r).map(esc).join(";")), ""] : []);
    return [...tab("Paramètres", [d.meta].map((m) => ({ ...m, facteurs: m.facteurs.join(" | ") }))), ...tab("Loadings et décomposition de variance", d.loadings), ...tab("Primes de risque (Fama-MacBeth)", d.primes_de_risque), ...tab("Test GRS et ajustement", [{ ...(d.grs || {}), r2_ajuste_moyen: d.r2_ajuste_moyen, r2_coupe_transversale: d.r2_coupe_transversale, rmse_pricing_annuel: d.rmse_pricing_annuel }]), ...tab("Critères de Bai & Ng", d.bai_ng), ...tab("GJR-GARCH", [{ ...d.gjr_garch, kupiec_gjr: undefined, kupiec_garch_symetrique: undefined, kupiec_gjr_LR: d.gjr_garch.kupiec_gjr.lr, kupiec_gjr_p: d.gjr_garch.kupiec_gjr.p, kupiec_gjr_depassements: d.gjr_garch.kupiec_gjr.x, kupiec_sym_LR: d.gjr_garch.kupiec_garch_symetrique.lr, kupiec_sym_p: d.gjr_garch.kupiec_garch_symetrique.p }])].join("\n"); }
  return { mount, exportData, toCSV, P, _dbg: () => ({ res, gj }) };
})();
