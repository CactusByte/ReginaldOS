import bs58 from 'bs58';
import { Keypair, Connection, PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpSdk, OnlinePumpSdk, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';

const key = '57CWtJDvHwLLR2674Z2sZZNeDvVpzzMiGN6yJ4wz1vwJw5wLWaPJhSDaEmJDudaRfFqUymv2rg6vUdvJirCjrYM';
const kp = Keypair.fromSecretKey(bs58.decode(key));
console.log('Wallet:', kp.publicKey.toBase58());

const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const sdk = new PumpSdk(conn);
const onlineSdk = new OnlinePumpSdk(conn);

const mint = new PublicKey('DkPywye2f8Zg8vW4f3DW9VBtDdNnfeBv3mfnD1sg9kRR');
const user = kp.publicKey;

const amount = new BN('3531030677665');
const slippage = 0.1; // 10%

console.log('Fetching sell state...');
const global = await onlineSdk.fetchGlobal();
const { bondingCurveAccountInfo, bondingCurve } = await onlineSdk.fetchSellState(mint, user);

console.log('Bonding curve:', JSON.stringify(bondingCurve, (k,v) => typeof v === 'bigint' ? v.toString() : v));

const solAmount = getSellSolAmountFromTokenAmount(global, bondingCurve, amount);
console.log('Expected SOL return (before slippage):', solAmount.toString(), 'lamports =', solAmount.toNumber() / 1e9, 'SOL');

const instructions = await sdk.sellInstructions({
  global,
  bondingCurveAccountInfo,
  bondingCurve,
  mint,
  user,
  amount,
  solAmount,
  slippage,
});

const tx = new Transaction().add(...instructions);
const { blockhash } = await conn.getLatestBlockhash();
tx.feePayer = kp.publicKey;
tx.recentBlockhash = blockhash;

console.log('Sending transaction...');
const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
console.log('SUCCESS! Signature:', sig);
console.log('Explorer:', `https://solscan.io/tx/${sig}`);
