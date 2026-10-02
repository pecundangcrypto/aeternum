/**
 * Solana connection, wallet, and Orca SDK bootstrap.
 *
 * The Orca v8 SDK keeps its RPC, payer and fee policy in module-level state, so
 * initialisation has to happen exactly once before any action call. Everything
 * here is lazy and idempotent: the CLI can import a single read-only helper
 * without ever touching the wallet.
 */

import bs58 from "bs58";
import { createSolanaRpc, createKeyPairSignerFromBytes, address, lamports } from "@solana/kit";
import {
  setRpc,
  setDefaultFunder,
  setPayerFromBytes,
  setDefaultSlippageToleranceBps,
  setPriorityFeeSetting,
  setNativeMintWrappingStrategy,
} from "@orca-so/whirlpools";
import { config, MINTS } from "../config.js";
import { log } from "../logger.js";
import * as paperAccount from "../store/paper-account.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

let rpcClient = null;
let watcherRpcClient = null;
let signer = null;
let sdkReady = null;

/** Read-only RPC for the main agent loop. */
export function rpc() {
  rpcClient ??= createSolanaRpc(config.chain.rpcUrl);
  return rpcClient;
}

/**
 * RPC for the fast PnL watcher.
 *
 * Falls back to the main endpoint when no separate one is configured, but a
 * dedicated URL is strongly recommended — the watcher polls every position
 * every few seconds and will exhaust a shared rate limit.
 */
export function watcherRpc() {
  if (!config.chain.watcherRpcUrl) return rpc();
  watcherRpcClient ??= createSolanaRpc(config.chain.watcherRpcUrl);
  return watcherRpcClient;
}

function decodeSecretKey(raw) {
  const value = String(raw).trim();
  if (!value) throw new Error("WALLET_PRIVATE_KEY is empty");

  // Accept both base58 (Phantom/Solflare export) and a JSON byte array (solana-keygen).
  if (value.startsWith("[")) {
    const bytes = Uint8Array.from(JSON.parse(value));
    if (bytes.length !== 64) throw new Error(`Expected a 64-byte keypair, got ${bytes.length}`);
    return bytes;
  }
  const bytes = bs58.decode(value);
  if (bytes.length !== 64) {
    throw new Error(`WALLET_PRIVATE_KEY decoded to ${bytes.length} bytes — expected a 64-byte base58 keypair`);
  }
  return bytes;
}

/** The agent's signer. Throws when no key is configured. */
export async function wallet() {
  if (signer) return signer;
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error("WALLET_PRIVATE_KEY is not set — run `npm run setup` or add it to .env");
  }
  signer = await createKeyPairSignerFromBytes(decodeSecretKey(raw));
  return signer;
}

export async function walletAddress() {
  return (await wallet()).address;
}

/**
 * Initialise the Orca SDK's global state. Safe to call repeatedly; the work
 * happens once.
 */
export async function initSdk() {
  sdkReady ??= (async () => {
    await setRpc(config.chain.rpcUrl);
    // The SDK's action functions (open, close, harvest, decrease) sign and send
    // with a module-level payer. Setting only the funder is not enough: every one
    // of them then fails with "Payer not set" — after any funding swap has
    // already landed. This is the call that registers it.
    const payer = await setPayerFromBytes(decodeSecretKey(process.env.WALLET_PRIVATE_KEY ?? ""));
    if (payer.address !== (await wallet()).address) {
      throw new Error("SDK payer does not match the configured wallet — refusing to continue");
    }
    setDefaultFunder(payer);
    setDefaultSlippageToleranceBps(config.chain.slippageBps);
    // Wrapping SOL through an ephemeral account avoids leaving a stranded wSOL
    // ATA behind on every position open.
    setNativeMintWrappingStrategy("keypair");
    setPriorityFeeSetting(
      config.chain.priorityFeeLamports > 0
        ? { type: "dynamic", maxCapLamports: BigInt(Math.round(config.chain.priorityFeeLamports)) }
        : { type: "none" },
    );
    log("chain", `SDK ready — payer ${payer.address}, slippage ${config.chain.slippageBps}bps`);
    return payer;
  })();
  return sdkReady;
}

/** Drop cached clients so a config reload can change the endpoint. */
export function resetConnections() {
  rpcClient = null;
  watcherRpcClient = null;
  sdkReady = null;
}

/**
 * Paper mode: dry run with no private key configured.
 *
 * This is a deliberate capability, not a degraded state. It lets the agent be
 * judged over days against live market data while being structurally incapable
 * of touching a real wallet — there is no key to sign with.
 */
export function isPaperMode() {
  return config.dryRun && !process.env.WALLET_PRIVATE_KEY;
}

export async function solBalance(owner = null) {
  const target = owner ?? (await walletAddress());
  const { value } = await rpc().getBalance(address(target)).send();
  return Number(value) / LAMPORTS_PER_SOL;
}

/**
 * SOL plus every SPL/Token-2022 balance the wallet holds.
 * Position NFTs (amount 1, 0 decimals) are filtered out — they are positions,
 * not spendable balance.
 */
export async function walletBalances(owner = null) {
  if (isPaperMode() && !owner) return paperAccount.balance();

  const target = address(owner ?? (await walletAddress()));
  const sol = await solBalance(target);

  const programs = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ];

  const tokens = [];
  for (const programId of programs) {
    try {
      const { value } = await rpc()
        .getTokenAccountsByOwner(target, { programId: address(programId) }, { encoding: "jsonParsed" })
        .send();
      for (const account of value) {
        const info = account.account.data.parsed?.info;
        if (!info) continue;
        const amount = Number(info.tokenAmount?.uiAmount ?? 0);
        const decimals = Number(info.tokenAmount?.decimals ?? 0);
        if (amount <= 0) continue;
        if (decimals === 0 && amount === 1) continue; // position / NFT
        tokens.push({
          mint: info.mint,
          amount,
          decimals,
          account: account.pubkey,
        });
      }
    } catch (err) {
      log("chain_warn", `Token account scan failed for ${programId.slice(0, 6)}: ${err.message}`);
    }
  }

  return {
    owner: target,
    sol: Number(sol.toFixed(6)),
    deployableSol: Number(Math.max(0, sol - config.management.gasReserveSol).toFixed(6)),
    tokens: tokens.sort((left, right) => right.amount - left.amount),
  };
}

export function isQuoteMint(mint) {
  return config.screening.quoteMints.includes(mint);
}

export { LAMPORTS_PER_SOL, MINTS, address, lamports };
