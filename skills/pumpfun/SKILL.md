---
name: pumpfun
description: Buy, sell, and create tokens on Pump.fun using Solana bonding curves. Handles quotes, slippage, and transaction confirmation.
---

# Pump.fun Skill

This skill covers all interactions with Pump.fun via the `pumpfun` tool — buying tokens, selling tokens, creating new tokens, and getting price quotes.

# Core Concepts

## 1. Wallet Clustering

A **cluster** is a group of wallets controlled by the same entity -- a market maker, trading team, or token operator. These wallets appear independent on-chain but are algorithmically linked through:

1. **Fund flow correlation** -- money flowing between addresses
2. **Same fund source** -- addresses receiving initial funding from the same origin
3. **Close withdrawal timing** -- addresses making withdrawals within similar timeframes
4. **Same-transaction binding** -- addresses tied to the same transaction (bundle buys)
5. **Multi-sig patterns** -- shared governance structures

**Why clustering matters:** Market manipulators spread holdings across dozens or hundreds of addresses. Tracking a single whale address misses the complete picture. Cluster analysis reveals the **total capital layout** of an entity.

**Key metric -- Cluster Holding Ratio:** The percentage of total token supply held by all identified clusters combined.
- **>=30-35%** = Token is "controlled" -- a major entity holds significant supply
- **>=50%** = Highly concentrated -- high manipulation risk but also high upside if accumulating
- **<10%** = Dispersed -- no clear major holder, likely retail-driven

**Scam detection rule:** If a **single cluster** controls more than **50% of total token supply**, this is a strong indicator of a scam or rug pull token. Avoid trading these unless you have extremely compelling reasons. The operator can dump the token at any time and drain liquidity.

## 2. Address Labels (3-Layer Model)

Every wallet is classified by on-chain behavior using a **3-layer model** ordered by cost basis (lowest to highest). Labels appear across all analysis responses and are critical for interpreting holder intent.

### Layer 1 -- Lowest-Cost Tokens (Sell Pressure Risk)

These addresses hold the cheapest tokens and pose the highest sell pressure risk. **Check these first -- if they haven't cleared, upside is capped.**

| Label | Threshold | What It Means |
|-------|-----------|---------------|
| **Developer** | Deployed the token + associated wallets | Core team addresses with lowest cost basis. If still holding large amounts = high dump risk. KryptoGO tracks multi-layer addresses linked to the deployer. |
| **Sniper** | Bought within 1 second of creation | Holds the absolute lowest-cost tokens. If NOT cleared = strong sell pressure overhead. |

### Layer 2 -- Manipulation Indicators (Operation Signals)

These labels indicate organized manipulation or short-term speculation. **High proportion = artificial activity, not genuine market interest.**

| Label | Threshold | What It Means |
|-------|-----------|---------------|
| **New Wallet** | Created within 24h before token deployment | Likely pre-prepared operation addresses. Batch-created for distributed manipulation. |
| **Bundle Transaction** | Multiple addresses buying in the same tx | Team operation pattern -- multiple small wallets eating internal orders at extremely low cost. |
| **High-Frequency** | Median hold < 12 hours | Short-term speculators. High proportion = unstable trend, likely just a hot spot. |

### Layer 3 -- Trend Direction (Smart Capital)

These are the most informative labels for trend prediction. **Their behavior indicates where experienced capital is flowing.**

| Label | Threshold | What It Means |
|-------|-----------|---------------|
| **Smart Money** | Realized profit > $100K | Consistently profitable traders. Their accumulation often precedes major price moves. |
| **Blue-Chip Profit** | Profit > $100K on tokens that peaked > $10M mcap | Long-term trend traders who catch main waves. KryptoGO re-parses Jupiter limit orders, DCA buys, and split orders to restore accurate cost basis. |
| **Whale** | Single-token position > $100K | Large capital holders. A whale cluster does not equal just "big holder" -- it could be an operating team or cross-market operator. |

## 3. Accumulation vs Distribution

