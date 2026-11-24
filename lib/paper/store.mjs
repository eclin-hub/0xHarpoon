// Persistance de l'agent : data/paper/ en local, dossier paper/ de la branche state en ligne.
// JSON écrit de façon atomique (fichier temporaire puis renommage) ; journaux en JSONL (une ligne par entrée).
import { readFile, writeFile, appendFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CONFIG } from "./config.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DATA_DIR = path.join(ROOT, "data");

export const FILES = Object.freeze({
  portfolio: "portfolio_state.json",
  whaleScores: "whale_scores.json",
  border: "border_proposals.json",
  trades: "trades_history.jsonl",
  votes: "model_votes.jsonl",
  equity: "equity_curve.jsonl",
  candidates: "candidates.json",
  history: "market_history.json",
  shadow: "shadow_book.json",
  metrics: "metrics.json",
});

export const utcNow = () => new Date().toISOString();

export function initialPortfolio(now = utcNow()) {
  const c = CONFIG.startCapital;
  return {
    version: 1, createdAt: now, updatedAt: now, lastTick: null, ticks: 0,
    startCapital: c, cash: c, equity: c, peakEquity: c,
    mode: "normal",                // normal | halveR | reduceOnly | killed
    positions: [],
  };
}

export class Store {
  constructor(dataDir = DEFAULT_DATA_DIR) { this.dataDir = dataDir; this.dir = path.join(dataDir, "paper"); }
  file(name) { return path.join(this.dir, name); }

  async readJson(name, fallback = null) {
    try { return JSON.parse(await readFile(this.file(name), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return fallback; throw new Error(`${name} illisible : ${e.message}`); }
  }
  async writeJson(name, value) {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.file(name) + ".tmp";
    await writeFile(tmp, JSON.stringify(value, null, 1));
    await rename(tmp, this.file(name));
  }
  async appendJsonl(name, entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    if (!list.length) return;
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(name), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  async readJsonl(name) {
    let raw;
    try { raw = await readFile(this.file(name), "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const out = [];
    raw.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try { out.push(JSON.parse(line)); } catch { throw new Error(`${name} ligne ${i + 1} invalide`); }
    });
    return out;
  }

  async loadPortfolio() { return (await this.readJson(FILES.portfolio)) ?? initialPortfolio(); }
  async savePortfolio(p) { await this.writeJson(FILES.portfolio, { ...p, updatedAt: utcNow() }); }
}
