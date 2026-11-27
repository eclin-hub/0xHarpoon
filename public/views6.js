"use strict";
/* X Alpha (ε / ∞) : ce que l'agent de paper trading lit sur X.
   Flux ε : signaux courts par ticker (vélocité des mentions, biais du récit, alerte de squeeze), durée de vie 4 h, injectés
   dans le dossier des LLM votants. Flux ∞ : stratégies et modèles partagés sur X, traduits en Blueprints JSON déclaratifs.
   Fichier lu : data/paper/x_alpha.json (serveur local : /api/paper/x_alpha.json, GitHub Pages : paper/x_alpha.json). */
App.views.xalpha = (() => {
  const z = {}, D = { at: 0, x: null, err: null };
  const base = () => (App.PAGES ? "paper/" : App.SNAP ? null : "/api/paper/");
  const STATUS = { "En attente D1": "neutral", "En test": "cyan", "Promu": "up" };
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

  function head() {
    const x = D.x, s = x.stats || {}, active = Object.values(x.epsilon?.tickers || {}).filter((e) => e.active && Date.parse(e.expiresAt) > Date.now());
    return h("div", { class: "kpis" },
      kpi("Source X", x.source || (x.free?.rss || x.free?.arxiv ? "secours" : "neutre"), `${x.status}${x.free ? ` · gratuit : ${x.free.rss} articles RSS, ${x.free.arxiv} arXiv` : ""}`),
      kpi("Dernière collecte", when(x.at), `${s.raw ?? 0} posts lus · ${s.spam ?? 0} spams · ${s.dup ?? 0} doublons`),
      kpi("Flux ε actif", String(active.length), `${active.filter((e) => e.squeezeWarning).length} alerte(s) de squeeze`, active.some((e) => e.squeezeWarning) ? "down" : ""),
      kpi("Bibliothèque ∞", String(x.infinity?.blueprints?.length ?? 0), `${x.infinity?.pending ?? 0} en file · traducteur ${x.infinity?.translator || "—"}`));
  }

  function epsilon() {
    const e = D.x.epsilon || {}, r = e.router || {}, list = Object.values(e.tickers || {}).sort((a, b) => (b.active - a.active) || (b.mentionVelocityRatio || 0) - (a.mentionVelocityRatio || 0));
    const used = (t) => (r.tickers || []).includes(t);
    const cards = list.map((s) => {
      const live = s.active && Date.parse(s.expiresAt) > Date.now();
      return h("div", { class: "card", style: `padding:14px;border-radius:12px;border:1px solid ${s.squeezeWarning && live ? "var(--down,#ff5c7a)" : "var(--line,rgba(255,255,255,.08))"};opacity:${live ? 1 : 0.55}` },
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" }, h("b", { style: "font-size:1.05rem" }, s.ticker), live ? ttl(s.expiresAt) : h("span", { class: "chip neutral" }, "expiré")),
        s.squeezeWarning ? h("div", { style: "margin-top:8px" }, h("span", { class: "chip down", title: `vélocité ≥ ${e.squeeze?.velocity ?? 2.2}× et biais haussier > ${e.squeeze?.bias ?? 0.35} : les votants ne doivent pas ouvrir de SHORT sans confirmation technique` }, "SQUEEZE WARNING")) : null,
        h("div", { style: "display:flex;gap:16px;margin-top:10px", class: "mono" },
          h("div", {}, h("div", { class: "muted", style: "font-size:.7rem" }, "VÉLOCITÉ"), h("div", { class: (s.mentionVelocityRatio ?? 0) >= 2.2 ? "down" : "" }, `${f2(s.mentionVelocityRatio)}×`)),
          h("div", {}, h("div", { class: "muted", style: "font-size:.7rem" }, "BIAIS NET"), h("div", { class: cls(s.netNarrativeBias || 0) }, (s.netNarrativeBias > 0 ? "+" : "") + f2(s.netNarrativeBias))),
          h("div", {}, h("div", { class: "muted", style: "font-size:.7rem" }, "MENTIONS"), h("div", {}, `${s.mentions1h} / 1 h · ${s.mentions24h} / 24 h`))),
        biasBar(s.netNarrativeBias),
        h("div", { class: "muted", style: "font-size:.72rem;margin:6px 0" }, live ? (used(s.ticker) ? `injecté dans le dossier des votants (${when(r.at)})` : "prêt : injecté au prochain réveil des votants") : "non transmis aux votants (expiré)"),
        h("ol", { style: "margin:4px 0 0 16px;padding:0;font-size:.78rem;display:flex;flex-direction:column;gap:4px" }, (s.catalysts || []).map((c) => h("li", {},
          c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit" }, c.text) : c.text,
          h("span", { class: "muted" }, ` — ${who(c.src, c.author)}${c.tier === 1 && (c.src || "x") === "x" ? " ★" : ""} · ${when(c.t)}`)))));
    });
    return panel("Flux ε : radar d'alpha direct", { sub: "signaux X et presse crypto / macro (RSS) sur nos tickers, demi-vie < 4 h", noteText: `Vélocité : mentions pondérées de la dernière heure contre la moyenne horaire des 23 h précédentes. ★ = compte de référence. Dernier réveil des votants avec ce contexte : ${r.at ? when(r.at) : "aucun"}.` },
      cards.length ? h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px" }, cards) : empty(D.x.source ? "Aucun signal court terme sur nos tickers pour l'instant." : "Flux neutre : aucune source X disponible à la dernière collecte."));
  }

  function blockText(b) {
    const p = Object.entries(b.params || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`).join(", ");
    return `${b.type}${p ? ` (${p})` : ""} × ${b.weight}`;
  }
  function infinity() {
    const inf = D.x.infinity || {}, bps = inf.blueprints || [];
    const rows = bps.map((x) => {
      const bp = x.blueprint;
      return h("div", { style: "padding:14px 0;border-top:1px solid var(--line,rgba(255,255,255,.08))" },
        h("div", { style: "display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap" },
          h("div", {}, h("b", {}, x.name), " ", h("span", { class: "chip " + (STATUS[x.status] || "neutral") }, x.status), " ",
            h("span", { class: "muted", style: "font-size:.75rem" }, `intérêt ${x.interest}/100 · ${bp.side} · ${bp.universe.join(", ")} · horizon ${bp.horizon_hours} h`)),
          h("span", { class: "muted", style: "font-size:.75rem" }, "source ", x.source?.url ? h("a", { href: x.source.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit" }, who(x.source.src, x.source.author)) : who(x.source?.src, x.source?.author), ` · ${when(x.source?.t)}`)),
        h("p", { style: "margin:6px 0", class: "muted" }, bp.thesis),
        h("div", { class: "mono", style: "font-size:.76rem" }, `entrée si score > ${bp.entry.score_above} · `, bp.blocks.map(blockText).join(" + "),
          ` · stop ${bp.exit.stop_atr} ATR${bp.exit.take_profit_atr ? ` · objectif ${bp.exit.take_profit_atr} ATR` : ""} · ${bp.exit.max_hold_hours} h max`),
        h("details", { style: "margin-top:6px" }, h("summary", { class: "muted", style: "font-size:.75rem" }, "Blueprint JSON et post d'origine"),
          h("pre", { class: "mono", style: "font-size:.72rem;white-space:pre-wrap;margin:6px 0" }, JSON.stringify(bp, null, 2)),
          h("blockquote", { class: "muted", style: "font-size:.75rem;margin:0" }, x.source?.excerpt || "")));
    });
    return panel("Flux ∞ : bibliothèque de modèles et stratégies X", { sub: `threads quant/ML X et articles arXiv (q-fin) d'intérêt ≥ ${inf.interestMin ?? 75}/100, traduits en Blueprints déclaratifs (aucun code exécuté)`,
      noteText: "Statuts : En attente D1 (pas encore testé), En test (suivi par les Ligues), Promu (utilisé par l'agent)." },
      rows.length ? h("div", {}, rows) : empty("Aucun Blueprint pour l'instant."),
      inf.errors?.length ? h("details", { style: "margin-top:8px" }, h("summary", { class: "muted" }, `${inf.errors.length} traduction(s) en échec au dernier cycle`), h("ul", { class: "muted", style: "font-size:.75rem" }, inf.errors.map((e) => h("li", {}, e)))) : null);
  }

  /* ---------- 3-League Strategy Arena (data/paper/leagues.json, league_engine.mjs) ---------- */
  const DIV = { D1: "D1 · Labo synthétique", D2: "D2 · Ligue supérieure live", D3: "D3 · Ensemble actif" };
  const pctv = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : (x * 100).toFixed(d) + " %");
  const srcOf = (e) => (e.src === "mutation" ? `mutation (${(e.parentSrc || []).map((s) => SRC[s] || s).join(" + ")})` : SRC[e.src] || e.src);
  const gauge = (x, title) => h("div", { title, style: "width:90px;height:7px;border-radius:4px;background:var(--line,rgba(255,255,255,.08));overflow:hidden" },
    h("div", { style: `width:${Math.round(Math.max(0, Math.min(1, x || 0)) * 100)}%;height:100%;background:${(x || 0) >= 1 ? "var(--up,#2bffb0)" : "var(--cyan,#22e6ff)"}` }));
  const nameCell = (e) => h("td", {}, e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit" }, e.name) : e.name,
    h("div", { class: "muted", style: "font-size:.7rem" }, `${e.gen} · ${srcOf(e)}`));
  const tbl = (heads, rows) => h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((x) => h("th", { scope: "col" }, x)))), h("tbody", {}, rows)));

  function pipeline(E) {
    const count = (f) => E.filter(f).length, srcs = (f) => { const s = {}; for (const e of E.filter(f)) s[srcOf(e)] = (s[srcOf(e)] || 0) + 1; return Object.entries(s).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"; };
    const box = (title, big, sub, src, tone) => h("div", { style: `flex:1;min-width:190px;padding:14px;border-radius:12px;border:1px solid ${tone};background:rgba(255,255,255,.02)` },
      h("div", { class: "muted", style: "font-size:.72rem;letter-spacing:.06em" }, title), h("div", { style: "font-size:1.6rem;font-weight:700;margin:4px 0" }, big),
      h("div", { class: "muted", style: "font-size:.76rem" }, sub), h("div", { class: "muted", style: "font-size:.72rem;margin-top:4px" }, "source : ", src));
    const arrow = () => h("div", { class: "muted", style: "align-self:center;font-size:1.4rem" }, "→");
    return h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:stretch" },
      box(DIV.D1, String(count((e) => e.d1)), `${count((e) => e.division === "D1Q")} qualifié(s) en attente · ${count((e) => e.division === "OUT" && !e.d2)} éliminé(s)`, srcs((e) => e.d1), "var(--line,rgba(255,255,255,.1))"), arrow(),
      box(DIV.D2, `${count((e) => e.division === "D2")} / 6`, `${count((e) => e.division === "OUT" && e.d2)} relégué(s) · paramètres gelés, 10 000 $ virtuels`, srcs((e) => e.division === "D2"), "var(--cyan,#22e6ff)"), arrow(),
      box(DIV.D3, `${count((e) => e.division === "D3")} / 3`, `${pctv(D.lg.meta?.d3 ?? 0, 0)} du poids des décisions (LLM ${pctv(D.lg.meta?.llm ?? 1, 0)})`, srcs((e) => e.division === "D3"), "var(--up,#2bffb0)"));
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

  function leagues() {
    const L = D.lg;
    if (!L) return panel("3-League Strategy Arena", { sub: "D1 → D2 → D3" }, empty("La compétition démarre dès que la bibliothèque ∞ contient un Blueprint."));
    const E = L.entries || [], W = Object.fromEntries((L.meta?.champions || []).map((c) => [c.id, c]));
    const d1 = E.filter((e) => e.d1 && (e.division === "D1Q" || (e.division === "OUT" && !e.d2))).sort((a, b) => Date.parse(b.d1.at) - Date.parse(a.d1.at)).slice(0, 15);
    const d2 = E.filter((e) => e.division === "D2"), d3 = E.filter((e) => e.division === "D3");
    const m2 = (e) => e.d2?.metrics || {};
    return panel("3-League Strategy Arena", { sub: "les Blueprints du Flux ∞ (X, arXiv) gravissent les divisions ; seuls les champions de D3 influencent l'agent",
      noteText: "D1 → D2 : PF ≥ 1,25, DD ≤ 12 %, survie au stress ≥ 80 %, ≥ 25 trades simulés. D2 → D3 : ≥ 15 trades réels, PSR ≥ 0,75, PF ≥ 1,30, corrélation < 0,60 avec D3. Relégation D2 : après 20 trades, PSR < 0,35 ou DD > 15 %. D3 → D2 : DD > 8 % ou PSR glissant < 0,50." },
      pipeline(E), curves(E),
      h("h3", { style: "margin:18px 0 6px;font-size:.95rem" }, DIV.D3),
      d3.length ? tbl(["Champion", "Trades", "Réussite", "PF", "PSR glissant", "DD depuis D3", "Poids dans router.mjs"], d3.map((e) => h("tr", {}, nameCell(e),
        h("td", { class: "mono" }, m2(e).trades), h("td", { class: "mono" }, pctv(m2(e).winRate, 0)), h("td", { class: "mono" }, f2(m2(e).profitFactor)), h("td", { class: "mono" }, f2(e.d3?.rollingPsr)),
        h("td", { class: "mono" }, pctv(e.d3?.drawdown)), h("td", { class: "mono", title: W[e.id] ? `PSR ${f2(W[e.id].psr)} × orthogonalité ${f2(W[e.id].orth)}` : "" }, pctv(W[e.id]?.weight, 1)))))
        : empty("Aucun champion en D3 : le panel LLM garde 100 % du poids."),
      h("h3", { style: "margin:18px 0 6px;font-size:.95rem" }, DIV.D2),
      d2.length ? tbl(["Stratégie", "Depuis", "Trades", "Réussite", "PF", "PSR", "Max DD", "Rendement", "Vers D3"], d2.map((e) => h("tr", {}, nameCell(e), h("td", {}, when(e.d2.since)),
        h("td", { class: "mono" }, m2(e).trades ?? 0), h("td", { class: "mono" }, pctv(m2(e).winRate, 0)), h("td", { class: "mono" }, f2(m2(e).profitFactor)), h("td", { class: "mono" }, f2(m2(e).psr)),
        h("td", { class: "mono" }, pctv(m2(e).maxDrawdown)), h("td", { class: "mono " + cls(m2(e).totalReturn || 0) }, pctv(m2(e).totalReturn, 2)), h("td", {}, gauge(m2(e).progress, `progression ${pctv(m2(e).progress, 0)}`)))))
        : empty("Aucune stratégie en D2."),
      h("h3", { style: "margin:18px 0 6px;font-size:.95rem" }, DIV.D1),
      d1.length ? tbl(["Blueprint", "Trades simulés", "Réussite", "PF", "PSR", "DD médian", "Survie au stress", "Vers D2", "Verdict"], d1.map((e) => h("tr", {}, nameCell(e),
        h("td", { class: "mono" }, e.d1.trades), h("td", { class: "mono" }, pctv(e.d1.winRate, 0)), h("td", { class: "mono" }, f2(e.d1.profitFactor)), h("td", { class: "mono" }, f2(e.d1.psr)),
        h("td", { class: "mono" }, pctv(e.d1.maxDrawdown)), h("td", { class: "mono" }, pctv(e.d1.stressSurvivalRate, 0)), h("td", {}, gauge(e.d1.progress, `progression ${pctv(e.d1.progress, 0)}`)),
        h("td", {}, e.division === "D1Q" ? h("span", { class: "chip cyan" }, "qualifié") : h("span", { class: "chip down", title: e.outReason || "" }, "éliminé")))))
        : empty("Aucun Blueprint évalué pour l'instant."),
      (L.log || []).length ? h("details", { style: "margin-top:12px" }, h("summary", { class: "muted" }, "Journal de la compétition"),
        h("ul", { class: "muted", style: "font-size:.76rem;margin:6px 0 0 18px" }, L.log.slice(0, 25).map((l) => h("li", {}, `${when(l.at)} — ${l.msg}`)))) : null);
  }

  function render() {
    if (!z.box) return;
    if (!base()) return z.box.replaceChildren(empty("Instantané : la page X Alpha n'est visible que sur le site en ligne ou dans la version locale (node server.mjs)."));
    if (D.err) return z.box.replaceChildren(empty(D.err), leagues());
    if (!D.x) return z.box.replaceChildren(empty("Chargement…"));
    z.box.replaceChildren(head(), epsilon(), infinity(), leagues(),
      h("p", { class: "disclaimer" }, "Les posts X sont filtrés (spams, airdrops, liens Telegram ou de parrainage, doublons) et pondérés par la crédibilité du compte et l'engagement. Ils ne déclenchent jamais un trade seuls : le flux ε ne sert que de contexte aux votants."));
  }

  return {
    title: () => ["X Alpha ", h("em", {}, "(ε / ∞)")],
    sub: "Ce que l'agent lit sur X : signaux courts par ticker (ε) et bibliothèque de stratégies traduites en Blueprints (∞).",
    init(box) { z.box = h("div", { style: "display:flex;flex-direction:column;gap:22px" }); box.append(z.box); render(); load(); },
    update() { if (Date.now() - D.at > 60_000) load(); },   // recharge (et recompte les durées de vie) chaque minute
  };
})();
