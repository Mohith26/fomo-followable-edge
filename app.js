import { hydrate, verify, simulateFollow, timingEdge, backtest, benjaminiHochberg, discoveryQuality, feeRate } from './core/edge.js';

window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));

// ---------------------------------------------------------------- state
const LS = 'fomo-edge-v1';
const DELAY_LABEL = { 0: 'Instant', 1: '1 min', 2: '2 min', 5: '5 min' };
const DELAY_SHORT = { 0: 'Instant', 1: '1m', 2: '2m', 5: '5m' };
const Q_OPTS = [0.05, 0.1, 0.2];
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
const S = {
  data: null, loadError: null,
  delay: saved.delay ?? 1, q: saved.q ?? 0.1, copy: saved.copy ?? 250,
  follows: new Set(saved.follows || []), notifyVerified: saved.notifyVerified ?? true,
  verifiedOnly: saved.verifiedOnly ?? false, lbTab: saved.lbTab || 'edge',
  view: 'board', traderId: null, tradeIdx: 0, subtab: 'trades',
  sort: { key: 'evidence', dir: 1 }, kb: 0,
  overlays: { leader: true, copy: true, volume: true }, rightTab: 'all'
};
function persist() {
  localStorage.setItem(LS, JSON.stringify({ delay: S.delay, q: S.q, copy: S.copy, follows: [...S.follows], notifyVerified: S.notifyVerified, verifiedOnly: S.verifiedOnly, lbTab: S.lbTab }));
}

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtUsd = (x, sign = false) => {
  const a = Math.abs(x);
  const s = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (x < 0 ? '-' : sign ? '+' : '') + '$' + s;
};
const fmtPct = (x, d = 2, sign = true) => (x > 0 && sign ? '+' : x < 0 ? '-' : '') + Math.abs(x * 100).toFixed(d) + '%';
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : 'muted');
const odds = (p) => (p >= 0.5 ? 'coin flip' : '1 in ' + Math.round(1 / p).toLocaleString('en-US') + (p <= 0.0010001 ? '+' : ''));
const minuteToDate = (m) => new Date((S.data.meta.start + m * 60) * 1000);
const fmtTime = (m) => { const d = minuteToDate(m); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC'; };
const fmtHold = (min) => (min < 60 ? min + 'm' : min < 1440 ? Math.floor(min / 60) + 'h ' + (min % 60 ? (min % 60) + 'm' : '') : (min / 1440).toFixed(1) + 'd');
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const PAL = [['#ff9a3c', '#ff5e62'], ['#6f85ff', '#221d4b'], ['#21c95e', '#0b3b1c'], ['#ffc861', '#af770f'], ['#fd5dd3', '#29112b'], ['#51a0b7', '#12313d'], ['#c1c1c1', '#5c5c5c'], ['#ffa35f', '#a4571c'], ['#9b8cff', '#2b2266'], ['#7ee3c4', '#16463a']];
function avatar(handle, verified, size = '') {
  const h = hash(handle), [a, b] = PAL[h % PAL.length], k = (h >> 8) % 4, id = 'g' + h.toString(36);
  const shapes = [
    `<circle cx="20" cy="22" r="9" fill="#ffffffd0"/><circle cx="16.5" cy="21" r="1.6" fill="#111"/><circle cx="23.5" cy="21" r="1.6" fill="#111"/>`,
    `<rect x="11" y="13" width="18" height="16" rx="5" fill="#ffffffcc"/><rect x="15" y="19" width="3" height="3" fill="#111"/><rect x="22" y="19" width="3" height="3" fill="#111"/>`,
    `<path d="M10 28 L20 10 L30 28 Z" fill="#ffffffc8"/><circle cx="20" cy="22" r="2" fill="#111"/>`,
    `<circle cx="20" cy="20" r="11" fill="none" stroke="#ffffffcc" stroke-width="3"/><circle cx="20" cy="20" r="4" fill="#ffffffcc"/>`
  ];
  return `<span class="av ${size}"><svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="40" height="40" fill="url(#${id})"/>${shapes[k]}</svg>${verified ? '<span class="vb" title="Verified edge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' : ''}</span>`;
}
const TOKC = { BONK: '#f7a325', WIF: '#c49a6c', POPCAT: '#e9e2d0', Fartcoin: '#5bbf6a', PENGU: '#7fb4ff', MEW: '#f4c27a', GOAT: '#b7b0a1', Pnut: '#d29a5b', MOODENG: '#e6a3b0', SPX: '#ff6a6a', CHILLGUY: '#9fd3c7', mihao: '#e8c39e', TRUMP: '#f2c14e', DEGEN: '#a36efd', KEYCAT: '#f0d36b', ZCAT: '#d9a066', CARDS: '#5aa9ff' };
function tokIcon(sym, size = 18) { const c = TOKC[sym] || '#9899a3'; return `<span class="tok" style="width:${size}px;height:${size}px;background:${c}" title="${esc(sym)}">${esc(sym[0])}</span>`; }
function tokStack(t) {
  const cnt = new Map(); for (const x of t.trades) cnt.set(x.tok, (cnt.get(x.tok) || 0) + 1);
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
  return `<div class="tokstack">${top.slice(0, 3).map(([k]) => tokIcon(k)).join('')}${top.length > 3 ? `<span class="more">${top.length - 3}+</span>` : ''}</div>`;
}
function rankMark(rk) {
  if (rk > 3) return rk + '.';
  const [a, b] = [['#ffc861', '#af770f'], ['#fff3dc', '#5c5c5c'], ['#ffa35f', '#a4571c']][rk - 1];
  return `<svg width="20" height="24" viewBox="0 0 20 24" aria-label="Rank ${rk}"><path d="M5 14 L3 23 L7 21 L10 23 L10 15 Z M15 14 L17 23 L13 21 L10 23 L10 15 Z" fill="${b}"/><circle cx="10" cy="9" r="8" fill="${a}" stroke="${b}" stroke-width="1.5"/><text x="10" y="12.5" text-anchor="middle" font-size="10" font-weight="700" fill="#1b1206" font-family="Geist">${rk}</text></svg>`;
}
function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 2 } }); }
function toast(msg) { const t = $('#toast'); t.innerHTML = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }

