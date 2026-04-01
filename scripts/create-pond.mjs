import { createRequire } from "node:module"
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js"
import BN from "bn.js"
import bs58 from "bs58"

const require = createRequire(import.meta.url)
const { PumpSdk, OnlinePumpSdk } = require("@pump-fun/pump-sdk")

const RPC_URL = process.env.SOLANA_RPC_URL
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY

if (!RPC_URL) throw new Error("SOLANA_RPC_URL not set")
if (!PRIVATE_KEY) throw new Error("SOLANA_PRIVATE_KEY not set")

const connection = new Connection(RPC_URL, "confirmed")

let wallet
if (PRIVATE_KEY.trim().startsWith("[")) {
  wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)))
} else {
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))
}

const pumpSdk = new PumpSdk(connection)
const onlineSdk = new OnlinePumpSdk(connection)

const mint = Keypair.generate()
const BUY_SOL = 0.10
const solLamports = new BN(Math.floor(BUY_SOL * 1e9))

console.log(`Mint keypair: ${mint.publicKey.toBase58()}`)
console.log(`Wallet: ${wallet.publicKey.toBase58()}`)
console.log(`Creating Pondsworth (POND) with ${BUY_SOL} SOL initial buy...`)

// Fetch global state
const global = await onlineSdk.fetchGlobal()

// Initial bonding curve virtual reserves at genesis
const VIRTUAL_SOL = BigInt("30000000000")   // 30 SOL in lamports
const VIRTUAL_TOK = BigInt("1073000191000000") // 1.073B tokens (6 decimals)

// protocol fee bps = 0x5f = 95 bps = 0.95%
const PROTOCOL_FEE_BPS = 95n
const sol_in = BigInt(Math.floor(BUY_SOL * 1e9))
const fee = (sol_in * PROTOCOL_FEE_BPS) / 10000n
const sol_after_fee = sol_in - fee

// AMM invariant: k = vSol * vTok
const k = VIRTUAL_SOL * VIRTUAL_TOK
const new_vSol = VIRTUAL_SOL + sol_after_fee
const new_vTok = k / new_vSol
const tokenAmount = new BN((VIRTUAL_TOK - new_vTok).toString())

console.log(`Expected tokens out: ~${tokenAmount.toString()}`)

const instructions = await pumpSdk.createV2AndBuyInstructions({
  global,
  mint: mint.publicKey,
  name: "Pondsworth",
  symbol: "POND",
  uri: "https://ipfs.io/ipfs/QmSBxLUczrAuu4ppVBzjd8QJ74QVnpNQsKqvmKxR7jvgYC",
  creator: wallet.publicKey,
  user: wallet.publicKey,
  amount: tokenAmount,
  solAmount: solLamports,
  mayhemMode: false,
})

console.log(`Built ${instructions.length} instructions`)

const tx = new Transaction().add(...instructions)
const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mint], {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
})

console.log(`\n✅ Token created and bought!`)
console.log(`Mint:     ${mint.publicKey.toBase58()}`)
console.log(`Tx:       ${sig}`)
console.log(`Explorer: https://solscan.io/tx/${sig}`)
console.log(`Pump.fun: https://pump.fun/${mint.publicKey.toBase58()}`)
