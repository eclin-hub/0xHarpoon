"use strict";
/* X Alpha (ε / ∞) : ce que l'agent de paper trading lit sur X.
   Flux ε : signaux courts par ticker (vélocité des mentions, biais du récit, alerte de squeeze), durée de vie 4 h, injectés
   dans le dossier des LLM votants. Flux ∞ : stratégies et modèles partagés sur X, traduits en Blueprints JSON déclaratifs.
   Fichier lu : data/paper/x_alpha.json (serveur local : /api/paper/x_alpha.json, GitHub Pages : paper/x_alpha.json). */
App.views.xalpha = (() => {
  const z = {}, D = { at: 0, x: null, err: null };
  const base = () => (App.PAGES ? "paper/" : App.SNAP ? null : "/api/paper/");
  const STATUS = { "En attente D1": "neutral", "En test": "cyan", "Promu": "up", "Éliminé D1": "down", "Éliminé D2": "down" };
  const when = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  // source d'un post : X (@compte), presse (RSS) ou article arXiv
  const SRC = { x: "X", rss: "RSS", arxiv: "arXiv" };
  const who = (src, author) => (src && src !== "x" ? `${author} (${SRC[src] || src})` : "@" + (author || "?"));
  const f2 = (x) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(2));
  const ttl = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return h("span", { class: "chip down" }, "expiré");
    const m = Math.floor(ms / 60e3);
    return h("span", { class: "chip " + (m < 30 ? "down" : m < 120 ? "cyan" : "up"), title: "Durée de vie restante du signal (4 h après le dernier post)" }, `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);
  };
  // barre de biais : -1 (baissier, à gauche) → +1 (haussier, à droite)
  const biasBar = (b) => {
    const x = Math.max(-1, Math.min(1, b || 0)), w = Math.abs(x) * 50;
    return h("div", { style: "position:relative;height:6px;border-radius:3px;background:var(--line,rgba(255,255,255,.08));margin:6px 0 2px", title: `biais net ${f2(x)}` },
      h("div", { style: `position:absolute;top:0;bottom:0;${x >= 0 ? "left:50%" : `left:${50 - w}%`};width:${w}%;border-radius:3px;background:${x >= 0 ? "var(--up,#3ddc97)" : "var(--down,#ff5c7a)"}` }),
      h("div", { style: "position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:currentColor;opacity:.35" }));
  };

  async function load() {
    const b = base(); if (!b) return;
    try {
      const get = (f) => fetch(b + f + (App.PAGES ? "?t=" + Date.now() : ""), { cache: "no-store" });
      const [r, rl, re] = await Promise.all([get("x_alpha.json"), get("leagues.json"), get("equity_curve.jsonl")]);
      const eq = re.ok ? (await re.text()).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
      Object.assign(D, { x: r.ok ? await r.json() : null, lg: rl.ok ? await rl.json() : null, eq, err: r.ok ? null : "Aucune donnée X : l'agent n'a pas encore fait de collecte X.", at: Date.now() });
    } catch (e) { Object.assign(D, { err: "Lecture impossible : " + e.message, at: Date.now() }); }
    render();
  }

  // 4 indicateurs ; l'état détaillé de la collecte (statut, sources gratuites, tri) est dans un tiroir
  function head() {
    const x = D.x, s = x.stats || {}, active = Object.values(x.epsilon?.tickers || {}).filter((e) => e.active && Date.parse(e.expiresAt) > Date.now());
    const src = x.source || (x.free?.rss || x.free?.arxiv ? "secours RSS / arXiv" : "neutre");
    return h("div", { style: "display:flex;flex-direction:column;gap:10px" },
      h("div", { class: "kpis" },
        kpi("Source", src, `collecte ${when(x.at)}`, x.source ? "" : "warn"),
        kpi("Signaux ε actifs", String(active.length), `${active.filter((e) => e.squeezeWarning).length} alerte(s) de squeeze`, active.some((e) => e.squeezeWarning) ? "down" : ""),
        kpi("Blueprints ∞", String(x.infinity?.blueprints?.length ?? 0), `${x.infinity?.pending ?? 0} en attente de traduction`),
        kpi("Champions D3", String((D.lg?.entries || []).filter((e) => e.division === "D3").length) + " / 3", `${pctv(D.lg?.meta?.d3 ?? 0, 0)} du poids des décisions`)),
      drawer("État de la collecte", h("p", { class: "muted", style: "margin:0 0 6px;font-size:.8rem" }, x.status),
        h("div", { class: "muted", style: "font-size:.78rem" }, `${s.raw ?? 0} éléments lus · ${s.spam ?? 0} spams · ${s.dup ?? 0} doublons · ${s.epsilon ?? 0} ε · ${s.infinity ?? 0} ∞`,
          x.free ? ` · sources gratuites : ${x.free.rss} articles RSS, ${x.free.arxiv} arXiv` : "", ` · traducteur ${x.infinity?.translator || "—"}`),
        (x.notes || []).length ? h("ul", { class: "muted", style: "font-size:.76rem;margin:6px 0 0 18px" }, x.notes.map((n) => h("li", {}, n))) : null));
  }

  function epsilon() {
    const e = D.x.epsilon || {}, r = e.router || {}, list = Object.values(e.tickers || {}).sort((a, b) => (b.active - a.active) || (b.mentionVelocityRatio || 0) - (a.mentionVelocityRatio || 0));
    const used = (t) => (r.tickers || []).includes(t);
    const isLive = (s) => s.active && Date.parse(s.expiresAt) > Date.now(), expired = list.filter((s) => !isLive(s));
    const stat = (l, v, c, title) => h("div", { title }, h("div", { class: "muted", style: "font-size:.68rem" }, l), h("div", { class: "mono " + (c || ""), style: "white-space:nowrap" }, v));
    const cards = list.filter(isLive).map((s) => {
      const live = true;
      return h("div", { class: "card", style: `padding:14px;border-radius:8px;background:var(--bg-2);border:1px solid ${s.squeezeWarning ? "var(--down)" : "var(--line)"}` },
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" }, h("span", {}, tag("eps"), " ", h("b", {}, s.ticker)),
          h("span", { style: "display:flex;gap:6px" }, s.squeezeWarning ? h("span", { class: "chip down", title: `vélocité ≥ ${e.squeeze?.velocity ?? 2.2}× et biais haussier > ${e.squeeze?.bias ?? 0.35} : pas de SHORT sans confirmation technique` }, "SQUEEZE") : null, ttl(s.expiresAt))),
        h("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px" },
          stat("Vélocité", `${f2(s.mentionVelocityRatio)}×`, (s.mentionVelocityRatio ?? 0) >= 2.2 ? "down" : ""),
          stat("Biais net", (s.netNarrativeBias > 0 ? "+" : "") + f2(s.netNarrativeBias), cls(s.netNarrativeBias || 0)),
          stat("Mentions", `${s.mentions1h} · ${s.mentions24h}`, "", "dernière heure · 24 h")),
        biasBar(s.netNarrativeBias),
        h("div", { class: "muted", style: "font-size:.72rem;margin:6px 0" }, live ? (used(s.ticker) ? `injecté dans le dossier des votants (${when(r.at)})` : "prêt : injecté au prochain réveil des votants") : "non transmis aux votants (expiré)"),
        h("ol", { style: "margin:4px 0 0 16px;padding:0;font-size:.78rem;display:flex;flex-direction:column;gap:4px" }, (s.catalysts || []).map((c) => h("li", { class: "clamp2", title: c.text },
          c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit" }, c.text) : c.text,
          h("span", { class: "muted" }, ` — ${who(c.src, c.author)}${c.tier === 1 && (c.src || "x") === "x" ? " ★" : ""} · ${when(c.t)}`)))));
    });
    return panel("Flux ε : radar d'alpha direct", { sub: "signaux X et presse crypto / macro (RSS) sur nos tickers, demi-vie < 4 h", noteText: `Vélocité : mentions pondérées de la dernière heure contre la moyenne horaire des 23 h précédentes. ★ = compte de référence. Dernier réveil des votants avec ce contexte : ${r.at ? when(r.at) : "aucun"}.` },
      cards.length ? h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px" }, cards) : empty("Aucun signal court terme actif sur nos tickers."),
      expired.length ? h("p", { class: "muted", style: "margin:12px 0 0;font-size:.78rem" }, `Expirés (plus de 4 h sans nouvelle mention) : ${expired.map((x) => x.ticker).join(", ")}`) : null);
  }

  function blockText(b) {
    const p = Object.entries(b.params || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`).join(", ");
    return `${b.type}${p ? ` (${p})` : ""} × ${b.weight}`;
  }
  // une ligne par Blueprint ; règles, JSON et extrait du post d'origine se déplient au clic
  function infinity() {
    const inf = D.x.infinity || {}, bps = inf.blueprints || [];
    const rows = bps.flatMap((x) => {
      const bp = x.blueprint, sk = x.source?.src || "x";
      const d = h("tr", { class: "detail", hidden: "" }, h("td", { colspan: 5 },
        h("p", { style: "margin:0 0 6px" }, bp.thesis),
        h("div", { class: "mono muted", style: "font-size:.74rem;margin-bottom:8px" }, `entrée si score > ${bp.entry.score_above} · `, bp.blocks.map(blockText).join(" + "),
          ` · stop ${bp.exit.stop_atr} ATR${bp.exit.take_profit_atr ? ` · objectif ${bp.exit.take_profit_atr} ATR` : ""} · ${bp.exit.max_hold_hours} h max`),
        drawer("Blueprint JSON", h("pre", { class: "json" }, JSON.stringify(bp, null, 2))),
        x.source?.excerpt ? h("p", { class: "muted", style: "font-size:.76rem;margin:8px 0 0" }, "Source : ", x.source.url ? h("a", { href: x.source.url, target: "_blank", rel: "noopener noreferrer" }, who(sk, x.source.author)) : who(sk, x.source.author), ` · ${x.source.excerpt}`) : null));
      const r = h("tr", { class: "row", style: "cursor:pointer", onclick: () => { d.hidden = !d.hidden; } },
        h("td", {}, h("b", {}, x.name), h("span", { class: "sub2" }, `${bp.side} · ${bp.universe.join(", ")} · ${bp.horizon_hours} h`)), h("td", {}, tag(sk)),
        h("td", {}, h("span", { class: "chip " + (STATUS[x.status] || "neutral") }, x.status)), h("td", { class: "num" }, x.interest), h("td", { class: "muted" }, when(x.createdAt)));
      return [r, d];
    });
    return panel("Flux ∞ : bibliothèque de stratégies", { sub: "threads quant X d'intérêt ≥ " + (inf.interestMin ?? 75) + "/100 et articles arXiv ≥ " + (inf.interestMinArxiv ?? inf.interestMin ?? 60) + "/100, traduits en Blueprints déclaratifs · clic pour le détail",
      noteText: "Aucun code n'est exécuté : un Blueprint est un assemblage de blocs connus (momentum, RSI, z-score de Bollinger, cassure ATR, régime de volatilité, biais X, avance Polymarket, score linéaire) aux paramètres bornés. Statuts : En attente D1, En test (D1 réussie ou D2), Promu (D3), Éliminé." },
      rows.length ? tbl(["Blueprint", "Source", "Statut", "Intérêt", "Compilé"], rows) : empty("Aucun Blueprint pour l'instant."),
      inf.errors?.length ? h("div", { style: "margin-top:10px" }, drawer(`${inf.errors.length} traduction(s) en échec au dernier cycle`, h("ul", { class: "muted", style: "font-size:.76rem;margin:0 0 0 18px" }, inf.errors.map((e) => h("li", {}, e))))) : null);
  }

  /* ---------- 3-League Strategy Arena (data/paper/leagues.json, league_engine.mjs) ---------- */
  const DIV = { D1: "D1 · Labo synthétique", D2: "D2 · Ligue supérieure live", D3: "D3 · Ensemble actif" };
  const pctv = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : (x * 100).toFixed(d) + " %");
  const srcOf = (e) => (e.src === "mutation" ? `mutation (${(e.parentSrc || []).map((s) => SRC[s] || s).join(" + ")})` : SRC[e.src] || e.src);
  const gauge = (x, title) => h("div", { title, style: "width:90px;height:7px;border-radius:4px;background:var(--line,rgba(255,255,255,.08));overflow:hidden" },
    h("div", { style: `width:${Math.round(Math.max(0, Math.min(1, x || 0)) * 100)}%;height:100%;background:${(x || 0) >= 1 ? "var(--up,#2bffb0)" : "var(--cyan,#22e6ff)"}` }));
  const nameCell = (e) => h("td", { title: e.outReason || null }, e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit;font-weight:600" }, e.name) : h("b", {}, e.name),
    h("span", { class: "sub2" }, `${e.gen} · ${srcOf(e)}`));
  const tbl = (heads, rows) => h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((x) => h("th", { scope: "col" }, x)))), h("tbody", {}, rows)));

  function pipeline(E) {
    const count = (f) => E.filter(f).length, srcs = (f) => { const s = {}; for (const e of E.filter(f)) s[srcOf(e)] = (s[srcOf(e)] || 0) + 1; return Object.entries(s).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"; };
    const box = (d, title, big, sub, src) => h("div", { class: "kpi", style: "flex:1;min-width:200px" }, h("div", { class: "l" }, tag(d), " ", title), h("div", { class: "v" }, big),
      h("div", { class: "s", title: sub }, sub), h("div", { class: "s", title: "sources : " + src }, "sources : " + src));
    const arrow = () => h("div", { class: "muted", style: "align-self:center" }, "→");
    return h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:stretch" },
      box("D1", "Labo synthétique", String(count((e) => e.d1)), `${count((e) => e.division === "D1Q")} qualifié(s) · ${count((e) => e.division === "OUT" && !e.d2)} éliminé(s)`, srcs((e) => e.d1)), arrow(),
      box("D2", "Ligue live", `${count((e) => e.division === "D2")} / 6`, `${count((e) => e.division === "OUT" && e.d2)} relégué(s)`, srcs((e) => e.division === "D2")), arrow(),
      box("D3", "Ensemble actif", `${count((e) => e.division === "D3")} / 3`, `LLM ${pctv(D.lg.meta?.llm ?? 1, 0)} · champions ${pctv(D.lg.meta?.d3 ?? 0, 0)}`, srcs((e) => e.division === "D3")));
  }

  function curves(E) {
    const live = E.filter((e) => (e.division === "D2" || e.division === "D3") && e.d2?.book?.curve?.length > 1);
    if (!live.length) return null;
    const since = Math.min(...live.map((e) => e.d2.book.curve[0][0])), pal = [Ch.C.violet, Ch.C.amber, Ch.C.up, Ch.C.down, Ch.C.muted, "#ff9d5c", "#7cd4ff", "#c38bff", "#9be564"];
    const main = (D.eq || []).filter((p) => Date.parse(p.at) >= since - 3600e3), m0 = main[0]?.equity;
    const series = [];
    if (m0) series.push({ name: "0xHarpoon Main", color: Ch.C.cyan, w: 2.6, pts: main.map((p) => [Date.parse(p.at), p.equity / m0 - 1]) });
    live.forEach((e, k) => series.push({ name: `${e.name} (${e.division})`, color: pal[k % pal.length], w: e.division === "D3" ? 2 : 1.3, opacity: 0.9, pts: e.d2.book.curve.map(([t, v]) => [t, v / e.d2.book.capital - 1]) }));
    const vs = series.flatMap((s) => s.pts.map((p) => p[1])), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), pad = Math.max(0.005, (hi - lo) * 0.15);
    const host = h("div", {});
    requestAnimationFrame(() => Ch.line(host, series, { height: 260, min: lo - pad, max: hi + pad, fmt: (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + " %", timeFmt: (x) => new Date(x).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit" }) }));
    return h("div", {}, h("div", { class: "muted", style: "font-size:.78rem;margin:4px 0" }, "Équité comparée (rendement cumulé) : stratégies D2 / D3 face à 0xHarpoon Main"), host,
      h("div", { class: "legend", style: "margin-top:8px" }, series.map((s) => h("span", {}, h("i", { style: `background:${s.color}` }), s.name))));
  }

  // Arène : un panneau de synthèse (pipeline, courbes, règles), puis un panneau par division, 6 colonnes au plus
  function leagues() {
    const L = D.lg;
    if (!L) return panel("3-League Strategy Arena", {}, empty("La compétition démarre dès que la bibliothèque ∞ contient un Blueprint."));
    const E = L.entries || [], W = Object.fromEntries((L.meta?.champions || []).map((c) => [c.id, c]));
    const d1 = E.filter((e) => e.d1 && (e.division === "D1Q" || (e.division === "OUT" && !e.d2))).sort((a, b) => Date.parse(b.d1.at) - Date.parse(a.d1.at));
    const d2 = E.filter((e) => e.division === "D2"), d3 = E.filter((e) => e.division === "D3");
    const m2 = (e) => e.d2?.metrics || {};
    const prog = (x, ok) => h("div", { style: "display:flex;align-items:center;gap:8px;justify-content:flex-end" }, gauge(x, `progression ${pctv(x, 0)}`), ok);
    return h("div", { style: "display:flex;flex-direction:column;gap:var(--gap)" },
      panel("3-League Strategy Arena", { sub: "les Blueprints du Flux ∞ gravissent les divisions ; seuls les champions de D3 pèsent sur l'agent",
        noteText: "D1 → D2 : PF ≥ 1,25, DD ≤ 12 %, survie au stress ≥ 80 %, ≥ 25 trades simulés. D2 → D3 : ≥ 15 trades réels, PSR ≥ 0,75, PF ≥ 1,30, corrélation < 0,60 avec D3. Relégation D2 : après 20 trades, PSR < 0,35 ou DD > 15 %. D3 → D2 : DD > 8 % ou PSR glissant < 0,50 (pas de retour avant 72 h)." },
        pipeline(E), curves(E),
        (L.log || []).length ? h("div", { style: "margin-top:12px" }, drawer(`Journal de la compétition (${L.log.length})`, h("ul", { class: "muted log", style: "font-size:.76rem;margin:0 0 0 18px" }, L.log.map((l) => h("li", {}, `${when(l.at)} — ${l.msg}`))))) : null),
      panel(["D3 · Ensemble actif"], { sub: "champions mêlés au vote des LLM" },
        d3.length ? tbl(["Champion", "Trades", "PF", "PSR glissant", "DD depuis D3", "Poids"], d3.map((e) => h("tr", {}, nameCell(e),
          h("td", { class: "num" }, m2(e).trades), h("td", { class: "num" }, f2(m2(e).profitFactor)), h("td", { class: "num" }, f2(e.d3?.rollingPsr)),
          h("td", { class: "num" }, pctv(e.d3?.drawdown)), h("td", { class: "num", title: W[e.id] ? `PSR ${f2(W[e.id].psr)} × orthogonalité ${f2(W[e.id].orth)}` : "" }, pctv(W[e.id]?.weight, 1)))))
          : empty("Aucun champion en D3 : le panel LLM garde 100 % du poids.")),
      panel("D2 · Ligue live", { sub: "paramètres gelés, 10 000 $ virtuels, vrais prix horaires" },
        d2.length ? tbl(["Stratégie", "Trades", "PF", "PSR", "Max DD", "Vers D3"], d2.map((e) => h("tr", { title: `depuis ${when(e.d2.since)} · réussite ${pctv(m2(e).winRate, 0)} · rendement ${pctv(m2(e).totalReturn, 2)}` }, nameCell(e),
          h("td", { class: "num" }, m2(e).trades ?? 0), h("td", { class: "num" }, f2(m2(e).profitFactor)), h("td", { class: "num" }, f2(m2(e).psr)),
          h("td", { class: "num" }, pctv(m2(e).maxDrawdown)), h("td", { class: "num" }, prog(m2(e).progress)))))
          : empty("Aucune stratégie en D2.")),
      panel("D1 · Labo synthétique", { sub: "5 scénarios de 500 h : GJR-GARCH, sauts, régimes, crise imposée" },
        d1.length ? tbl(["Blueprint", "Trades", "PF", "DD médian", "Survie", "Vers D2"], d1.map((e) => h("tr", { title: e.outReason || `réussite ${pctv(e.d1.winRate, 0)} · PSR ${f2(e.d1.psr)}` }, nameCell(e),
          h("td", { class: "num" }, e.d1.trades), h("td", { class: "num" }, f2(e.d1.profitFactor)), h("td", { class: "num" }, pctv(e.d1.maxDrawdown)), h("td", { class: "num" }, pctv(e.d1.stressSurvivalRate, 0)),
          h("td", { class: "num" }, prog(e.d1.progress, e.division === "D1Q" ? h("span", { class: "chip cyan" }, "qualifié") : h("span", { class: "chip down" }, "éliminé"))))))
          : empty("Aucun Blueprint évalué pour l'instant.")));
  }

  function render() {
    if (!z.box) return;
    if (!base()) return z.box.replaceChildren(empty("Instantané : la page X Alpha n'est visible que sur le site en ligne ou dans la version locale (node server.mjs)."));
    if (D.err) return z.box.replaceChildren(empty(D.err), leagues());
    if (!D.x) return z.box.replaceChildren(empty("Chargement…"));
    z.box.replaceChildren(head(), epsilon(), infinity(), leagues(),
      h("p", { class: "disclaimer" }, "Posts filtrés (spams, airdrops, parrainage, doublons) et pondérés par crédibilité et engagement ; le flux ε ne sert que de contexte aux votants, jamais de déclencheur."));
  }

  return {
    title: () => ["X Alpha ", h("em", {}, "(ε / ∞)")],
    sub: "Signaux courts par ticker (ε), bibliothèque de stratégies (∞) et compétition à 3 divisions.",
    init(box) { z.box = h("div", { style: "display:flex;flex-direction:column;gap:22px" }); box.append(z.box); render(); load(); },
    update() { if (Date.now() - D.at > 60_000) load(); },   // recharge (et recompte les durées de vie) chaque minute
  };
})();
