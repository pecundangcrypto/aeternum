/**
 * Synthetic SOL account for paper mode.
 *
 * Exists so the agent can be evaluated for days without a private key anywhere
 * on the machine. Nothing here touches a wallet, an RPC balance, or a signature —
 * it is a ledger of what the configured starting balance would be worth after the
 * paper positions the agent chose to open.
 *
 * The point is isolation. A paper run must be incapable of interacting with a
 * live wallet, not merely configured not to.
 */

import { createStore } from "./json-store.js";
import { dataPath } from "../paths.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const store = createStore(dataPath("paper-account.json"), {
  startingSol: null,
  sol: null,
  openedAt: null,
  history: [],
});

const MAX_HISTORY = 200;

function ensure() {
  return store.update((state) => {
    if (state.sol == null) {
      state.startingSol = config.paper.startingSol;
      state.sol = config.paper.startingSol;
      state.openedAt = new Date().toISOString();
      log("paper", `Paper account opened with ${state.sol} SOL (no wallet key involved)`);
    }
    return state;
  });
}

export function balance() {
  const state = ensure();
  return {
    owner: "paper",
    sol: Number(state.sol.toFixed(6)),
    deployableSol: Number(Math.max(0, state.sol - config.management.gasReserveSol).toFixed(6)),
    // A paper run never holds token balances: `openPosition` debits SOL directly
    // rather than simulating the funding swaps, so there is nothing to report.
    tokens: [],
    paper: true,
    startingSol: state.startingSol,
  };
}

/** Debit the cost of opening a paper position. */
export function debit(sol, { label = null } = {}) {
  return store.update((state) => {
    if (state.sol == null) {
      state.startingSol = config.paper.startingSol;
      state.sol = config.paper.startingSol;
      state.openedAt = new Date().toISOString();
    }
    state.sol = Number((state.sol - Number(sol || 0)).toFixed(6));
    state.history = [...state.history, { at: new Date().toISOString(), kind: "debit", sol: Number(sol), label, balance: state.sol }].slice(-MAX_HISTORY);
    return state.sol;
  });
}

/** Credit the proceeds of closing a paper position. */
export function credit(sol, { label = null } = {}) {
  return store.update((state) => {
    if (state.sol == null) {
      state.startingSol = config.paper.startingSol;
      state.sol = config.paper.startingSol;
    }
    state.sol = Number((state.sol + Number(sol || 0)).toFixed(6));
    state.history = [...state.history, { at: new Date().toISOString(), kind: "credit", sol: Number(sol), label, balance: state.sol }].slice(-MAX_HISTORY);
    return state.sol;
  });
}

/** Overall paper result since the account was opened. */
export function summary() {
  const state = ensure();
  const pnlSol = Number((state.sol - state.startingSol).toFixed(6));
  return {
    startingSol: state.startingSol,
    currentSol: Number(state.sol.toFixed(6)),
    pnlSol,
    pnlPct: state.startingSol ? Number(((pnlSol / state.startingSol) * 100).toFixed(2)) : null,
    openedAt: state.openedAt,
    movements: state.history.length,
  };
}

export function reset() {
  store.write({ startingSol: null, sol: null, openedAt: null, history: [] });
  return ensure();
}
