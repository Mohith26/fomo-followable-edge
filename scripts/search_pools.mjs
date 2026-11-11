// Resolves the deepest pool for each symbol via GeckoTerminal search. Writes data/pools.json.
import { writeFileSync } from 'node:fs';
const H = { Accept: 'application/json;version=20230302' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { await sleep(20000); continue; }
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return r.json();
  }
  throw new Error('rate limited ' + url);
}
// Tokens visible in fomo's own Discover "Most held" table (release notes, Oct 16 2026) plus large Solana/Base memecoins.
const WANT = [
  ['STONK','solana'],['CATI','solana'],['PONS','solana'],['ZCAT','solana'],['MARSCOIN','solana'],['MASK','solana'],['USELESS','solana'],['CARDS','solana'],['ORBIO','solana'],
  ['BONK','solana'],['WIF','solana'],['POPCAT','solana'],['Fartcoin','solana'],['PENGU','solana'],['MEW','solana'],['GOAT','solana'],['Pnut','solana'],['MOODENG','solana'],['SPX','solana'],['CHILLGUY','solana'],['mihao','solana'],['TRUMP','solana'],
  ['BRETT','base'],['TOSHI','base'],['DEGEN','base'],['KEYCAT','base'],['SKI','base']
];
const START = Date.UTC(2026, 10, 3);
const out = [];
for (const [sym, net] of WANT) {
  const d = await get(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(sym)}&network=${net}`);
  const cands = (d.data || []).map((p) => ({ p, a: p.attributes })).filter(({ a }) => {
    const [b] = a.name.split(' / ');
    return b.trim().toUpperCase().replace('$', '') === sym.toUpperCase() && Date.parse(a.pool_created_at) < START - 2 * 86400e3;
  }).sort((x, y) => (+y.a.reserve_in_usd || 0) - (+x.a.reserve_in_usd || 0));
  const c = cands[0];
  if (c && +c.a.reserve_in_usd > 100000) {
    out.push({ symbol: sym, network: net, pool: c.a.address, name: c.a.name, dex: c.p.relationships.dex.data.id, reserve_usd: Math.round(+c.a.reserve_in_usd), vol24h_usd: Math.round(+c.a.volume_usd.h24 || 0), fdv_usd: Math.round(+c.a.fdv_usd || 0), created: c.a.pool_created_at });
    console.log('ok', sym, c.a.name, Math.round(+c.a.reserve_in_usd), Math.round(+c.a.volume_usd.h24));
  } else console.log('skip', sym, c ? Math.round(+c.a.reserve_in_usd) : 'none');
  await sleep(4500);
}
writeFileSync('data/pools.json', JSON.stringify({ fetched_at: new Date().toISOString(), source: 'GeckoTerminal public API /search/pools (deepest pool per symbol, created before 2026-11-01)', pools: out }, null, 1));
