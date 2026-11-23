# SPEC.md — Agent de Paper Trading Autonome (« Boussole des Baleines »)

## 1. Objectif & Architecture Générale
Construire un moteur de paper trading autonome (capital fictif : **10 000 $**) branché sur les flux de données existants (Hyperliquid, Polymarket, Macro/Fed, CFTC, Options).

> **Arbitrages du 24/11/2026** (priment sur toute mention contraire) : Node.js ESM (≥ 20) pour réutiliser `lib/hl.mjs`, `lib/pm.mjs`, `lib/macro.mjs` ; validation stricte des sorties LLM sans Pydantic ; état sur la branche `state` ; un seul déploiement GitHub Pages ; 3 votants indépendants + 1 arbitre, sans avocat du diable.

**Principe fondamental :** séparation stricte entre le **moteur déterministe** (Node.js : filtrage statistique, calcul de risque, exécution simulée, comptabilité) et la **couche cognitive** (LLM : synthèse de thèse, arbitrage, détection de catalyseurs). **Aucun LLM ne peut contourner les règles de risque ni modifier directement la taille d'une position au-delà des bornes calculées par le code.**

### Cadence & Infrastructure (100 % gratuit)
- **Moteur horaire (GitHub Actions `trading_loop.yml`, `cron: "0 * * * *"`) :**
  - Partage le groupe de concurrence `boussole` avec `update.yml` : les deux workflows ne tournent jamais en même temps, aucun ne peut écraser la branche `state` de l'autre.
  - Ne pousse **jamais** si la récupération de la branche `state` a échoué (sinon l'historique serait remplacé par un état vide).
  - Met à jour le mark-to-market, le funding Hyperliquid, les résolutions Polymarket et vérifie les stops/kill-switches.
  - Exécute le pipeline de détection de candidats.
  - **Règle anti-overtrading :** ne réveille les LLM que si au moins un candidat dépasse le seuil de score requis, si une position ouverte approche de son invalidation, ou lors de la revue quotidienne fixe (ex. 14h00 UTC).
- **Tâches cognitives lourdes (Claude Code planifié, 3–4×/jour) :**
  - Exécute le module *Border* (recherche web + thèses asymétriques) et écrit ses propositions validées dans `paper/border_proposals.json` sur la branche `state`, relues par le moteur horaire.
- **Stockage & Frontend :**
  - `data/` reste hors de `main` (`.gitignore`). L'état du paper trading vit dans `data/paper/`, sauvegardé sur la branche `state` comme le reste de l'historique (`paper/portfolio_state.json`, `paper/trades_history.jsonl`, `paper/model_votes.jsonl`, `paper/whale_scores.json`, `paper/equity_curve.jsonl`).
  - Un seul déploiement Pages, celui de `update.yml` : `scripts/snapshot.mjs --site` copie `data/paper/*` dans `site/paper/`, et une nouvelle page du terminal (« Paper trading ») les affiche. Les ordres horaires apparaissent donc sur le site à la collecte suivante (10 à 20 min).

---

## 2. Allocation du Capital (3 Poches Isolées)
Le capital total $E_t$ est réparti en trois sous-portefeuilles comptabilisés séparément :

1. **Poche Core (70 % max) — Copy-Whale + Macro & Relative Value :**
   - Directionnel filtré et paires Long/Short sur Hyperliquid, convictions sur Polymarket (hors sport).
2. **Poche Portage (25 % max) — Haute Probabilité Polymarket :**
   - Marchés Polymarket à échéance courte ($\le 14$ jours), cote entre `0.88 $` et `0.95 $`, confirmés par les baleines, sans risque de retournement évident. Tenue jusqu'à résolution.
3. **Poche Border (5 % max, ~250–300 $ / idée) — Spéculation Asymétrique :**
   - Thèses non-consensuelles issues de l'actualité avec catalyseur daté. Zéro levier, ratio gain/risque minimal de **3:1** (ex. achat Polymarket $\le 0.25\$$).

---

## 3. Pipeline de Filtrage Statistique (Pré-LLM)
Avant tout appel IA, le code filtre l'univers et construit un dossier JSON compact contenant au maximum les **5 meilleurs candidats**.

### 3.1 Scoring des Baleines (Déterministe, sans LLM)
Chaque baleine $w$ dispose d'un poids $W_{w,c} \in [0.5, 2.0]$ **par catégorie** $c \in \{\text{Macro/Fed}, \text{Géopolitique}, \text{Crypto}, \text{Commodities/Indices}\}$.
- Mise à jour automatique à chaque trade résolu via une moyenne mobile exponentielle (EMA) du PnL ajusté du risque (Hyperliquid) ou du Brier Score inversé (Polymarket).
- **Filtre anti-survivant :** seules les baleines ayant au moins $N \ge 15$ positions résolues et un drawdown historique maîtrisé sont éligibles.
- **Démarrage à froid (warm-up) :** tant qu'une baleine a moins de 15 positions résolues relevées par nos soins, $W_{w,c}$ part de **1.0**, ajusté par son PnL déjà connu du terminal (Hyperliquid : PnL/ROI mois et all-time du classement ; Polymarket : PnL du classement par catégorie), borné à $[0.75, 1.25]$. Le filtre strict $N \ge 15$ s'applique baleine par baleine dès que son historique l'atteint. Le dossier envoyé aux LLM indique pour chaque baleine `warmup: true|false`.

### 3.2 Filtres Obligatoires par Candidat
Un candidat est **rejeté automatiquement par le code** s'il échoue à l'un de ces critères :
1. **Conviction relative :** la position doit représenter au moins **5 % de l'equity** du wallet de la baleine (élimine le bruit des gros comptes).
2. **Fenêtre de convergence :** au moins 2 baleines qualifiées dans la catégorie $c$ entrées dans une fenêtre glissante de **4 heures** (ou 24h pour le swing macro).
3. **Freshness (Dislocation de prix) :**
   - *Hyperliquid :* $\vert{}\text{Prix}_{\text{actuel}} - \text{VWAP}_{\text{baleines}}\vert{} \le 1.2 \times \text{ATR}_{14}$ dans le sens du trade. $\text{VWAP}_{\text{baleines}}$ = moyenne des `entryPx` de `clearinghouseState`, pondérée par le notionnel.
   - *Polymarket :* $\text{Prix}_{\text{actuel}} - \text{Prix}_{\text{moyen\_baleines}} \le 0.10\$$ (champ `avg_price` des positions).
   - *Heure d'entrée :* `entryPx` ne donne pas l'heure. La fenêtre de convergence (filtre 2) ne compte donc que les ouvertures et renforcements détectés entre deux relevés (`diffAccounts`, `diffWhales`), horodatés à la détection. Une position déjà ouverte au premier relevé peut servir de confirmation, jamais de déclencheur.
4. **Filtre Contrariant (Baleines vs Retail — Hyperliquid) :**
   - *Bonus de score :* baleines Long avec funding $\le 0$ (ou neutre) / baleines Short avec funding positif élevé.
   - *Rejet :* trade encombré (*crowded*) où funding extrême + mur de liquidations immédiat dans le sens du trade.
5. **Détection de Hedge :** exclusion des wallets Hyperliquid identifiés comme *delta-neutral* ou *market makers* (ratio d'exposition nette directionnelle trop faible).
   - *V1 :* ratio directionnel net sur les perps $= \vert{}\text{Long}_N - \text{Short}_N\vert{} / (\text{Long}_N + \text{Short}_N)$ ; exclusion si $< 0.3$ (seuil configurable). Les market makers sont déjà écartés par `selectCohort` (volume mensuel / capital).
   - *Option :* appel `spotClearinghouseState` (une requête de plus par baleine candidate, pas par baleine de la cohorte) pour soustraire les soldes au comptant couvrant un short perp.

### 3.3 Signaux Avancés (Alpha Structurel)
- **Relative Value (Long/Short) :** si les baleines sont fortement Long sur un actif $A$ et neutres/Short sur un actif corrélé $B$ ($\rho > 0.6$), générer un candidat *paire neutre* (`Long A / Short B` de même valeur notionnelle).
- **Lead-Lag (Polymarket $\leftrightarrow$ Hyperliquid) :** si une probabilité Polymarket liée à un catalyseur macro/géopolitique varie de $\ge 10\%$ en moins de 2 heures sans réaction proportionnelle de l'actif Hyperliquid associé (pétrole, or, BTC), générer un candidat prioritaire.

---

## 4. Couche Décisionnelle IA (Vote Parallèle + Arbitre)
Remplace le débat séquentiel par une architecture parallèle pour éliminer la complaisance (*sycophancy*) et les rejets artificiels.

### 4.1 Routeur LLM Multi-Providers (100 % Gratuit)
Implémenter une classe `LLMRouter` (`lib/paper/router.mjs`) avec fallback automatique et validation stricte du JSON renvoyé (schéma maison dans `lib/paper/schema.mjs`, sans dépendance, pour garder le projet installable sans `npm install` ; Zod reste possible si on accepte un `npm ci` dans les workflows). Une réponse invalide compte comme une absence de réponse. Les 3 votants doivent être **3 modèles distincts** ; le routeur les prend dans l'ordre des fournisseurs ci-dessous et passe au suivant en cas d'erreur, de limite ou de JSON invalide :
1. **GitHub Models** (GPT-4o-mini / Llama-3.3-70B)
2. **Groq** (Llama-3.3-70B / Qwen-2.5)
3. **Cerebras / SambaNova** (offres gratuites rapides)
4. **OpenRouter** (modèles `:free`) / **Gemini Free** (dernier secours)

### 4.2 Processus de Décision
1. **Vote Parallèle Indépendant (3 modèles distincts) :**
   Chaque modèle reçoit le même dossier candidat + l'état du portefeuille et renvoie strictement ce JSON :
   ```json
   {
     "candidate_id": "string",
     "action": "OPEN | REJECT | HOLD | CLOSE",
     "conviction": 0,
     "invalidation_condition": "string",
     "horizon_hours": 72,
     "cited_risk_metric": "string (doit citer une métrique réelle du dossier)"
   }
   ```
2. **Règle de Quorum :**
   - Il faut **au moins 2 modèles valides** pour ouvrir une position.
   - Si 1 seul modèle répond : gestion de l'existant uniquement (pas d'ouverture).
   - Si 0 modèle répond : bascule sur l'agent de secours déterministe (gestion des stops/take-profits uniquement).
3. **Arbitre (Synthèse) :**
   - Si unanimité (`OPEN` ou `REJECT`) : exécution directe sans appel supplémentaire.
   - Si divergence (2 `OPEN` vs 1 `REJECT`, ou inverse) : un modèle Arbitre (distinct des 3 votants) tranche en exigeant que toute objection cite une métrique chiffrée du dossier.
   - Si seulement 2 votes valides et 1 contre 1 : pas d'ouverture.
   - **Contrôle par le code :** un `REJECT` dont `cited_risk_metric` ne correspond à aucune clé et valeur chiffrée du dossier est écarté avant l'arbitrage. Pas d'avocat du diable désigné.
4. **Traçabilité :** chaque vote individuel est loggué dans `data/model_votes.jsonl` pour calculer le **PnL contrefactuel** de chaque modèle seul.

---

## 5. Moteur de Risque Déterministe (Hard-Coded)
Appliqué strictement par le code (`lib/paper/risk.mjs`) **après** la décision IA et **avant** l'exécution.

### 5.1 Dimensionnement par le Risque ($R$)
- Risque maximal par trade : $R = 1.0\%$ à $1.5\%$ de l'equity $E_t$ (modulé linéairement par la conviction IA entre 60 et 100).
- **Hyperliquid (Perps) :**
  - Stop-loss basé sur la volatilité : $d_{\text{stop}} = \text{clip}(2.0 \times \text{ATR}_{14} / \text{Prix},\; 3\%,\; 15\%)$.
  - Taille notionnelle :
    $$\text{Notionnel} = \min\left(\frac{R \times E_t}{d_{\text{stop}}},\; 0.20 \times E_t \times L_{\max}\right)$$
- **Polymarket (Binaire) :**
  - Pas de stop-loss en % (évite les mèches dans les carnets vides). Le risque est égal à 100 % de la mise :
    $$\text{Mise} = R \times E_t \quad (\text{ou jusqu'à } 5\% \text{ pour la poche Portage})$$
  - Sortie anticipée uniquement sur *invalidation fondamentale* (coût de spread vérifié avant sortie).

### 5.2 Plafonds Globaux & Corrélation
- **Levier effectif global max :** $\frac{\sum \vert{}\text{Notionnel}_i\vert{}}{E_t} \le 2.5\times$ (plafond individuel à $3\times$ par position).
- **Exposition factorielle (Anti-concentration) :** chaque actif est taggué par facteur (`CRYPTO_BETA`, `RATES_MACRO`, `ENERGY_GEO`, `GOLD_SAFEHAVEN`, `IDIOSYNCRATIC`). L'exposition notionnelle cumulée sur un même facteur ne peut pas dépasser **40 % de l'equity** (les paires *Relative Value* comptent pour leur exposition nette résiduelle).
- **Drawdown maximal & Frein progressif :**
  - Si $\text{DD} \ge 10\%$ : $R$ est divisé par 2.
  - Si $\text{DD} \ge 20\%$ : mode *Reduce-Only* (aucune nouvelle ouverture).
  - Si $\text{DD} \ge 25\%$ : arrêt d'urgence (*Kill Switch* global).
- **Kill Switch temporel (Poche Border) :** clôture automatique à la date $T$ du catalyseur si l'événement n'a pas eu lieu.
- **Conventions de mesure (implémentation, `lib/paper/risk.mjs`) :**
  - Levier brut : notionnel HL au mark + valeur des parts PM, rapporté à l'equity.
  - Facteurs : $ert{}sum	ext{notionnel signé}ert{}$ des positions HL du facteur ; les paris Polymarket n'y entrent pas (perte bornée à la mise).
  - Occupation d'une poche : coût restant des positions PM + marge des positions HL (notionnel / $3	imes$ ; poche Border sans levier : notionnel entier).
  - Portage : mise $= 5% 	imes E 	imes R / R_{max}$, plafonnée à $5%$ de l'equity **par marché** ; Border : mise $= 300$ 	imes R / R_{max}$ ; toute ouverture Border exige une date de catalyseur.
  - Conviction < 60 : aucune ouverture. Ordre < 25 $ : refusé.
  - L'arrêt d'urgence est définitif : seul un humain le lève (champ `mode` de `portfolio_state.json`).

---

## 6. Moteur d'Exécution Simulé
- **Horodatage :** UTC strict.
- **Prix d'exécution (Orderbook Walking) :** lecture du carnet d'ordres réel (L2) au moment de la décision pour calculer le prix moyen pondéré (VWAP) incluant le glissement (*slippage*) pour la taille exacte demandée.
  - Hyperliquid : `POST api.hyperliquid.xyz/info` avec `{"type":"l2Book","coin":…}`.
  - Polymarket : `GET clob.polymarket.com/book?token_id=…` (domaine autorisé). `lib/pm.mjs` doit conserver le `token_id` de chaque position (il ne sert aujourd'hui qu'au dédoublonnage).
  - Résolutions Polymarket : `GET clob.polymarket.com/markets/{condition_id}` (`closed`, jeton gagnant).
  - Carnet trop mince pour la taille demandée : l'ordre est réduit à ce que le carnet absorbe dans la limite de glissement, ou annulé.
- **Frais :**
  - Hyperliquid : taker fee `0.035%` (ou grille réelle) + comptabilisation horaire du **funding rate** sur les positions ouvertes.
  - Polymarket : spread réel du carnet + paiement `0 $` ou `1 $` à la résolution.

---

## 7. Évaluation & Métriques de Compétition
Calculées automatiquement à chaque mise à jour et exposées sur le site :
- **Performance ajustée du risque :** Sharpe Ratio, Sortino Ratio, Calmar Ratio, Max Drawdown.
- **Qualité de prédiction :** Brier Score (Polymarket), Expectancy, Profit Factor.
- **Benchmarks passifs :** comparaison sur la même période contre *Buy & Hold BTC* et un panier *50/50 BTC-Or*.
- **Significativité statistique :** calcul du *Probabilistic Sharpe Ratio (PSR)* et du PnL contrefactuel par modèle IA (dès $N \ge 30$ trades indépendants).

---

## 8. Arborescence Cible du Dépôt
Le terminal existant reste en place ; l'agent s'ajoute dans `lib/paper/`. Aucune dépendance npm ; tests avec `node --test`.

```text
/
├── SPEC.md, PROGRESS.md
├── server.mjs                    # inchangé (route /api/paper en local)
├── .github/workflows/
│   ├── update.yml                # existant : collecte + Pages (copie data/paper → site/paper)
│   └── trading_loop.yml          # nouveau : cron horaire, même groupe de concurrence, pousse sur state
├── lib/
│   ├── hl.mjs                    # + l2Book, bougies OHLC (ATR), spotClearinghouseState optionnel
│   ├── pm.mjs                    # + token_id conservé, carnet CLOB, résolution des marchés
│   ├── macro.mjs, alt.mjs …      # inchangés, lus tels quels
│   └── paper/
│       ├── config.mjs            # tous les seuils de la spec, à un seul endroit
│       ├── store.mjs             # lecture/écriture data/paper (JSON + JSONL), horodatage UTC
│       ├── loader.mjs            # dernier relevé (data/last.json, events) + compléments frais
│       ├── scorer.mjs            # poids W(w,c), EMA, warm-up
│       ├── candidates.mjs        # filtres 3.2 + score
│       ├── cross.mjs             # Relative Value, Lead-Lag
│       ├── schema.mjs            # validation stricte des votes
│       ├── router.mjs            # LLMRouter multi-fournisseurs
│       ├── decision.mjs          # vote, quorum, arbitre, secours déterministe
│       ├── risk.mjs              # sizing R, stops ATR, levier, facteurs, freins de drawdown
│       ├── simulator.mjs         # orderbook walking, frais, funding, résolutions, MTM
│       └── metrics.mjs           # Sharpe, Sortino, Calmar, Brier, PSR, contrefactuels
├── scripts/
│   ├── snapshot.mjs              # + copie data/paper
│   └── paper.mjs                 # point d'entrée horaire (--dry-run pour tester sans écrire)
├── public/
│   └── views5.js                 # page « Paper trading » (capital, courbe, DD, positions, votes)
└── test/paper/*.test.mjs

Branche state (= dossier data/ en local)
└── paper/
    ├── portfolio_state.json
    ├── equity_curve.jsonl
    ├── trades_history.jsonl
    ├── model_votes.jsonl
    ├── whale_scores.json
    └── border_proposals.json     # écrit par Claude Code (3-4×/jour)
```
