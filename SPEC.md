# SPEC.md — Agent de Paper Trading Autonome (« Boussole des Baleines »)

## 1. Objectif & Architecture Générale
Construire un moteur de paper trading autonome (capital fictif : **10 000 $**) branché sur les flux de données existants (Hyperliquid, Polymarket, Macro/Fed, CFTC, Options).

> **Arbitrages du 24/11/2026** (priment sur toute mention contraire) : Node.js ESM (≥ 20) pour réutiliser `lib/hl.mjs`, `lib/pm.mjs`, `lib/macro.mjs` ; validation stricte des sorties LLM sans Pydantic ; état sur la branche `state` ; un seul déploiement GitHub Pages ; 3 votants indépendants + 1 arbitre, sans avocat du diable.

**Principe fondamental :** séparation stricte entre le **moteur déterministe** (Node.js : filtrage statistique, calcul de risque, exécution simulée, comptabilité) et la **couche cognitive** (LLM : synthèse de thèse, arbitrage, détection de catalyseurs). **Aucun LLM ne peut contourner les règles de risque ni modifier directement la taille d'une position au-delà des bornes calculées par le code.**

### Cadence & Infrastructure (100 % gratuit)
- **Moteur horaire (GitHub Actions `trading_loop.yml`, lancé à :10 chaque heure par cron-job.org via `workflow_dispatch`, après `update.yml` à :00) :**
  - Partage le groupe de concurrence `boussole` avec `update.yml` : les deux workflows ne tournent jamais en même temps, aucun ne peut écraser la branche `state` de l'autre.
  - Ne pousse **jamais** si la récupération de la branche `state` a échoué (sinon l'historique serait remplacé par un état vide).
  - Met à jour le mark-to-market, le funding Hyperliquid, les résolutions Polymarket et vérifie les stops/kill-switches.
  - Exécute le pipeline de détection de candidats.
  - **Règle anti-overtrading :** ne réveille les LLM que si au moins un candidat dépasse le seuil de score requis, si une position ouverte approche de son invalidation, ou lors de la revue quotidienne fixe (ex. 14h00 UTC).
- **Tâches cognitives lourdes (Claude Code planifié, 3–4×/jour) :**
  - Exécute le module *Border* (recherche web + thèses asymétriques) et écrit ses propositions dans `border_proposals.json` d'une branche dédiée `border` (jamais `state`, réécrite à chaque exécution des workflows), relues par le moteur horaire ; elles passent par le même vote que les autres candidats (au plus 2 par cycle, en plus des 5 meilleurs) et par le moteur de risque. Format et instructions : `lib/paper/border.mjs`, `scripts/border_prompt.md`.
- **Stockage & Frontend :**
  - `data/` reste hors de `main` (`.gitignore`). L'état du paper trading vit dans `data/paper/`, sauvegardé sur la branche `state` comme le reste de l'historique (`paper/portfolio_state.json`, `paper/trades_history.jsonl`, `paper/model_votes.jsonl`, `paper/whale_scores.json`, `paper/equity_curve.jsonl`).
  - Un seul déploiement Pages, celui de `update.yml` : `scripts/snapshot.mjs --site` copie `data/paper/*` dans `site/paper/`, et une nouvelle page du terminal (« Paper trading ») les affiche. Les ordres du cycle de :10 apparaissent donc sur le site à la collecte suivante, à l'heure pile (environ 50 min plus tard).

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
- **Implémentation (`lib/paper/scorer.mjs`) :**
  - Score d'une position résolue $s in [-1, 1]$. Hyperliquid : $s = 	anh(	ext{PnL}/	ext{notionnel} / 5%)$. Polymarket : avantage réalisé $s = 	ext{issue} - 	ext{prix moyen}$ (issue 1 ou 0) si le marché est résolu, sinon $s = 	ext{dernier prix} - 	ext{prix moyen}$. Ce score remplace le « Brier inversé » : la probabilité que la baleine avait en tête est inconnue, seul le prix payé l'est ; un Brier calculé sur ce prix pénaliserait les paris gagnants achetés bon marché. Le score de Brier reste utilisé pour les prédictions de l'agent (§7).
  - Poids : $W leftarrow (1-alpha)W + alpha(1+s)$, $alpha = 0.2$, borné à $[0.5, 2]$.
  - Catégories : Hyperliquid crypto (marché principal), commodities (dex `xyz`, PAXG), macro (`xyz:DXY`, `EUR`, `JPY`) ; Polymarket selon le thème et la catégorie du titre (sport et divers exclus).
  - Phase de démarrage : 30 jours après la création de `whale_scores.json`. Après, une baleine a besoin de 15 positions résolues dans la catégorie.
  - « Drawdown maîtrisé » : creux de la somme des scores $le 4$, sinon exclue.
  - Poids de départ, rafraîchis chaque jour pour les baleines du relevé : Hyperliquid selon le ROI du mois ($pm 50%$ → bornes), Polymarket selon le rang dans le classement mensuel de la catégorie.

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

### 3.2 bis Score et dossier (implémentation, `lib/paper/candidates.mjs`)
- Score $= sum_{	ext{entrées dans la fenêtre}} W + 0.5 sum_{	ext{déjà en position}} W$, $	imes 1.2$ si contrariant, $	imes (1 - 0.5 cdot 	ext{distance}/	ext{seuil de fraîcheur})$. Il n'est pas borné : 29 baleines de poids 1 donnent environ 30. Seuil de réveil des LLM : **2**.
- Fraîcheur « dans le sens du trade » : seul un prix déjà parti dans le sens du trade est pénalisé ou rejeté.
- Contrariant : funding horaire $le 0$ pour un long, $ge 0.003,%$ pour un short. Encombré (rejet) : le sens du trade paie un funding $ge 0.005,%$/h **et** au moins 25 % du notionnel de la cohorte dans ce sens est liquidable à moins de 1 ATR.
- Polymarket : poids de la position = valeur / valeur totale des positions relevées de la baleine ; cote > 0,95 rejetée ; cote 0,88 – 0,95 à 14 jours au plus → poche Portage, sinon Core.
- ATR demandé seulement pour les 8 meilleurs groupes Hyperliquid, leurs partenaires de paire et les actifs liés aux cotes qui ont bougé.
- Un candidat déjà en portefeuille est écarté ; le dossier (`paper/candidates.json`) garde les 5 meilleurs et la raison de chaque rejet.

### 3.3 Signaux Avancés (Alpha Structurel)
- **Relative Value (Long/Short) :** si les baleines sont fortement Long sur un actif $A$ et neutres/Short sur un actif corrélé $B$ ($\rho > 0.6$), générer un candidat *paire neutre* (`Long A / Short B` de même valeur notionnelle).
- **Lead-Lag (Polymarket $\leftrightarrow$ Hyperliquid) :** si une probabilité Polymarket liée à un catalyseur macro/géopolitique varie de $\ge 10\%$ en moins de 2 heures sans réaction proportionnelle de l'actif Hyperliquid associé (pétrole, or, BTC), générer un candidat prioritaire.
- **Implémentation (`lib/paper/cross.mjs`) :**
  - Paires : sentiment d'un actif $= (L - S)/(L + S)$ sur les notionnels pondérés des baleines qualifiées ; actif A $ge 0.6$ dans le sens du candidat, partenaire B du même facteur $le 0.2$ dans ce sens, $
ho$ sur 30 rendements quotidiens. Score de la paire = score de A $	imes 
ho$.
  - Décalage : historique de 48 h (`paper/market_history.json`) des cotes Polymarket liées à un actif et des prix mark. « Réaction proportionnelle » = mouvement de même sens d'au moins 0,25 ATR quotidien. Score fixe 3 (prioritaire). Le cycle étant horaire, la fenêtre de 2 h ne contient que 2 ou 3 relevés.

---

## 4. Couche Décisionnelle IA (Vote Parallèle + Arbitre)
Remplace le débat séquentiel par une architecture parallèle pour éliminer la complaisance (*sycophancy*) et les rejets artificiels.

### 4.1 Routeur LLM Multi-Providers (100 % Gratuit)
Implémenter une classe `LLMRouter` (`lib/paper/router.mjs`) avec fallback automatique et validation stricte du JSON renvoyé (schéma maison dans `lib/paper/schema.mjs`, sans dépendance, pour garder le projet installable sans `npm install` ; Zod reste possible si on accepte un `npm ci` dans les workflows). Une réponse invalide compte comme une absence de réponse. Les 3 votants doivent être **3 modèles distincts** ; le routeur les prend dans l'ordre des fournisseurs ci-dessous et passe au suivant en cas d'erreur, de limite ou de JSON invalide :
1. ~~**GitHub Models**~~ : service retiré le 30 juillet 2026, plus utilisé
2. **Groq** (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b` : 2 votants)
3. **Gemini**, API directe Google AI Studio (`gemini-3.8-flash` et `gemini-3.5-flash-lite` : modèles « ombre » depuis le 28/11/2026, 3.8-flash en HTTP 429 en ~200 ms sur la clé AI Studio, voir §4.3 ; `gemini-3.6-flash` retiré le 28/11/2026, HTTP 429 faute de quota)
4. **Gemma 4** sur l'API Gemini, même clé, API native `generateContent` (`gemma-4-26b-a4b-it`, secours `gemma-4-31b-it` : arbitre)
5. **Cerebras / SambaNova** (offres gratuites rapides, si leurs clés existent ; identifiants non vérifiés)
6. **OpenRouter** (modèles `:free` seulement : `ernie-5.5-flash-preview` en ombre, réponses vides ; `gemma-4-31b-it` remplace un arbitre absent)

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

### 4.3 Implémentation (`lib/paper/schema.mjs`, `router.mjs`, `decision.mjs`, `execute.mjs`)
- **Un appel par modèle et par cycle :** chaque votant reçoit tous les candidats et toutes les positions ouvertes, et renvoie `{"votes":[…]}` (un vote au schéma du §4.2 par identifiant). Tout champ inconnu, manquant ou hors bornes invalide le vote ; un bulletin sans vote valide compte comme une absence de réponse.
- **Familles :** chaque modèle a une famille (`gpt-oss`, `qwen3.8`, `gemini`, `gemma`, `ernie`…). Les 3 votants sont de familles distinctes ; l'arbitre est d'une 4ᵉ famille. Groq fournit 2 familles (`openai/gpt-oss-120b` et `gpt-oss-20b` → `gpt-oss`, `qwen/qwen3.8-27b` → `qwen3.8`) et Gemini la 3ᵉ (`gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite` → `gemini` ; `gemini-2.5-flash` et `gemini-2.5-pro` sont dépréciés et redirigés à partir du 01/12/2026). L'arbitre est Gemma 4 servi par Google avec la même clé (`gemma-4-31b-it`, puis `gemma-4-26b-a4b-it` → `gemma`), appelé par l'API native `generateContent` (clé dans l'en-tête `x-goog-api-key`, partie « thought » ignorée), car l'endpoint compatible OpenAI n'est pas documenté pour Gemma ; OpenRouter (`gemma-4-31b-it:free`, `ernie-5.5-flash-preview:free`) n'est plus qu'un dernier recours. Cycle du 24/11/2026 : `nemotron-3-ultra` (60 s) et `nemotron-3.5-lightning` (réponse vide) retirés. GitHub Models, retiré le 30 juillet 2026, n'est plus utilisé.
- **Rôles et modèles « ombre » (27/11/2026, audit des 3,2 premiers jours) :** chaque modèle a un rôle, votant (`role: "voter"`) ou arbitre (`role: "arbiter"`). Votants : `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` (`gemini-3.8-flash` en ombre depuis le 28/11/2026, HTTP 429 ; ses échecs ne vont plus dans `problems`), avec `ernie-5.5-flash-preview` en remplaçant ; arbitre : `gemma-4-26b-a4b-it`. `gemini-3.6-flash` (−0,51 R, 0 % de réussite) et `gemini-3.5-flash-lite` (−1,00 R) sont `shadowOnly` : interrogés en parallèle des votants, leurs votes ont un poids nul (`weight: 0`) dans le dépouillement et l'exécution, mais restent journalisés et suivis dans le PnL contrefactuel. Le quorum (2 votes valides) est inchangé.
- **Pool élargi et classement dynamique (28/11/2026, `lib/paper/llm_ranking.mjs`) :** fournisseurs activés dès que leur clé existe : Groq (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`), Cerebras (`llama-3.3-70b`, `qwen-3-32b`, `CEREBRAS_API_KEY`), Mistral (`mistral-small-latest`, `MISTRAL_API_KEY`), OpenRouter (`meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen3-235b-a22b:free`, routeur automatique `openrouter/free`), Gemma 4 en arbitre, `gemini-3.5-flash-lite`, `gemini-3.8-flash` et `ernie` en ombre. Chaque modèle reçoit un score tiré de ses trades fantômes clos (30 jours, 40 au plus) : composite 0,5 × (2·PSR − 1) + 0,3 × borne(ln PF, ±1) + 0,2 × (2·réussite − 1), soit 1 + composite, ramené vers 1 par un prior bayésien (5 trades) et égal à 1 sous 5 trades ; pénalité légère (au plus −30 %) pour les échecs récents (moyenne mobile exponentielle). Depuis le 28/11/2026 (2ᵉ version), TOUS les modèles décisionnels (non `shadowOnly`) votent à chaque réveil, en parallèle (`collectAll`), sans limite de nombre ni contrainte de famille. Poids cible continu : max(0,2 ; score)², normalisé et borné entre 4 % (`MIN_WEIGHT`, un modèle mal classé garde une voix) et 30 % (`MAX_WEIGHT`), somme 1 (bornes 1/n quand elles sont infaisables). Un modèle actif qui ne répond pas pèse 0 sur ce cycle et sa part est redistribuée au prorata des poids cibles des modèles qui ont répondu, dans les mêmes bornes. Les modèles `shadowOnly` ont un poids nul mais leurs votes alimentent le shadow book. OpenRouter : 400 ms au moins entre deux requêtes vers openrouter.ai. JSON des réponses extrait des habillages markdown, du texte autour et des balises de raisonnement. Les Blueprints du Flux ∞ sont compilés après le vote (mistral-small d'abord, puis qwen3.8, gpt-oss-120b, openrouter/free) pour préserver le quota par minute de Groq ; ils entrent en D1 au cycle suivant. Dépouillement pondéré : s = part pondérée des OPEN ; unanimité → ouverture, s ≥ 0,75 → ouverture, s ≤ 0,25 → rejet, entre les deux → arbitre (à poids égaux : la règle à 3 votants est inchangée) ; conviction = moyenne pondérée des OPEN. État publié : `llm_ranking.json` (onglet Paper trading, « Classement des modèles IA »).
- **Erreurs :** en cas de HTTP ≥ 400 ou de réponse non JSON, le message du routeur reprend les 200 premiers caractères du corps (modèle retiré ou renommé, quota, clé…).
- **Clés (secrets du dépôt) :** `GROQ_API_KEY` (2 votants à lui seul : aucune ouverture sans un second fournisseur), et en option `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`. La liste des modèles se remplace par la variable `PAPER_LLM_PROVIDERS` (JSON) sans toucher au code.
- **Citation :** `cited_risk_metric` est vérifiée par le code : nom d'une métrique du bloc `metrics` du candidat **et** sa valeur (tolérance 2 %, ou exprimée en pourcentage). Seuls les `REJECT` sont écartés si la citation échoue ; `HOLD` sur un candidat vaut « ne pas ouvrir ».
- **Positions ouvertes :** fermeture à la majorité stricte des votes valides `CLOSE` (un seul vote suffit si un seul modèle a répondu).
- **Secours (aucun vote valide, ou aucune clé) :** ni ouverture ni fermeture discrétionnaire ; stops, échéances et freins de drawdown restent appliqués à chaque cycle.
- **Exécution :** fermetures d'abord, puis ouvertures une par une (chaque ouverture modifie les plafonds de la suivante). La conviction retenue (moyenne en cas d'unanimité, celle de l'arbitre sinon) est passée au moteur de risque. Une paire dont la seconde jambe échoue est refermée aussitôt.
- **Garde-fous d'exécution (`config.guards`, `risk.mjs`, appliqués par `execute.mjs`) :**
  1. *Sortie par vote :* aucune fermeture par vote avant **8 h** de détention, sauf invalidation majeure (≥ 85 % des votes valides disent `CLOSE`, conviction moyenne ≥ 85). Stops, échéances et freins de drawdown (10 / 20 / 25 %) passent par le simulateur et ne sont jamais bloqués.
  2. *Ré-entrée :* pas de réouverture d'un actif Hyperliquid (quel que soit le sens) ou d'un marché Polymarket fermé il y a moins de **4 h**, y compris dans le même cycle.
  3. *Panier corrélé :* au plus **3** positions ouvertes dans le même sens parmi `BTC`, `ETH`, `SOL`, `HYPE`, `ZEC`, `NVDA`, `SOXL`. Les positions existantes au-delà ne sont pas fermées, seules les nouvelles sont refusées.
  4. *Barrière Polymarket :* un signal lead-lag dont l'intitulé est une barrière (`hit`, `touch`, `reach`, `above`, `below`) est écarté si le seuil est à plus de **8 %** du prix actuel (dès la détection, puis à nouveau à l'exécution).
- **Réveil :** candidat au-dessus du seuil, position à moins de 25 % de la distance entrée – stop, ou revue quotidienne (première exécution après 14 h UTC).


### 4.4 Collecte X : flux ε et ∞ (`lib/paper/x_scraper.mjs`, `blueprint.mjs`, page « X Alpha »)
- **Sources, dans l'ordre :** (1) `twitter-cli` (PyPI `twitter-cli`, version figée dans `.github/x-requirements.txt`) avec les cookies d'une session X, `TWITTER_AUTH_TOKEN` et `TWITTER_CT0`, alimentés en CI par les secrets `X_AUTH_TOKEN` et `X_CT0` ; commande `twitter search <q> -t Latest --max <n> --json` (`X_TWITTER_CMD`). (2) `agent-reach twitter search <q> --limit <n>` (`X_REACH_CMD`), seulement sur un poste où son navigateur est connecté à x.com : agent-reach ne prend pas de cookies et n'est pas installé en CI (le paquet PyPI « agent-reach » est un autre projet). (3) API X v2 (`X_BEARER_TOKEN`) ou twitterapi.io (`TWITTERAPI_IO_KEY`). Cookies expirés (`not_authenticated`) : flux neutre, statut « renouveler les secrets X_AUTH_TOKEN et X_CT0 » et message dans le journal ; limite de débit ou blocage : pause d'1 h. Le cycle de trading n'est jamais interrompu.
- **Anti-ban :** une collecte réussie et non vide de moins de 45 min est réutilisée sans nouvelle requête X (`collectedAt`) ; un lancement manuel avec l'option `force_x` (ou `X_FORCE=true`, `--x-force`) force la collecte.
- **Correctif twitter-cli (`scripts/x_twitter.py`, appelé à la place de `twitter` en CI) :** depuis le nouveau frontend de x.com, la page servie sans session ne référence plus le script `ondemand.s` dont twitter-cli 0.8.5 tire l'en-tête `x-client-transaction-id`, et ses `queryId` GraphQL sont périmés : X répond 404. Le lanceur charge la page avec les cookies (frontend connecté), prépare le cache que twitter-cli relit, récupère des `queryId` à jour (bundles du frontend connecté, puis fichier communautaire fa0311/twitter-openapi, puis ceux du paquet) et les essaie en GET puis en POST. Il retient la combinaison qui marche (ou l'échec total) 50 min, pour ne pas multiplier les requêtes. `python scripts/x_twitter.py --diagnose` affiche l'état, sans les cookies.
- **Secours gratuit, sans clé (`lib/paper/x_free.mjs`), collecté à chaque cycle en complément de X et seul quand X échoue :** ε ← flux RSS CoinDesk, Cointelegraph, Decrypt, Réserve fédérale et OilPrice (articles citant nos tickers, poids 0,6) ; ∞ ← API arXiv (`cat:q-fin.TR OR cat:q-fin.PM OR cat:q-fin.ST`, 40 derniers articles), restreinte aux sujets testables (facteurs, GARCH, arbitrage statistique, microstructure, momentum, volatilité, crypto, ML), abstracts conservés 21 jours (le flux couvre ~3 semaines) et traduits en Blueprints comme les threads X, au seuil d'intérêt 60/100 (75 pour X) ; chaque échec, rejet du validateur ou réponse `{"none":true}` est tracé dans `x.notes`.
- **Tri :** spams écartés (airdrop, giveaway, whitelist, liens Telegram ou de parrainage), doublons textuels supprimés, poids = crédibilité du compte (liste de référence `X_TIER1`, 1 contre 0,35) × engagement. Cache de 24 h dans `x_cache.json` (non publié).
- **Flux ε (demi-vie < 4 h) :** posts qui citent un ticker suivi (`BTC`, `ETH`, `SOL`, `HYPE`, `ZEC`, `NVDA`, `SOXL`, `BRENTOIL`) avec un catalyseur, ou venant d'un compte de référence. Par ticker : `mentionVelocityRatio` (mentions pondérées de la dernière heure contre la moyenne horaire des 23 h précédentes), `netNarrativeBias` (−1 à +1), `squeezeWarning` (vélocité ≥ 2,2×, biais > 0,35 et au moins 3 mentions dans l'heure), 3 meilleurs catalyseurs. Les signaux encore actifs sont ajoutés au dossier des votants et de l'arbitre (`x_epsilon`) avec deux consignes : pas de vote `OPEN` sur un SHORT en alerte de squeeze sans métrique technique contraire, pas de vote `CLOSE` avant 8 h (délai appliqué aussi par le code, §4.3).
- **Flux ∞ :** threads quant/ML (au moins 2 termes du vocabulaire quant). Score d'intérêt 0–100 ; à partir de 75, `gpt-oss-120b` (puis `qwen3.8`) traduit le post en **Blueprint** JSON déclaratif : blocs `momentum`, `rsi`, `bollinger_zscore`, `atr_breakout`, `volatility_regime`, `x_velocity_bias`, `polymarket_edge`, `linear_ml_score`, chacun avec des paramètres numériques bornés, une pondération, un seuil d'entrée et des sorties en ATR. Tout champ inconnu ou valeur hors bornes invalide le Blueprint ; rien n'est jamais évalué comme du code. 3 traductions au plus par cycle, statut initial « En attente D1 ».
- **Page « X Alpha (ε / ∞) » (`public/views6.js`) :** radar ε (durée de vie restante, vélocité, biais, alerte de squeeze, transmission aux votants), bibliothèque ∞ (Blueprint, auteur, statut), emplacement réservé aux 3 Ligues. Fichier publié : `x_alpha.json`.

