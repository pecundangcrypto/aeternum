/**
 * Read-only status page.
 *
 * Everything it serves comes from the local JSON ledgers, which the watcher
 * already keeps current. Opening the page therefore costs no RPC calls, no API
 * quota, and cannot slow a cycle down — a dashboard that pulls live quotes on
 * every refresh would compete with the agent for the same rate limits.
 *
 * It exposes no actions. Closing a position or changing a threshold stays with
 * the CLI and Telegram, where every change is journalled with a reason.
 */

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";

import { config } from "./config.js";
import { buildState } from "./dashboard-state.js";
import { log } from "./logger.js";

let server = null;
let token = null;

// Single self-contained page: no build step, no CDN, works offline on a LAN.
// Colours come from the validated data-viz reference palette; fee income and
// price movement get fixed categorical slots so the two never swap identity.
//
// String.raw, so the page's own backslashes (regex literals, escaped quotes)
// survive verbatim — escaping them here silently corrupts the served markup.
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aeternum</title>
<style>
  /* Two data hues only, both calm and both validated: teal-green for fee income,
     blue for price movement (CVD ΔE 19.6 on the dark surface — the green/red pair
     a finance dashboard reaches for first measures 2.6, i.e. indistinguishable to
     a deuteranope). Direction is carried by signed numbers and by which side of
     the zero line a bar sits on, never by hue alone. */
  :root {
    color-scheme: light;
    --plane:#f6f7f5; --surface:#ffffff; --ink:#14171c; --ink-2:#565d68; --muted:#858c96;
    --line:#e6e7e3; --ring:rgba(20,23,28,.09);
    --fees:#1baf7a; --price:#2a78d6;
    --up:#146c3f; --down:#b3453c; --warnc:#9a6a12;
    --accent:#2a78d6;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --plane:#0f1216; --surface:#171b21; --ink:#e7ebf0; --ink-2:#98a2b0; --muted:#6d7682;
      --line:#252b33; --ring:rgba(231,235,240,.10);
      --fees:#199e70; --price:#3987e5;
      --up:#2f9e63; --down:#e07a72; --warnc:#d9a441;
      --accent:#3987e5;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --plane:#0f1216; --surface:#171b21; --ink:#e7ebf0; --ink-2:#98a2b0; --muted:#6d7682;
    --line:#252b33; --ring:rgba(231,235,240,.10);
    --fees:#199e70; --price:#3987e5;
    --up:#2f9e63; --down:#e07a72; --warnc:#d9a441;
    --accent:#3987e5;
  }

  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--plane); color:var(--ink);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  .wrap { max-width:1120px; margin:0 auto; padding:20px 16px 48px; }

  /* Two columns where there is room; the page must not grow without bound.
     stretch, not start: a short headline card beside a tall breakdown otherwise
     leaves a dead rectangle under it. */
  .top { display:grid; gap:14px; grid-template-columns:minmax(0,0.85fr) minmax(0,1.15fr); align-items:stretch; }
  .top > .card { display:flex; flex-direction:column; }
  .hero-card { justify-content:center; }
  /* auto-fit, not auto-fill: a single position must fill the row rather than sit
     next to empty tracks. A wide card suits the range bar anyway. */
  .pos-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  @media (max-width:820px) { .top { grid-template-columns:1fr; } }

  header { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin-bottom:22px; }
  .brand { font-size:13px; font-weight:600; letter-spacing:.18em; color:var(--ink-2); }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip {
    font-size:11px; padding:3px 9px; border-radius:99px;
    border:1px solid var(--ring); color:var(--ink-2); background:var(--surface); white-space:nowrap;
  }
  .chip.live { color:var(--down); border-color:var(--down); font-weight:600; }

  .card { background:var(--surface); border:1px solid var(--ring); border-radius:12px; padding:18px; margin-bottom:14px; }
  h2 { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:0 0 4px; }
  .sub { font-size:13px; color:var(--ink-2); margin:0 0 16px; }

  /* Hero */
  .hero-label { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
  .hero { font-size:52px; line-height:1.05; font-weight:600; margin:6px 0 6px; letter-spacing:-.02em; }
  .hero-sub { font-size:14px; color:var(--ink-2); }
  .hero-split { font-size:13px; color:var(--ink-2); margin-top:9px; padding-top:9px; border-top:1px solid var(--line); }
  .hero-split b { font-weight:600; color:var(--ink); }
  @media (max-width:520px) { .hero { font-size:42px; } }

  /* Contribution bars */
  .contrib { margin-top:6px; }
  .crow { display:grid; grid-template-columns:136px minmax(0,1fr) 84px; gap:14px; align-items:center; margin-bottom:11px; }
  .ckey { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--ink-2); }
  .dot { width:9px; height:9px; border-radius:2px; flex:none; }
  .track { position:relative; height:22px; }
  .zero { position:absolute; top:-3px; bottom:-3px; width:1px; background:var(--line); }
  .fill { position:absolute; top:3px; height:16px; border-radius:3px; min-width:2px; }
  .cval { text-align:right; font-size:14px; font-variant-numeric:tabular-nums; font-weight:600; }
  .crow.total { border-top:1px solid var(--line); padding-top:10px; margin-top:2px; }
  .crow.total .ckey { color:var(--ink); font-weight:600; }

  .explain {
    font-size:13px; line-height:1.6; color:var(--ink-2);
    background:var(--plane); border:1px solid var(--line); border-radius:8px; padding:11px 13px; margin-top:14px;
  }
  .explain b { color:var(--ink); font-weight:600; }

  /* Position card */
  /* The card responds to its own width, not the viewport: one position stretches
     across the grid, three sit side by side, and each lays itself out to suit. */
  .pos { border:1px solid var(--ring); border-radius:12px; background:var(--surface); padding:15px; container-type:inline-size; }
  .pos-body { margin-top:14px; }
  @container (min-width:520px) {
    .pos-body { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); gap:24px; align-items:center; }
    .pos-body .range { margin:0; }
    .pos-body .stats { margin-top:0; }
  }
  .pos-head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; justify-content:space-between; margin-bottom:2px; }
  .pair { font-size:16px; font-weight:600; }
  .status { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; padding:3px 9px; border-radius:99px; }
  .s-good { color:var(--up);    background:color-mix(in srgb, var(--up) 13%, transparent); }
  .s-warn { color:var(--warnc); background:color-mix(in srgb, var(--warnc) 16%, transparent); }
  .s-crit { color:var(--down);  background:color-mix(in srgb, var(--down) 14%, transparent); }
  .s-dim  { color:var(--muted); background:color-mix(in srgb, var(--muted) 14%, transparent); }
  .pos-detail { font-size:13px; color:var(--ink-2); margin:6px 0 0; }

  /* Range */
  .range { margin:16px 0 4px; }
  .rtrack { position:relative; height:8px; border-radius:99px; background:var(--line); }
  .rin { position:absolute; inset:0; border-radius:99px; background:color-mix(in srgb, var(--accent) 26%, transparent); }
  .rmark { position:absolute; top:-5px; width:3px; height:18px; border-radius:2px; background:var(--accent); box-shadow:0 0 0 2px var(--surface); }
  .rmark.out { background:var(--down); }
  .rentry { position:absolute; top:-2px; width:1px; height:12px; background:var(--muted); }
  .rends { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-top:9px; font-variant-numeric:tabular-nums; }
  .rnow { text-align:center; font-size:13px; margin-top:7px; font-variant-numeric:tabular-nums; }

  .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px 12px; margin-top:14px; }
  .stat .k { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .stat .v { font-size:15px; font-weight:600; margin-top:1px; font-variant-numeric:tabular-nums; }
  .meta { font-size:12px; color:var(--muted); margin-top:12px; font-variant-numeric:tabular-nums; }

  details { margin-top:14px; border-top:1px solid var(--line); padding-top:10px; }
  summary { font-size:12px; color:var(--muted); cursor:pointer; list-style:none; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:"▸ "; }
  details[open] summary::before { content:"▾ "; }
  .plan { margin-top:10px; font-size:13px; }
  .plan div { display:flex; justify-content:space-between; gap:12px; padding:4px 0; border-bottom:1px solid var(--line); }
  .plan div:last-child { border-bottom:0; }
  .plan .pk { color:var(--ink-2); }
  .plan .pv { text-align:right; font-variant-numeric:tabular-nums; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:0 10px 7px 0; }
  td { padding:8px 10px 8px 0; border-top:1px solid var(--line); font-variant-numeric:tabular-nums; vertical-align:top; }
  th:last-child, td:last-child { padding-right:0; }
  .num { text-align:right; }

  .up { color:var(--up); } .down { color:var(--down); } .muted { color:var(--muted); }
  .empty { color:var(--muted); font-size:13px; padding:4px 0; }
  ul.feed { list-style:none; margin:0; padding:0; font-size:13px; }
  ul.feed li { padding:9px 0; border-top:1px solid var(--line); }
  ul.feed li:first-child { border-top:0; }
  .kind { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .gloss dt { font-weight:600; font-size:13px; margin-top:12px; }
  .gloss dt:first-child { margin-top:0; }
  .gloss dd { margin:3px 0 0; font-size:13px; color:var(--ink-2); }
  .tabs { display:flex; gap:2px; flex-wrap:wrap; border-bottom:1px solid var(--line); margin:-4px -4px 14px; padding:0 4px; }
  .tab {
    appearance:none; border:0; background:none; cursor:pointer; font:inherit; font-size:13px;
    color:var(--muted); padding:8px 11px; border-bottom:2px solid transparent; margin-bottom:-1px; white-space:nowrap;
  }
  .tab:hover { color:var(--ink-2); }
  .tab[aria-selected="true"] { color:var(--ink); border-bottom-color:var(--accent); font-weight:600; }
  .tab .count { color:var(--muted); font-weight:400; }
  /* Bound the tall lists so one busy day cannot make the page endless. */
  .panel { max-height:420px; overflow-y:auto; overscroll-behavior:contain; }
  .panel table { margin:0; }
  .panel thead th { position:sticky; top:0; background:var(--surface); z-index:1; padding-top:2px; }
  footer { text-align:center; font-size:12px; color:var(--muted); padding-top:18px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="brand">AETERNUM</span>
    <div class="chips">
      <span class="chip" id="mode">…</span>
      <span class="chip" id="uptime">…</span>
      <span class="chip" id="clock">…</span>
    </div>
  </header>

  <div class="top">
    <div class="card hero-card">
      <div class="hero-label" id="heroLabel">Return</div>
      <div class="hero" id="hero">—</div>
      <div class="hero-sub" id="heroSub">…</div>
    </div>

    <div class="card">
      <h2>Where the return came from</h2>
      <p class="sub">A position earns trading fees but loses value when the price moves away from where it entered. These two pull against each other; the net is what you keep.</p>
      <div class="contrib" id="contrib"></div>
      <div class="explain" id="contribNote"></div>
    </div>
  </div>

  <div class="card">
    <h2>Open positions <span class="muted" id="openSub"></span></h2>
    <div class="pos-grid" id="positions"></div>
  </div>

  <div class="card">
    <div class="tabs" id="tabs" role="tablist">
      <button class="tab" role="tab" data-tab="closed">Closed <span class="count" id="cClosed"></span></button>
      <button class="tab" role="tab" data-tab="mix">Why positions ended</button>
      <button class="tab" role="tab" data-tab="decisions">Decisions <span class="count" id="cDec"></span></button>
      <button class="tab" role="tab" data-tab="lessons">Learned <span class="count" id="cLes"></span></button>
      <button class="tab" role="tab" data-tab="help">Reading this page</button>
    </div>

    <div class="tabpane" data-pane="closed">
      <p class="sub">Every position the agent has exited, and what triggered it.</p>
      <div class="panel" id="closed"></div>
    </div>

    <div class="tabpane" data-pane="mix" hidden>
      <p class="sub">The most diagnostic view here. Mostly “out of range” means the ranges are too narrow for the pools being picked; mostly “stop loss” means the volatility filter is too loose.</p>
      <div class="panel" id="mix"></div>
    </div>

    <div class="tabpane" data-pane="decisions" hidden>
      <p class="sub">What the agent chose to do, and the reasoning it recorded at the time.</p>
      <div class="panel" id="decisions"></div>
    </div>

    <div class="tabpane" data-pane="lessons" hidden>
      <p class="sub">Rules the agent wrote for itself after a position taught it something specific.</p>
      <div class="panel" id="lessons"></div>
    </div>

    <div class="tabpane" data-pane="help" hidden>
      <div class="panel">
      <dl class="gloss">
        <dt>Range</dt>
        <dd>The price band your money is working in. Fees accrue only while the price sits inside it. Outside, the position earns nothing and is fully in whichever asset just fell.</dd>
        <dt>Price movement (divergence loss)</dt>
        <dd>As the price moves, the position automatically sells the rising asset and buys the falling one. That is a real cost, and it is what fees have to beat.</dd>
        <dt>Fee APR</dt>
        <dd>Fees earned so far, projected out to a year. Early on it swings wildly — a few minutes of data extrapolated over twelve months. Treat it as a trend, not a forecast.</dd>
        <dt>Time in range</dt>
        <dd>The share of the hold the price actually spent inside the range. Below 50% usually means the range was sized wrong from the start.</dd>
        <dt>SOL price effect</dt>
        <dd>The account is funded in SOL, but a position holds other assets. If SOL falls while your position sits in USDC, the balance rises in SOL terms without the agent having done anything. The headline deliberately excludes it so it is not mistaken for skill.</dd>
        <dt>Trailing stop</dt>
        <dd>Once a position is up enough, the agent remembers the best level reached and closes if the return falls back by a set amount — locking in part of the gain instead of watching it evaporate.</dd>
      </dl>
      </div>
    </div>
  </div>

  <footer id="foot"></footer>
</div>
<script>
const tokenParam = new URLSearchParams(location.search).get("token");
const tok = tokenParam ? "?token=" + encodeURIComponent(tokenParam) : "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const fx = (v, d = 2) => (Number.isFinite(num(v)) ? num(v).toFixed(d) : "—");
const pct = (v, d = 2) => {
  const x = num(v);
  if (!Number.isFinite(x)) return "—";
  const r = Number(x.toFixed(d));
  // Avoid "-0.00%": a value that rounds to zero is zero, not a small loss.
  if (r === 0) return "0." + "0".repeat(d) + "%";
  return (r > 0 ? "+" : "") + r.toFixed(d) + "%";
};
const usd = (v) => { const x = num(v); if (!Number.isFinite(x)) return "—"; const s = x < 0 ? "−$" : "$"; const a = Math.abs(x); return s + (a >= 1000 ? a.toFixed(0) : a.toFixed(2)); };
const dir = (v) => (!Number.isFinite(num(v)) ? "muted" : num(v) > 0 ? "up" : num(v) < 0 ? "down" : "");
const dur = (m) => { const x = num(m); if (!Number.isFinite(x)) return "—"; if (x < 60) return Math.round(x) + " min"; if (x < 2880) return (x/60).toFixed(1) + " h"; return (x/1440).toFixed(1) + " d"; };
const price = (v) => { const x = num(v); if (!Number.isFinite(x)) return "—"; if (x >= 1000) return x.toFixed(2); if (x >= 1) return x.toFixed(4); return x.toPrecision(4); };
const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return Math.round(s) + "s ago"; if (s < 3600) return Math.round(s/60) + "m ago"; if (s < 86400) return (s/3600).toFixed(1) + "h ago"; return (s/86400).toFixed(1) + "d ago"; };

function hero(s) {
  // The headline must measure the same thing the rest of the page decomposes:
  // fees plus price movement. Equity in SOL also contains SOL's own price moves,
  // which nothing below explains — leading with that made the page contradict
  // itself (a positive headline above a negative breakdown).
  const e = s.equity;
  const v = e ? e.strategyReturnPct : (s.performance && s.performance.sampleSize ? s.performance.avgPnlPct : null);
  $("heroLabel").textContent = "Return from the agent's positions";
  $("hero").textContent = pct(v);
  $("hero").className = "hero " + dir(v);

  const held = s.positions.length;
  if (!e) { $("heroSub").textContent = "No account history yet."; return; }

  const fx = num(e.returnPct) - num(e.strategyReturnPct);
  const lines = [
    held + " open · " + (s.performance.sampleSize || 0) + " closed"
      + (e.valued === false ? ' <span class="muted">(one not valued yet)</span>' : ""),
  ];
  const fxNote = Number.isFinite(fx) && Math.abs(fx) >= 0.02
    ? " · SOL's own price " + (fx > 0 ? "added " : "removed ") + pct(Math.abs(fx)).replace("+", "")
    : "";
  lines.push('<span class="muted">Balance ' + esc(fx4(e.totalSol)) + " SOL from " + esc(fx2(e.startingSol))
    + " started (" + pct(e.returnPct) + ")" + fxNote + "</span>");
  $("heroSub").innerHTML = lines.join("<br>");
}

const fx4 = (v) => fx(v, 4);
const fx2 = (v) => fx(v, 2);

function contrib(s) {
  const rows = [
    { key: "Fees earned", v: s.split.feesUsd, color: "var(--fees)" },
    { key: "Price movement", v: s.split.priceUsd, color: "var(--price)" },
  ];
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(num(r.v) || 0)));
  const mid = 50;
  $("contrib").innerHTML = rows.map((r) => {
    const x = num(r.v) || 0;
    const w = (Math.abs(x) / max) * 46;
    const left = x >= 0 ? mid : mid - w;
    return '<div class="crow">'
      + '<div class="ckey"><span class="dot" style="background:' + r.color + '"></span>' + r.key + "</div>"
      + '<div class="track"><span class="zero" style="left:' + mid + '%"></span>'
      + '<span class="fill" style="left:' + left + "%;width:" + w + "%;background:" + r.color + '"></span></div>'
      + '<div class="cval ' + dir(x) + '">' + usd(x) + "</div></div>";
  }).join("")
  + '<div class="crow total"><div class="ckey">Net</div><div class="track"></div>'
  + '<div class="cval ' + dir(s.split.totalPnlUsd) + '">' + usd(s.split.totalPnlUsd) + "</div></div>";

  // This note must not diagnose beyond its evidence. An earlier version asserted
  // "the ranges are too narrow" whenever price movement outweighed fees — which it
  // happily said about a position that had spent 100% of its life inside its range.
  // A confident wrong cause is worse than no cause, especially for a reader who
  // cannot yet tell the difference.
  const f = num(s.split.feesUsd) || 0, p = num(s.split.priceUsd) || 0;
  const closedN = (s.performance && s.performance.sampleSize) || 0;

  // How much observation actually stands behind the numbers.
  const openMinutes = s.positions.reduce((t, x) => t + (num(x.minutesHeld) || 0), 0);
  const closedMinutes = s.closed.reduce((t, x) => t + (num(x.minutesHeld) || 0), 0);
  const hours = (openMinutes + closedMinutes) / 60;

  // Evidence for the "ranges too narrow" story, rather than an assumption of it.
  const inRangeSamples = [...s.positions, ...s.closed]
    .map((x) => num(x.timeInRangePct)).filter(Number.isFinite);
  const avgInRange = inRangeSamples.length
    ? inRangeSamples.reduce((a, b) => a + b, 0) / inRangeSamples.length : null;
  const oorShare = closedN
    ? ((s.performance.byCloseReason || [])
        .filter((r) => /out of range/i.test(r.key))
        .reduce((t, r) => t + r.count, 0)) / closedN
    : 0;

  let note;
  if (!closedN && !s.positions.length) {
    note = "Nothing to split yet — this fills in once the agent opens its first position.";
  } else if (hours < 6 && !closedN) {
    note = "<b>Too early to read.</b> " + usd(f) + " of fees against " + usd(p)
      + " of price movement, over " + (hours < 1 ? Math.round(hours * 60) + " minutes" : fx(hours, 1) + " hours")
      + " and nothing closed yet. At this stage the figure is mostly the cost of entering plus whichever way the price happened to drift. What matters is whether fee income outgrows price movement over days, not hours.";
  } else if (f + p > 0) {
    note = "<b>Fees are ahead.</b> The price moved against the positions by " + usd(Math.abs(p))
      + ", and " + usd(f) + " of fee income more than covered it. That is exactly what a liquidity position is for.";
  } else if (avgInRange !== null && avgInRange >= 75 && oorShare < 0.3) {
    note = "<b>Price movement is ahead, but the ranges are holding.</b> Price stayed inside them "
      + Math.round(avgInRange) + "% of the time, so this is ordinary divergence — the position sells whatever is rising and buys whatever is falling as the price moves. The question is whether these pairs pay enough in fees to cover how much they move; fees have not caught up yet.";
  } else if (avgInRange !== null && avgInRange < 75) {
    note = "<b>Price movement is ahead, and the ranges are being left behind.</b> Price sat inside them only "
      + Math.round(avgInRange) + "% of the time"
      + (oorShare >= 0.3 ? ", and " + Math.round(oorShare * 100) + "% of exits were out-of-range" : "")
      + ". A position earns nothing outside its range, so the ranges look too narrow for how much these pairs move.";
  } else {
    note = "Fees so far: " + usd(f) + ". Price movement: " + usd(p) + ". Not enough history yet to say which part is the agent's doing.";
  }
  $("contribNote").innerHTML = note;
}

