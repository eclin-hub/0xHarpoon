<div align="center">

<br/>

```text
  ██████╗ ██╗  ██╗██╗  ██╗ █████╗ ██████╗ ██████╗  ██████╗  ██████╗ ███╗   ██╗
 ██╔═████╗╚██╗██╔╝██║  ██║██╔══██╗██╔══██╗██╔══██╗██╔═══██╗██╔═══██╗████╗  ██║
 ██║██╔██║ ╚███╔╝ ███████║███████║██████╔╝██████╔╝██║   ██║██║   ██║██╔██╗ ██║
 ████╔╝██║ ██╔██╗ ██╔══██║██╔══██║██╔══██╗██╔═══╝ ██║   ██║██║   ██║██║╚██╗██║
 ╚██████╔╝██╔╝ ██╗██║  ██║██║  ██║██║  ██║██║     ╚██████╔╝╚██████╔╝██║ ╚████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝      ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝
```

**`[`** `SYSTEM: ACTIVE` **`]`** &nbsp; **`[`** `ARCHITECTURE: ZERO-DEPENDENCY` **`]`** &nbsp; **`[`** `ENGINE: REAL-TIME QUANT & OSINT` **`]`**

<h3>Cross-Market Quantitative Intelligence & Institutional Order-Flow Terminal</h3>

<p>
  <em>Synthesizing decentralized order books, prediction market probabilities, central bank liquidity, derivatives skew, and geopolitical catalysts inside a single zero-latency cockpit.</em>
</p>

<p>
  <a href="https://github.com/eclin-hub/0xHarpoon">
    <img src="https://img.shields.io/badge/RUNTIME-NODE.JS_20%2B-090C10?style=for-the-badge&logo=node.js&logoColor=10B981" alt="Node.js 20+">
  </a>
  <a href="https://github.com/eclin-hub/0xHarpoon">
    <img src="https://img.shields.io/badge/DEPENDENCIES-0_EXTERNAL_PACKAGES-090C10?style=for-the-badge&logo=files&logoColor=3B82F6" alt="Zero Dependencies">
  </a>
  <a href="https://github.com/eclin-hub/0xHarpoon">
    <img src="https://img.shields.io/badge/QUANT_ENGINE-RMT_%7C_KALMAN_%7C_GARCH-090C10?style=for-the-badge&logo=chartdotjs&logoColor=8B5CF6" alt="Quant Engine">
  </a>
  <a href="https://github.com/eclin-hub/0xHarpoon">
    <img src="https://img.shields.io/badge/DATA_STREAMS-15%2B_LIVE_FEEDS-090C10?style=for-the-badge&logo=rss&logoColor=F59E0B" alt="15+ Live Feeds">
  </a>
</p>

<br/>

</div>

---

## 01 // EXECUTIVE THESIS

Institutional trading desks and macro researchers face a structural bottleneck: **severe data fragmentation**. Reconciling on-chain perpetual positioning, prediction market probability shifts, derivatives skew, central bank net liquidity, and geopolitical risk typically requires switching across dozens of disconnected terminals.

**0xHarpoon** (Est. 2026) solves this by unifying multi-asset surveillance and econometric modeling into a single, sovereign software artifact:

* **Zero External Dependencies (`0 npm packages`)** — Built purely on native Node.js 20+ primitives, HTML5 Canvas, WebGL/D3.js, and Server-Sent Events (SSE). Immune to supply-chain bloat or dependency rot.
* **Dual-Speed Ingestion Engine** — Combines sub-minute browser polling for live order books and whale executions with automated background batch pipelines for macro, CFTC filings, and options surfaces.
* **Embedded Quantitative Research Lab (`Quant Vault`)** — Transitions seamlessly into a browser-native econometrics suite implementing Random Matrix Theory (Marchenko-Pastur), Kalman state-space filtering, and stochastic jump-diffusion modeling without server round-trips.

---

## 02 // SYSTEM ARCHITECTURE & DATA TOPOLOGY