// ---------------------------------------------------------------- model (recomputed when delay / q / copy change)
let M = null;
function compute() {
  const D = S.data;
  const v = verify(D.traders, { delayKey: S.delay, q: S.q, minTrades: 5 });
  const byPnl = [...D.traders].sort((a, b) => b.pnl - a.pnl);
  const rank = new Map(byPnl.map((t, i) => [t.id, i + 1]));
  const rows = D.traders.map((t) => {
    const sim = simulateFollow(t.trades, { delayKey: S.delay, copy: S.copy, fee: D.fee, depth: D.depth, net: D.net });
    const edge = timingEdge(t.trades, S.delay);
    return { t, rank: rank.get(t.id), verified: v.verified.has(t.id), eligible: t.n >= 5, p: t.p[S.delay], edge, sim };
  });
  const top20 = byPnl.slice(0, 20).filter((t) => v.verified.has(t.id)).length;
  const bt = backtest(D.traders, { delayKey: S.delay, q: S.q, copy: S.copy, fee: D.fee, depth: D.depth, net: D.net, split: D.meta.split, minTrades: 5 });
  // synthetic-only ground truth check
  const elig = D.traders.filter((t) => t.n >= 5);
  const followable = elig.map((t) => (S.delay === 0 ? t.type === 'swing' || t.type === 'sniper' : t.type === 'swing'));
  const dq = discoveryQuality(elig.map((t) => v.verified.has(t.id)), followable);
  const luck = elig.filter((t) => v.verified.has(t.id) && (t.type === 'random' || t.type === 'whale')).length;
  const naive = benjaminiHochberg(elig.map((t) => t.pUniform1), S.q);
  const naiveLuck = elig.filter((t, i) => naive.reject[i] && (t.type === 'random' || t.type === 'whale')).length;
  M = { v, rows, byId: new Map(rows.map((r) => [r.t.id, r])), top20, bt, dq, luck, naive: { k: naive.k, luck: naiveLuck } };
}
function sortedRows() {
  let rows = M.rows;
  if (S.verifiedOnly) rows = rows.filter((r) => r.verified);
  const k = S.sort.key, d = S.sort.dir;
  const val = {
    evidence: (r) => (r.eligible ? r.p - (r.verified ? 1 : 0) : 2) - r.edge * 1e-3,
    rank: (r) => r.rank, pnl: (r) => -r.t.pnl, n: (r) => -r.t.n, edge: (r) => -r.edge, p: (r) => r.p, follow: (r) => -r.sim.pnl
  }[k];
  return [...rows].sort((a, b) => d * (val(a) - val(b)));
}
function leftRows() {
  let rows = S.lbTab === 'traders' ? [...M.rows].sort((a, b) => a.rank - b.rank) : sortedRows();
  if (S.verifiedOnly) rows = rows.filter((r) => r.verified);
  return rows;
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs || '');
  if (params.has('d') && [0, 1, 2, 5].includes(+params.get('d'))) S.delay = +params.get('d');
  if (params.has('q') && Q_OPTS.includes(+params.get('q') / 100)) S.q = +params.get('q') / 100;
  if (params.has('c')) S.copy = Math.min(1000, Math.max(10, +params.get('c') || 250));
  const parts = (path || '/').split('/').filter(Boolean);
  if (parts[0] === 'trader' && parts[1]) {
    const t = S.data && S.data.traders.find((x) => x.handle.toLowerCase() === decodeURIComponent(parts[1]).toLowerCase());
    if (t) { S.view = 'trader'; S.traderId = t.id; S.tradeIdx = Math.min(+(params.get('t') || 0), t.trades.length - 1); S.subtab = params.get('tab') || 'trades'; return; }
    S.view = 'missing'; S.missing = decodeURIComponent(parts[1]); return;
  }
  S.view = parts[0] === 'backtest' ? 'backtest' : 'board';
}
function buildHash(view = S.view, extra = {}) {
  const p = new URLSearchParams({ d: S.delay, q: Math.round(S.q * 100), c: S.copy, ...extra });
  if (view === 'trader') {
    const t = S.data.traders[S.traderId];
    return `#/trader/${encodeURIComponent(t.handle)}?${p}&t=${S.tradeIdx}${S.subtab !== 'trades' ? '&tab=' + S.subtab : ''}`;
  }
  return (view === 'backtest' ? '#/backtest?' : '#/?') + p;
}
function go(h) { if (location.hash !== h) location.hash = h; else render(); }
function syncUrl() { history.replaceState(null, '', buildHash()); }