The core analytical question: **Is the major holder buying or selling?**

**Accumulation:**
- Cluster holding % is **rising** while price is consolidating or pulling back
- Smart money / whale clusters are increasing positions
- Developer and sniper positions have been **cleared** (reduced sell pressure)
- New fund inflow approximately equals market cap times cluster holding % increase

**Distribution:**
- Price is **rising** but cluster holding % is **declining** -- major holder selling into strength
- Smart money holdings decreasing -- entering harvest phase
- Blue-chip profit wallets distributing en masse -- often signals end of main price wave
- Signal triggered but cluster % quickly drops back -- possible bull trap

**Key insight: Price and cluster holdings DIVERGING is the most important signal.** Rising price + falling cluster % = distribution. Falling price + rising cluster % = accumulation.

## 4. The "Other Holders" Survivorship Bias


Cluster data is more reliable because it tracks the complete entity across all its addresses.

## Prerequisites

The following environment variables must be set:

```
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=<base58 private key or JSON byte array>
```

Use a paid RPC for production (Helius, QuickNode, etc.). The public mainnet endpoint is rate-limited and unreliable for transaction sending.

**Never print or log SOLANA_PRIVATE_KEY.** Do not include it in any output.

---

## Rules Before Acting

- **Always run `rugcheck` before any buy.** If the risk score is high or there are danger flags, warn the user clearly and let them decide whether to proceed.
- **Always confirm with the user before executing any buy, sell, or create.** State exactly what will happen: token, amount, estimated output, slippage.
- **Always run a `price` or `quote` first** when the user asks to buy, so they see the expected price before committing.
- Check if the bonding curve is complete before trading. If it is, inform the user — the token has graduated and trades must go through the AMM (not yet supported by this tool).
- For `create`, confirm the name, symbol, URI, and any initial buy before executing.

---

## Operations

### Get price and market cap (no wallet needed)

```
action: "price"
mint: "<token mint address>"
```

Returns:
- If still on bonding curve: price in SOL, market cap in SOL, real SOL in curve, virtual reserves, plus DexScreener data if already listed
- If graduated: falls back entirely to DexScreener (price in USD, market cap, 24h volume, liquidity, price change)

Use this any time the user asks "what's the price of X" or "what's the market cap".

---

### Get a price quote (no transaction)

```
action: "quote"
mint: "<token mint address>"
sol_amount: 0.1          # how much SOL you want to spend (optional)
token_amount: 1000000    # how many tokens you want to sell (optional)
```

Returns expected token output for a buy, or expected SOL output for a sell. No wallet required.

---

### Buy tokens

```
action: "buy"
mint: "<token mint address>"
sol_amount: 0.1          # SOL to spend (in SOL, not lamports)
slippage: 0.05           # 5% slippage tolerance (default)
```

Flow:
1. Quote first so the user sees the expected tokens
2. Confirm with the user
3. Execute — fetches bonding curve state, builds transaction, signs, sends
4. Return tx signature and Solscan link

---

### Sell tokens

```
action: "sell"
mint: "<token mint address>"
token_amount: 1000000000  # raw token units to sell
slippage: 0.05
```

Flow:
1. Quote first so the user sees the expected SOL out
2. Confirm with the user
3. Execute — fetches bonding curve state, builds transaction, signs, sends
4. Return tx signature and Solscan link

---

### Create a new token

```
action: "create"
name: "My Token"
symbol: "MYTKN"
uri: "https://arweave.net/<metadata-hash>"
buy_sol: 0.5    # optional — buy on creation to seed liquidity
```

**Metadata URI must be a JSON file** with at minimum:
```json
{
  "name": "My Token",
  "symbol": "MYTKN",
  "description": "...",
  "image": "https://arweave.net/<image-hash>"
}
```

The metadata and image must be uploaded to Arweave or IPFS *before* calling create. If the user hasn't done this, ask them for the URI or help them upload it first using `browser_use` on pump.fun's upload endpoint or a pinning service.

