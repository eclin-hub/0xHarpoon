<div align="center">

```text
   ___        _   _                                    
  / _ \ __  _| | | | __ _ _ __ _ __   ___   ___  _ __  
 | | | |\ \/ / |_| |/ _` | '__| '_ \ / _ \ / _ \| '_ \ 
 | |_| | >  <|  _  | (_| | |  | |_) | (_) | (_) | | | |
  \___/ /_/\_\_| |_|\__,_|_|  | .__/ \___/ \___/|_| |_|
                              |_|                      
```

# 🔱 0xHarpoon

### Terminal d'Intelligence Quantitative & Surveillance Multi-Marchés en Temps Réel
*Suivi des baleines, analyse des flux d'ordres institutionnels et modélisation factorielle prédictive.*

[![Architecture](https://img.shields.io/badge/Architecture-Zero--Dependency_Node.js-10b981?style=for-the-badge)]()
[![Edition](https://img.shields.io/badge/Édition-2026_Quantitative_Suite-3b82f6?style=for-the-badge)]()
[![Data](https://img.shields.io/badge/Flux-Temps_Réel_&_SSE-f59e0b?style=for-the-badge)]()

---

</div>

## 🧭 Qu'est-ce que 0xHarpoon ?

**0xHarpoon** est un terminal de recherche quantitative et de surveillance de marché conçu en **2026** pour unifier en un seul cockpit haute vitesse l'ensemble des flux financiers majeurs. 

Là où les traders doivent habituellement jongler entre des dizaines d'onglets (carnets d'ordres crypto, marchés de prédiction, rapports macroéconomiques, calendriers financiers, flux d'actualités et modèles mathématiques), **0xHarpoon** agrège, croise et pondère ces sources en continu sans aucune dépendance externe lourde.

---

## 🌐 Ce que 0xHarpoon regroupe en temps réel

Le moteur du terminal fusionne **plus de 15 sources de données institutionnelles, on-chain et alternatives** à travers 18 vues analytiques spécialisées :

### 1. 🐋 Surveillance des Baleines & Flux On-Chain (Hyperliquid & Polymarket)
* **Cohorte Élite Hyperliquid :** Filtrage algorithmique en temps réel des 100 portefeuilles les plus performants ($> 500\text{ k\$}$ de capital, excluant le bruit des market makers) pour suivre leurs positions exactes sur les cryptos majeures et les actifs synthétiques (Or, Pétrole, Indices).
* **Whale Tape & Inspecteur Polymarket :** Détection instantanée toutes les 30 secondes des paris à forte conviction ($\ge 10\text{ k\$}$ jusqu'à $100\text{ k\$}+$), calcul des convergences multi-baleines sur une même issue, et audit détaillé de chaque portefeuille (PnL latent/réalisé, concentration, historique sur 7 jours).
* **Microstructure & Liquidations :** Suivi toutes les 15 à 20 secondes des prix, taux de financement (*funding rates*), *Open Interest* et carte thermique des niveaux de liquidation.

### 2. 🏛️ Données Institutionnelles & Macroéconomie
* **Régime Macroéconomique (FRED & Réserve Fédérale) :** Surveillance en continu de la courbe des taux, de la liquidité nette globale, des anticipations d'inflation, de l'emploi et des spreads de crédit.
* **Positionnement des Hedge Funds (CFTC) :** Analyse des rapports *Commitments of Traders* sur les contrats à terme américains avec calcul des centiles historiques sur 3 ans.
* **Marché des Options (Deribit) :** Volatilité implicite, ratio Puts/Calls, asymétrie (*skew* put − call) et calcul automatique du *Max Pain*.

### 3. 🌍 Géopolitique, Actualités & Thermomètres Alternatifs
* **Globe 3D Interactif :** Cartographie dynamique de 25 foyers de tension géopolitique mondiaux (base éditoriale 2026), flux sismiques en direct (USGS) et dépêches localisées par pays.
* **Synthèse Directionnelle & Signaux d'Edge :** Moteur de décision pondérant automatiquement tendance, baleines, options et macro pour dégager un biais clair sur **BTC, ETH, SOL, S&P 500, Nasdaq, Or, Pétrole et Dollar (DXY)**.
* **Indicateurs Alternatifs :** Indice Peur & Avidité, flux de liquidité des stablecoins (DefiLlama), tendances grand public (Wikipedia, classements App Store) et calendrier économique haute fréquence (ForexFactory).

### 4. 🔒 Quant Vault (Laboratoire de Recherche Quantitative)
Accessible en un clic sans rechargement, cet espace intègre un moteur mathématique et graphique 3D sur mesure :
* **Gestion du Risque & Portefeuille (Outils 1 à 7) :** Flux Sankey Capital $\rightarrow$ Facteurs $\rightarrow$ CVaR, frontière efficiente 3D, paysages de robustesse, arbres couvrants minimaux (contagion), cônes de diffusion à sauts (modèle de Bates) et surfaces de bêta conditionnel.
* **Extraction de Facteurs Cachés (Outil 11) :** Régression des facteurs évidents, débruitage de matrices de covariance (Marchenko-Pastur & Ledoit-Wolf) et analyse en composantes principales (ACP) sur données simulées ou cours réels Hyperliquid.
* **Économétrie Avancée (Outils 8 à 10) :** Filtre de Kalman dynamique, régressions Fama-MacBeth avec correction Newey-West, tests GRS, modèles Factor-GJR-GARCH et backtesting de VaR (Kupiec).

---

## 🏗️ Architecture du Système

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         SOURCES DE DONNÉES EN DIRECT                    │
│  Hyperliquid API • Polymarket Gamma • FRED • CFTC • Deribit • USGS/News │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│     SERVEUR LOCAL (Node.js)     │     │    COLLECTE CLOUD (GitHub)      │
│  • Agrégation mémoire & disque  │     │  • Actions toutes les 10-20 min │
│  • Flux temps réel SSE (/events)│     │  • Sauvegarde branche 'state'   │
└────────────────┬────────────────┘     └────────────────┬────────────────┘
                 │                                       │
                 └───────────────────┬───────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     INTERFACE CLIENT (Vanilla JS & D3)                  │
│  • Mise à jour directe navigateur (15s - 45s)                           │
│  • Moteur mathématique & rendu 3D Canvas (Quant Vault)                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 💻 Lancer 0xHarpoon sur son propre PC

Le projet est conçu sans aucune dépendance externe (`node_modules` inutile) pour démarrer instantanément sur n'importe quelle machine disposant de **Node.js 20 ou supérieur**.

### 1. Cloner le dépôt et démarrer le serveur
Ouvrez votre terminal et exécutez les commandes suivantes :

```bash
git clone https://github.com/eclin-hub/0xHarpoon.git
cd 0xHarpoon
node server.mjs
```

### 2. Accéder au terminal
Une fois le serveur lancé, ouvrez simplement votre navigateur à l'adresse :
👉 **[http://localhost:8787](http://localhost:8787)**

> *Note : L'historique des positions et le flux d'activité sont automatiquement sauvegardés dans le dossier local `data/` et survivent au redémarrage de votre ordinateur.*

### 3. Personnalisation avancée (Optionnel)
Vous pouvez ajuster la puissance de collecte locale via des variables d'environnement au lancement :

```bash
# Exemple : doublage de la vitesse de rafraîchissement et suivi de 150 baleines
PORT=8787 HL_COHORT=150 REFRESH_SCALE=0.5 node server.mjs
```

---

## 📁 Structure du Projet

* `server.mjs` — Serveur HTTP natif, gestionnaire de cache et diffuseur temps réel SSE.
* `lib/` — Connecteurs d'ingestion de données (`hl.mjs`, `pm.mjs`, `macro.mjs`, `odds.mjs`, `world.mjs`, `synth.mjs`...).
* `public/` — Interface utilisateur complète, vues analytiques (`views1.js` à `views4.js`) et moteurs en direct (`live.js`, `tape.js`, `globe.js`).
* `public/q-*.js` — Suite mathématique et rendu 3D du laboratoire **Quant Vault** (`q-model.js`, `q-canvas.js`, `q-hidden.js`, `q-thesis.js`).
* `scripts/snapshot.mjs` — Générateur d'instantanés autonomes (`dist/snapshot.html`).

---

<div align="center">
  <sub>Conçu pour l'analyse quantitative et l'observation des microstructures de marché. Ne constitue pas un conseil en investissement.</sub>
</div>