// ---------------------------------------------------------------- render: left panel
function renderLeft() {
  document.querySelectorAll('[data-lb]').forEach((b) => { b.classList.toggle('active', b.dataset.lb === S.lbTab); b.setAttribute('aria-selected', b.dataset.lb === S.lbTab); });
  $('#verified-only').setAttribute('aria-pressed', S.verifiedOnly);
  const el = $('#lb-list');
  if (!S.data) { el.innerHTML = S.loadError ? '' : Array.from({ length: 9 }, () => '<div class="lb-row"><div class="skel" style="height:12px"></div><div class="skel" style="width:36px;height:36px;border-radius:50%"></div><div><div class="skel" style="height:12px;width:70%"></div><div class="skel" style="height:10px;width:45%;margin-top:6px"></div></div><div class="skel" style="height:12px;width:60px"></div></div>').join(''); return; }
  const rows = leftRows().slice(0, 100);
  const me = `<div class="yourrank"><span class="me sm"><span>M</span></span><div><div class="s12 muted">Your rank</div><div class="yr"><span style="color:var(--accent-g)">#</span> 18,520</div></div><span class="grow"></span><span class="neg num">-$6.38</span></div>`;
  if (!rows.length) { el.innerHTML = `<div class="empty">No verified traders at ${Math.round(S.q * 100)}% FDR with a ${DELAY_LABEL[S.delay]} delay.<br><button class="btn" style="margin-top:12px" data-act="loosen">Allow 20% FDR</button></div>`; return; }
  el.innerHTML = me + rows.map((r, i) => {
    const t = r.t, rk = S.lbTab === 'traders' ? r.rank : i + 1;
    const sub = S.lbTab === 'traders'
      ? `${t.n} trades · ${fmtUsd(t.vol)} vol`
      : r.eligible ? `<span class="${cls(r.edge)}">${fmtPct(Math.expm1(r.edge))}</span> edge / trade` : `${t.n} trades · needs 5+`;
    return `<div class="lb-row ${S.view === 'trader' && S.traderId === t.id ? 'sel' : ''}" data-trader="${t.id}" role="button" tabindex="0" aria-label="${esc(t.handle)}">
      <div class="lb-rank">${rankMark(rk)}</div>${avatar(t.handle, r.verified)}
      <div style="min-width:0"><div class="lb-name"><span class="h">${esc(t.handle)}</span>${r.verified ? '<span class="vbadge">Edge</span>' : ''}</div><div class="lb-sub">${sub}</div></div>
      <div class="lb-r"><div class="lb-pnl ${cls(t.pnl)}">${fmtUsd(t.pnl, true)}</div>${tokStack(t)}</div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- render: center
const SORT_COLS = [
  ['rank', 'PnL #', 'l'], ['trader', 'Trader', 'l'], ['pnl', '7D PnL'], ['edge', 'Edge / trade'], ['p', 'Luck odds'], ['follow', 'If you copied'], ['f', '']
];
function controls() {
  return `<div class="toolbar">
    <span class="tlabel">Delay</span><div class="seg" role="radiogroup" aria-label="Follower delay">${[0, 1, 2, 5].map((d) => `<button role="radio" aria-checked="${S.delay === d}" class="${S.delay === d ? 'on' : ''}" data-delay="${d}">${DELAY_SHORT[d]}</button>`).join('')}</div>
    <div class="tsep"></div>
    <span class="tlabel">FDR</span><div class="seg" role="radiogroup" aria-label="FDR target">${Q_OPTS.map((q) => `<button role="radio" aria-checked="${S.q === q}" class="${S.q === q ? 'on' : ''}" data-q="${q}">≤${Math.round(q * 100)}%</button>`).join('')}</div>
    <div class="tsep"></div>
    <span class="tlabel">Copy</span><span class="num" style="font-weight:500">$${S.copy}</span><span class="tlabel">/trade</span>
    <span class="grow"></span>
    <button class="btn ghost" data-act="csv" title="Export CSV (e)"><i data-lucide="download" class="ic14"></i>CSV</button>
    <button class="btn ghost" data-act="json" aria-label="Export JSON" title="Export JSON"><i data-lucide="braces" class="ic14"></i></button>
  </div>`;
}
function headerStats() {
  return `<div class="stats">
    <div class="stat"><div class="k">Verified</div><div class="v num">${M.v.k} <span class="muted s12">of ${M.v.eligible}</span></div></div>
    <div class="stat"><div class="k">Top 20 by PnL</div><div class="v num">${M.top20} <span class="muted s12">verified</span></div></div>
    <div class="stat"><div class="k">Badge cutoff</div><div class="v num">${M.v.k ? 'p ≤ ' + M.v.threshold.toFixed(4) : 'none'}</div></div>
  </div>`;
}
function renderBoard(c) {
  const bt = M.bt;
  const rows = sortedRows();
  const sortIc = (k) => (S.sort.key === k ? `<i data-lucide="${S.sort.dir === 1 ? 'arrow-down' : 'arrow-up'}" class="ic12"></i>` : '');
  c.innerHTML = `
  <div class="mhead"><div class="mtitle"><div><h1>Followable edge <span class="lev">New</span><span class="tip" data-tip="A trader gets the Edge badge when their entries, replayed ${DELAY_LABEL[S.delay].toLowerCase()} late, beat random entries into the same tokens (same hold, timed where the token was actually trading in the same 12-hour block). Benjamini-Hochberg keeps the share of lucky traders among badges at or below ${Math.round(S.q * 100)}%."><i data-lucide="info" class="ic16"></i></span></h1><div class="sub">Whose moves still pay after the notification</div></div></div>${headerStats()}</div>
  ${controls()}
  <div class="cards">
    <div class="card"><div class="k"><i data-lucide="badge-check" class="ic14" style="color:var(--accent-g)"></i>Verified edge, ${DELAY_LABEL[S.delay].toLowerCase()} delay</div><div class="v num">${M.v.k} traders</div><div class="d">${M.top20} of the 7D top 20 by PnL qualify. ${M.v.eligible - M.v.k} traders with 5+ trades can't be told apart from random timing.</div></div>
    <a class="card" href="${buildHash('backtest')}"><div class="k"><i data-lucide="trophy" class="ic14"></i>Copy the PnL top 10 (backtest)</div><div class="v num ${cls(bt.topPnl.ret)}">${fmtPct(bt.topPnl.ret)} <span class="muted s12" style="font-size:14px;font-weight:400">per trade</span></div><div class="d">Picked on Nov 3-6, copied Nov 7-9: ${bt.topPnl.trades} trades, ${fmtUsd(bt.topPnl.pnl, true)} at $${S.copy}/trade.</div></a>
    <a class="card" href="${buildHash('backtest')}"><div class="k"><i data-lucide="badge-check" class="ic14" style="color:var(--accent-g)"></i>Copy verified traders (backtest)</div><div class="v num ${cls(bt.verified.ret)}">${fmtPct(bt.verified.ret)} <span class="muted s12" style="font-size:14px;font-weight:400">per trade</span></div><div class="d">Badged on Nov 3-6 data only, copied Nov 7-9: ${bt.verified.traders} traders, ${bt.verified.trades} trades, ${fmtUsd(bt.verified.pnl, true)}.</div></a>
  </div>
  ${rows.length ? `<table class="tbl" aria-label="Followable edge leaderboard"><thead><tr>${SORT_COLS.map(([k, label, x]) => `<th class="${x || ''}">${['trader', 'status', 'f'].includes(k) ? label : `<button data-sort="${k === 'rank' ? 'rank' : k}" class="${S.sort.key === k ? 'on' : ''}">${label}${sortIc(k)}</button>`}</th>`).join('')}</tr></thead>
  <tbody>${rows.slice(0, 150).map((r, i) => {
    const t = r.t;
    const bar = Math.min(1, -Math.log10(r.p) / 3);
    const name = `<span>${esc(t.handle)}</span>${r.verified ? '<span class="vbadge">Edge</span>' : !r.eligible ? '<span class="pill n s12">5+ trades</span>' : ''}`;
    return `<tr data-trader="${t.id}" class="${i === S.kb ? 'kb' : ''}"><td class="l muted num">${r.rank}</td>
      <td class="l"><div class="tcell-trader">${avatar(t.handle, r.verified)}<div><div class="row" style="gap:6px;justify-content:flex-start">${name}</div><div class="s12 muted">${t.n} trades</div></div></div></td>
      <td class="num ${cls(t.pnl)}">${fmtUsd(t.pnl, true)}</td>
      <td class="num ${cls(r.edge)}">${fmtPct(Math.expm1(r.edge))}</td>
      <td class="num">${odds(r.p)}<span class="oddsbar"><i style="width:${(bar * 100).toFixed(0)}%"></i></span></td>
      <td class="num"><div class="${cls(r.sim.pnl)}">${fmtUsd(r.sim.pnl, true)}</div><div class="s12 muted">${fmtPct(r.sim.ret, 1)} / trade</div></td>
      <td><button class="followbtn ${S.follows.has(t.id) ? 'on' : ''}" data-follow="${t.id}" aria-pressed="${S.follows.has(t.id)}" aria-label="${S.follows.has(t.id) ? 'Unfollow' : 'Follow'} ${esc(t.handle)}">${S.follows.has(t.id) ? 'Following' : 'Follow'}</button></td></tr>`;
  }).join('')}</tbody></table>` : `<div class="state"><i data-lucide="search-x" class="ic16"></i><h3>No verified traders</h3><div>Nobody's timing survives a ${DELAY_LABEL[S.delay]} delay at ${Math.round(S.q * 100)}% FDR. Try a shorter delay or a looser FDR.</div><button class="btn" data-act="loosen">Allow 20% FDR</button></div>`}`;
}

let chart = null, chartRO = null;
const priceCache = new Map();
async function prices(sym) {
  if (!priceCache.has(sym)) priceCache.set(sym, fetch(`data/prices/${sym}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }));
  return priceCache.get(sym);
}
function renderTrader(c) {
  const r = M.byId.get(S.traderId), t = r.t;
  const tr = t.trades[S.tradeIdx];
  const following = S.follows.has(t.id);
  c.innerHTML = `
  <div class="mhead">
    <div class="mtitle">${avatar(t.handle, r.verified)}<div><h1 style="font-size:18px">${esc(t.handle)} ${r.verified ? '<span class="lev">Edge</span>' : ''}<span class="hicons"><i data-lucide="star" class="ic16"></i><i data-lucide="link" class="ic16" data-act="copylink" style="cursor:pointer"></i></span></h1><div class="sub">#${r.rank} on 7D PnL · ${t.n} trades</div></div></div>
    <div class="stats">
      <div class="stat plain big"><div class="k">7D PnL</div><div class="v num ${cls(t.pnl)}">${fmtUsd(t.pnl, true)}</div></div>
      <div class="stat"><div class="k">Edge / trade</div><div class="v num ${cls(r.edge)}">${fmtPct(Math.expm1(r.edge))}</div></div>
      <div class="stat"><div class="k">Luck odds</div><div class="v num">${odds(r.p)}</div></div>
      <div class="stat"><div class="k">If you copied</div><div class="v num ${cls(r.sim.pnl)}">${fmtUsd(r.sim.pnl, true)}</div></div>
      <div class="stat"><div class="k">Delay</div><div class="v">${DELAY_LABEL[S.delay]}</div></div>
    </div>
  </div>
  <div class="toolbar" style="padding-top:0">
    <button class="btn ghost" data-act="back" title="Back (Esc)"><i data-lucide="arrow-left" class="ic14"></i>Leaderboard</button>
    <div class="tsep"></div>
    <span class="tlabel">Trade</span>
    <button class="btn ghost" data-act="prev" aria-label="Previous trade"><i data-lucide="chevron-left" class="ic14"></i></button>
    <span class="num" style="font-weight:500;white-space:nowrap">${S.tradeIdx + 1} / ${t.n}</span>
    <button class="btn ghost" data-act="next" aria-label="Next trade"><i data-lucide="chevron-right" class="ic14"></i></button>
    <span class="tlabel"><b style="color:var(--fg);font-weight:500">${esc(tr.tok)}</b> · ${fmtTime(tr.entry)} · held ${fmtHold(tr.exit - tr.entry)}</span>
    <span class="grow"></span>
    <div class="seg" role="radiogroup" aria-label="Follower delay">${[0, 1, 2, 5].map((d) => `<button role="radio" aria-checked="${S.delay === d}" class="${S.delay === d ? 'on' : ''}" data-delay="${d}">${DELAY_SHORT[d]}</button>`).join('')}</div>
  </div>
  <div class="ctool"><span class="cbtn on">${tr.exit - tr.entry > 900 ? '1h' : tr.exit - tr.entry > 240 ? '15m' : tr.exit - tr.entry > 45 ? '5m' : '1m'}</span><span class="vsep"></span><span class="cbtn"><i data-lucide="chart-candlestick" class="ic16"></i></span><span class="vsep"></span><span class="cbtn"><i data-lucide="sigma" class="ic16"></i>Indicators</span><span class="vsep"></span><span class="cbtn dim"><i data-lucide="undo-2" class="ic16"></i></span><span class="cbtn dim"><i data-lucide="redo-2" class="ic16"></i></span><span class="grow"></span><span class="cbtn"><i data-lucide="settings" class="ic16"></i></span><span class="cbtn"><i data-lucide="maximize" class="ic16"></i></span><span class="cbtn"><i data-lucide="camera" class="ic16"></i></span></div>
  <div class="chartwrap"><div class="legend" id="legend"></div><div id="chart"><div class="skel" style="position:absolute;inset:12px"></div></div><div id="bubbles" class="bubbles" aria-hidden="true"></div></div>
  <div class="overlays"><span class="t">Chart overlays</span>
    <label><input type="checkbox" data-ov="leader" ${S.overlays.leader ? 'checked' : ''}>Trader's trades</label>
    <label><input type="checkbox" data-ov="copy" ${S.overlays.copy ? 'checked' : ''}>Your copy (${DELAY_LABEL[S.delay].toLowerCase()})</label>
    <label><input type="checkbox" data-ov="volume" ${S.overlays.volume ? 'checked' : ''}>Volume</label>
    <span class="grow"></span><span class="s12 muted">Real 1-minute ${esc(tr.tok)} candles (GeckoTerminal)</span></div>
  <div class="subtabs" role="tablist">${[['trades', 'Trades'], ['luck', 'Luck test'], ['delay', 'Delay decay']].map(([k, l]) => `<button role="tab" aria-selected="${S.subtab === k}" class="subtab ${S.subtab === k ? 'on' : ''}" data-sub="${k}">${l}</button>`).join('')}</div>
  <div id="subview"></div>`;
  renderSub(r);
  drawChart(t, tr);
}
function renderSub(r) {
  const t = r.t, el = $('#subview'), d = S.delay;
  if (S.subtab === 'trades') {
    const sim = r.sim;
    el.innerHTML = `<table class="tbl" aria-label="Trades"><thead><tr><th class="l">Token</th><th class="l">Opened</th><th>Hold</th><th>Size</th><th>Trader net</th><th>Random entry (avg)</th><th>Timing edge</th><th>Your copy net</th></tr></thead><tbody>${t.trades.map((x, i) => {
      const te = Math.log(x.g[d]) - x.base[d];
      return `<tr data-trade="${i}" class="${i === S.tradeIdx ? 'kb' : ''}"><td class="l" style="font-weight:500">${esc(x.tok)}</td><td class="l muted">${fmtTime(x.entry)}</td><td class="num">${fmtHold(x.exit - x.entry)}</td><td class="num">$${x.size.toLocaleString('en-US')}</td>
        <td class="num ${cls(x.lead)}">${fmtPct(x.lead)}</td><td class="num muted">${fmtPct(Math.expm1(x.base[d]))}</td><td class="num ${cls(te)}">${fmtPct(Math.expm1(te))}</td><td class="num ${cls(sim.per[i])}">${fmtPct(sim.per[i])}</td></tr>`;
    }).join('')}</tbody></table>`;
  } else if (S.subtab === 'luck') {
    const h = t.hist[d], max = Math.max(...h.c), W = 560, H = 200, bw = W / h.c.length;
    const xo = ((t.obs[d] - h.lo) / (h.hi - h.lo)) * W;
    const ge = Math.round(r.p * 1000) - 1;
    el.innerHTML = `<div class="histwrap"><div><svg class="hist" viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Null distribution of mean return for random entry timing, with this trader's result marked">
      ${h.c.map((v, i) => `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - (v / max) * (H - 10)).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((v / max) * (H - 10)).toFixed(1)}" rx="2" fill="#cbd0eb33"/>`).join('')}
      <line x1="${xo}" x2="${xo}" y1="6" y2="${H}" stroke="#6f85ff" stroke-width="2"/><text x="${xo > W - 110 ? xo - 6 : xo + 6}" text-anchor="${xo > W - 110 ? 'end' : 'start'}" y="18" fill="#6f85ff" font-size="15" font-family="Geist">${esc(t.handle)}</text>
      <text x="0" y="${H + 20}" fill="#9899a3" font-size="14" font-family="Geist">${fmtPct(Math.expm1(h.lo))}</text><text x="${W}" y="${H + 20}" text-anchor="end" fill="#9899a3" font-size="14" font-family="Geist">${fmtPct(Math.expm1(h.hi))}</text>
      <text x="${W / 2}" y="${H + 20}" text-anchor="middle" fill="#9899a3" font-size="14" font-family="Geist">avg return per trade, ${DELAY_LABEL[d].toLowerCase()} late</text></svg></div>
      <div class="kv"><span class="k">Replays of these ${t.n} trades</span><span class="num">999</span><span class="k">Replays that did as well</span><span class="num">${Math.max(0, ge)}</span><span class="k">Luck odds (p-value)</span><span class="num">${odds(r.p)} (${r.p.toFixed(4)})</span><span class="k">Badge cutoff at ${Math.round(S.q * 100)}% FDR</span><span class="num">${M.v.k ? 'p ≤ ' + M.v.threshold.toFixed(4) : 'no badges'}</span><span class="k">Result</span><span>${!r.eligible ? 'Needs 5+ trades' : r.verified ? '<span class="vbadge">Verified edge</span>' : 'Unproven'}</span></div></div>
      <div class="explain">Each replay keeps every one of ${esc(t.handle)}'s trades (same token, same hold time) but moves the entry to a random minute in the same 12-hour block, drawn in proportion to how much that token was actually trading. Buying when everyone else is buying is not skill, so the replays buy at busy times too. The blue line is the real average, shifted ${DELAY_LABEL[d].toLowerCase()} late to match what a follower gets. Benjamini-Hochberg then picks the cutoff so that across the whole board at most ${Math.round(S.q * 100)}% of badges are expected to be luck.</div>`;
  } else {
    const W = 560, H = 170;
    const vals = [0, 1, 2, 5].map((dd) => ({ dd, e: Math.expm1(timingEdge(t.trades, dd)), p: t.p[dd], ver: verify(S.data.traders, { delayKey: dd, q: S.q }).verified.has(t.id) }));
    const mx = Math.max(0.002, ...vals.map((x) => Math.abs(x.e)));
    const bw = 90, gap = (W - 4 * bw) / 5, mid = H / 2;
    el.innerHTML = `<div class="histwrap"><svg class="hist" viewBox="0 0 ${W} ${H + 30}" role="img" aria-label="Timing edge by follower delay">
      <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="#ffffff1a"/>
      ${vals.map((x, i) => { const hgt = (Math.abs(x.e) / mx) * (mid - 14), xx = gap + i * (bw + gap); return `<rect x="${xx}" y="${x.e >= 0 ? mid - hgt : mid}" width="${bw}" height="${Math.max(1, hgt)}" rx="4" fill="${x.ver ? '#516af6' : x.e >= 0 ? '#21c95e55' : '#ff622e55'}"/><text x="${xx + bw / 2}" y="${x.e >= 0 ? mid - hgt - 6 : mid + hgt + 14}" text-anchor="middle" font-size="12" fill="#f7f7f7" font-family="Geist">${fmtPct(x.e)}</text><text x="${xx + bw / 2}" y="${H + 24}" text-anchor="middle" font-size="12" fill="${x.dd === S.delay ? '#f7f7f7' : '#9899a3'}" font-family="Geist">${DELAY_LABEL[x.dd]}</text>`; }).join('')}</svg>
      <div class="kv">${vals.map((x) => `<span class="k">${DELAY_LABEL[x.dd]}</span><span class="num">${odds(x.p)} ${x.ver ? '<span class="vbadge">Edge</span>' : ''}</span>`).join('')}</div></div>
      <div class="explain">Edge per trade (actual entry vs. the exact average of random entries in the same window) when you act 0, 1, 2 or 5 minutes after ${esc(t.handle)}. Blue bars are verified at ${Math.round(S.q * 100)}% FDR. Snipers look brilliant at "Instant" and lose the edge by the time a human follower can act; that is what this view is for.</div>`;
  }
  icons();
}
async function drawChart(t, tr) {
  const host = $('#chart');
  let px;
  try { px = await prices(tr.tok); } catch (e) {
    host.innerHTML = `<div class="state"><h3>Couldn't load ${esc(tr.tok)} prices</h3><button class="btn" data-act="retry-chart">Retry</button></div>`; return;
  }
  if (S.view !== 'trader' || S.data.traders[S.traderId].trades[S.tradeIdx] !== tr) return;
  host.innerHTML = '';
  if (chartRO) chartRO.disconnect();
  if (!window.LightweightCharts) { host.innerHTML = '<div class="state">Chart library failed to load.</div>'; return; }
  const hold = tr.exit - tr.entry;
  const agg = hold > 900 ? 60 : hold > 240 ? 15 : hold > 45 ? 5 : 1;
  const pad = Math.max(60, Math.round(hold * 0.5)) * 1;
  const lo = Math.max(0, tr.entry - pad), hi = Math.min(px.c.length - 1, tr.exit + pad + 6);
  const candles = [], vols = [];
  for (let m = lo - (lo % agg); m <= hi; m += agg) {
    let o = px.o[m], h = -Infinity, l = Infinity, c = px.c[m], v = 0;
    for (let k = m; k < Math.min(m + agg, px.c.length); k++) { h = Math.max(h, px.h[k]); l = Math.min(l, px.l[k]); c = px.c[k]; v += px.v[k]; }
    const time = px.start + m * 60;
    candles.push({ time, open: o, high: h, low: l, close: c });
    vols.push({ time, value: v, color: c >= o ? '#21c95e55' : '#ff622e55' });
  }
  chart = LightweightCharts.createChart(host, {
    layout: { background: { type: 'solid', color: '#060510' }, textColor: '#9899a3', fontFamily: 'Geist, system-ui, sans-serif', fontSize: 12 },
    grid: { vertLines: { color: '#ffffff08' }, horzLines: { color: '#ffffff08' } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.2, bottom: 0.18 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: 0, vertLine: { color: '#ffffff40', labelBackgroundColor: '#161522' }, horzLine: { color: '#ffffff40', labelBackgroundColor: '#161522' } },
    localization: { priceFormatter: (p) => '$' + (p >= 1 ? p.toFixed(3) : p.toPrecision(4)) }
  });
  const cs = chart.addCandlestickSeries({ upColor: '#21c95e', downColor: '#ff622e', borderVisible: false, wickUpColor: '#21c95e', wickDownColor: '#ff622e', priceLineColor: '#21c95e', priceFormat: { type: 'price', precision: 8, minMove: 1e-8 } });
  cs.setData(candles);
  if (S.overlays.volume) {
    const vs = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    vs.setData(vols);
  }
  const snap = (m) => px.start + (m - (m % agg)) * 60;
  // trade bubbles drawn as HTML over the chart (fomo shows trader avatars on its chart)
  const bub = [];
  if (S.overlays.leader) { bub.push({ m: tr.entry, p: px.c[tr.entry], html: avatar(t.handle, false), k: 'lead', tip: `${t.handle} bought $${tr.size.toLocaleString('en-US')}` }); bub.push({ m: tr.exit, p: px.c[tr.exit], html: avatar(t.handle, false), k: 'lead sell', tip: `${t.handle} sold` }); }
  if (S.overlays.copy) { bub.push({ m: tr.entry + S.delay, p: px.c[tr.entry + S.delay], html: '<span class="you">You</span>', k: 'copy', tip: `You buy ${DELAY_LABEL[S.delay].toLowerCase()} later` }); bub.push({ m: tr.exit + S.delay, p: px.c[tr.exit + S.delay], html: '<span class="you">You</span>', k: 'copy sell', tip: 'You sell' }); }
  const layer = $('#bubbles');
  const place = () => {
    if (!chart || !layer) return;
    layer.innerHTML = bub.map((b) => {
      const x = chart.timeScale().timeToCoordinate(snap(b.m)), y = cs.priceToCoordinate(b.p);
      if (x == null || y == null) return '';
      return `<div class="bubble ${b.k}" style="left:${x}px;top:${y}px" title="${esc(b.tip)}">${b.html}</div>`;
    }).join('');
  };
  cs.setMarkers([]);  chart.timeScale().fitContent();
  const last = candles[candles.length - 1];
  const sim = M.byId.get(t.id).sim.per[S.tradeIdx];
  $('#legend').innerHTML = `<span class="t">${esc(tr.tok)} · ${agg === 60 ? '1h' : agg + 'm'} · GeckoTerminal</span> &nbsp;<b>trader</b> <span class="${cls(tr.lead)}">${fmtPct(tr.lead)}</span> &nbsp;<b>you</b> <span class="${cls(sim)}">${fmtPct(sim)}</span> &nbsp;<b>C</b><span class="o">$${last.close.toPrecision(5)}</span>`;
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(place));
  requestAnimationFrame(place);
  chartRO = new ResizeObserver(() => { if (chart) { chart.applyOptions({ width: host.clientWidth, height: host.clientHeight }); requestAnimationFrame(place); } });
  chartRO.observe(host);
}