```text
╔════════════════════════════════════════════════════════════════════════════════════════╗
║                             0xHARPOON INGESTION & COMPUTE PIPELINE                     ║
╚════════════════════════════════════════════════════════════════════════════════════════╝

  [ HIGH-FREQUENCY BROWSER LAYER ]                  [ ASYNCHRONOUS SERVER / BATCH LAYER ]
  ┌──────────────────────────────┐                  ┌───────────────────────────────────┐
  │ • Hyperliquid L1 & HIP-3     │ (15s - 45s)      │ • FRED (Yield Curve / Net Liq)    │
  │ • Polymarket Whale Tape      │ (30s)            │ • CFTC COT Reports (3Y Percentiles)│
  │ • Liquidation Heatmaps       │ (Live SSE)       │ • Deribit Options (IV / Max Pain) │
  │ • Geopolitical OSINT & News  │ (On-Demand)      │ • USGS Seismic & World Bank APIs  │
  └──────────────┬───────────────┘                  └─────────────────┬─────────────────┘
                 │                                                    │
                 ▼                                                    ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │                       RATE-LIMITED QUEUE & NORMALIZATION ENGINE                     │
  │        (Exponential Backoff • 45s Stale-While-Revalidate Cache • Cohort Scoring)    │
  └──────────────────────────────────────────┬──────────────────────────────────────────┘
                                             │
                 ┌───────────────────────────┴───────────────────────────┐
                 ▼                                                       ▼
  ┌─────────────────────────────┐                         ┌─────────────────────────────┐
  │   18 SURVEILLANCE MODULES   │                         │      🔒 QUANT VAULT LAB     │
  │  • Cross-Asset Conviction   │                         │  • Marchenko-Pastur RMT     │
  │  • Edge & Divergence Alerts │                         │  • Kalman Dynamic Betas     │
  │  • 3D Geopolitical Globe    │                         │  • Factor-GJR-GARCH / GRS   │
  └─────────────────────────────┘                         └─────────────────────────────┘
```

---

## 03 // LIVE DATA MATRIX (15+ REAL-TIME STREAMS)

Every data source integrated into **0xHarpoon** uses public institutional or decentralized endpoints with zero mandatory API keys required out of the box:

| Domain | Source / Endpoint | Refresh Cadence | Extracted Signal & Analytical Purpose |
| :--- | :--- | :---: | :--- |
| **Perpetual DEX** | `Hyperliquid Mainnet & HIP-3` | `15s – 45s` | Top-100 smart-money cohort positions, funding rates, open interest, liquidation clusters (Crypto, Gold, Oil, Indices). |
| **Prediction Markets** | `Polymarket Gamma & Data API` | `30s – 90s` | Whale Tape (`>$10k` single fills), multi-whale convergence alerts, implied macro/political probabilities. |
| **Derivatives & Vol** | `Deribit Public API` | `15m` | Implied Volatility (IV) term structure, Put/Call ratios, $25\Delta$ Put–Call skew, options Max Pain levels. |
| **Institutional Flow** | `CFTC Commitments of Traders` | `15m` | Leveraged fund positioning across US equity, rates, FX, and commodity futures normalized to 3-year percentiles. |
| **Macro Liquidity** | `Federal Reserve (FRED)` | `15m` | Treasury yield curve ($10\text{Y}-2\text{Y}$), Fed Net Liquidity (`WALCL - TGA - RRP`), inflation breakevens, credit spreads. |
| **Geopolitics & OSINT** | `USGS / World Bank / News` | `15m / Live` | 25 monitored geopolitical flashpoints, live seismic telemetry, macro calendar (`ForexFactory`), Telegram & social feeds. |
| **Sentiment Proxies** | `DefiLlama / Wiki / AppStore` | `15m` | Stablecoin net inflows, retail attention spikes (Wikipedia pageviews, finance app rankings), Fear & Greed index. |

### Smart-Money Cohort Filtering (`lib/hl.mjs`)
To isolate genuine alpha from market-making noise, Hyperliquid accounts are algorithmically filtered (`Equity >= $500k`, active within 7 days, positive monthly and all-time PnL, monthly turnover `< 300x` equity) and ranked via a composite factor score:

$$\text{Score}_i = 0.30 \cdot \text{PnL}_{1\text{M}} + 0.20 \cdot \text{PnL}_{\text{All}} + 0.25 \cdot \text{ROI}_{1\text{M}} + 0.25 \cdot \text{Equity}_i$$

---

## 04 // 🔒 QUANT VAULT: EMBEDDED ECONOMETRICS LAB

Clicking **`🔒 QUANT VAULT`** inside the navigation bar mounts an isolated 11-module quantitative research environment directly in browser memory—preserving live telemetry streams in the background.