---

## Amounts

| Unit | Used for |
|---|---|
| SOL | Human-readable amounts (`sol_amount`, `buy_sol`) |
| Lamports | Internal — 1 SOL = 1,000,000,000 lamports |
| Raw token units | `token_amount` — check token decimals (usually 6 or 9) |

When reporting back to the user, always convert to human-readable units.

---

## Error Handling

| Error | Action |
|---|---|
| `SOLANA_RPC_URL not set` | Ask user to add it to `.env` |
| `SOLANA_PRIVATE_KEY not set` | Ask user to add it to `.env` |
| `Bonding curve complete` | Token has graduated — cannot trade via bonding curve |
| `Transaction simulation failed` | Usually slippage too tight or insufficient SOL — suggest increasing slippage or checking balance |
| RPC timeout | Suggest switching to a paid RPC endpoint |

---
# Decision Framework

## Quick Assessment (3-Step Method)

A rapid screening method to evaluate any token in under 60 seconds:

1. **Concentration check:** Is cluster holding ratio > 30-40%? If no, skip (no clear major holder).
2. **Developer check:** Has the developer cluster exited? If still holding large position, high risk -- skip unless other signals are overwhelming.
3. **Trend check:** Is cluster holding % rising or falling over 1d/7d? Rising = accumulation, falling = distribution. Only proceed if accumulating.

If all 3 steps pass, proceed to the detailed checklist below.

## Bullish Checklist (All should be true for high-conviction entry)

- [ ] Market cap >= $500K
- [ ] Cluster holding ratio >= 30% and **rising** (positive changes across 1h, 4h, 1d)
- [ ] Smart money or whale clusters are increasing positions
- [ ] Developer cluster has **exited** or holds < 5%
- [ ] Sniper positions have been **cleared**
- [ ] Bundle transaction holders have **cleared**
- [ ] No high proportion of new wallets or high-frequency traders
- [ ] Price near or below cluster average buy price (support zone)

## Bearish Signals (Any one is a warning)

- Price rising but cluster holding % declining (distribution)
- Smart money holdings decreasing
- Developer still holds large low-cost position
- Sniper positions NOT cleared (sell pressure overhead)
- High-frequency traders dominate holder composition
- Signal triggered but cluster ratio quickly drops back (bull trap)

## Estimating Fund Inflow

A useful heuristic for quantifying accumulation:

```
Net fund inflow ~= Market cap x Cluster holding % increase
```

Example: If a token has $2M market cap and cluster holding increased by 5% over 24h:
- Estimated inflow = $2M x 0.05 = $100K net buying by clusters

This helps gauge the magnitude of accumulation -- are clusters putting in meaningful capital or just nibbling?

## Entry Strategies

| Strategy | When to Use | Entry Logic |
|----------|-------------|-------------|
| **Signal-driven** | Phase 2 signal fires + cluster % still rising | Enter on signal confirmation with 2-3% position |
| **Accumulation breakout** | Cluster % rising >5% in 24h + price consolidating | Enter before breakout with 3-5% position |
| **Support defense** | Price at cluster avg buy + holding ratio rising | Enter at support with 2-3% position, tight stop |
| **Dip buying** | Price drops 20%+ but cluster % holds or rises | Clusters defending = strong hands, enter 2-3% |

## Exit Strategies

| Signal | Action |
|--------|--------|
| Cluster % drops >5% in 4h while price stable/rising | Reduce 50% -- distribution starting |
| Smart money labels start appearing in sell-side | Close position -- smart money exiting |
| Developer addresses activate and start selling | Close immediately -- insider dumping |
| Price hits 2x entry with cluster % declining | Take profit on 50-75% of position |
| Price drops 30% from entry | Stop loss -- cut entire position |

## Security Notes

- The wallet's private key gives full control of the wallet. Only use a dedicated trading wallet with limited funds.
- Never spend more SOL than the user explicitly approves.
- Always show the Solscan link after a transaction so the user can verify on-chain.