let btChart = null;
function renderBacktest(c) {
  const bt = M.bt;
  const truthNote = `<b>${M.dq.discoveries}</b> badges at ${DELAY_LABEL[S.delay].toLowerCase()} delay; <b>${M.dq.discoveries - M.dq.false}</b> are traders built with real followable skill (${(M.dq.fdp * 100).toFixed(1)}% false, target ≤ ${Math.round(S.q * 100)}%), finding ${(M.dq.power * 100).toFixed(0)}% of the ${M.dq.trueCount} skilled traders. Pure-luck traders badged: <b>${M.luck}</b>. A naive null that draws entry times uniformly (ignoring when the token was trading) would badge ${M.naive.k} at 1 min, including <b>${M.naive.luck}</b> pure-luck traders.`;
  c.innerHTML = `
  <div class="mhead"><div class="mtitle"><div><h1>Backtest <span class="lev">Out of sample</span></h1><div class="sub">Picked on Nov 3-6 · copied Nov 7-9 · ${DELAY_LABEL[S.delay].toLowerCase()} late · $${S.copy}/trade</div></div></div>${headerStats()}</div>
  ${controls()}
  <div class="cards" style="grid-template-columns:1fr 1fr">
    <div class="card"><div class="k"><i data-lucide="trophy" class="ic14"></i>Copy the PnL top 10</div><div class="v num ${cls(bt.topPnl.ret)}">${fmtPct(bt.topPnl.ret)} <span class="muted" style="font-size:14px;font-weight:400">per trade</span></div><div class="d">${bt.topPnl.trades} copied trades · ${fmtUsd(bt.topPnl.pnl, true)} on ${fmtUsd(bt.topPnl.trades * S.copy)} deployed</div></div>
    <div class="card"><div class="k"><i data-lucide="badge-check" class="ic14" style="color:var(--accent-g)"></i>Copy verified traders (${bt.verified.traders})</div><div class="v num ${cls(bt.verified.ret)}">${fmtPct(bt.verified.ret)} <span class="muted" style="font-size:14px;font-weight:400">per trade</span></div><div class="d">${bt.verified.trades} copied trades · ${fmtUsd(bt.verified.pnl, true)} on ${fmtUsd(bt.verified.trades * S.copy)} deployed</div></div>
  </div>
  <div class="sectionh"><h2>Follower PnL, Nov 7-9</h2><span class="s12" style="color:#ffbf17">● PnL top 10</span><span class="s12" style="color:var(--accent-g)">● Verified</span></div>
  <div class="chartwrap" style="height:300px"><div id="btchart" style="position:absolute;inset:0"></div></div>
  <div class="sectionh"><h2>Ground truth check</h2><span class="pill n">synthetic data only</span></div>
  <div class="explain">The traders in this demo are simulated on real prices, so we know who was built with skill. ${truthNote}</div>
  <div class="sectionh"><h2>Who got picked</h2></div>
  <div class="cards" style="grid-template-columns:1fr 1fr;padding-top:0">
    <div><div class="s12 muted" style="padding:0 4px 4px">PnL top 10 (Nov 3-6)</div>${bt.topPnl.ids.map((id) => pickRow(id)).join('')}</div><div><div class="s12 muted" style="padding:0 4px 4px">Verified on Nov 3-6 data</div>${bt.verified.ids.length ? bt.verified.ids.map((id) => pickRow(id)).join('') : '<div class="empty">No traders verified on Nov 3-6 at this setting.</div>'}</div>
  </div>`;
  const host = $('#btchart');
  if (!window.LightweightCharts) return;
  btChart = LightweightCharts.createChart(host, {
    layout: { background: { type: 'solid', color: '#060510' }, textColor: '#9899a3', fontFamily: 'Geist, system-ui, sans-serif', fontSize: 12 },
    grid: { vertLines: { color: '#ffffff08' }, horzLines: { color: '#ffffff08' } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
    localization: { priceFormatter: (p) => fmtUsd(p, true) }
  });
  const toSeries = (curve) => { const out = []; let lastT = -1; for (const [m, v] of curve) { const time = S.data.meta.start + m * 60; if (time === lastT) out[out.length - 1].value = v; else out.push({ time, value: v }); lastT = time; } return out; };
  const a = btChart.addLineSeries({ color: '#ffbf17', lineWidth: 2, priceLineVisible: false });
  a.setData(toSeries(bt.topPnl.curve));
  const b = btChart.addLineSeries({ color: '#6f85ff', lineWidth: 2, priceLineVisible: false });
  b.setData(toSeries(bt.verified.curve));
  btChart.timeScale().fitContent();
  new ResizeObserver(() => btChart && btChart.applyOptions({ width: host.clientWidth, height: host.clientHeight })).observe(host);
}
function pickRow(id) {
  const r = M.byId.get(id), t = r.t;
  return `<div class="fl-row" data-trader="${id}">${avatar(t.handle, r.verified)}<span style="flex:1">${esc(t.handle)}</span><span class="num ${cls(t.pnl)}">${fmtUsd(t.pnl, true)}</span></div>`;
}

// ---------------------------------------------------------------- right panel
function renderRight() {
  const el = $('#right');
  if (!S.data) { el.innerHTML = '<div class="skel" style="height:46px"></div><div class="skel" style="height:90px"></div><div class="skel" style="height:34px"></div>'; return; }
  const trader = S.view === 'trader' ? M.byId.get(S.traderId) : null;
  const followRows = [...S.follows].map((id) => M.byId.get(id)).filter(Boolean).filter((r) => S.rightTab === 'all' || r.verified);
  const pos = Math.log(S.copy / 10) / Math.log(100);
  let top;
  if (trader) {
    const t = trader.t, d = S.delay, n = t.trades.length;
    const gross0 = t.trades.reduce((a, x) => a + (x.g[0] - 1), 0) / n;
    const grossD = t.trades.reduce((a, x) => a + (x.g[d] - 1), 0) / n;
    const net = trader.sim.ret;
    const following = S.follows.has(t.id);
    top = `<div class="lsx"><button class="on blue" aria-pressed="true">Copy check</button><button data-act="toggle-notify-tab" title="Notification settings">Alerts</button></div>
    <div class="row"><span class="mini">Per trade <i data-lucide="repeat" class="ic12 muted"></i></span><span class="mini out"><i data-lucide="clock" class="ic12"></i>${DELAY_LABEL[d]}</span></div>
    <div class="bigbox"><div class="amt num ${cls(trader.sim.pnl)}">${fmtUsd(trader.sim.pnl, true)}</div><div class="rt"><div class="num">${n} trades</div><div class="muted">if you copied</div></div></div>
    ${slider(pos)}
    <div class="hint"><span>$${S.copy} per trade</span><span>${fmtUsd(S.copy * n)} deployed</span></div>
    <div class="sep"></div>
    <div class="row"><button class="lever" data-act="cycle-delay">${DELAY_LABEL[d]} delay <i data-lucide="chevrons-up-down" class="ic14"></i></button><span class="row" style="gap:8px"><span>Only if verified</span><button class="toggle" role="switch" aria-checked="${S.notifyVerified}" aria-label="Notify only for verified edge" data-act="notify"></button></span></div>
    <div class="sep"></div>
    <div class="dl">
      <span class="k">Trader's move / trade</span><span class="v num ${cls(gross0)}">${fmtPct(gross0)}</span>
      <span class="k">Lost to your delay</span><span class="v num ${cls(grossD - gross0)}">${fmtPct(grossD - gross0)}</span>
      <span class="k">Fees + price impact</span><span class="v num neg">${fmtPct(net - grossD)}</span>
      <span class="k">Your net / trade</span><span class="v num ${cls(net)}">${fmtPct(net)}</span>
      <span class="k">Fee per side</span><span class="v num">${(feeRate(S.copy, 'solana') * 100).toFixed(2)}% ($${(S.copy * feeRate(S.copy, 'solana')).toFixed(2)})</span>
    </div>
    <button class="cta ${following ? 'off' : trader.verified ? '' : 'blue'}" data-follow="${t.id}">${following ? 'Following ' + esc(t.handle) : 'Follow ' + esc(t.handle)}</button>
    ${!trader.verified && !following ? `<div class="s12 muted" style="text-align:center;margin-top:-4px">${trader.eligible ? 'Unproven: timing not distinguishable from luck yet' : 'Needs 5+ trades before it can be checked'}</div>` : ''}`;
  } else {
    const all = [...S.follows].map((id) => M.byId.get(id)).filter(Boolean);
    const tot = all.reduce((a, r) => a + r.sim.pnl, 0), nTr = all.reduce((a, r) => a + r.sim.n, 0);
    const ver = M.rows.filter((r) => r.verified);
    top = `<div class="lsx"><button class="on blue" aria-pressed="true">Copy check</button><button data-act="toggle-notify-tab">Alerts</button></div>
    <div class="row"><span class="mini">Your follows <i data-lucide="users" class="ic12 muted"></i></span><span class="mini out"><i data-lucide="clock" class="ic12"></i>${DELAY_LABEL[S.delay]}</span></div>
    <div class="bigbox"><div class="amt num ${cls(tot)}">${fmtUsd(tot, true)}</div><div class="rt"><div class="num">${nTr} trades</div><div class="muted">${all.length} followed</div></div></div>
    ${slider(pos)}
    <div class="hint"><span>$${S.copy} per trade</span><span>${fmtUsd(S.copy * nTr)} deployed</span></div>
    <div class="sep"></div>
    <div class="row"><button class="lever" data-act="cycle-delay">${DELAY_LABEL[S.delay]} delay <i data-lucide="chevrons-up-down" class="ic14"></i></button><span class="row" style="gap:8px"><span>Only if verified</span><button class="toggle" role="switch" aria-checked="${S.notifyVerified}" aria-label="Notify only for verified edge" data-act="notify"></button></span></div>
    <div class="sep"></div>
    <div class="dl">
      <span class="k">Verified at this delay</span><span class="v num">${ver.length}</span>
      <span class="k">Your follows verified</span><span class="v num">${all.filter((r) => r.verified).length} / ${all.length}</span>
      <span class="k">Alerts you'd get (7d)</span><span class="v num">${2 * all.filter((r) => !S.notifyVerified || r.verified).reduce((a, r) => a + r.t.n, 0)}</span>
    </div>
    <button class="cta blue" data-act="follow-verified" ${ver.every((r) => S.follows.has(r.t.id)) ? 'disabled style="opacity:.5"' : ''}>Follow all verified (${ver.length})</button>`;
  }
  el.innerHTML = top + `<div class="yp"><div class="row" style="margin-top:6px"><h3>Following</h3><div class="seg"><button class="${S.rightTab === 'all' ? 'on' : ''}" data-rtab="all">All</button><button class="${S.rightTab === 'verified' ? 'on' : ''}" data-rtab="verified">Verified</button></div></div>
    ${followRows.length ? followRows.map((r) => `<div class="fl-row" data-trader="${r.t.id}">${avatar(r.t.handle, r.verified)}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(r.t.handle)}</span><span class="num ${cls(r.sim.pnl)}">${fmtUsd(r.sim.pnl, true)}</span><button class="ptab icon" data-unfollow="${r.t.id}" aria-label="Unfollow ${esc(r.t.handle)}"><i data-lucide="x" class="ic14"></i></button></div>`).join('') : `<div class="empty">${S.follows.size ? 'None of your follows are verified' : 'No follows yet'}</div>`}</div>`;
  const inp = $('#copy-size');
  if (inp) {
    inp.addEventListener('input', (e) => {
      S.copy = Math.max(10, Math.round((10 * Math.pow(100, +e.target.value)) / 5) * 5);
      const f = $('.slider .fill'); if (f) f.style.width = (+e.target.value * 100) + '%';
      const h = $('.hint span'); if (h) h.textContent = `$${S.copy} per trade`;
    });
    inp.addEventListener('change', () => { persist(); syncUrl(); render(); });
  }
}
function slider(pos) {
  return `<div class="slider"><div class="fill" style="width:${(pos * 100).toFixed(1)}%"></div><input id="copy-size" type="range" min="0" max="1" step="0.005" value="${pos}" aria-label="Copy size per trade, $10 to $1,000"></div>`;
}