function statusClass(state) {
  return state === "in_range" ? "s-good" : state === "near_edge" ? "s-warn" : state === "out_of_range" ? "s-crit" : "s-dim";
}
function statusIcon(state) {
  return state === "in_range" ? "●" : state === "near_edge" ? "▲" : state === "out_of_range" ? "■" : "○";
}

function positions(s) {
  $("openSub").textContent = s.positions.length ? s.positions.length + " / " + s.limits.maxPositions : "";
  if (!s.positions.length) {
    $("positions").innerHTML = '<div class="empty">No open positions. The agent screens for candidates every ' + s.limits.screenIntervalMin + ' minutes and only opens one when a pool clears every filter — long stretches with nothing open are normal.</div>';
    return;
  }
  $("positions").innerHTML = s.positions.map((p) => {
    const lo = num(p.priceLower), hi = num(p.priceUpper), now = num(p.price), en = num(p.entryPrice);
    const span = hi - lo;
    const clamp = (x) => Math.max(0, Math.min(100, x));
    const posPct = Number.isFinite(now) && span > 0 ? clamp(((now - lo) / span) * 100) : null;
    const enPct = Number.isFinite(en) && span > 0 ? clamp(((en - lo) / span) * 100) : null;
    const out = p.health.state === "out_of_range";

    return '<div class="pos">'
      + '<div class="pos-head"><span class="pair">' + esc(p.pair || "position") + "</span>"
      + '<span class="status ' + statusClass(p.health.state) + '">' + statusIcon(p.health.state) + " " + esc(p.health.headline) + "</span></div>"
      + '<div class="pos-detail">' + esc(p.health.detail) + "</div>"

      + '<div class="pos-body"><div class="range"><div class="rtrack"><span class="rin"></span>'
      + (enPct !== null ? '<span class="rentry" style="left:' + enPct + '%"></span>' : "")
      + (posPct !== null ? '<span class="rmark' + (out ? " out" : "") + '" style="left:calc(' + posPct + '% - 1px)"></span>' : "")
      + '</div><div class="rends"><span>' + price(lo) + "</span><span>" + price(hi) + "</span></div>"
      + '<div class="rnow">now <b>' + price(now) + "</b>" + (Number.isFinite(en) ? ' <span class="muted">· in at ' + price(en) + "</span>" : "") + "</div></div>"

      + "<div><div class=\"stats\">"
      + '<div class="stat"><div class="k">Return</div><div class="v ' + dir(p.pnlPct) + '">' + pct(p.pnlPct) + "</div></div>"
      + '<div class="stat"><div class="k">From fees</div><div class="v ' + dir(p.feeContribPct) + '">' + pct(p.feeContribPct) + "</div></div>"
      + '<div class="stat"><div class="k">From price</div><div class="v ' + dir(p.priceContribPct) + '">' + pct(p.priceContribPct) + "</div></div>"
      + "</div>"
      + '<div class="meta">fee APR ' + (p.feeAprPct !== null ? fx(p.feeAprPct, 0) + "%" : "—")
      + " · in range " + (p.timeInRangePct !== null ? p.timeInRangePct + "%" : "—")
      + " · held " + dur(p.minutesHeld) + "</div></div></div>"

      + (p.pendingExit ? '<div class="explain"><b>Closing soon.</b> The “' + esc(p.pendingExit.replace(/_/g, " ")) + '” rule has triggered and is waiting for a second confirming reading.</div>' : "")

      + "<details><summary>What would close this position</summary><div class=\"plan\">"
      + p.exitPlan.map((r) => '<div><span class="pk">' + esc(r.label) + '</span><span class="pv">' + esc(r.at) + (Number.isFinite(num(r.away)) ? ' <span class="muted">(' + fx(Math.abs(num(r.away))) + "% away)</span>" : "") + "</span></div>").join("")
      + "</div></details></div>";
  }).join("");
}

