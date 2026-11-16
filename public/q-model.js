"use strict";
/* QM — noyau mathématique du Quant Vault : algèbre linéaire, lois statistiques, univers de 17 actifs et modèle à 5 facteurs.
   Les paramètres (loadings, volatilités, corrélations) sont un calibrage stylisé, pas des estimations sur données de marché. */
const QM = (() => {
  /* ---------- algèbre linéaire (matrices = tableaux de lignes) ---------- */
  const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));
  const eye = (n) => zeros(n, n).map((r, i) => ((r[i] = 1), r));
  const T = (A) => A[0].map((_, j) => A.map((r) => r[j]));
  const mul = (A, B) => { const n = A.length, m = B[0].length, k = B.length, C = zeros(n, m); for (let i = 0; i < n; i++) for (let l = 0; l < k; l++) { const a = A[i][l]; if (a) for (let j = 0; j < m; j++) C[i][j] += a * B[l][j]; } return C; };
  const mv = (A, x) => A.map((r) => { let s = 0; for (let j = 0; j < x.length; j++) s += r[j] * x[j]; return s; });
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  function inv(A) { // Gauss-Jordan avec pivot partiel
    const n = A.length, M = A.map((r, i) => [...r, ...eye(n)[i]]);
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-14) M[p][c] = 1e-14; [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; } }
    return M.map((r) => r.slice(n));
  }
  function chol(A) { const n = A.length, L = zeros(n, n); for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j]; } return L; }
  function eig(S) { // Jacobi pour matrice symétrique ; valeurs propres décroissantes, vecteurs en colonnes
    const n = S.length, A = S.map((r) => [...r]), V = eye(n);
    for (let sweep = 0; sweep < 60; sweep++) { let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j]; if (off < 1e-18) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) { if (Math.abs(A[p][q]) < 1e-15) continue; const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; } for (let k = 0; k < n; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
        for (let k = 0; k < n; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; } } }
    const idx = A.map((_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
    return { vals: idx.map((i) => A[i][i]), vecs: V.map((r) => idx.map((i) => r[i])) };
  }
  // MCO : y (T) sur X (T×K) -> coefficients, résidus, (X'X)^-1
  function ols(X, y) { const Xt = T(X), XtXi = inv(mul(Xt, X)), b = mv(XtXi, mv(Xt, y)), e = y.map((v, t) => v - dot(X[t], b)); return { b, e, XtXi, s2: dot(e, e) / Math.max(1, y.length - b.length) }; }

  /* ---------- lois statistiques ---------- */
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2)), normPdf = (x) => Math.exp(-0.5 * x * x) / 2.5066282746310002;
  function normInv(p) { // Acklam
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239], b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572], c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) return -normInv(1 - p);
    const q = p - 0.5, r = q * q; return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function lgamma(x) { const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const c of g) s += c / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
  function betai(a, b, x) { // bêta incomplète régularisée (fraction continue de Lentz)
    if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    const cf = (a, b, x) => { let c = 1, d = 1 - (a + b) * x / (a + 1); d = Math.abs(d) < 1e-30 ? 1e-30 : d; d = 1 / d; let h = d; for (let m = 1; m <= 300; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2)); d = 1 + aa * d; d = Math.abs(d) < 1e-30 ? 1e-30 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c; d = 1 / d; h *= d * c; aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1)); d = 1 + aa * d; d = Math.abs(d) < 1e-30 ? 1e-30 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break; } return h; };
    return x < (a + 1) / (a + b + 2) ? bt * cf(a, b, x) / a : 1 - bt * cf(b, a, 1 - x) / b;
  }
  const tCdf = (t, df) => { const x = df / (df + t * t), p = 0.5 * betai(df / 2, 0.5, x); return t >= 0 ? 1 - p : p; };
  const fCdf = (f, d1, d2) => (f <= 0 ? 0 : betai(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2)));
  const chi2Cdf1 = (x) => (x <= 0 ? 0 : erf(Math.sqrt(x / 2)));
  const tInv = (p, df) => { let lo = -60, hi = 60; for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; tCdf(m, df) < p ? (lo = m) : (hi = m); } return (lo + hi) / 2; };
  // t asymétrique de Hansen (1994), standardisée (moyenne 0, variance 1) : quantile
  function skewTInv(p, nu = 5, lam = -0.3) { const c = Math.exp(lgamma((nu + 1) / 2) - lgamma(nu / 2)) / Math.sqrt(Math.PI * (nu - 2)), a = 4 * lam * c * (nu - 2) / (nu - 1), b = Math.sqrt(1 + 3 * lam * lam - a * a), k = Math.sqrt((nu - 2) / nu);
    return p < (1 - lam) / 2 ? ((1 - lam) * k * tInv(p / (1 - lam), nu) - a) / b : ((1 + lam) * k * tInv(0.5 + (p - (1 - lam) / 2) / (1 + lam), nu) - a) / b; }
  const rng = (seed) => { let a = seed >>> 0; const u = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; let spare = null;
    const g = () => { if (spare != null) { const s = spare; spare = null; return s; } let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0); const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return x * f; }; return { u, g }; };

  /* ---------- univers et structure factorielle ---------- */
  const FACTORS = [{ id: "F_LIQ", name: "Liquidité globale", color: "#22e6ff" }, { id: "F_RATE", name: "Taux réels & pente", color: "#9a6bff" }, { id: "F_TECH", name: "Croissance / IA", color: "#2bffb0" }, { id: "F_ENER", name: "Énergie & géopolitique", color: "#ffc247" }, { id: "F_VOL", name: "Tension de queue / vol", color: "#ff3d86" }];
  //            ticker  classe                 μ     σε     LIQ   RATE  TECH  ENER  VOL    α (erreur de pricing annuelle, pour les tests du labo)
  const RAW = [["BTC", "Crypto", 0.35, 0.45, 2.6, -0.8, 1.2, 0.0, -1.6, 0.04], ["ETH", "Crypto", 0.38, 0.55, 3.0, -0.9, 1.5, 0.0, -1.9, 0], ["GOLD", "Matières", 0.07, 0.10, 0.5, -1.4, -0.1, 0.3, 0.5, 0], ["SILV", "Matières", 0.08, 0.20, 0.9, -1.3, 0.2, 0.5, -0.2, 0], ["WTI", "Matières", 0.06, 0.22, 0.5, 0.2, 0.0, 2.0, -0.6, 0], ["NGAS", "Matières", 0.04, 0.45, 0.2, 0.1, -0.1, 2.4, -0.2, -0.03],
    ["SPX", "Indice", 0.09, 0.04, 1.0, -0.6, 0.8, -0.1, -1.0, 0], ["NVDA", "Actions", 0.30, 0.30, 1.4, -1.1, 2.6, -0.2, -1.5, 0.03], ["AAPL", "Actions", 0.13, 0.16, 1.0, -0.7, 1.3, -0.1, -0.9, 0], ["MSFT", "Actions", 0.15, 0.14, 1.0, -0.8, 1.5, -0.1, -0.9, 0], ["AMZN", "Actions", 0.16, 0.20, 1.2, -0.9, 1.7, -0.2, -1.1, 0], ["GOOG", "Actions", 0.15, 0.18, 1.1, -0.7, 1.5, -0.1, -1.0, 0],
    ["META", "Actions", 0.18, 0.24, 1.2, -0.9, 1.9, -0.1, -1.2, 0], ["TSLA", "Actions", 0.20, 0.40, 1.8, -1.2, 2.2, -0.3, -1.7, -0.02], ["JPM", "Actions", 0.11, 0.14, 0.9, 0.9, 0.3, 0.1, -1.1, 0], ["XOM", "Actions", 0.09, 0.14, 0.4, 0.3, -0.1, 1.5, -0.5, 0], ["LLY", "Actions", 0.17, 0.22, 0.5, -0.3, 0.4, 0.0, -0.3, 0.02]];
  const ASSETS = RAW.map((r) => ({ t: r[0], cls: r[1], mu: r[2], idio: r[3], alpha: r[9] })), N = ASSETS.length, K = 5, L0 = RAW.map((r) => r.slice(4, 9));
  const CLS_COL = { Crypto: "#ffc247", Matières: "#ff8a3d", Indice: "#e8ecff", Actions: "#22e6ff" };
  const FV0 = [0.09, 0.07, 0.10, 0.14, 0.08], FV_STRESS = [0.9, 0.4, 0.4, 0.6, 1.5], L_STRESS = [0.35, 0.1, 0.0, 0.15, 0.45];
  const sym = (U) => { const C = eye(K); U.forEach(([i, j, v]) => (C[i][j] = C[j][i] = v)); return C; };
  const C0 = sym([[0, 1, -0.30], [0, 2, 0.35], [0, 4, -0.45], [1, 2, -0.30], [1, 3, 0.20], [2, 4, -0.40], [3, 4, -0.10], [0, 3, 0.05]]);
  const C1 = sym([[0, 1, -0.55], [0, 2, 0.80], [0, 3, 0.45], [0, 4, -0.90], [1, 2, -0.50], [1, 3, 0.15], [1, 4, 0.45], [2, 3, 0.25], [2, 4, -0.80], [3, 4, -0.45]]);
  const SCEN = { none: [1, 1, 1, 1, 1], oil: [1.1, 1.2, 1, 2.6, 1.4], rates: [1.3, 2.3, 2.1, 1, 1.5], liq: [2.2, 1.2, 1.3, 1.2, 2.2] };

  // état du modèle pour un niveau de stress s ∈ [0,1], un scénario (multiplicateurs de vol par facteur) et un glissement de corrélation δ
  function state(s, scen = SCEN.none, shift = 0) {
    const fvol = FV0.map((v, k) => v * (1 + FV_STRESS[k] * s) * scen[k]);
    let fcorr = C0.map((r, i) => r.map((v, j) => (1 - s) * v + s * C1[i][j]));
    if (shift > 0) fcorr = fcorr.map((r, i) => r.map((v, j) => (i === j ? 1 : (1 - shift) * v + shift * Math.sign(v || 1) * 0.95))); else if (shift < 0) fcorr = fcorr.map((r, i) => r.map((v, j) => (i === j ? 1 : (1 + shift) * v)));
    const fcov = fcorr.map((r, i) => r.map((v, j) => v * fvol[i] * fvol[j])), L = L0.map((r) => r.map((v, k) => v * (1 + L_STRESS[k] * s)));
    const idio = ASSETS.map((a) => a.idio * (1 - 0.15 * s)), mu = ASSETS.map((a, i) => a.mu * (1 - 0.7 * s) - 0.10 * s * Math.abs(L0[i][4]));
    const LF = mul(L, fcov), cov = mul(LF, T(L)); for (let i = 0; i < N; i++) cov[i][i] += idio[i] * idio[i];
    const sd = cov.map((r, i) => Math.sqrt(r[i])), corr = cov.map((r, i) => r.map((v, j) => v / (sd[i] * sd[j])));
    return { s, fvol, fcorr, fcov, L, idio, mu, cov, corr, sd };
  }
  // quantile de Cornish-Fisher : asymétrie et queues épaisses croissantes avec le stress
  const zcf = (p, s) => { const z = normInv(p), S = -0.3 - 0.7 * s, Kx = 1 + 3 * s; return z + (z * z - 1) * S / 6 + (z * z * z - 3 * z) * Kx / 24 - (2 * z * z * z - 5 * z) * S * S / 36; };
  const FLOOR = 0.10, RF = 0.04, MAINT = 0.15;
  function portfolio(w, lev, hedge, st) {
    const b = new Array(K).fill(0); for (let i = 0; i < N; i++) for (let k = 0; k < K; k++) b[k] += w[i] * st.L[i][k];
    const Fb = mv(st.fcov, b), varF = dot(b, Fb); let varI = 0; for (let i = 0; i < N; i++) varI += w[i] * w[i] * st.idio[i] * st.idio[i];
    const v = varF + varI, vol = Math.sqrt(v), mu = lev * dot(w, st.mu) - (lev - 1) * RF - hedge, m = mu / 12, sdm = lev * vol / Math.sqrt(12), cov = Math.min(1, hedge / 0.04);
    const hl = (L) => (L <= FLOOR ? L : FLOOR + (1 - cov) * (L - FLOOR)), lossQ = (p) => Math.min(1, -(m + zcf(p, st.s) * sdm));   // une perte ne dépasse pas 100 % des fonds propres
    const var99 = hl(lossQ(0.01)); let es = 0, esRaw = 0; for (let i = 0; i < 10; i++) { const l = lossQ(0.0005 + i * 0.001); es += hl(l) / 10; esRaw += l / 10; }
    let pm = 0; if (lev > 1.0001) { const Lt = 1 - ((lev - 1) / (1 - MAINT)) / lev; let need = Lt; if (Lt > FLOOR) need = cov >= 1 ? Infinity : FLOOR + (Lt - FLOOR) / (1 - cov);
      if (need < Infinity) { let lo = 1e-7, hi = 0.5; if (lossQ(lo) < need) pm = 0; else { for (let i = 0; i < 40; i++) { const mid = Math.sqrt(lo * hi); lossQ(mid) >= need ? (lo = mid) : (hi = mid); } pm = lo; } } }
    const rcF = b.map((x, k) => x * Fb[k] / v), tot = rcF.reduce((s, x) => s + Math.abs(x), 0) || 1; let H = 0; for (const x of rcF) { const p = Math.abs(x) / tot; if (p > 1e-12) H -= p * Math.log(p); }
    const Sw = mv(st.cov, w), rcA = w.map((x, i) => x * Sw[i] / v), rcAK = w.map((x, i) => st.L[i].map((l, k) => x * l * Fb[k] / v)), rcI = w.map((x, i) => x * x * st.idio[i] * st.idio[i] / v);
    return { b, mu, vol: lev * vol, volF: lev * Math.sqrt(varF), var99, es, esRaw, pMargin: pm, entropy: H / Math.log(K), rcF, rcA, rcAK, rcI, idioShare: varI / v, margin: lev > 1.0001 ? 1 - ((lev - 1) / (1 - MAINT)) / lev : null, cover: cov };
  }
  const norm = (w) => { const s = w.reduce((a, b) => a + b, 0) || 1; return w.map((x) => x / s); };
  const by = (o) => norm(ASSETS.map((a) => o[a.t] || 0));
  function riskParity() { const st = state(0.3); let w = norm(st.sd.map((s) => 1 / s)), best = portfolio(w, 1, 0, st).entropy; const r = rng(7);
    for (let it = 0; it < 900; it++) { const c = [...w], i = Math.floor(r.u() * N); c[i] = Math.max(0.005, c[i] * Math.exp(0.5 * r.g())); const n = norm(c), e = portfolio(n, 1, 0, st).entropy; if (e > best) { best = e; w = n; } } return w; }
  const PRESETS = { barbell: () => by({ BTC: 10, ETH: 4, GOLD: 24, SILV: 4, WTI: 5, SPX: 28, NVDA: 5, JPM: 6, XOM: 6, LLY: 8 }), tech: () => by({ NVDA: 16, AAPL: 10, MSFT: 12, AMZN: 10, GOOG: 10, META: 10, TSLA: 8, BTC: 10, ETH: 5, SPX: 9 }), parity: riskParity, equal: () => norm(new Array(N).fill(1)) };
  return { zeros, eye, T, mul, mv, dot, inv, chol, eig, ols, erf, normCdf, normPdf, normInv, betai, tCdf, fCdf, chi2Cdf1, tInv, skewTInv, rng, FACTORS, ASSETS, N, K, L0, CLS_COL, FV0, SCEN, state, zcf, portfolio, norm, PRESETS, FLOOR, RF, MAINT };
})();
if (typeof module !== "undefined") module.exports = QM;