// ---------------------------------------------------------------- main render
function render() {
  if (S.data) parseHash();
  const c = $('#center');
  if (chart && S.view !== 'trader') { chart.remove(); chart = null; }
  if (btChart) { btChart.remove(); btChart = null; }
  if (S.loadError) {
    c.innerHTML = `<div class="state"><i data-lucide="wifi-off" class="ic16"></i><h3>Couldn't load the leaderboard</h3><div>${esc(S.loadError)}</div><button class="btn" data-act="reload">Retry</button></div>`;
    renderLeft(); renderRight(); icons(); return;
  }
  if (!S.data) {
    c.innerHTML = `<div class="mhead"><div class="skel" style="height:28px;width:260px"></div></div><div class="skel" style="height:34px;margin:6px 4px"></div><div class="cards">${'<div class="skel" style="height:110px"></div>'.repeat(3)}</div>${'<div class="skel" style="height:34px;margin:8px 4px"></div>'.repeat(8)}`;
    renderLeft(); renderRight(); return;
  }
  compute();
  if (S.view === 'missing') c.innerHTML = `<div class="state"><i data-lucide="user-x" class="ic16"></i><h3>No trader called "${esc(S.missing)}"</h3><a class="btn" href="${buildHash('board')}">Back to leaderboard</a></div>`;
  else if (S.view === 'trader') renderTrader(c);
  else if (S.view === 'backtest') renderBacktest(c);
  else renderBoard(c);
  renderLeft(); renderRight(); icons();
  document.title = S.view === 'trader' ? `${S.data.traders[S.traderId].handle} · Followable edge | fomo` : 'Leaderboard · Followable edge | fomo';
}

