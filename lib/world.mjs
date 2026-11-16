// Carte du monde : foyers de tension (liste éditoriale de base) et pays suivis.
// La liste des conflits est une base de référence arrêtée à mi-2026 ; l'actualité en direct vient des flux d'information.
import { readFileSync } from "node:fs";
export const COUNTRIES = JSON.parse(readFileSync(new URL("./countries.json", import.meta.url), "utf8"));

// kind : guerre | insurrection | tension | commerce ; level 1 (local) à 3 (impact mondial)
export const CONFLICTS = [
  { id: "ukraine", name: "Guerre Russie – Ukraine", lat: 48.6, lon: 35.5, iso: ["UA", "RU"], kind: "guerre", level: 3, assets: ["OIL", "NATGAS", "GOLD"], note: "Invasion russe depuis février 2022. Canaux d'impact : gaz et pétrole, céréales, sanctions, dépenses de défense en Europe.", q: "Ukraine Russie guerre" },
  { id: "gaza", name: "Israël – Gaza", lat: 31.4, lon: 34.4, iso: ["IL", "PS"], kind: "guerre", level: 3, assets: ["OIL", "GOLD"], note: "Conflit ouvert depuis octobre 2023, avec trêves et reprises. Risque d'extension régionale.", q: "Gaza Israël" },
  { id: "iran", name: "Iran – Israël / États-Unis", lat: 32.6, lon: 53.5, iso: ["IR", "IL", "US"], kind: "tension", level: 3, assets: ["OIL", "GOLD"], note: "Frappes de juin 2025 sur le programme nucléaire, négociations et menaces depuis. Risque clé : le détroit d'Ormuz, où transite environ un cinquième du pétrole mondial.", q: "Iran nucléaire Israël États-Unis" },
  { id: "redsea", name: "Mer Rouge / Yémen (Houthis)", lat: 15.2, lon: 43.2, iso: ["YE"], kind: "insurrection", level: 2, assets: ["OIL"], note: "Attaques contre la navigation commerciale. Canaux d'impact : fret maritime, canal de Suez, prix de l'énergie.", q: "Houthis mer Rouge Yémen" },
  { id: "lebanon", name: "Liban – Israël (Hezbollah)", lat: 33.4, lon: 35.6, iso: ["LB", "IL"], kind: "tension", level: 2, assets: ["OIL"], note: "Cessez-le-feu fragile depuis fin 2024, frappes ponctuelles.", q: "Liban Hezbollah Israël" },
  { id: "syria", name: "Syrie", lat: 34.9, lon: 38.5, iso: ["SY"], kind: "insurrection", level: 1, assets: [], note: "Transition après la chute du régime Assad (décembre 2024), violences persistantes.", q: "Syrie" },
  { id: "sudan", name: "Guerre civile au Soudan", lat: 14.5, lon: 30.2, iso: ["SD"], kind: "guerre", level: 2, assets: ["GOLD"], note: "Armée contre Forces de soutien rapide depuis avril 2023. Plus grave crise humanitaire en cours, enjeu aurifère.", q: "Soudan guerre" },
  { id: "drc", name: "Est de la RD Congo (M23)", lat: -1.6, lon: 29.0, iso: ["CD", "RW"], kind: "guerre", level: 2, assets: [], note: "Offensive du M23 soutenu par le Rwanda. Canaux d'impact : cobalt, cuivre, coltan.", q: "RDC M23 Goma" },
  { id: "sahel", name: "Sahel (Mali, Burkina Faso, Niger)", lat: 15.0, lon: -1.0, iso: ["ML", "BF", "NE"], kind: "insurrection", level: 2, assets: ["GOLD"], note: "Insurrections djihadistes et juntes militaires. Canaux d'impact : or, uranium.", q: "Sahel Mali Burkina Niger" },
  { id: "somalia", name: "Somalie (al-Shabaab)", lat: 4.0, lon: 45.5, iso: ["SO"], kind: "insurrection", level: 1, assets: [], note: "Insurrection de longue durée.", q: "Somalie al-Shabaab" },
  { id: "ethiopia", name: "Éthiopie (Amhara, Tigré)", lat: 11.6, lon: 38.5, iso: ["ET"], kind: "insurrection", level: 1, assets: [], note: "Conflits régionaux et tensions avec l'Érythrée.", q: "Éthiopie Amhara Tigré" },
  { id: "nigeria", name: "Nigeria (nord)", lat: 11.2, lon: 8.5, iso: ["NG"], kind: "insurrection", level: 1, assets: ["OIL"], note: "Insurrections et banditisme dans le nord. Premier producteur de pétrole d'Afrique.", q: "Nigeria Boko Haram" },
  { id: "myanmar", name: "Guerre civile en Birmanie", lat: 21.0, lon: 96.0, iso: ["MM"], kind: "guerre", level: 1, assets: [], note: "Junte contre groupes armés depuis le coup d'État de 2021. Enjeu : terres rares.", q: "Birmanie junte" },
  { id: "taiwan", name: "Détroit de Taïwan", lat: 24.2, lon: 119.8, iso: ["TW", "CN"], kind: "tension", level: 3, assets: ["NVDA", "US_EQ"], note: "Pression militaire chinoise régulière. Taïwan produit l'essentiel des puces avancées : risque majeur pour la tech mondiale.", q: "Taïwan Chine détroit" },
  { id: "scs", name: "Mer de Chine méridionale", lat: 12.5, lon: 115.0, iso: ["CN", "PH"], kind: "tension", level: 2, assets: [], note: "Accrochages Chine – Philippines. Un tiers du commerce maritime mondial y passe.", q: "mer de Chine méridionale Philippines" },
  { id: "korea", name: "Péninsule coréenne", lat: 38.0, lon: 127.0, iso: ["KP", "KR"], kind: "tension", level: 2, assets: [], note: "Essais de missiles nord-coréens, rapprochement Pyongyang – Moscou.", q: "Corée du Nord missile" },
  { id: "kashmir", name: "Inde – Pakistan (Cachemire)", lat: 34.0, lon: 75.0, iso: ["IN", "PK"], kind: "tension", level: 2, assets: [], note: "Affrontements de mai 2025 entre deux puissances nucléaires, cessez-le-feu depuis.", q: "Inde Pakistan Cachemire" },
  { id: "afpak", name: "Afghanistan – Pakistan", lat: 33.2, lon: 70.2, iso: ["AF", "PK"], kind: "tension", level: 1, assets: [], note: "Accrochages frontaliers et attentats.", q: "Afghanistan Pakistan frontière" },
  { id: "venezuela", name: "Venezuela – États-Unis", lat: 8.0, lon: -66.0, iso: ["VE", "US"], kind: "tension", level: 2, assets: ["OIL"], note: "Crise politique et pression militaire américaine. Plus grandes réserves de pétrole prouvées au monde.", q: "Venezuela États-Unis" },
  { id: "haiti", name: "Haïti (gangs)", lat: 18.9, lon: -72.3, iso: ["HT"], kind: "insurrection", level: 1, assets: [], note: "Effondrement sécuritaire, gangs contrôlant la capitale.", q: "Haïti gangs" },
  { id: "mexico", name: "Mexique (cartels)", lat: 24.0, lon: -104.0, iso: ["MX"], kind: "insurrection", level: 1, assets: [], note: "Violence des cartels, pression américaine sur la sécurité et le commerce.", q: "Mexique cartels" },
  { id: "colombia", name: "Colombie (groupes armés)", lat: 4.5, lon: -73.5, iso: ["CO"], kind: "insurrection", level: 1, assets: [], note: "Regain de violence des groupes armés.", q: "Colombie ELN" },
  { id: "libya", name: "Libye", lat: 27.0, lon: 17.0, iso: ["LY"], kind: "tension", level: 1, assets: ["OIL"], note: "Pays divisé entre deux gouvernements, production pétrolière régulièrement bloquée.", q: "Libye pétrole" },
  { id: "thaicam", name: "Thaïlande – Cambodge", lat: 14.3, lon: 103.6, iso: ["TH", "KH"], kind: "tension", level: 1, assets: [], note: "Affrontements frontaliers en 2025.", q: "Thaïlande Cambodge frontière" },
  { id: "tradewar", name: "Guerre commerciale États-Unis – Chine", lat: 36.0, lon: 104.0, iso: ["US", "CN"], kind: "commerce", level: 3, assets: ["US_EQ", "USD", "NVDA"], note: "Droits de douane, contrôles à l'export sur les puces et les terres rares. Touche les chaînes d'approvisionnement mondiales.", q: "droits de douane Chine États-Unis" },
];