function closed(s) {
  if (!s.closed.length) { $("closed").innerHTML = '<div class="empty">Nothing closed yet.</div>'; return; }
  $("closed").innerHTML = "<table><thead><tr><th>Pair</th><th class='num'>Return</th><th class='num'>Fees</th><th class='num'>Held</th><th class='num'>In range</th><th>Closed because</th></tr></thead><tbody>"
    + s.closed.map((c) => "<tr><td>" + esc(c.pair || "—") + "</td>"
      + '<td class="num ' + dir(c.pnlPct) + '">' + pct(c.pnlPct) + "</td>"
      + '<td class="num">' + usd(c.feesUsd) + "</td>"
      + '<td class="num">' + dur(c.minutesHeld) + "</td>"
      + '<td class="num">' + (c.timeInRangePct !== null ? c.timeInRangePct + "%" : "—") + "</td>"
      + '<td class="muted">' + esc(c.closeReason || "") + "</td></tr>").join("") + "</tbody></table>";
}

function mix(s) {
  const rows = (s.performance && s.performance.byCloseReason) || [];
  if (!rows.length) { $("mix").innerHTML = '<div class="empty">Needs closed positions before this means anything.</div>'; return; }
  $("mix").innerHTML = "<table><thead><tr><th>Reason</th><th class='num'>Count</th><th class='num'>Win rate</th><th class='num'>Avg return</th></tr></thead><tbody>"
    + rows.map((r) => "<tr><td>" + esc(r.key) + "</td><td class='num'>" + r.count + "</td><td class='num'>" + fx(r.winRate, 0) + "%</td>"
      + "<td class='num " + dir(r.avgPnlPct) + "'>" + pct(r.avgPnlPct) + "</td></tr>").join("") + "</tbody></table>";
}

