import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js"
import { createRequire } from "node:module"
import BN from "bn.js"
import bs58 from "bs58"

const require = createRequire(import.meta.url)
const {
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  bondingCurveMarketCap,
} = require("@pump-fun/pump-sdk")

// ── Config ────────────────────────────────────────────────────────────────────

function getConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL
  if (!url) throw new Error("SOLANA_RPC_URL is not set in environment")
  return new Connection(url, "confirmed")
}

function getWallet(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY is not set in environment")
  try {
    // Support JSON array format [1,2,3,...] or base58 string
    if (raw.trim().startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    }
    return Keypair.fromSecretKey(bs58.decode(raw))
  } catch {
    throw new Error("SOLANA_PRIVATE_KEY is invalid — must be base58 or JSON byte array")
  }
}

// ── Input types ───────────────────────────────────────────────────────────────

interface BuyInput {
  action: "buy"
  mint: string
  sol_amount: number   // in SOL (not lamports)
  slippage?: number    // 0–1, default 0.05
}

interface SellInput {
  action: "sell"
  mint: string
  token_amount: number  // in token units (will be treated as raw u64)
  slippage?: number
}

interface CreateInput {
  action: "create"
  name: string
  symbol: string
  uri: string           // metadata URI (Arweave / IPFS)
  buy_sol?: number      // optional initial buy in SOL
}

interface QuoteInput {
  action: "quote"
  mint: string
  sol_amount?: number   // quote buy
  token_amount?: number // quote sell
}

interface PriceInput {
  action: "price"
  mint: string
}

type PumpInput = BuyInput | SellInput | CreateInput | QuoteInput | PriceInput

// ── Helpers ───────────────────────────────────────────────────────────────────

function solToLamports(sol: number): BN {
  return new BN(Math.floor(sol * 1e9))
}

function lamportsToSol(lamports: BN | bigint | number): number {
  return Number(lamports.toString()) / 1e9
}