// Pays dont l'actualité est préchargée (les autres sont chargés au clic, en version locale)
export const WATCH = ["US", "CN", "JP", "DE", "FR", "GB", "IN", "RU", "UA", "IL", "IR", "SA", "TR", "BR", "MX", "CA", "KR", "TW", "AU", "IT", "ES", "CH", "AR", "VE", "ZA", "NG", "EG", "PK", "ID", "AE", "QA", "PL", "KP", "SD", "YE", "SY", "LB", "MM", "CD"];

// Mots-clés anglais pour rattacher un marché Polymarket à un pays
export const PM_KEYS = {
  US: /\b(u\.s\.|united states|trump|fed |fed's|fomc|powell|congress|senate|white house|vance|democrat|republican|supreme court)\b/i, CN: /\b(china|chinese|xi jinping|beijing)\b/i, RU: /\b(russia|russian|putin|moscow|kremlin)\b/i, UA: /\b(ukraine|ukrainian|zelensky|kyiv)\b/i,
  IL: /\b(israel|israeli|netanyahu|gaza|hamas)\b/i, IR: /\b(iran|iranian|khamenei|tehran)\b/i, TW: /\btaiwan\b/i, KP: /\b(north korea|kim jong)\b/i, KR: /\bsouth korea\b/i, JP: /\b(japan|japanese|boj|takaichi)\b/i, DE: /\b(germany|german|merz|bundestag)\b/i,
  FR: /\b(france|french|macron|le pen)\b/i, GB: /\b(uk |u\.k\.|britain|british|starmer|bank of england)\b/i, IN: /\b(india|indian|modi)\b/i, PK: /\bpakistan\b/i, SA: /\b(saudi|mbs)\b/i, TR: /\b(turkey|türkiye|erdogan)\b/i, BR: /\b(brazil|lula|bolsonaro)\b/i,
  MX: /\b(mexico|sheinbaum)\b/i, CA: /\b(canada|canadian|carney)\b/i, VE: /\b(venezuela|maduro)\b/i, AR: /\b(argentina|milei)\b/i, SY: /\bsyria\b/i, LB: /\b(lebanon|hezbollah)\b/i, YE: /\b(yemen|houthi)\b/i, SD: /\bsudan\b/i, PL: /\bpoland\b/i, IT: /\b(italy|meloni)\b/i,
  ES: /\bspain\b/i, AU: /\baustralia\b/i, EG: /\begypt\b/i, ZA: /\bsouth africa\b/i, NG: /\bnigeria\b/i, ID: /\bindonesia\b/i, CH: /\b(switzerland|swiss|snb)\b/i, QA: /\bqatar\b/i, AE: /\b(uae|emirates|dubai)\b/i, MM: /\bmyanmar\b/i, CD: /\bcongo\b/i,
};
export const pmCountries = (title) => Object.entries(PM_KEYS).filter(([, re]) => re.test(title)).map(([k]) => k);