<table>
  <tr>
    <th width="28%">Module Suite</th>
    <th width="72%">Quantitative Methodology & Implementation</th>
  </tr>
  <tr>
    <td><strong>01–07 // Risk & Topology</strong></td>
    <td>
      • <strong>Capital-to-CVaR Sankey:</strong> Multi-stage risk attribution flow from capital allocation to factor exposure.<br/>
      • <strong>3D Efficient Frontier & Robustness Surface:</strong> WebGL/Canvas rendering of mean-variance manifolds under parameter perturbation.<br/>
      • <strong>Minimum Spanning Tree (MST):</strong> Graph-theoretic asset contagion topology via Mantegna distance $d_{ij} = \sqrt{2(1 - \rho_{ij})}$.<br/>
      • <strong>Bates Jump-Diffusion & Conditional Beta:</strong> Stochastic volatility cones with Poisson jumps and regime-switching beta surfaces.
    </td>
  </tr>
  <tr>
    <td><strong>08–10 // Econometric Lab</strong></td>
    <td>
      • <strong>State-Space Kalman Filter:</strong> Time-varying factor loadings $\beta_t$ and latent dynamic factor extraction.<br/>
      • <strong>Asset Pricing Tests:</strong> Two-pass Fama-MacBeth regressions with Newey-West HAC standard errors and Gibbons-Ross-Shanken (GRS) joint alpha tests.<br/>
      • <strong>Asymmetric Volatility & Backtesting:</strong> Factor-GJR-GARCH conditional variance modeling and Kupiec POF VaR coverage tests (CSV/JSON export).
    </td>
  </tr>
  <tr>
    <td><strong>11 // Hidden Factor RMT</strong></td>
    <td>
      • Strips known market/sector factors via OLS regression, then denoises the residual covariance matrix using <strong>Marchenko-Pastur</strong> Random Matrix Theory eigenvalue clipping or <strong>Ledoit-Wolf</strong> shrinkage.<br/>
      • Isolates latent alpha clusters and unhedged portfolio variance on either synthetic data or <strong>live Hyperliquid return series</strong>.
    </td>
  </tr>
</table>

---

## 05 // TERMINAL MODULES (18 VIEWS)

```text
├── SYNTHESIS
│   ├── Dashboard          Global sentiment gauge, cross-asset conviction scores, setup radar
│   ├── Asset Directions   Multi-factor synthesis for BTC, ETH, SOL, SPX, NDX, Gold, Oil, DXY
│   └── Edge Signals       Cross-venue divergence detection & alternative sentiment thermometers
├── WORLD & GEOPOLITICS
│   ├── 3D Interactive Globe   25 tension flashpoints, live USGS earthquakes, country intelligence drawers
│   ├── Intelligence Wire      Real-time news tagged by macro theme and impacted ticker
│   └── Prediction Odds        Polymarket political, economic, and geopolitical probability movers
├── INSTITUTIONAL & MACRO
│   ├── Macro Regime       Yield curve dynamics, net liquidity impulse, inflation & credit regimes
│   ├── Hedge Funds (COT)  CFTC leveraged positioning with 3-year historical percentile bands
│   └── Options Surface    Deribit implied volatility, put/call skew, and expiry max-pain magnets
└── WHALE SURVEILLANCE
    ├── Whale Tape         Real-time >$10k Polymarket fills + Hyperliquid cohort executions & convergences
    ├── Account Inspector  Deep-dive portfolio breakdown, realized/unrealized PnL, 7-day trade history
    └── Risk Tools         Live liquidation maps, funding/OI term structure, position sizing calculator
```

---

## 06 // QUICKSTART & DEPLOYMENT

### Local Execution (Full Live Mode)
Requires **Node.js 20+**. No `npm install` or build step required.

```bash
git clone https://github.com/eclin-hub/0xHarpoon.git
cd 0xHarpoon
node server.mjs
```

Open **`http://localhost:8787`** in your browser. State and historical snapshots persist locally in `data/`.

| Environment Variable | Default | Description |
| :--- | :---: | :--- |
| `PORT` | `8787` | Local HTTP/SSE server listening port. |
| `HL_COHORT` | `100` | Number of top-ranked Hyperliquid smart-money accounts tracked. |
| `REFRESH_SCALE` | `1.0` | Polling interval multiplier (`0.5` = 2x faster live updates). |
| `X_BEARER_TOKEN` | *Optional* | Official X API v2 token (or `TWITTERAPI_IO_KEY` / `X_RSS_BASE`) for social wire ingestion. |

### Serverless Deployment (GitHub Pages + Actions)
**0xHarpoon** includes a pre-configured `.github/workflows/update.yml` pipeline to run headlessly for free:
1. Push repository to GitHub (public repo) and set **Settings → Pages → Source** to `GitHub Actions`.
2. Grant **Read and write permissions** under **Settings → Actions → General → Workflow permissions**.
3. Trigger **`Mise à jour des données`** in the **Actions** tab. GitHub will execute `scripts/snapshot.mjs` every 15 minutes and persist historical state to the `state` branch.

---

<div align="center">

**0xHarpoon** — *Built for quantitative transparency, cross-market synthesis, and zero-dependency resilience.*

</div>
