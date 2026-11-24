// Lecture des données pour l'agent.
// 1. loadSnapshot : dernier relevé du terminal (data/last.json + data/events.json), écrit par server.mjs / update.yml.
// 2. enrich : compléments frais, seulement pour les actifs et marchés utiles (prix, ATR, carnets, résolutions).
// Aucune erreur réseau ne fait échouer le cycle : elle est notée dans `errors` et le module suivant décide.
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as hl from "../hl.mjs";
import * as pm from "../pm.mjs";
import { pool } from "../util.mjs";
import { CONFIG } from "./config.mjs";
import { DEFAULT_DATA_DIR } from "./store.mjs";

async function readJsonFile(file) {
  try { return { ok: true, value: JSON.parse(await readFile(file, "utf8")) }; }
  catch (e) { return { ok: false, error: e.code === "ENOENT" ? "absent" : e.message }; }
}

export async function loadSnapshot(dataDir = DEFAULT_DATA_DIR, now = Date.now(), cfg = CONFIG) {
  const problems = [];
  const last = await readJsonFile(path.join(dataDir, "last.json"));
  const ev = await readJsonFile(path.join(dataDir, "events.json"));
  if (!last.ok) problems.push(`last.json : ${last.error}`);
  if (!ev.ok) problems.push(`events.json : ${ev.error}`);
  const at = last.ok ? Number(last.value.at) || null : null;
  const ageMin = at ? (now - at) / 60000 : null;
  const fresh = ageMin != null && ageMin >= 0 && ageMin <= cfg.data.snapshotMaxAgeMin;
  if (at && !fresh) problems.push(`relevé périmé (${Math.round(ageMin)} min)`);
  const hlAccounts = last.ok && Array.isArray(last.value.hl) ? last.value.hl.filter((a) => a && a.addr && Array.isArray(a.positions)) : [];
  const pmWhales = last.ok && Array.isArray(last.value.pm) ? last.value.pm.filter((w) => w && w.addr && Array.isArray(w.positions)) : [];
  const events = ev.ok && Array.isArray(ev.value) ? ev.value.filter((e) => e && Number.isFinite(e.t)).sort((a, b) => b.t - a.t) : [];
  return { at, ageMin, fresh, hl: hlAccounts, pm: pmWhales, events, problems };
}

// Ouvertures et renforcements détectés depuis `sinceMs` (seule source d'heure d'entrée fiable, cf. SPEC §3.2).
export const recentEntries = (events, sinceMs, src = null) =>
  events.filter((e) => e.t >= sinceMs && (e.kind === "open" || e.kind === "add") && (!src || e.src === src));

// Prix d'entrée moyen des baleines sur un actif Hyperliquid, pondéré par le notionnel (entryPx de clearinghouseState).
export function entryVwap(accounts, coin, side) {
  let n = 0, w = 0, count = 0;
  for (const a of accounts) for (const p of a.positions) {
    if (p.coin !== coin || p.side !== side || !(p.entry > 0) || !(p.notional > 0)) continue;
    n += p.entry * p.notional; w += p.notional; count++;
  }
  return w ? { px: n / w, notional: w, whales: count } : null;
}

const DEFAULT_DEPS = {
  fetchMarkets: hl.fetchMarkets, fetchOhlc: hl.fetchOhlc, fetchL2Book: hl.fetchL2Book,
  fetchBook: pm.fetchBook, fetchResolution: pm.fetchResolution,
};

const settle = async (list, conc, fn, errors, label) => {
  const out = {};
  const res = await pool(list, conc, fn);
  list.forEach((k, i) => { const r = res[i]; if (r && !r.error) out[k] = r; else errors.push(`${label} ${k} : ${r?.error || "vide"}`); });
  return out;
};

// coins : carnet + ATR (positions de l'agent, ordres à exécuter) ; atrCoins : ATR et clôtures seulement (candidats, paires).
// markets : déjà relevés dans ce cycle, pour ne pas les redemander.
export async function enrich({ coins = [], atrCoins = [], tokens = [], cids = [], markets: known = null } = {}, deps = {}, cfg = CONFIG) {
  const d = { ...DEFAULT_DEPS, ...deps }, errors = [], ex = cfg.exec;
  const uniq = (a) => [...new Set(a.filter(Boolean).map(String))];
  coins = uniq(coins); tokens = uniq(tokens); cids = uniq(cids); atrCoins = uniq([...coins, ...atrCoins]);
  let markets = known || {};
  if (!known) try { markets = await d.fetchMarkets(); } catch (e) { errors.push(`marchés : ${e.message || e}`); }
  const ohlc = await settle(atrCoins, 4, async (c) => {
    const candles = await d.fetchOhlc(c, ex.atrInterval, ex.atrLookbackDays);
    const a = hl.atr(candles, ex.atrPeriod);
    if (a == null) throw new Error(`moins de ${ex.atrPeriod + 1} bougies`);
    return { atr: a, atrPct: a / candles.at(-1).c, last: candles.at(-1).c, n: candles.length, closes: candles.map((k) => [k.t, k.c]) };
  }, errors, "ATR");
  const hlBooks = await settle(coins, 4, (c) => d.fetchL2Book(c), errors, "carnet HL");
  const pmBooks = await settle(tokens, 2, (t) => d.fetchBook(t), errors, "carnet PM");
  const resolutions = await settle(cids, 2, (c) => d.fetchResolution(c), errors, "résolution");
  return { at: Date.now(), markets, ohlc, hlBooks, pmBooks, resolutions, errors };
}

// Classements servant aux poids de départ des baleines (scorer.priorsFromHl / priorsFromPm).
export async function fetchPriorSources(deps = {}) {
  const d = { fetchLeaderboard: hl.fetchLeaderboard, pmLeaderboard: pm.leaderboard, ...deps }, errors = [];
  let hlRows = [];
  try { hlRows = await d.fetchLeaderboard(); } catch (e) { errors.push(`classement HL : ${e.message || e}`); }
  const pmBoards = {};
  for (const c of ["POLITICS", "CRYPTO", "FINANCE"]) {
    try { pmBoards[c] = await d.pmLeaderboard("MONTH", c, 50); } catch (e) { errors.push(`classement PM ${c} : ${e.message || e}`); }
  }
  return { hlRows, pmBoards, errors };
}
