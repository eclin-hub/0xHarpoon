// Validation stricte des réponses des LLM (SPEC §4), sans dépendance.
// Une réponse qui ne respecte pas le schéma compte comme une absence de réponse.

export const ACTIONS = Object.freeze(["OPEN", "REJECT", "HOLD", "CLOSE"]);
const VOTE_KEYS = ["candidate_id", "action", "conviction", "invalidation_condition", "horizon_hours", "cited_risk_metric"];
const ARB_KEYS = ["candidate_id", "action", "conviction", "reason", "cited_metric"];

// Extrait le premier objet ou tableau JSON d'un texte (bloc ```json, texte autour, balises <think>…).
// Tolérant aux habillages fréquents (mistral-small, qwen3-235b…) : raisonnement <think>…</think> (ou seulement la balise
// de fin), blocs markdown (```json, ```JSON, ``` sans langage, plusieurs blocs dont un seul en JSON), texte avant et
// après l'objet, accolades dans la prose avant l'objet, virgules finales.
const balanced = (body, start) => {
  const open = body[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return body.slice(start, i + 1);
  }
  return null;
};
const parseLoose = (t) => { try { return { ok: true, v: JSON.parse(t) }; } catch {} try { return { ok: true, v: JSON.parse(t.replace(/,\s*([}\]])/g, "$1")) }; } catch {} return { ok: false }; };
export function extractJson(text) {
  if (text && typeof text === "object") return text;
  let s = String(text ?? "").replace(/^\uFEFF/, "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<\/think>/i.test(s)) s = s.slice(s.search(/<\/think>/i) + 8);   // balise ouvrante absente
  const fences = [...s.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)].map((m) => m[1]);
  let incomplete = false;
  for (const body of [...fences, s]) {
    const whole = parseLoose(body.trim());
    if (whole.ok && whole.v && typeof whole.v === "object") return whole.v;
    // chaque « { » ou « [ » candidat, dans l'ordre : le premier bloc équilibré qui se lit est retenu
    for (let i = body.search(/[{[]/); i >= 0 && i < body.length; i = body.slice(i + 1).search(/[{[]/) < 0 ? -1 : i + 1 + body.slice(i + 1).search(/[{[]/)) {
      const chunk = balanced(body, i);
      if (!chunk) { incomplete = true; continue; }
      const r = parseLoose(chunk);
      if (r.ok && r.v && typeof r.v === "object") return r.v;
    }
  }
  throw new Error(incomplete ? "JSON incomplet dans la réponse" : "aucun JSON dans la réponse");
}

const isStr = (x, max) => typeof x === "string" && x.trim().length > 0 && x.length <= max;
const isNum = (x, a, b) => typeof x === "number" && Number.isFinite(x) && x >= a && x <= b;
function exactKeys(o, keys) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return "pas un objet";
  const extra = Object.keys(o).filter((k) => !keys.includes(k)), missing = keys.filter((k) => !(k in o));
  return missing.length ? `champ manquant : ${missing.join(", ")}` : extra.length ? `champ inconnu : ${extra.join(", ")}` : null;
}

// ids : identifiants autorisés (candidats du dossier et positions ouvertes)
export function validateVote(v, ids) {
  const k = exactKeys(v, VOTE_KEYS);
  if (k) return { ok: false, error: k };
  if (!ids.includes(v.candidate_id)) return { ok: false, error: `candidate_id inconnu : ${v.candidate_id}` };
  if (!ACTIONS.includes(v.action)) return { ok: false, error: `action invalide : ${v.action}` };
  if (!isNum(v.conviction, 0, 100)) return { ok: false, error: "conviction hors de 0 – 100" };
  if (!isStr(v.invalidation_condition, 400)) return { ok: false, error: "invalidation_condition vide ou trop longue" };
  if (!isNum(v.horizon_hours, 1, 2160)) return { ok: false, error: "horizon_hours hors de 1 – 2160" };
  if (!isStr(v.cited_risk_metric, 300)) return { ok: false, error: "cited_risk_metric vide ou trop long" };
  return { ok: true, vote: { ...v, conviction: Math.round(v.conviction) } };
}

// Bulletin d'un modèle : { "votes": [ … ] } (un tableau seul ou un vote seul sont aussi acceptés). Un id voté deux fois : le premier compte.
export function validateBallot(obj, ids) {
  const list = Array.isArray(obj) ? obj : Array.isArray(obj?.votes) ? obj.votes : obj && typeof obj === "object" && "candidate_id" in obj ? [obj] : null;
  if (!list) return { ok: false, votes: [], errors: ["format : { \"votes\": [ … ] } attendu"] };
  const votes = [], errors = [], seen = new Set();
  for (const v of list) {
    const r = validateVote(v, ids);
    if (!r.ok) { errors.push(r.error); continue; }
    if (seen.has(r.vote.candidate_id)) { errors.push(`vote en double : ${r.vote.candidate_id}`); continue; }
    seen.add(r.vote.candidate_id); votes.push(r.vote);
  }
  return { ok: votes.length > 0, votes, errors };
}

export function validateArbiter(o, id) {
  const k = exactKeys(o, ARB_KEYS);
  if (k) return { ok: false, error: k };
  if (o.candidate_id !== id) return { ok: false, error: "candidate_id différent du dossier arbitré" };
  if (o.action !== "OPEN" && o.action !== "REJECT") return { ok: false, error: "action OPEN ou REJECT attendue" };
  if (!isNum(o.conviction, 0, 100)) return { ok: false, error: "conviction hors de 0 – 100" };
  if (!isStr(o.reason, 600) || !isStr(o.cited_metric, 300)) return { ok: false, error: "reason ou cited_metric vide" };
  return { ok: true, value: { ...o, conviction: Math.round(o.conviction) } };
}

/* ---------- citation d'une métrique du dossier ---------- */

export function flattenMetrics(m, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(m || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenMetrics(v, prefix + k + "."));
    else if (typeof v === "number" && Number.isFinite(v)) out.push([prefix + k, v]);
  }
  return out;
}

const numbersIn = (text) => [...String(text).matchAll(/-?\d+(?:[.,]\d+)?(?:e-?\d+)?/gi)].map((x) => Number(x[0].replace(",", "."))).filter(Number.isFinite);
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-6, 0.02 * Math.abs(b));

// Valide si le texte nomme une métrique du dossier ET donne sa valeur (tolérance 2 %, ou en pourcentage).
export function checkCitation(text, metrics) {
  const t = String(text || "").toLowerCase(), nums = numbersIn(t);
  for (const [path, v] of flattenMetrics(metrics)) {
    const key = path.split(".").at(-1).toLowerCase();
    if (!(t.includes(key) || t.includes(key.replace(/_/g, " ")) || t.includes(path.toLowerCase()))) continue;
    if (nums.some((n) => near(n, v) || near(n, v * 100))) return { ok: true, key: path, value: v };
  }
  return { ok: false, key: null, value: null };
}