// ---------------------------------------------------------------- export
function exportData(kind) {
  const rows = sortedRows().map((r) => ({
    handle: r.t.handle, pnl_rank: r.rank, pnl_7d_usd: r.t.pnl, trades: r.t.n, delay_min: S.delay, fdr_target: S.q,
    edge_per_trade: +Math.expm1(r.edge).toFixed(6), p_value: r.p, verified: r.verified, copy_usd_per_trade: S.copy, copy_pnl_usd: +r.sim.pnl.toFixed(2), copy_return_per_trade: +r.sim.ret.toFixed(6)
  }));
  let blob, name;
  if (kind === 'json') { blob = new Blob([JSON.stringify({ settings: { delay_min: S.delay, fdr_target: S.q, copy_usd: S.copy, badge_cutoff_p: M.v.threshold }, backtest: { topPnl: { ...M.bt.topPnl, curve: undefined }, verified: { ...M.bt.verified, curve: undefined } }, traders: rows }, null, 1)], { type: 'application/json' }); name = 'fomo-followable-edge.json'; }
  else { const cols = Object.keys(rows[0]); blob = new Blob([[cols.join(','), ...rows.map((r) => cols.map((k) => r[k]).join(','))].join('\n')], { type: 'text/csv' }); name = 'fomo-followable-edge.csv'; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`<i data-lucide="check" class="ic14"></i> Exported ${rows.length} traders`); icons();
}