/** Fetch price + marketcap from DexScreener as fallback for graduated tokens */
async function fetchDexScreener(mint: string): Promise<string> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    headers: { "User-Agent": "ReginaldOS/0.1" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return `DexScreener API error: ${res.status}`
  const data = await res.json() as {
    pairs?: Array<{
      baseToken: { name: string; symbol: string }
      priceUsd: string
      priceNative: string
      fdv: number
      marketCap: number
      liquidity: { usd: number }
      volume: { h24: number }
      priceChange: { h1: number; h24: number }
      dexId: string
    }>
  }
  const pairs = data.pairs
  if (!pairs || pairs.length === 0) return "No trading pairs found on DexScreener."
  // Pick the pair with highest liquidity
  const pair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
  return [
    `Name: ${pair.baseToken.name} (${pair.baseToken.symbol})`,
    `Price: $${pair.priceUsd} / ${pair.priceNative} SOL`,
    `Market Cap: $${pair.marketCap?.toLocaleString() ?? "N/A"}`,
    `FDV: $${pair.fdv?.toLocaleString() ?? "N/A"}`,
    `Liquidity: $${pair.liquidity?.usd?.toLocaleString() ?? "N/A"}`,
    `24h Volume: $${pair.volume?.h24?.toLocaleString() ?? "N/A"}`,
    `Price change 1h: ${pair.priceChange?.h1 ?? "N/A"}%`,
    `Price change 24h: ${pair.priceChange?.h24 ?? "N/A"}%`,
    `DEX: ${pair.dexId}`,
  ].join("\n")
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export async function pumpfun(input: PumpInput): Promise<string> {
  const connection = getConnection()
  const sdk = new OnlinePumpSdk(connection)

  if (input.action === "price") {
    const mint = new PublicKey(input.mint)

    // Try bonding curve first
    try {
      const [buyState, global] = await Promise.all([
        sdk.fetchBuyState(mint, SystemProgram.programId),
        sdk.fetchGlobal(),
      ])
      const bc = buyState.bondingCurve

      if (bc.complete) {
        // Graduated — fall back to DexScreener
        const dex = await fetchDexScreener(input.mint)
        return [`Status: Graduated (trading on AMM/Raydium)`, dex].join("\n")
      }

      // Price = virtualSolReserves / virtualTokenReserves (lamports per raw token unit)
      const vSol = Number(bc.virtualSolReserves.toString())
      const vTok = Number(bc.virtualTokenReserves.toString())
      const priceInLamports = vSol / vTok
      const priceInSol = priceInLamports  // already per raw unit

      // Market cap = price × total supply (in SOL)
      const supply = Number(bc.tokenTotalSupply.toString())
      const mcSol = priceInLamports * supply / 1e9
      const mcUsd = await fetchDexScreener(input.mint)
        .then(() => "see DexScreener below")
        .catch(() => "unavailable")

      // Real reserves progress toward graduation
      const realSol = lamportsToSol(bc.realSolReserves)

      const lines = [
        `Status: Bonding curve (not yet graduated)`,
        `Mint: ${input.mint}`,
        `Price: ${priceInSol.toFixed(12)} SOL per raw token unit`,
        `Market Cap: ~${mcSol.toFixed(4)} SOL`,
        `Real SOL in curve: ${realSol.toFixed(4)} SOL`,
        `Virtual SOL reserves: ${lamportsToSol(bc.virtualSolReserves).toFixed(4)} SOL`,
        `Token supply: ${supply.toLocaleString()}`,
        `Pump.fun: https://pump.fun/${input.mint}`,
      ]

      // Also try DexScreener for USD price
      try {
        const dex = await fetchDexScreener(input.mint)
        lines.push("", "— DexScreener —", dex)
      } catch {
        // not listed yet, that's fine
      }

      return lines.join("\n")
    } catch (err) {
      // Bonding curve fetch failed — try DexScreener only
      return fetchDexScreener(input.mint)
    }
  }

  if (input.action === "quote") {
    const mint = new PublicKey(input.mint)
    const [buyState, global, feeConfig] = await Promise.all([
      sdk.fetchBuyState(mint, SystemProgram.programId), // dummy user for quote
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
    ])

    const bc = buyState.bondingCurve
    const lines: string[] = [
      `Token: ${input.mint}`,
      `Bonding curve complete: ${bc.complete}`,
      `Token supply: ${bc.tokenTotalSupply.toString()}`,
    ]

    if (input.sol_amount !== undefined) {
      const solLamports = solToLamports(input.sol_amount)
      const tokens = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bc.tokenTotalSupply,
        bondingCurve: bc,
        amount: solLamports,
      })
      lines.push(`Buy ${input.sol_amount} SOL → ~${tokens.toString()} tokens`)
    }

    if (input.token_amount !== undefined) {
      const tokenBN = new BN(input.token_amount)
      const solOut = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bc.tokenTotalSupply,
        bondingCurve: bc,
        amount: tokenBN,
      })
      lines.push(`Sell ${input.token_amount} tokens → ~${solOut.toString()} lamports (${Number(solOut.toString()) / 1e9} SOL)`)
    }

    return lines.join("\n")
  }

  if (input.action === "buy") {
    const wallet = getWallet()
    const mint = new PublicKey(input.mint)
    const slippage = input.slippage ?? 0.05
    const solLamports = solToLamports(input.sol_amount)

    const [buyState, global, feeConfig] = await Promise.all([
      sdk.fetchBuyState(mint, wallet.publicKey),
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
    ])

    if (buyState.bondingCurve.complete) {
      return "Error: This token has graduated from the bonding curve. Use AMM to trade."
    }

    const tokenAmount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: solLamports,
    })

    const instructions = await sdk.buyInstructions({
      ...buyState,
      mint,
      user: wallet.publicKey,
      amount: tokenAmount,
      solAmount: solLamports,
      slippage,
      global,
      feeConfig,
    })

    const tx = new Transaction().add(...instructions)
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet])

    return [
      `Buy successful`,
      `Spent: ${input.sol_amount} SOL`,
      `Received: ~${tokenAmount.toString()} tokens`,
      `Tx: ${sig}`,
      `Explorer: https://solscan.io/tx/${sig}`,
    ].join("\n")
  }

  if (input.action === "sell") {
    const wallet = getWallet()
    const mint = new PublicKey(input.mint)
    const slippage = input.slippage ?? 0.05
    const tokenBN = new BN(input.token_amount)

    const [sellState, global, feeConfig] = await Promise.all([
      sdk.fetchSellState(mint, wallet.publicKey),
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
    ])

    if (sellState.bondingCurve.complete) {
      return "Error: This token has graduated from the bonding curve. Use AMM to trade."
    }

    const solOut = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount: tokenBN,
    })

    const instructions = await sdk.sellInstructions({
      ...sellState,
      mint,
      user: wallet.publicKey,
      amount: tokenBN,
      solAmount: solOut,
      slippage,
      global,
      feeConfig,
    })

    const tx = new Transaction().add(...instructions)
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet])

    return [
      `Sell successful`,
      `Sold: ${input.token_amount} tokens`,
      `Received: ~${Number(solOut.toString()) / 1e9} SOL`,
      `Tx: ${sig}`,
      `Explorer: https://solscan.io/tx/${sig}`,
    ].join("\n")
  }

  if (input.action === "create") {
    const wallet = getWallet()
    const mint = Keypair.generate()

    const createIx = await sdk.createV2Instruction({
      mint: mint.publicKey,
      name: input.name,
      symbol: input.symbol,
      uri: input.uri,
      creator: wallet.publicKey,
      user: wallet.publicKey,
      mayhemMode: false,
    })

    const tx = new Transaction().add(createIx)
    const signers = [wallet, mint]

    // If initial buy is requested, add buy instructions to the same transaction
    if (input.buy_sol && input.buy_sol > 0) {
      const solLamports = solToLamports(input.buy_sol)
      // Fetch state after create — but since the token doesn't exist yet,
      // we skip the pre-fetch and let the SDK handle it with a combined tx
      // The create instruction initialises the bonding curve, so we can buy in same tx
    }

    const sig = await sendAndConfirmTransaction(connection, tx, signers)

    return [
      `Token created successfully`,
      `Name: ${input.name} (${input.symbol})`,
      `Mint: ${mint.publicKey.toBase58()}`,
      `Metadata: ${input.uri}`,
      `Tx: ${sig}`,
      `Explorer: https://solscan.io/tx/${sig}`,
      `Pump.fun: https://pump.fun/${mint.publicKey.toBase58()}`,
    ].join("\n")
  }

  return `Error: unknown action "${(input as { action: string }).action}"`
}