function decisions(s) {
  if (!s.decisions.length) { $("decisions").innerHTML = '<div class="empty">No decisions recorded yet.</div>'; return; }
  $("decisions").innerHTML = '<ul class="feed">' + s.decisions.map((d) =>
    "<li><span class=\"kind\">" + esc(d.kind.replace(/_/g, " ")) + "</span> "
    + (d.pair ? "<b>" + esc(d.pair) + "</b> " : "")
    + '<span class="muted">' + ago(d.at) + "</span><br>"
    + esc(d.summary || d.reason || "")
    + (d.summary && d.reason && d.reason !== d.summary ? '<br><span class="muted">' + esc(d.reason.slice(0, 260)) + "</span>" : "")
    + "</li>").join("") + "</ul>";
}

function lessonList(s) {
  if (!s.lessons.length) { $("lessons").innerHTML = '<div class="empty">Nothing yet — the agent writes a lesson when a closed position taught it something specific.</div>'; return; }
  $("lessons").innerHTML = '<ul class="feed">' + s.lessons.map((l) => "<li>" + (l.pinned ? "📌 " : "") + esc(l.rule) + "</li>").join("") + "</ul>";
}

// Tab state lives outside refresh so a 15s update never yanks the reader back.
let activeTab = localStorage.getItem("aeternum.tab") || "closed";
function selectTab(name) {
  activeTab = name;
  try { localStorage.setItem("aeternum.tab", name); } catch (e) { /* private mode */ }
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tabpane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) selectTab(b.dataset.tab);
});
selectTab(activeTab);