// ---------------------------------------------------------------- events
function setDelay(d) { S.delay = d; persist(); go(buildHash()); }
function toggleFollow(id) {
  const t = S.data.traders[id];
  if (S.follows.has(id)) { S.follows.delete(id); toast(`Unfollowed ${esc(t.handle)}`); }
  else { S.follows.add(id); const r = M.byId.get(id); toast(`<i data-lucide="bell-ring" class="ic14"></i> Following ${esc(t.handle)}${S.notifyVerified && !r.verified ? ' · alerts start once verified' : ''}`); }
  persist(); render();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-delay],[data-q],[data-sort],[data-follow],[data-unfollow],[data-trader],[data-trade],[data-sub],[data-act],[data-lb],[data-rtab],[data-ov],#verified-only,.sr-item');
  if (!b || !S.data && !b.matches('[data-act="reload"]')) return;
  if (b.matches('[data-ov]')) { S.overlays[b.dataset.ov] = b.checked; render(); return; }
  if (b.dataset.delay !== undefined) return setDelay(+b.dataset.delay);
  if (b.dataset.q) { S.q = +b.dataset.q; persist(); return go(buildHash()); }
  if (b.dataset.sort) { const k = b.dataset.sort; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 }; S.kb = 0; return render(); }
  if (b.dataset.follow) { e.stopPropagation(); return toggleFollow(+b.dataset.follow); }
  if (b.dataset.unfollow) { e.stopPropagation(); return toggleFollow(+b.dataset.unfollow); }
  if (b.dataset.lb) { S.lbTab = b.dataset.lb; persist(); return renderLeft(); }
  if (b.dataset.rtab) { S.rightTab = b.dataset.rtab; return renderRight(), icons(); }
  if (b.id === 'verified-only') { S.verifiedOnly = !S.verifiedOnly; persist(); return render(); }
  if (b.dataset.sub) { S.subtab = b.dataset.sub; syncUrl(); renderSub(M.byId.get(S.traderId)); document.querySelectorAll('.subtab').forEach((x) => { x.classList.toggle('on', x.dataset.sub === S.subtab); x.setAttribute('aria-selected', x.dataset.sub === S.subtab); }); return; }
  if (b.dataset.trade !== undefined) { S.tradeIdx = +b.dataset.trade; return go(buildHash()); }
  if (b.classList.contains('sr-item')) { closeSearch(); S.traderId = +b.dataset.id; S.tradeIdx = 0; S.subtab = 'trades'; return go(buildHash('trader')); }
  if (b.dataset.trader !== undefined) { S.traderId = +b.dataset.trader; S.tradeIdx = 0; S.subtab = 'trades'; return go(buildHash('trader')); }
  const act = b.dataset.act;
  if (act === 'csv' || act === 'json') return exportData(act);
  if (act === 'back') return go(buildHash('board'));
  if (act === 'prev' || act === 'next') { const n = S.data.traders[S.traderId].trades.length; S.tradeIdx = (S.tradeIdx + (act === 'next' ? 1 : n - 1)) % n; return go(buildHash()); }
  if (act === 'cycle-delay') { const D = [0, 1, 2, 5]; return setDelay(D[(D.indexOf(S.delay) + 1) % D.length]); }
  if (act === 'notify') { S.notifyVerified = !S.notifyVerified; persist(); return render(); }
  if (act === 'loosen') { S.q = 0.2; persist(); return go(buildHash()); }
  if (act === 'follow-verified') { M.rows.filter((r) => r.verified).forEach((r) => S.follows.add(r.t.id)); persist(); toast(`<i data-lucide="bell-ring" class="ic14"></i> Following ${M.v.k} verified traders`); return render(); }
  if (act === 'copylink') { navigator.clipboard?.writeText(location.href); toast('<i data-lucide="link" class="ic14"></i> Link copied'); icons(); return; }
  if (act === 'toggle-notify-tab') { toast('Alert thresholds live in Settings in the real app'); return; }
  if (act === 'retry-chart') { const tr = S.data.traders[S.traderId].trades[S.tradeIdx]; priceCache.delete(tr.tok); return render(); }
  if (act === 'reload') { S.loadError = null; return load(); }
});
document.addEventListener('keydown', (e) => {
  if (!S.data) return;
  const typing = e.target.matches('input[type=text]');
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; }
  if (typing) return;
  if (e.key === 'Escape' && S.view !== 'board') { go(buildHash('board')); return; }
  if (e.key === 'e') return exportData('csv');
  if (e.key === 'v') { S.verifiedOnly = !S.verifiedOnly; persist(); return render(); }
  if (e.key === 'd') { const D = [0, 1, 2, 5]; return setDelay(D[(D.indexOf(S.delay) + 1) % D.length]); }
  if (S.view === 'board') {
    const rows = sortedRows();
    if (e.key === 'j' || e.key === 'ArrowDown') { S.kb = Math.min(rows.length - 1, S.kb + 1); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { S.kb = Math.max(0, S.kb - 1); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[S.kb]) { S.traderId = rows[S.kb].t.id; S.tradeIdx = 0; return go(buildHash('trader')); }
    else if (e.key === 'f' && rows[S.kb]) return toggleFollow(rows[S.kb].t.id);
    else return;
    document.querySelectorAll('.tbl tbody tr').forEach((tr, i) => tr.classList.toggle('kb', i === S.kb));
    document.querySelectorAll('.tbl tbody tr')[S.kb]?.scrollIntoView({ block: 'nearest' });
  } else if (S.view === 'trader') {
    const n = S.data.traders[S.traderId].trades.length;
    if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'ArrowRight') { S.tradeIdx = (S.tradeIdx + 1) % n; go(buildHash()); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') { S.tradeIdx = (S.tradeIdx + n - 1) % n; go(buildHash()); e.preventDefault(); }
    else if (e.key === 'f') toggleFollow(S.traderId);
  }
});
// search
let srSel = 0;
function closeSearch() { $('#search-results').hidden = true; $('#search').value = ''; $('#search').blur(); }
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase(), box = $('#search-results');
  if (!q || !S.data) { box.hidden = true; return; }
  const hits = M.rows.filter((r) => r.t.handle.toLowerCase().includes(q)).sort((a, b) => a.rank - b.rank).slice(0, 8);
  srSel = 0;
  box.hidden = false;
  box.innerHTML = hits.length ? hits.map((r, i) => `<div class="sr-item" role="option" aria-selected="${i === 0}" data-id="${r.t.id}">${avatar(r.t.handle, r.verified)}<div style="flex:1"><div>${esc(r.t.handle)}</div><div class="s12 muted">#${r.rank} · ${r.t.n} trades</div></div><span class="num ${cls(r.t.pnl)}">${fmtUsd(r.t.pnl, true)}</span></div>`).join('') : '<div class="empty">No traders match</div>';
});
$('#search').addEventListener('keydown', (e) => {
  const items = [...document.querySelectorAll('.sr-item')];
  if (e.key === 'Escape') return closeSearch();
  if (!items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { srSel = (srSel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; items.forEach((x, i) => x.setAttribute('aria-selected', i === srSel)); e.preventDefault(); }
  if (e.key === 'Enter') items[srSel].click();
});
$('#search').addEventListener('blur', () => setTimeout(() => ($('#search-results').hidden = true), 150));
$('#deposit').addEventListener('click', () => toast('Deposits are disabled in this concept demo'));
window.addEventListener('hashchange', render);

async function load() {
  render();
  try {
    const r = await fetch('data/board.json');
    if (!r.ok) throw new Error(`HTTP ${r.status} loading data/board.json`);
    S.data = hydrate(await r.json());
  } catch (e) { S.loadError = e.message || String(e); }
  render();
}
window.addEventListener('DOMContentLoaded', load);