### 4.5 Compétition à 3 divisions et meta-ensemble (`synthetic_market.mjs`, `blueprint_eval.mjs`, `league_engine.mjs`)
- **Compilation des Blueprints :** `qwen/qwen3.8-27b` puis `openai/gpt-oss-120b` ; la réponse est normalisée (`coerceBlueprint` : alias de blocs et de tickers, bornes, champs inconnus retirés) avant la validation stricte. Elle tourne à chaque cycle, collecte X neuve ou réutilisée ; 3 par cycle, 6 tant que la bibliothèque est vide.
- **Évaluateur commun :** score d'un Blueprint = moyenne pondérée des signaux de ses blocs (−1 à +1), `volatility_regime` servant de filtre ; carnet à une position par ticker, risque de 1 % au stop (`stop_atr` × ATR), objectif `take_profit_atr` × ATR, durée maximale, sortie sur signal contraire, frais 0,035 % et glissement 3 pb par côté. Le même code sert au labo et au live.
- **D1 `L1_SYNTHETIC_LAB` :** `runSyntheticBenchmark(blueprint, 5)` : 5 scénarios de 500 barres horaires (mêmes graines pour tous), GJR-GARCH(1,1) (α 0,07, γ 0,10, β 0,80), sauts de Poisson (krachs, short squeezes en tendance baissière), 4 régimes cachés dont une crise imposée par scénario, séries cohérentes de funding, vélocité et biais X, cote Polymarket légèrement en avance. Retourne `profitFactor`, `winRate`, `psr` (trades poolés), `maxDrawdown` (médiane), `sharpe`, `stressSurvivalRate` (part des scénarios finis avec un drawdown ≤ 15 % et ≥ 90 % du capital). Promotion : PF ≥ 1,25, DD ≤ 12 %, survie ≥ 80 %, ≥ 25 trades. Mutation `Gen-2` toutes les 24 h : `gemma-4-26b-a4b-it` fusionne les 2 meilleurs survivants, l'hybride repasse par D1.
- **D2 `L2_LIVE_SHADOW` (6 places) :** paramètres gelés, 10 000 $ virtuels, une barre par cycle sur les vrais prix horaires (`league_market.json` : prix mark, funding, flux ε, mouvement de cote Polymarket ; amorçage par 21 jours de bougies 1 h d'Hyperliquid). Promotion en D3 : ≥ 15 trades clos, PSR ≥ 0,75, PF ≥ 1,30, corrélation des rendements < 0,60 avec chaque champion. Relégation : au-delà de 20 trades, PSR < 0,35 ou drawdown > 15 %.
- **D3 `D3_MAIN_ENSEMBLE` (3 places) :** coupe-circuit si drawdown depuis l'entrée en D3 > 8 % ou PSR glissant (20 derniers trades) < 0,50 : retour immédiat en D2, pas de nouvelle promotion pendant 72 h.
- **Meta-ensemble (`router.mjs`) :** LLM 65 %, champions de D3 35 % au prorata de PSR × orthogonalité (jusqu'à +50 % pour un champion qui penche contre le biais directionnel net du portefeuille). Sur une ouverture Hyperliquid à un seul actif couvert par des champions : conviction = w_LLM × conviction des LLM + w_D3 × (50 + 50 × accord des champions) ; sous 60, l'ouverture est écartée. Sans champion : 100 % LLM. Les garde-fous de `risk.mjs` s'appliquent ensuite inchangés.
- **Page X Alpha :** « 3-League Strategy Arena » (pipeline D1 → D2 → D3, courbes d'équité face à 0xHarpoon Main, tableaux par division, poids dans le meta-ensemble). Fichier publié : `leagues.json`.
---

### 4.5 bis Carnet permanent des stratégies (`strategy_ledger.json`, page `ledger.html`)
- **Statistiques D1 figées :** à l'évaluation au labo, `d1Stats` (`trades`, `profitFactor`, `winRate`, `maxDrawdown`, `sharpe`, `psr`, `stressSurvivalRate`, `evaluatedAt`) est copié sur la stratégie et n'est plus jamais réécrit, après la promotion en D2 puis D3 comme après une rétrogradation.
- **Carnet (`league_engine.updateLedger`, à chaque cycle) :** une fiche par stratégie testée, jamais supprimée (l'état des ligues, lui, ne garde que les 60 éliminées les plus récentes) : `id`, `name`, `family`, `generation`, `source` (X, arXiv, Mutation), `status` (`D1_PENDING`, `D1_QUALIFIED`, `D1_OUT`, `D2_ACTIVE`, `D2_OUT`, `D3_CHAMPION`, `D3_RELEGATED` = renvoyée de D3 en D2 par le coupe-circuit), `d1Stats`, `d2Stats` (bilan en cours, final après élimination), `d3Stats` (gardé après une rétrogradation), `dates` (`createdAt`, `evaluatedD1At`, `promotedD2At`, `promotedD3At`, `relegatedD3At`, `closedAt`, chacune écrite une fois), `exitReason`, `history` et le Blueprint complet. Initialisé au premier cycle avec les stratégies de l'état courant.
- **Publication :** `strategy_ledger.json` fait partie des fichiers publics (serveur local `/api/paper/`, GitHub Pages `paper/`) ; `scripts/snapshot.mjs --site` copie aussi `ledger.html` et `app.css`. La page autonome `ledger.html` (lien « Carnet complet des stratégies ↗ » dans l'en-tête de l'arène X Alpha, nouvel onglet) affiche 4 indicateurs, filtres, recherche, tri, un tableau de 6 colonnes paginé par 25 et la fiche complète au clic.

### 4.6 Méta-Agent de Régime Macro (`lib/paper/regime_agent.mjs`)
Au-dessus des ligues : les équations de D2/D3 sont les capteurs d'exécution, le méta-agent qualifie le régime et décide quelles familles de stratégies sont autorisées. Évalué à chaque cycle, avant les ligues et le vote, jamais bloquant.
- **Entrées :** calendrier économique live (`lib/alt.mjs`, ForexFactory, semaine en cours, relu au plus toutes les 60 min, dernière version gardée si la source tombe) ; événements critiques = impact « High », USD ou EUR, FOMC / taux Fed / BCE / CPI / NFP / PCE, dans la fenêtre −4 h / +2 h. Métriques de marché sur BTC, ETH, NVDA et BRENTOIL (prix horaires réels des ligues) : volatilité réalisée 24 h contre 7 jours, rendements 4 h / 24 h / 72 h, force de tendance, funding horaire Hyperliquid ; Flux ε (vélocité, biais, alertes de squeeze). Synthèse LLM par le meilleur votant actif du classement (`llm_ranking.mjs`), en cache 2 h, invalidée dès qu'un événement critique entre dans la fenêtre.
- **5 régimes, par priorité :** `RISK_OFF_CRASH` (BTC −6 % en 24 h ou −3,5 % en 4 h, ETH −8 % en 24 h) ; `MACRO_EVENT_STRESS` (événement critique dans la fenêtre, ou volatilité 24 h ≥ 2,2 × la normale sur BTC ou ETH) ; `SQUEEZE_CROWDED` (funding ≥ 0,01 %/h sur BTC ou ETH et vélocité haussière X ou hausse ≥ 4 %) ; `TREND_RISK_ON` (force de tendance ≥ 1,5, volatilité ≤ 1,6 × la normale) ; `RANGE_COMPRESSION` (volatilité ≤ 0,85 × la normale, pas de tendance ; régime par défaut). Les trois premiers cas « durs » sont déterministes ; ailleurs le LLM peut nuancer le régime s'il est sûr à 70 % au moins.
- **Familles de stratégies** (`blueprint.mjs`, `inferFamily`, déduites des règles et de leurs signes, jamais du LLM ; Blueprints déjà compilés typés au cycle suivant) : `trend_breakout`, `mean_reversion`, `stat_arb_leadlag`, `volatility_squeeze`, `defensive_hedge`.
- **Pilotage :** `MACRO_EVENT_STRESS` → seules `stat_arb_leadlag` et `defensive_hedge` restent actives ; `RANGE_COMPRESSION` → `mean_reversion` et `stat_arb_leadlag` × 1,25, `trend_breakout` × 0,5 ; `TREND_RISK_ON` et `SQUEEZE_CROWDED` → `trend_breakout` et `volatility_squeeze` × 1,25, `mean_reversion` interdite à contre-sens de la tendance 72 h ; `RISK_OFF_CRASH` → `trend_breakout` interdite à l'achat (Blueprints « long » : poids 0), `defensive_hedge` et `volatility_squeeze` × 1,25. En D2/D3, une famille coupée n'ouvre plus de position (stops et sorties continuent) ; dans le meta-ensemble, le poids d'un champion est multiplié par celui de sa famille (0 = coupé ; tous coupés : LLM à 100 %) et ses signaux à contre-régime sont écartés.
- **Risque :** en `MACRO_EVENT_STRESS` et `RISK_OFF_CRASH`, taille de toute nouvelle position × 0,5 (appliquée après les plafonds) et conviction minimale relevée de 60 à 70 (moteur de risque et meta-ensemble). Les votants reçoivent le régime (`macro_regime`) et ces règles.
- **Publication :** `metrics.json` et `x_alpha.json` (champ `regime`) ; bandeau sous les indicateurs de Paper trading et de X Alpha : régime, prochain événement critique avec compte à rebours, familles autorisées et coupées. Cache non publié : `regime_cache.json`.

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
- **Implémentation (`lib/paper/metrics.mjs`, `shadow.mjs`) :**
  - Rendements quotidiens (dernier point de chaque jour UTC), annualisation sur 365 jours ; drawdown max sur tous les points horaires ; pas de rendement annualisé ni de Calmar avant 7 jours d'historique.
  - Trade terminé = fermeture complète ou résolution Polymarket ; espérance et profit factor sur le résultat net (frais et funding compris).
  - Brier : la conviction retenue (0 – 100) est lue comme la probabilité que le pari gagne, comparée au Brier du prix payé ($\text{skill} = \text{Brier}_{\text{marché}} - \text{Brier}_{\text{agent}}$). Marchés résolus seulement.
  - Références : chaque point de la courbe porte les prix de BTC et de `xyz:GOLD` ; achat-conservation BTC et panier 50/50 sans rééquilibrage, depuis le premier point qui a les deux prix.
  - PnL contrefactuel : chaque vote `OPEN` valide ouvre une position fantôme pour son modèle (`paper/shadow_book.json`), mesurée en R (multiple du risque) pour ne pas dépendre des plafonds : Hyperliquid, rendement / distance du stop (2 × ATR), sortie à −1 R ou à l'horizon voté ; Polymarket, $R = (\text{sortie} - \text{entrée})/\text{entrée}$ à la résolution ou à l'horizon. Équivalent en dollars : 1 R = 1 % du capital de départ.
  - Synthèse recalculée à chaque cycle dans `paper/metrics.json` ; `significant` passe à `true` à 30 trades terminés.

---

## 8. Arborescence Cible du Dépôt
Le terminal existant reste en place ; l'agent s'ajoute dans `lib/paper/`. Aucune dépendance npm ; tests avec `node --test`.

```text
/
├── SPEC.md, PROGRESS.md
├── server.mjs                    # inchangé (route /api/paper en local)
├── .github/workflows/
│   ├── update.yml                # existant : collecte + Pages (copie data/paper → site/paper)
│   └── trading_loop.yml          # nouveau : horaire (cron-job.org, :10), même groupe de concurrence, pousse sur state
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
    ├── candidates.json, metrics.json, shadow_book.json, market_history.json
    └── border_proposals.json     # copié depuis la branche border à chaque cycle

Branche border (écrite par la tâche Claude 3-4×/jour)
└── border_proposals.json
```

Fichiers publiés sur le site (`site/paper/`, route locale `/api/paper/…`) : liste fermée `PUBLIC_PAPER_FILES` de `lib/paper/store.mjs` (jamais `whale_scores.json` ni `market_history.json`).
