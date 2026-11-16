<div align="center">

<!-- Dark-Mode Terminal Hero Banner via Capsule Render -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:090d16,50:111827,100:0ea5e9&height=210&section=header&text=0xHarpoon&fontSize=72&fontColor=f8fafc&animation=fadeIn&fontAlignY=38&desc=Quantitative%20Intelligence%20%26%20Cross-Market%20Surveillance%20Terminal&descAlignY=62&descSize=18&descColor=38bdf8" width="100%" alt="0xHarpoon Banner" />

<p align="center">
  <a href="https://github.com/eclin-hub/0xHarpoon">
    <img src="https://img.shields.io/badge/Architecture-Zero--Dependency_Node.js-0f172a?style=for-the-badge&logo=node.js&logoColor=38bdf8" alt="Node.js" />
  </a>
  <a href="#-quant-vault-research-laboratory">
    <img src="https://img.shields.io/badge/Quant_Engine-Kalman_%7C_GJR--GARCH_%7C_RMT-0f172a?style=for-the-badge&logo=wolframmathematica&logoColor=10b981" alt="Quant Engine" />
  </a>
  <a href="#-real-time-data-ingestion-matrix">
    <img src="https://img.shields.io/badge/Live_Feeds-15%2B_Institutional_%26_On--Chain-0f172a?style=for-the-badge&logo=databricks&logoColor=f59e0b" alt="Live Feeds" />
  </a>
  <a href="#-local-deployment">
    <img src="https://img.shields.io/badge/Build-2026_Edition-0f172a?style=for-the-badge&logo=github&logoColor=e2e8f0" alt="2026 Edition" />
  </a>
</p>

<br />

> **An institutional-grade, zero-dependency quantitative terminal engineered in 2026.**  
> Unifying real-time on-chain whale order flow, prediction market probabilities, macroeconomic regimes, CFTC hedge fund positioning, and a 3D econometric research laboratory into a single low-latency interface.

</div>

<br />

---

## 🎯 Executive Summary

Modern quantitative trading and macro research suffer from severe data fragmentation. Analysts routinely switch across dozens of isolated terminals to reconcile on-chain order books, prediction market odds, derivatives skew, central bank liquidity, and geopolitical catalysts.

**0xHarpoon** eliminates this friction. Built from the ground up with **zero external runtime dependencies**, it operates as a self-contained analytical cockpit that ingests, normalizes, and cross-correlates **15+ live financial, on-chain, and geopolitical data streams** in real time—paired with an embedded **Quantitative Research Laboratory (Quant Vault)** capable of running Random Matrix Theory denoising, Kalman filtering, and stochastic jump-diffusion simulations directly in the browser.

---

## ⚡ Real-Time Data Ingestion Matrix

0xHarpoon synthesizes market microstructure, institutional filings, and alternative data across **18 specialized analytical views**:

<table>
  <thead>
    <tr>
      <th width="22%">Domain</th>
      <th width="38%">Data Sources & APIs</th>
      <th width="40%">Analytical Output & Cadence</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>🐋 On-Chain Whales</strong><br><em>(Hyperliquid DEX)</em></td>
      <td><code>stats-data.hyperliquid.xyz</code><br><code>api.hyperliquid.xyz/info</code> (Mainnet + HIP-3)</td>
      <td>Algorithmic cohort filtering of the <strong>Top 100 profitable wallets</strong> (&gt;$500k equity, market-maker noise stripped). Live position deltas, funding rates, OI, and liquidation heatmaps every <strong>15s–45s</strong>.</td>
    </tr>
    <tr>
      <td><strong>🎲 Prediction Markets</strong><br><em>(Polymarket)</em></td>
      <td><code>data-api.polymarket.com</code><br>Polymarket Gamma CLOB</td>
      <td><strong>Whale Tape</strong> capturing high-conviction blocks (&ge;$10k to $100k+) every <strong>30s</strong>, multi-whale convergence alerts, and full wallet forensics (unrealized/realized PnL, 7d flow, concentration).</td>
    </tr>
    <tr>
      <td><strong>🏛️ Institutional & Macro</strong><br><em>(FRED, CFTC, Deribit)</em></td>
      <td>Federal Reserve (FRED), CFTC COT Reports, Deribit Options API</td>
      <td>Yield curve dynamics, net USD liquidity, credit spreads, 3-year CFTC hedge fund positioning percentiles, implied volatility, Put/Call skew, and automated <strong>Max Pain</strong> calculation.</td>
    </tr>
    <tr>
      <td><strong>🌍 Geopolitics & Alt-Data</strong><br><em>(USGS, News, DeFiLlama)</em></td>
      <td>USGS Seismic Feed, ForexFactory, Google News, DeFiLlama, Alternative.me</td>
      <td>Interactive <strong>3D Geopolitical Globe</strong> tracking 25 global flashpoints (2026 editorial baseline), live seismic events, stablecoin liquidity velocity, and high-frequency economic calendars.</td>
    </tr>
    <tr>
      <td><strong>🧭 Cross-Asset Synthesis</strong><br><em>(Proprietary Engine)</em></td>
      <td>Multi-factor weighted scoring across all ingested pipelines</td>
      <td>Automated directional bias and anomaly ("Edge") detection across <strong>BTC, ETH, SOL, S&amp;P 500, Nasdaq, Gold, Crude Oil, and DXY</strong>.</td>
    </tr>
  </tbody>
</table>

---

## 🔬 Quant Vault: Embedded Econometric & 3D Research Lab

Toggled instantaneously without page reload via the **`🔒 QUANT VAULT`** switch, this module serves as a self-contained quantitative research environment featuring custom mathematical engines (`q-model.js`) and hardware-accelerated 3D rendering (`q-canvas.js`).

```text
+---------------------------------------------------------------------------------------------------+
|                                   QUANT VAULT ARCHITECTURE                                        |
+---------------------------------+---------------------------------+-------------------------------+
|   PORTFOLIO & RISK TOPOLOGY     |     HIDDEN FACTOR EXTRACTION    |     ECONOMETRIC THESIS LAB    |
|          (Tools 1 - 7)          |            (Tool 11)            |         (Tools 8 - 10)        |
+---------------------------------+---------------------------------+-------------------------------+
| • Capital -> Factor -> CVaR     | • Orthogonal Regression of      | • Dynamic Factor Models via   |
|   Sankey Attribution            |   Obvious Market Factors        |   Kalman Filtering            |
| • 3D Efficient Frontier         | • Residual Covariance Denoising | • Time-Varying Betas          |
| • Robustness Parameter Surface  |   (Marchenko-Pastur RMT &       | • Fama-MacBeth Regressions    |
| • Minimum Spanning Tree (MST)   |    Ledoit-Wolf Shrinkage)       |   with Newey-West HAC Errors  |
|   for Contagion & Correlation   | • PCA & Partial Correlations    | • Gibbons-Ross-Shanken (GRS)  |
| • Bates Jump-Diffusion Cones    | • Live Hyperliquid or Synthetic | • Factor-GJR-GARCH & Kupiec   |
| • Conditional Beta Surfaces     |   Data Ingestion                |   VaR Backtesting (CSV/JSON)  |
+---------------------------------+---------------------------------+-------------------------------+
```

---

## 🏗️ Hybrid System Architecture

0xHarpoon is engineered around a resilient dual-engine pipeline: a lightweight local Node.js server using Server-Sent Events (SSE) for ultra-low-latency streaming, paired with automated GitHub Actions workflows for zero-cost cloud persistence.