async function refresh() {
  try {
    const r = await fetch("/api/state" + tok, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 401 ? "Add ?token=… to the URL" : "HTTP " + r.status);
    const s = await r.json();
    $("mode").textContent = s.mode;
    $("mode").className = "chip" + (s.mode === "live" ? " live" : "");
    $("uptime").textContent = s.startedAt ? "running " + ago(s.startedAt).replace(" ago", "") : "";
    $("clock").textContent = new Date(s.at).toLocaleTimeString();
    hero(s); contrib(s); positions(s); closed(s); mix(s); decisions(s); lessonList(s);
    $("cClosed").textContent = s.closed.length ? "(" + s.closed.length + ")" : "";
    $("cDec").textContent = s.decisions.length ? "(" + s.decisions.length + ")" : "";
    $("cLes").textContent = s.lessons.length ? "(" + s.lessons.length + ")" : "";
    $("foot").textContent = "Screens every " + s.limits.screenIntervalMin + " min · reviews every "
      + s.limits.manageIntervalMin + " min · checks positions every " + s.watcher.intervalSec + "s"
      + (s.paper ? " · paper run: position values are exact, fee income is estimated" : "")
      + (s.creatorFee && s.creatorFee.enabled
        ? " · creator fee " + s.creatorFee.pct.toFixed(2) + "% on Jupiter swaps"
          + (s.paper ? " (not charged in paper mode)" : "") + ", disable with AETERNUM_REFERRAL_FEE_BPS=0"
        : "");
  } catch (e) {
    $("foot").textContent = "Could not refresh: " + e.message;
  }
}
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>
`;

function authorized(url) {
  if (!token) return true;
  return url.searchParams.get("token") === token;
}

export function start() {
  if (server) return { started: false, reason: "already running" };
  if (!config.dashboard.enabled) return { started: false, reason: "disabled" };

  const { host, port } = config.dashboard;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

  token = config.dashboard.token;
  if (!isLoopback && !token) {
    // Reachable beyond this machine means position and PnL data is reachable too.
    // Generate a token rather than serve it open, and print the full URL once.
    token = crypto.randomBytes(12).toString("hex");
    log("dashboard", "Host is not loopback and no token was set — generated one");
  }

  server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }

    if (url.pathname === "/api/state") {
      if (!authorized(url)) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"token required"}');
        return;
      }
      let body;
      try {
        body = JSON.stringify(buildState());
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // The page itself is public; the data behind it is what the token guards.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  // A dashboard must never be able to take the agent down.
  server.on("error", (err) => {
    log("dashboard_error", `${err.message}`);
    server = null;
  });

  server.listen(port, host, () => {
    const shown = isLoopback ? "127.0.0.1" : host === "0.0.0.0" ? localAddress() : host;
    log("dashboard", `http://${shown}:${port}/${token ? `?token=${token}` : ""}`);
  });

  return { started: true, port, host };
}

/** Best-guess LAN address, so the logged URL is one you can actually click. */
function localAddress() {
  try {
    const nets = Object.values(os.networkInterfaces()).flat();
    const lan = nets.find((net) => net && net.family === "IPv4" && !net.internal && !/^172\.1[6-9]\./.test(net.address));
    return lan?.address ?? "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

export function stop() {
  if (server) server.close();
  server = null;
  return { stopped: true };
}

export function status() {
  return {
    running: !!server,
    enabled: config.dashboard.enabled,
    host: config.dashboard.host,
    port: config.dashboard.port,
    tokenRequired: !!token,
  };
}
