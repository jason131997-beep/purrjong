#!/usr/bin/env node
/* Purrjong board checker (node, no deps).
   For every board (or a range): validates the layout geometry (no overlaps, tileCount), the cat list (known
   cats, no duplicates), that the labels cover the tile count with even copies of every match key, deals the
   board with the real generator (core.js generateTrayDeal) and replays the generator's own tap order with
   checkTaps under the 3-cat hold limit, i.e. the deal is provably clearable without filling the 4-slot shelf.
   It also plays each deal with two simple bots to estimate how punishing it is:
     random: taps a uniformly random free cat;
     greedy: breaks a shelf pair if it can, else shelves one of two free copies of a cat, else a random free cat.
   (A reimplementation: these bots are not the ones behind the older boards' recorded "sim" numbers.)
   Usage: node tools/check-boards.js [from] [to] [--runs N] [--write-sim]   (--write-sim rewrites sim for the range) */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const C = require(path.join(root, 'src/core.js'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const nums = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--runs').map(Number);
const from = nums[0] || 1, to = nums[1] || 1e9, runs = opt('--runs', 200);
const B = read('data/boards.json'), L = read('data/layouts.json'), CATS = read('art/cats.json');
const LAY = Object.fromEntries(L.layouts.map((l) => [l.layoutId, l]));
const catIds = new Set(CATS.cats.filter((c) => !c.bonusSet && !c.rarity).map((c) => c.id));

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (a, r) => a[Math.floor(r() * a.length)];
const BOTS = {
  random: (f, tray, free, r) => pick(free, r),
  greedy: (f, tray, free, r) => {
    const held = new Set(tray.map((t) => C.matchKey(f[t])));
    const m = free.filter((i) => held.has(C.matchKey(f[i])));
    if (m.length) return pick(m, r);
    const by = {}; for (const i of free) (by[C.matchKey(f[i])] = by[C.matchKey(f[i])] || []).push(i);
    const pairs = Object.values(by).filter((a) => a.length >= 2);
    return pairs.length ? pick(pairs, r)[0] : pick(free, r);
  },
};
function play(geom, faces, bot, r) {
  const present = new Uint8Array(geom.n).fill(1), tray = [];
  for (let left = geom.n; left > 0; left--) {
    const i = bot(faces, tray, C.freeList(geom, present), r);
    present[i] = 0;
    const j = tray.findIndex((t) => C.matchKey(faces[t]) === C.matchKey(faces[i]));
    if (j >= 0) tray.splice(j, 1); else if (tray.push(i) >= C.TRAY_SLOTS) return false;
  }
  return true;
}
function check(b) {
  const errs = [], l = LAY[b.layoutId];
  if (!l) return { errs: [`missing layout ${b.layoutId}`] };
  const geom = C.buildGeometry(l.tiles);
  errs.push(...geom.errors);
  if (l.tileCount !== l.tiles.length) errs.push(`tileCount ${l.tileCount} != ${l.tiles.length} tiles`);
  const maxX = Math.max(...l.tiles.map((t) => t[0])) + 2, maxY = Math.max(...l.tiles.map((t) => t[1])) + 2, maxZ = Math.max(...l.tiles.map((t) => t[2])) + 1;
  if (l.width !== maxX || l.height !== maxY || l.layers !== maxZ) errs.push('width/height/layers do not match tiles');
  for (const c of b.cats) if (!catIds.has(c)) errs.push(`unknown cat ${c}`);
  if (new Set(b.cats).size !== b.cats.length) errs.push('duplicate cat');
  for (const c of Object.keys(b.copies || {})) if (!b.cats.includes(c)) errs.push(`copies for absent cat ${c}`);
  if (errs.length) return { errs };
  let deal;
  try { deal = C.generateTrayDeal(l, b, geom); } catch (e) { return { errs: [e.message] }; }
  const counts = {}; for (const f of deal.faces) counts[C.matchKey(f)] = (counts[C.matchKey(f)] || 0) + 1;
  for (const k in counts) if (counts[k] % 2) errs.push(`odd number of ${k}`);
  const all = new Uint8Array(geom.n).fill(1);
  const rep = C.checkTaps(geom, deal.faces, all, deal.solution, C.TRAY_HOLD);
  if (!rep.ok) errs.push(`generator solution fails: ${rep.reason}`);
  else if (rep.present.some((x) => x)) errs.push('generator solution leaves tiles');
  new C.Game(l, b); // the app's constructor must accept it too
  const r = rng(b.seed), sim = {};
  for (const k of Object.keys(BOTS)) { let lost = 0; for (let n = 0; n < runs; n++) if (!play(geom, deal.faces, BOTS[k], r)) lost++; sim[k] = +(lost / runs).toFixed(2); }
  return { errs, n: geom.n, layers: l.layers, maxHeld: rep.maxHeld, sim };
}
let bad = 0, count = 0;
for (const b of B.boards) {
  if (b.boardId < from || b.boardId > to) continue;
  const r = check(b); count++;
  if (r.errs.length) bad++;
  console.log(`${String(b.boardId).padStart(3)} ${b.layoutId.padEnd(20)} ${r.errs.length ? 'FAIL ' + r.errs.join('; ') : `ok  ${r.n} tiles, ${r.layers} layers, ${b.cats.length} cats, solution holds <=${r.maxHeld}, bots lose random ${r.sim.random} greedy ${r.sim.greedy}`}`);
  if (flag('--write-sim') && !r.errs.length) b.sim = Object.assign({}, b.sim, { random: r.sim.random, greedy: r.sim.greedy, runs });
}
// chapters must tile the board ids with no gaps
const ids = B.boards.map((b) => b.boardId);
ids.forEach((id, k) => { if (id !== k + 1) { bad++; console.log(`board ids not contiguous at ${id}`); } });
let expect = 1;
for (const ch of B.chapters) { if (ch.from !== expect) { bad++; console.log(`chapter ${ch.n} starts at ${ch.from}, expected ${expect}`); } expect = ch.to + 1; }
if (expect !== ids.length + 1) { bad++; console.log(`chapters end at ${expect - 1}, boards end at ${ids.length}`); }
if (flag('--write-sim')) fs.writeFileSync(path.join(root, 'data/boards.json'), JSON.stringify(B, null, 2) + '\n');
console.log(bad ? `\n${bad} problem(s) in ${count} boards` : `\nall ${count} boards ok`);
process.exit(bad ? 1 : 0);
