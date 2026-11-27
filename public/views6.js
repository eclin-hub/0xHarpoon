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
      const r = await fetch(b + "x_alpha.json" + (App.PAGES ? "?t=" + Date.now() : ""), { cache: "no-store" });
      Object.assign(D, { x: r.ok ? await r.json() : null, err: r.ok ? null : "Aucune donnée X : l'agent n'a pas encore fait de collecte X.", at: Date.now() });
    } catch (e) { Object.assign(D, { err: "Lecture impossible : " + e.message, at: Date.now() }); }
    render();
  }

  function head() {
    const x = D.x, s = x.stats || {}, active = Object.values(x.epsilon?.tickers || {}).filter((e) => e.active && Date.parse(e.expiresAt) > Date.now());
    return h("div", { class: "kpis" },
      kpi("Source X", x.source || "neutre", x.status),
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
          h("span", { class: "muted" }, ` — @${c.author}${c.tier === 1 ? " ★" : ""} · ${when(c.t)}`)))));
    });
    return panel("Flux ε : radar d'alpha direct", { sub: "signaux X sur nos tickers, demi-vie < 4 h", noteText: `Vélocité : mentions pondérées de la dernière heure contre la moyenne horaire des 23 h précédentes. ★ = compte de référence. Dernier réveil des votants avec ce contexte : ${r.at ? when(r.at) : "aucun"}.` },
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
          h("span", { class: "muted", style: "font-size:.75rem" }, "source ", x.source?.url ? h("a", { href: x.source.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit" }, "@" + x.source.author) : "@" + (x.source?.author || "?"), ` · ${when(x.source?.t)}`)),
        h("p", { style: "margin:6px 0", class: "muted" }, bp.thesis),
        h("div", { class: "mono", style: "font-size:.76rem" }, `entrée si score > ${bp.entry.score_above} · `, bp.blocks.map(blockText).join(" + "),
          ` · stop ${bp.exit.stop_atr} ATR${bp.exit.take_profit_atr ? ` · objectif ${bp.exit.take_profit_atr} ATR` : ""} · ${bp.exit.max_hold_hours} h max`),
        h("details", { style: "margin-top:6px" }, h("summary", { class: "muted", style: "font-size:.75rem" }, "Blueprint JSON et post d'origine"),
          h("pre", { class: "mono", style: "font-size:.72rem;white-space:pre-wrap;margin:6px 0" }, JSON.stringify(bp, null, 2)),
          h("blockquote", { class: "muted", style: "font-size:.75rem;margin:0" }, x.source?.excerpt || "")));
    });
    return panel("Flux ∞ : bibliothèque de modèles et stratégies X", { sub: `threads quant/ML d'intérêt ≥ ${inf.interestMin ?? 75}/100, traduits en Blueprints déclaratifs (aucun code exécuté)`,
      noteText: "Statuts : En attente D1 (pas encore testé), En test (suivi par les Ligues), Promu (utilisé par l'agent)." },
      rows.length ? h("div", {}, rows) : empty("Aucun Blueprint pour l'instant."),
      inf.errors?.length ? h("details", { style: "margin-top:8px" }, h("summary", { class: "muted" }, `${inf.errors.length} traduction(s) en échec au dernier cycle`), h("ul", { class: "muted", style: "font-size:.75rem" }, inf.errors.map((e) => h("li", {}, e)))) : null);
  }

  function leagues() {
    return panel("Les 3 Ligues", { sub: "emplacement réservé" }, h("div", { id: "x-leagues", class: "empty" }, "Le tableau de bord des 3 Ligues (tests des Blueprints) arrivera à l'étape suivante."));
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