```text
                       [ EXTERNAL INSTITUTIONAL & ON-CHAIN APIS ]
        Hyperliquid • Polymarket • FRED • CFTC • Deribit • USGS • DeFiLlama
                                           │
                     ┌─────────────────────┴─────────────────────┐
                     ▼                                           ▼
     ┌───────────────────────────────┐           ┌───────────────────────────────┐
     │     LOCAL NODE.JS ENGINE      │           │   SERVERLESS CLOUD PIPELINE   │
     │  • Zero-dependency HTTP/SSE   │           │  • GitHub Actions (10-20m)    │
     │  • Rate-limited request queue │           │  • Persistent 'state' branch  │
     │  • Disk persistence (/data)   │           │  • Static Edge Deployment     │
     └───────────────┬───────────────┘           └───────────────┬───────────────┘
                     │                                           │
                     └─────────────────────┬─────────────────────┘
                                           ▼
                     ┌───────────────────────────────────────────┐
                     │        CLIENT TERMINAL (VANILLA JS)       │
                     │  • Direct browser polling (15s - 45s)     │
                     │  • 45s SWR cache + LocalStorage forensics │
                     │  • D3.js & Custom 3D Canvas Engine        │
                     └───────────────────────────────────────────┘
```

### Engineering Highlights
* **Zero External Dependencies:** Runs natively on **Node.js 20+** without `npm install` bloat—eliminating supply-chain vulnerabilities and ensuring instant portability.
* **Intelligent Queue & Backoff Controller (`pmapi.js` / `pm.mjs`):** Enforces strict concurrency limits (max 2 parallel requests), exponential backoff on rate limits, and a 45-second stale-while-revalidate (SWR) browser cache.
* **State Survival:** Views mount once and preserve internal state across tab switches; background engines (`live.js`, `tape.js`) operate independently of the UI thread and automatically throttle when the tab loses focus.

---

## 💻 Local Deployment

Deploy the full terminal locally on Windows, macOS, or Linux in under 15 seconds:

```bash
# 1. Clone the repository
git clone https://github.com/eclin-hub/0xHarpoon.git
cd 0xHarpoon

# 2. Launch the zero-dependency server (Requires Node.js >= 20)
node server.mjs
```

Open your browser to **[`http://localhost:8787`](http://localhost:8787)**. All historical snapshots and whale activity logs are persisted locally in `data/`.

### Runtime Configuration (Optional)

Tune ingestion frequency and sample depth via environment variables:

```bash
# Double refresh speed and expand Hyperliquid whale cohort to 150 wallets
PORT=8787 HL_COHORT=150 REFRESH_SCALE=0.5 node server.mjs
```

### Standalone Static Snapshot

Generate a self-contained, portable HTML snapshot of the current market state without running a persistent server:

```bash
node scripts/snapshot.mjs   # Outputs to dist/snapshot.html
```

---

## 📂 Repository Blueprint

```text
0xHarpoon/
├── server.mjs                 # Native HTTP server, cache layer & SSE real-time broadcaster
├── lib/                       # Server-side data connectors & quantitative aggregators
│   ├── hl.mjs                 # Hyperliquid leaderboard & cohort filtering engine
│   ├── pm.mjs                 # Polymarket Gamma/CLOB queue & position parser
│   ├── macro.mjs              # FRED yield curve, liquidity & credit spread ingestion
│   ├── odds.mjs               # Deribit options surface, skew & Max Pain solver
│   ├── synth.mjs              # Cross-asset directional weighting & edge detector
│   └── world.mjs              # Geopolitical flashpoints & USGS seismic monitor
├── public/                    # Frontend terminal & visualization engines
│   ├── index.html             # Single-page analytical shell
│   ├── live.js & tape.js      # Real-time WebSocket/polling & Whale Tape engines
│   ├── globe.js               # Interactive 3D D3/TopoJSON geopolitical globe
│   ├── views1.js .. views4.js # 18 specialized market & institutional dashboards
│   └── q-*.js                 # Quant Vault math core, 3D renderer, RMT & Kalman labs
├── scripts/
│   └── snapshot.mjs           # Standalone HTML report compiler
└── .github/workflows/         # Automated data collection & GitHub Pages CI/CD
```

---

<div align="center">

**Engineered by [@eclin-hub](https://github.com/eclin-hub) • 2026**  
*Built for quantitative research, market microstructure analysis, and institutional surveillance.*

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0ea5e9,50:111827,100:090d16&height=90&section=footer" width="100%" alt="Footer" />

</div>
