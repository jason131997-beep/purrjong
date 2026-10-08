/*
 * Purrjong GameCore (browser + Node, no DOM). Mirrors design doc Section 3 + 10 so it can be
 * ported 1:1 to a pure-Swift package:
 *   - half-step (x, y, z) grid: a tile covers [x, x+2) x [y, y+2) on layer z
 *   - covered  = a tile on a higher layer overlaps its footprint
 *   - side-free = nothing on the same layer touches its left edge, or nothing touches its right edge
 *   - match = same cat id, or two tiles of the same bonus set (Seasons any-with-any, Lucky any-with-any)
 *   - SplitMix64 RNG; reverse-build deals (pairs placed in a valid removal order) => always solvable
 *   - undo stack, hint finder, dead-end detection, solvable re-deal Shuffle, auto-finish, headless solver
 *   - v4 tray (shelf) play: tap a free tile to send it to a 4-slot tray; two matching tiles there break.
 *     Tray-aware deal generator (tap order + hold-limited pairing), tray solver, hints and shuffle.
 *     The classic pair generator/solver stay exported for tests and comparisons.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PurrjongCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- bonus sets
  const BONUS_SETS = {
    seasons: ['spring', 'summer', 'autumn', 'winter'],
    lucky: ['lucky-white', 'lucky-gold', 'lucky-black', 'lucky-jade'],
  };
  const FACE_TO_SET = {};
  for (const set of Object.keys(BONUS_SETS)) for (const f of BONUS_SETS[set]) FACE_TO_SET[f] = set;

  /** Match key: bonus faces collapse to their set id, standard cats match by id. */
  function matchKey(face) { return FACE_TO_SET[face] || face; }
  function facesMatch(a, b) { return matchKey(a) === matchKey(b); }

  // ---------------------------------------------------------------- SplitMix64
  const M64 = (1n << 64n) - 1n;
  class SplitMix64 {
    constructor(seed) { this.state = BigInt.asUintN(64, BigInt(seed)); }
    nextU64() {
      this.state = (this.state + 0x9E3779B97F4A7C15n) & M64;
      let z = this.state;
      z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
      z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
      return z ^ (z >> 31n);
    }
    /** Uniform double in [0, 1): top 53 bits (Swift: Double(x >> 11) * 0x1p-53). */
    nextFloat() { return Number(this.nextU64() >> 11n) / 9007199254740992; }
    /** Uniform int in [0, n). */
    nextInt(n) { return Math.floor(this.nextFloat() * n); }
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) { const j = this.nextInt(i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
      return arr;
    }
  }
  /** Derive a sub-seed deterministically (e.g. for the n-th shuffle of a board). */
  function deriveSeed(seed, salt) {
    const r = new SplitMix64(BigInt.asUintN(64, BigInt(seed) ^ (BigInt(salt) * 0x9E3779B97F4A7C15n)));
    return r.nextU64();
  }

  // ---------------------------------------------------------------- geometry
  /**
   * Precompute adjacency for a layout. tiles: [[x,y,z], ...] (half-steps).
   * above[i]   tiles on higher layers overlapping i's footprint (cover i)
   * aboveZ1[i] the subset on exactly z+1 (the doc's literal rule; identical on valid layouts)
   * left[i] / right[i]  same-layer tiles touching i's left / right edge
   */
  function buildGeometry(tiles) {
    const n = tiles.length;
    const pos = tiles.map((t) => (Array.isArray(t) ? { x: t[0], y: t[1], z: t[2] } : { x: t.x, y: t.y, z: t.z }));
    const above = [], aboveZ1 = [], left = [], right = [], below = [];
    for (let i = 0; i < n; i++) { above.push([]); aboveZ1.push([]); left.push([]); right.push([]); below.push([]); }
    const errors = [];
    for (let i = 0; i < n; i++) {
      const a = pos[i];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = pos[j];
        const ox = Math.abs(a.x - b.x) < 2, oy = Math.abs(a.y - b.y) < 2;
        if (b.z > a.z && ox && oy) { above[i].push(j); below[j].push(i); if (b.z === a.z + 1) aboveZ1[i].push(j); }
        if (b.z === a.z && oy) {
          if (ox) { if (i < j) errors.push(`tiles ${i} and ${j} overlap on layer ${a.z}`); }
          else if (b.x + 2 === a.x) left[i].push(j);
          else if (a.x + 2 === b.x) right[i].push(j);
        }
      }
    }
    return { n, pos, above, aboveZ1, left, right, below, errors };
  }

  function anyPresent(list, present) {
    for (let k = 0; k < list.length; k++) if (present[list[k]]) return true;
    return false;
  }
  function isFreeIn(geom, present, i) {
    if (!present[i]) return false;
    if (anyPresent(geom.above[i], present)) return false;
    return !anyPresent(geom.left[i], present) || !anyPresent(geom.right[i], present);
  }
  /** Literal Section 3 rule (covered only by z+1). Used by tests to prove equivalence. */
  function isFreeZ1(geom, present, i) {
    if (!present[i]) return false;
    if (anyPresent(geom.aboveZ1[i], present)) return false;
    return !anyPresent(geom.left[i], present) || !anyPresent(geom.right[i], present);
  }
  function freeList(geom, present) {
    const out = [];
    for (let i = 0; i < geom.n; i++) if (isFreeIn(geom, present, i)) out.push(i);
    return out;
  }

  // ---------------------------------------------------------------- reverse-build
  /**
   * Builds a removal order over the present positions: repeatedly take two tiles that are free
   * at the same time and remove them. Faces assigned along this order make the deal solvable.
   * Returns [[a, b], ...] or null when this random walk paints itself into a corner.
   */
  function buildRemovalOrder(geom, presentIn, rng) {
    const present = Uint8Array.from(presentIn);
    let left = 0; for (let i = 0; i < geom.n; i++) left += present[i];
    const order = [];
    while (left > 0) {
      const free = freeList(geom, present);
      if (free.length < 2) return null;
      // weight: prefer higher tiles and tiles that block others, which keeps the board open
      const w = free.map((i) => 1 + geom.pos[i].z * 2 + geom.below[i].length * 0.5 + (geom.left[i].length + geom.right[i].length) * 0.25);
      let chosen = null;
      for (let tries = 0; tries < 12 && !chosen; tries++) {
        const a = weightedPick(free, w, rng, -1);
        const b = weightedPick(free, w, rng, a);
        present[a] = 0; present[b] = 0;
        const rem = left - 2;
        if (rem === 0 || tries === 11 || countFreeAtLeast(geom, present, 2)) chosen = [a, b];
        else { present[a] = 1; present[b] = 1; }
      }
      order.push(chosen);
      left -= 2;
    }
    return order;
  }
  function countFreeAtLeast(geom, present, k) {
    let c = 0;
    for (let i = 0; i < geom.n; i++) if (isFreeIn(geom, present, i) && ++c >= k) return true;
    return false;
  }
  function weightedPick(list, w, rng, exclude) {
    let total = 0;
    for (let k = 0; k < list.length; k++) if (list[k] !== exclude) total += w[k];
    let r = rng.nextFloat() * total;
    let last = -1;
    for (let k = 0; k < list.length; k++) {
      if (list[k] === exclude) continue;
      last = list[k];
      r -= w[k];
      if (r < 0) return list[k];
    }
    return last;
  }

  /** "Pair i buries pair j": a tile of j sits under, or is side-blocked by, a tile of i. */
  function buries(geom, pi, pj) {
    for (const t of pj) for (const s of pi) {
      if (geom.above[t].includes(s) || geom.left[t].includes(s) || geom.right[t].includes(s)) return true;
    }
    return false;
  }

  /** Step at which each tile first becomes free while replaying a removal order. */
  function freeSteps(geom, order, presentIn) {
    const present = presentIn ? Uint8Array.from(presentIn) : new Uint8Array(geom.n).fill(1);
    const at = new Int32Array(geom.n).fill(-1);
    order.forEach(([a, b], s) => {
      for (const i of freeList(geom, present)) if (at[i] < 0) at[i] = s;
      present[a] = 0; present[b] = 0;
    });
    return at;
  }

  /**
   * Trap strength of grouping later pair pj with earlier pair pi (same cat on all four tiles).
   * 0 = harmless. A tile of pi directly covering a tile of pj is the classic dead end (grab the
   * wrong two copies and the last two are stacked on each other); side-blocking is weaker. The trap
   * is tempting when pj's other tile is already free while pi is still on the board.
   */
  function trapScore(geom, pi, pj, i, freeAt) {
    let best = 0;
    for (let k = 0; k < 2; k++) {
      const t = pj[k], other = pj[1 - k];
      let s = 0;
      for (const u of pi) {
        if (geom.above[t].includes(u)) s = Math.max(s, 3);
        else if (geom.left[t].includes(u) || geom.right[t].includes(u)) s = Math.max(s, 1.5);
      }
      if (!s) continue;
      if (freeAt && freeAt[other] >= 0 && freeAt[other] <= i) s *= 2; // decoy copy visible early
      best = Math.max(best, s);
    }
    return best;
  }

  /**
   * Groups removal-order pairs into match groups (sizes[k] pairs each: 2 = four copies, 3 = six,
   * 1 = two). With probability trapDensity a group's next pair is the later pair that the previous
   * one buries most tightly (direct covers with a visible decoy first); otherwise we prefer a
   * partner it does not bury. Any grouping keeps the deal solvable: the removal order is untouched.
   */
  function groupPairs(geom, order, rng, trapDensity, sizesIn, freeAt, spread) {
    const m = order.length;
    const sizes = sizesIn ? sizesIn.slice() : new Array(m / 2).fill(2);
    if (sizes.reduce((a, b) => a + b, 0) !== m) throw new Error('group sizes do not cover the removal order');
    rng.shuffle(sizes);
    const used = new Uint8Array(m);
    const groups = [];
    let traps = 0, gi = 0;
    for (let i = 0; i < m; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const size = sizes[gi++];
      const group = [i];
      let anchor = i;
      while (group.length < size) {
        const open = [];
        for (let j = i + 1; j < m; j++) if (!used[j]) open.push(j);
        if (!open.length) throw new Error('ran out of pairs while grouping');
        let j;
        // spread (tray deals): the next copies come free only after this pair is gone, so a cat's copies
        // surface one at a time (lonely tiles that have to wait on the shelf)
        if (spread && freeAt && rng.nextFloat() < spread) {
          const late = open.filter((x) => freeAt[order[x][0]] > anchor && freeAt[order[x][1]] > anchor);
          if (late.length) {
            late.sort((p, q) => Math.min(freeAt[order[p][0]], freeAt[order[p][1]]) - Math.min(freeAt[order[q][0]], freeAt[order[q][1]]));
            j = late[rng.nextInt(Math.min(3, late.length))];
            used[j] = 1; group.push(j); anchor = j;
            continue;
          }
        }
        const scored = open.map((j) => [j, trapScore(geom, order[anchor], order[j], anchor, freeAt)]);
        if (rng.nextFloat() < trapDensity) {
          const top = Math.max(...scored.map((x) => x[1]));
          const pool = top > 0 ? scored.filter((x) => x[1] >= top - 1e-9).map((x) => x[0]) : open;
          j = pool[rng.nextInt(pool.length)];
          if (top > 0) traps++;
        } else {
          const safe = scored.filter((x) => x[1] === 0).map((x) => x[0]);
          const pool = safe.length ? safe : open;
          j = pool[rng.nextInt(pool.length)];
        }
        used[j] = 1;
        group.push(j);
        anchor = j;
      }
      groups.push(group);
    }
    return { groups, traps };
  }

  /** Match labels for a board: cats with board.copies[cat] (default 4) copies, bonus sets of 4. */
  function boardLabels(board) {
    const copies = board.copies || {};
    const labels = board.cats.map((c) => { const k = copies[c] || 4; return { key: c, faces: new Array(k).fill(c) }; });
    for (const s of board.bonusSets || []) labels.push({ key: s, faces: BONUS_SETS[s].slice() });
    return labels;
  }
  function boardTileCount(board) { return boardLabels(board).reduce((a, l) => a + l.faces.length, 0); }

  /**
   * Deal a board. layout: {tiles:[[x,y,z]...]}, board: {seed, cats[], copies{}, bonusSets[], trapDensity}.
   * Returns { faces[], solution: [[a,b]...], traps, attempts }.
   */
  function generateDeal(layout, board, geom) {
    geom = geom || buildGeometry(layout.tiles);
    const n = geom.n;
    const labels = boardLabels(board);
    const total = labels.reduce((a, l) => a + l.faces.length, 0);
    if (total !== n) throw new Error(`board ${board.boardId}: ${n} tiles but labels cover ${total}`);
    for (const l of labels) if (l.faces.length % 2) throw new Error(`board ${board.boardId}: odd copies of ${l.key}`);
    const rng = new SplitMix64(board.seed);
    let order = null, attempts = 0;
    const all = new Uint8Array(n).fill(1);
    while (!order) {
      if (++attempts > 2000) throw new Error(`layout ${layout.layoutId}: no removal order found`);
      order = buildRemovalOrder(geom, all, rng);
    }
    const faces = new Array(n);
    const { traps } = assignFaces(geom, order, labels, rng, board.trapDensity || 0, faces);
    return { faces, solution: order, traps, attempts };
  }

  /** Paint labels onto a removal order (trap-aware grouping). Writes into faces[]. */
  function assignFaces(geom, order, labels, rng, trapDensity, faces, spread, presentIn) {
    const freeAt = freeSteps(geom, order, presentIn);
    const { groups, traps } = groupPairs(geom, order, rng, trapDensity, labels.map((l) => l.faces.length / 2), freeAt, spread);
    // labels by group size, shuffled within each size class
    const bySize = {};
    for (const l of rng.shuffle(labels.slice())) (bySize[l.faces.length / 2] = bySize[l.faces.length / 2] || []).push(l);
    for (const g of groups) {
      const lab = bySize[g.length].pop();
      const f = rng.shuffle(lab.faces.slice());
      g.forEach((p, k) => { faces[order[p][0]] = f[2 * k]; faces[order[p][1]] = f[2 * k + 1]; });
    }
    return { traps };
  }

  // ---------------------------------------------------------------- solver
  /**
   * Headless DFS solver with failed-state memo. Safe move: when every remaining copy of a key is
   * free, removing them all can never hurt, so that is taken without branching. Dead-state prune:
   * when the last two copies of a key sit on top of each other (or forced pairs block each other
   * in a cycle) the state can never be finished.
   * opts.rank (tile -> step in a known removal order, e.g. the generator's) only changes the move
   * ordering: the search stays complete and every returned move list is verified by replay.
   * Returns { solved: true|false|null(budget hit), moves, nodes }.
   */
  function solve(geom, faces, presentIn, opts) {
    opts = opts || {};
    const maxNodes = opts.maxNodes || 200000;
    const n = geom.n;
    const present = Uint8Array.from(presentIn || new Uint8Array(n).fill(1));
    const keyIds = new Map(); const key = new Int32Array(n);
    for (let i = 0; i < n; i++) { const k = matchKey(faces[i]); if (!keyIds.has(k)) keyIds.set(k, keyIds.size); key[i] = keyIds.get(k); }
    const remainingByKey = new Int32Array(keyIds.size);
    const tilesByKey = Array.from({ length: keyIds.size }, () => []);
    let remaining = 0;
    for (let i = 0; i < n; i++) { tilesByKey[key[i]].push(i); if (present[i]) { remainingByKey[key[i]]++; remaining++; } }
    const rank = opts.rank || null;
    /*
     * Dead-state prune (sound): a key with exactly two copies left is "forced": both leave in one
     * move. Every tile stacked above a copy (transitively) must leave first. If forced key K needs a
     * tile of forced key J gone first and J needs a tile of K gone first (or K's copies are stacked
     * on each other: a self-loop), no order can ever clear the board.
     */
    const mark = new Int32Array(n); let stamp = 0;
    function coverKeys(k, out) { // keys of all present tiles transitively above k's present copies
      stamp++;
      const stack = [];
      for (const t of tilesByKey[k]) if (present[t]) for (const u of geom.above[t]) if (present[u] && mark[u] !== stamp) { mark[u] = stamp; stack.push(u); }
      while (stack.length) {
        const t = stack.pop();
        out.add(key[t]); // includes k itself when one copy is buried under the other
        for (const u of geom.above[t]) if (present[u] && mark[u] !== stamp) { mark[u] = stamp; stack.push(u); }
      }
      return out;
    }
    function forcedCycleFrom(k0) {
      if (remainingByKey[k0] !== 2) return false;
      const visited = new Set();
      const todo = [k0];
      while (todo.length) {
        const k = todo.pop();
        for (const j of coverKeys(k, new Set())) {
          if (remainingByKey[j] !== 2) continue;
          if (j === k0) return true;
          if (!visited.has(j)) { visited.add(j); todo.push(j); }
        }
      }
      return false;
    }
    function deadAfter(list) {
      for (const t of list) if (forcedCycleFrom(key[t])) return true;
      return false;
    }
    if (remaining) for (let k = 0; k < keyIds.size; k++) if (forcedCycleFrom(k)) return { solved: false, moves: null, nodes: 0 };
    const failed = new Set();
    const moves = [];
    let nodes = 0, aborted = false;
    const stateKey = () => {
      let s = '';
      for (let i = 0; i < n; i += 16) { let v = 0; for (let b = 0; b < 16 && i + b < n; b++) if (present[i + b]) v |= 1 << b; s += String.fromCharCode(v); }
      return s;
    };
    const lift = (i) => { present[i] = 0; remainingByKey[key[i]]--; remaining--; };
    const drop = (i) => { present[i] = 1; remainingByKey[key[i]]++; remaining++; };
    function score(a, b) { // how much a removal opens up (or: how early in the known order)
      if (rank) return -(rank[a] + rank[b]) - (rank[a] === rank[b] ? 0.5 : 0);
      return geom.below[a].length + geom.below[b].length + geom.pos[a].z + geom.pos[b].z +
        (geom.left[a].length + geom.right[a].length + geom.left[b].length + geom.right[b].length) * 0.5;
    }
    function dfs() {
      if (remaining === 0) return true;
      if (++nodes > maxNodes) { aborted = true; return false; }
      const sk = stateKey();
      if (failed.has(sk)) return false;
      const byKey = new Map();
      for (let i = 0; i < n; i++) if (isFreeIn(geom, present, i)) { const k = key[i]; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(i); }
      // safe move
      for (const [k, list] of byKey) {
        if (list.length >= 2 && list.length === remainingByKey[k] && list.length % 2 === 0) {
          for (let t = 0; t < list.length; t += 2) moves.push([list[t], list[t + 1]]);
          list.forEach(lift);
          if (dfs()) return true;
          list.forEach(drop);
          for (let t = 0; t < list.length; t += 2) moves.pop();
          if (!aborted) failed.add(sk);
          return false;
        }
      }
      const cands = [];
      for (const list of byKey.values()) {
        if (list.length < 2) continue;
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) cands.push([list[a], list[b]]);
      }
      cands.sort((p, q) => score(q[0], q[1]) - score(p[0], p[1]));
      for (const [a, b] of cands) {
        lift(a); lift(b); moves.push([a, b]);
        if (!deadAfter([a, b]) && dfs()) return true; // only these two keys changed
        moves.pop(); drop(a); drop(b);
        if (aborted) return false;
      }
      failed.add(sk);
      return false;
    }
    const ok = dfs();
    return { solved: ok ? true : (aborted ? null : false), moves: ok ? moves.slice() : null, nodes };
  }

  // ---------------------------------------------------------------- tray (shelf) rules
  /*
   * Tray play (Vita-style shelf): tapping a free tile sends it to the tray. If a tile with the same
   * match key is already there, both break. The tray has `slots` places; a tile that does not match
   * needs an empty one. When every slot is taken only a matching tile can be tapped; if none of the
   * free board tiles matches, the player is stuck ("Tray full!").
   * Because matching is immediate, the tray never holds two tiles of one key, and which keys sit in the
   * tray follows from the board alone: key k is held iff an odd number of its copies has left the board.
   */
  const TRAY_SLOTS = 4;
  // The 4th slot is the game-over slot: matching is immediate, so a full shelf (4 cats, no pair) ends the round.
  // A winning line can therefore hold at most 3 unmatched cats at once (solver, hint and generator capacity).
  const TRAY_HOLD = TRAY_SLOTS - 1;

  /** Single-tile removal order over the present positions: every tile is free when it is taken. */
  function buildTapOrder(geom, presentIn, rng) {
    const present = Uint8Array.from(presentIn);
    let left = 0; for (let i = 0; i < geom.n; i++) left += present[i];
    const order = [];
    while (left > 0) {
      const free = freeList(geom, present);
      const w = free.map((i) => 1 + geom.pos[i].z * 2 + geom.below[i].length * 0.5 + (geom.left[i].length + geom.right[i].length) * 0.25);
      const i = weightedPick(free, w, rng, -1);
      present[i] = 0; order.push(i); left--;
    }
    return order;
  }

  /**
   * Pairs a tap order under a hold limit (tray-aware reverse build). Walking the order, each tile either
   * opens a pair (it would wait in the tray) or closes one of the open pairs. At most `hold` pairs are
   * open at once, so replaying the order never needs more than `hold` tray slots. closeBias is the chance
   * to close when both are allowed: high = pairs come free together (gentle), low = long holds (tricky).
   * initialOpen: tiles already in the tray (shuffle); each gets a closer from the order.
   * deep (0..1, with freeAt from tapFreeSteps): chance a closer prefers an opener it was not free alongside.
   * Returns { pairs: [[opener, closer], ...] for board-board pairs (opener order), trayClosers: {trayTile: closer}, maxOpen }.
   */
  function pairTapOrder(order, rng, hold, closeBias, initialOpen, deep, freeAt) {
    const open = (initialOpen || []).map((t) => ({ tile: t, tray: true, at: -1 }));
    const pairs = [], trayClosers = {};
    let maxOpen = open.length;
    for (let t = 0; t < order.length; t++) {
      const tile = order[t], r = order.length - t;
      const canOpen = open.length < hold && open.length <= r - 2;
      let close;
      if (!open.length) close = false;
      else if (!canOpen) close = true;
      else close = rng.nextFloat() < closeBias;
      if (close) {
        // deep: prefer an opener this tile was NOT free next to (the pair then needs the shelf)
        let pool = null;
        if (deep && freeAt && rng.nextFloat() < deep) {
          const d = []; for (let k = 0; k < open.length; k++) if (open[k].tray || freeAt[tile] > open[k].at) d.push(k);
          if (d.length) pool = d;
        }
        const k = pool ? pool[rng.nextInt(pool.length)] : rng.nextInt(open.length);
        const o = open[k]; open.splice(k, 1);
        if (o.tray) trayClosers[o.tile] = tile; else pairs.push({ a: o.tile, b: tile, at: o.at });
      } else { open.push({ tile, at: t }); maxOpen = Math.max(maxOpen, open.length); }
    }
    if (open.length) throw new Error('pairTapOrder: unclosed pairs (odd tile count?)');
    pairs.sort((p, q) => p.at - q.at);
    return { pairs: pairs.map((p) => [p.a, p.b]), trayClosers, maxOpen };
  }

  /** Step of a single-tile order at which each tile first becomes free. */
  function tapFreeSteps(geom, order, presentIn) {
    const present = Uint8Array.from(presentIn);
    const at = new Int32Array(geom.n).fill(-1);
    order.forEach((i, s) => {
      for (const f of freeList(geom, present)) if (at[f] < 0) at[f] = s;
      present[i] = 0;
    });
    return at;
  }

  /** Keys held in the tray for a board state (parity rule above). Returns Map key -> true. */
  function heldKeys(faces, present) {
    const odd = new Map();
    for (let i = 0; i < faces.length; i++) if (!present[i]) { const k = matchKey(faces[i]); odd.set(k, !odd.get(k)); }
    for (const [k, v] of odd) if (!v) odd.delete(k);
    return odd;
  }

  /**
   * Replays a tap list from a state and checks it obeys the tray rules (free when tapped, a non-matching
   * tile needs an empty slot). Returns { ok, maxHeld, broke, reason }.
   */
  function checkTaps(geom, faces, presentIn, taps, slots) {
    const present = Uint8Array.from(presentIn);
    const held = heldKeys(faces, present);
    let maxHeld = held.size, broke = 0;
    for (let s = 0; s < taps.length; s++) {
      const i = taps[s];
      if (!isFreeIn(geom, present, i)) return { ok: false, reason: `tap ${s}: tile ${i} not free`, maxHeld, broke };
      const k = matchKey(faces[i]);
      if (held.has(k)) { held.delete(k); broke++; }
      else { if (held.size >= slots) return { ok: false, reason: `tap ${s}: tray full`, maxHeld, broke }; held.set(k, true); maxHeld = Math.max(maxHeld, held.size); }
      present[i] = 0;
    }
    return { ok: true, maxHeld, broke, present };
  }

  /**
   * Tray-aware solver: DFS over single taps with a failed-state memo (the board determines the tray).
   * Safe move: when every remaining copy of a key is free, tapping them all can never hurt (the board
   * only opens up and that key never needs a slot again), as long as the transient slot fits.
   * opts: { slots, maxNodes, rank } (rank only orders moves; the search stays complete).
   * Returns { solved: true|false|null(budget), moves: [tile...], nodes }.
   */
  function solveTray(geom, faces, presentIn, opts) {
    opts = opts || {};
    const slots = opts.slots || TRAY_HOLD;
    const maxNodes = opts.maxNodes || 200000;
    const n = geom.n;
    const present = Uint8Array.from(presentIn || new Uint8Array(n).fill(1));
    const keyIds = new Map(); const key = new Int32Array(n);
    for (let i = 0; i < n; i++) { const k = matchKey(faces[i]); if (!keyIds.has(k)) keyIds.set(k, keyIds.size); key[i] = keyIds.get(k); }
    const K = keyIds.size;
    const remainingByKey = new Int32Array(K), totalByKey = new Int32Array(K);
    let remaining = 0;
    for (let i = 0; i < n; i++) { totalByKey[key[i]]++; if (present[i]) { remainingByKey[key[i]]++; remaining++; } }
    const held = new Uint8Array(K); let heldCount = 0;
    for (let k = 0; k < K; k++) { held[k] = (totalByKey[k] - remainingByKey[k]) & 1; heldCount += held[k]; }
    if (heldCount > slots) return { solved: false, moves: null, nodes: 0 };
    const rank = opts.rank || null;
    const failed = new Set();
    const moves = [];
    let nodes = 0, aborted = false;
    const stateKey = () => {
      let s = '';
      for (let i = 0; i < n; i += 16) { let v = 0; for (let b = 0; b < 16 && i + b < n; b++) if (present[i + b]) v |= 1 << b; s += String.fromCharCode(v); }
      return s;
    };
    const tap = (i) => { present[i] = 0; remaining--; const k = key[i]; remainingByKey[k]--; if (held[k]) { held[k] = 0; heldCount--; } else { held[k] = 1; heldCount++; } moves.push(i); };
    const untap = (i) => { present[i] = 1; remaining++; const k = key[i]; remainingByKey[k]++; if (held[k]) { held[k] = 0; heldCount--; } else { held[k] = 1; heldCount++; } moves.pop(); };
    const opened = (i) => geom.below[i].length + geom.pos[i].z + (geom.left[i].length + geom.right[i].length) * 0.5;
    function dfs() {
      if (remaining === 0) return true;
      if (++nodes > maxNodes) { aborted = true; return false; }
      const sk = stateKey();
      if (failed.has(sk)) return false;
      const free = [];
      for (let i = 0; i < n; i++) if (present[i] && isFreeIn(geom, present, i)) free.push(i);
      const freeByKey = new Map();
      for (const i of free) { const k = key[i]; if (!freeByKey.has(k)) freeByKey.set(k, []); freeByKey.get(k).push(i); }
      // safe move: all remaining copies of a key are free
      for (const [k, list] of freeByKey) {
        if (list.length !== remainingByKey[k]) continue;
        if (!held[k] && heldCount + 1 > slots) continue;
        list.forEach(tap);
        if (dfs()) return true;
        for (let t = list.length - 1; t >= 0; t--) untap(list[t]);
        if (!aborted) failed.add(sk);
        return false;
      }
      const cands = [];
      for (const i of free) {
        const k = key[i];
        if (held[k]) cands.push([i, 0]);
        else if (heldCount + 1 <= slots) cands.push([i, freeByKey.get(k).length > 1 ? 1 : 2]);
      }
      if (rank) cands.sort((p, q) => rank[p[0]] - rank[q[0]]);
      else cands.sort((p, q) => p[1] - q[1] || opened(q[0]) - opened(p[0]));
      for (const [i] of cands) {
        tap(i);
        if (dfs()) return true;
        untap(i);
        if (aborted) return false;
      }
      failed.add(sk);
      return false;
    }
    const ok = dfs();
    return { solved: ok ? true : (aborted ? null : false), moves: ok ? moves.slice() : null, nodes };
  }

  /** Tray deal: tap order + hold-limited pairing + trap-aware key grouping. */
  function generateTrayDeal(layout, board, geom) {
    geom = geom || buildGeometry(layout.tiles);
    const n = geom.n;
    const labels = boardLabels(board);
    const total = labels.reduce((a, l) => a + l.faces.length, 0);
    if (total !== n) throw new Error(`board ${board.boardId}: ${n} tiles but labels cover ${total}`);
    for (const l of labels) if (l.faces.length % 2) throw new Error(`board ${board.boardId}: odd copies of ${l.key}`);
    const rng = new SplitMix64(board.seed);
    const order = buildTapOrder(geom, new Uint8Array(n).fill(1), rng);
    const hold = Math.max(1, Math.min(board.hold || 2, (board.traySlots || TRAY_SLOTS) - 1));
    const freeAt = tapFreeSteps(geom, order, new Uint8Array(n).fill(1));
    const { pairs, maxOpen } = pairTapOrder(order, rng, hold, board.closeBias == null ? 0.5 : board.closeBias, [], board.deep || 0, freeAt);
    const faces = new Array(n);
    const { traps } = assignFaces(geom, pairs, labels, rng, board.trapDensity || 0, faces, board.spread || 0);
    return { faces, solution: order, pairs, traps, maxOpen, attempts: 1 };
  }

  // ---------------------------------------------------------------- Game
  class Game {
    /**
     * layout: {layoutId, tiles}, board: {boardId, seed, cats, bonusSets, trapDensity, hold, closeBias, traySlots}
     * opts.faces: start from explicit faces instead of dealing (tests, restore); opts.slots: tray size
     */
    constructor(layout, board, opts) {
      opts = opts || {};
      this.layout = layout;
      this.board = board;
      this.geom = buildGeometry(layout.tiles);
      if (this.geom.errors.length) throw new Error(this.geom.errors.join('; '));
      this.slots = opts.slots || board.traySlots || TRAY_SLOTS;
      const deal = opts.faces ? { faces: opts.faces.slice(), solution: null } : generateTrayDeal(layout, board, this.geom);
      this.faces = deal.faces;
      this.solution = deal.solution; // tap order (tile ids) that clears the board within the tray
      this.present = new Uint8Array(this.geom.n).fill(1);
      this.tray = [];                // tile ids on the shelf, left to right
      this.history = [];
      this.shuffleCount = 0;
      this.moves = 0;                // pairs broken
      this.taps = 0;
      this.revives = 0;
    }
    /** Most unmatched cats a winning line can hold: one less than the slots (a full shelf is game over). */
    get hold() { return this.slots - 1; }
    /** Game over: the shelf filled up with no pair (matching is immediate, so full = no pair). */
    get over() { return this.tray.length >= this.slots; }
    get tileCount() { return this.geom.n; }
    /** Tiles still on the board (the tray empties itself when the board does). */
    get remaining() { let c = 0; for (let i = 0; i < this.geom.n; i++) c += this.present[i]; return c; }
    tile(i) { const p = this.geom.pos[i]; return { id: i, x: p.x, y: p.y, z: p.z, face: this.faces[i], key: matchKey(this.faces[i]), present: !!this.present[i] }; }
    isFree(i) { return isFreeIn(this.geom, this.present, i); }
    freeTiles() { return freeList(this.geom, this.present); }
    blockReason(i) {
      if (!this.present[i]) return null;
      if (anyPresent(this.geom.above[i], this.present)) return 'covered';
      if (anyPresent(this.geom.left[i], this.present) && anyPresent(this.geom.right[i], this.present)) return 'sides';
      return null;
    }
    /** Index of the tray tile that tile i would break with, or -1. */
    trayMatch(i) {
      const k = matchKey(this.faces[i]);
      for (let t = 0; t < this.tray.length; t++) if (matchKey(this.faces[this.tray[t]]) === k) return t;
      return -1;
    }
    get trayFull() { return this.tray.length >= this.slots; }
    /** Free and the round is still on. Any free cat can go up; the one that fills the shelf ends the round. */
    canTap(i) { return !!this.present[i] && !this.over && this.isFree(i); }
    legalTaps() { return this.freeTiles().filter((i) => this.canTap(i)); }
    /**
     * Tap tile i: it leaves the board for the tray. Returns null if illegal, else
     * { tile, broke: bool, partner (tray tile it broke with, or -1), at (tray index it landed next to / at) }.
     */
    tap(i) {
      if (!this.canTap(i)) return null;
      const j = this.trayMatch(i);
      this.present[i] = 0; this.taps++;
      let h;
      if (j >= 0) { const partner = this.tray[j]; this.tray.splice(j, 1); this.moves++; h = { type: 'tap', tile: i, partner, at: j }; }
      else { this.tray.push(i); h = { type: 'tap', tile: i, partner: -1, at: this.tray.length - 1 }; }
      this.history.push(h);
      return { tile: i, broke: h.partner >= 0, partner: h.partner, at: h.at };
    }
    /** Convenience for tests/tools: tap a then b; b must break with a (or with a tray copy). */
    match(a, b) {
      if (a === b || !facesMatch(this.faces[a], this.faces[b]) || !this.canTap(a)) return false;
      const ra = this.tap(a);
      if (!ra) return false;
      if (ra.broke || !this.canTap(b)) { this.undo(); return false; }
      this.tap(b); return true;
    }
    get canUndo() { return this.history.length > 0; }
    lastTap() { for (let k = this.history.length - 1; k >= 0; k--) if (this.history[k].type === 'tap') return this.history[k]; return null; }
    /** Undo the last action. A tap flies back to its board spot; a break also puts its partner back on the shelf. */
    undo() {
      const h = this.history.pop();
      if (!h) return null;
      if (h.type === 'tap') {
        this.present[h.tile] = 1; this.taps--;
        if (h.partner >= 0) { this.tray.splice(h.at, 0, h.partner); this.moves--; }
        else { const t = this.tray.lastIndexOf(h.tile); if (t >= 0) this.tray.splice(t, 1); }
      } else if (h.type === 'shuffle') { this.faces = h.prevFaces; if (h.prevSolution) this.solution = h.prevSolution; }
      return h;
    }
    isWon() { return this.remaining === 0; }
    /** Out of space: tiles left and the shelf is full (game over until Revive / Retry). */
    isStuck() { return this.remaining > 0 && this.over; }
    isOver() { return this.isStuck(); }
    /**
     * Revive (Vita-style): every cat on the shelf flies back to its board spot and play continues. Their taps
     * leave the history (so Undo keeps working on what came before). Returns the revived tile ids.
     */
    revive() {
      if (!this.tray.length) return null;
      const tiles = this.tray.slice();
      for (const t of tiles) {
        this.present[t] = 1; this.taps--;
        for (let k = this.history.length - 1; k >= 0; k--) {
          const h = this.history[k];
          if (h.type === 'tap' && h.tile === t && h.partner < 0) { this.history.splice(k, 1); break; }
        }
      }
      this.tray = [];
      this.revives++;
      return tiles;
    }
    isDeadEnd() { return this.isStuck(); }
    /** Every remaining board tile is free: Finish can clear the rest. */
    canAutoFinish() {
      if (this.remaining === 0) return false;
      for (let i = 0; i < this.geom.n; i++) if (this.present[i] && !this.isFree(i)) return false;
      return true;
    }
    /** Tap order that clears an all-free board: first drain the shelf, then pairs (top tiles first). */
    autoFinishTaps() {
      if (!this.canAutoFinish()) return [];
      const idx = [];
      for (let i = 0; i < this.geom.n; i++) if (this.present[i]) idx.push(i);
      idx.sort((a, b) => this.geom.pos[b].z - this.geom.pos[a].z || this.geom.pos[a].y - this.geom.pos[b].y || this.geom.pos[a].x - this.geom.pos[b].x);
      const out = [], used = new Set();
      for (const t of this.tray) { const k = matchKey(this.faces[t]); const i = idx.find((x) => !used.has(x) && matchKey(this.faces[x]) === k); if (i != null) { out.push(i); used.add(i); } }
      const byKey = new Map();
      for (const i of idx) if (!used.has(i)) { const k = matchKey(this.faces[i]); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(i); }
      for (const list of byKey.values()) for (const i of list) out.push(i);
      return out;
    }
    solutionRank() {
      if (!this.solution) return null;
      const rank = new Int32Array(this.geom.n).fill(1 << 30);
      this.solution.forEach((t, k) => { rank[t] = k; });
      return rank;
    }
    /** true / false / null (unknown within budget), from the current board + tray. */
    isSolvable(maxNodes) { if (this.over) return false; return solveTray(this.geom, this.faces, this.present, { slots: this.hold, maxNodes: maxNodes || 100000, rank: this.solutionRank() }).solved; }
    /**
     * Hint: the next tap of a winning line from the current board + tray (truthful: proven by a full
     * tray-aware solve, guided by the known tap order so it stays fast).
     * Returns { tile, with: [tiles to highlight with it], safe: true|false|null, boardSolvable } or null if no tap is legal.
     *   with: the shelf tile it breaks with, or the board twin to tap right after
     */
    hint(opts) {
      opts = opts || {};
      const legal = this.legalTaps();
      if (!legal.length) return null;
      const budget = opts.maxNodes || 60000;
      const pack = (moves, safe) => {
        const t = moves[0];
        const j = this.trayMatch(t);
        // the twin to glow is only named when it is free right now (a twin that the paw cat sits on would
        // read as "tap this" while it is still buried; the app then looks for another free twin)
        const withT = j >= 0 ? [this.tray[j]] : (moves.length > 1 && facesMatch(this.faces[moves[1]], this.faces[t]) && this.isFree(moves[1]) ? [moves[1]] : []);
        return { tile: t, with: withT, onTray: j >= 0, safe, boardSolvable: safe };
      };
      const r = solveTray(this.geom, this.faces, this.present, { slots: this.hold, maxNodes: budget, rank: this.solutionRank() });
      if (r.solved === true) {
        // prefer breaking with a shelf cat when that also keeps a win open (reads naturally to players)
        if (this.trayMatch(r.moves[0]) < 0) {
          for (const t of legal.filter((x) => this.trayMatch(x) >= 0).slice(0, 4)) {
            this.tap(t);
            const q = solveTray(this.geom, this.faces, this.present, { slots: this.hold, maxNodes: 4000, rank: this.solutionRank() });
            this.undo();
            if (q.solved === true) return pack([t].concat(q.moves), true);
          }
        }
        return pack(r.moves, true);
      }
      if (r.solved === false) {
        // no win left: still point at a tap that doesn't end the round, if there is one
        const t = legal.find((x) => this.trayMatch(x) >= 0) ?? legal[0];
        return { tile: t, with: [], onTray: this.trayMatch(t) >= 0, safe: false, boardSolvable: false };
      }
      // budget hit: per-tap checks with the unguided ordering (closes first)
      const order = legal.slice().sort((a, b) => (this.trayMatch(b) >= 0) - (this.trayMatch(a) >= 0));
      const small = Math.max(3000, Math.floor(budget / Math.max(4, order.length)));
      for (const t of order) {
        const res = this.tap(t);
        const q = this.over ? { solved: false } : solveTray(this.geom, this.faces, this.present, { slots: this.hold, maxNodes: small });
        if (res) this.undo();
        if (res && q.solved === true) return pack([t].concat(q.moves), true);
      }
      return { tile: order[0], with: [], onTray: this.trayMatch(order[0]) >= 0, safe: null, boardSolvable: null };
    }
    /**
     * Beginner coach target, always from the live state. Returns { tile, twin, blocked } or null:
     * tile is a free cat to tap (the paw), twin a free cat it pairs with (or -1), blocked the stuck cat it
     * opens up (or -1). kind 'pair': any free cat; 'sides': a free cat beside a boxed-in one; 'covered': a
     * free cat sitting on a covered one. Prefers a fully free pair whose two taps still leave a win.
     */
    coachTarget(kind, opts) {
      opts = opts || {};
      if (this.over) return null;
      const free = this.legalTaps();
      const freeSet = new Set(free);
      const cands = [];
      for (const t of free) {
        let blocked = -1;
        if (kind === 'sides') {
          for (const c of this.geom.left[t].concat(this.geom.right[t])) if (this.present[c] && this.blockReason(c) === 'sides') { blocked = c; break; }
          if (blocked < 0) continue;
        } else if (kind === 'covered') {
          for (const c of this.geom.below[t]) if (this.present[c] && this.blockReason(c) === 'covered') { blocked = c; break; }
          if (blocked < 0) continue;
        }
        const twins = free.filter((u) => u !== t && freeSet.has(u) && facesMatch(this.faces[u], this.faces[t]));
        cands.push({ tile: t, twins, blocked });
      }
      if (!cands.length) return null;
      const budget = opts.maxNodes || 20000;
      const winsAfter = (t, u) => {
        const r1 = this.tap(t); if (!r1) return false;
        let ok = false;
        if (u >= 0) { const r2 = this.over ? null : this.tap(u); ok = !!r2 && !this.over && (this.remaining === 0 || this.isSolvable(budget) === true); if (r2) this.undo(); }
        else ok = !this.over && (this.remaining === 0 || this.isSolvable(budget) === true);
        this.undo();
        return ok;
      };
      // 1) both cats free and the pair keeps a win open, 2) both free, 3) a lone free cat that keeps a win open
      for (const c of cands) for (const u of c.twins) if (winsAfter(c.tile, u)) return { tile: c.tile, twin: u, blocked: c.blocked };
      for (const c of cands) if (c.twins.length) return { tile: c.tile, twin: c.twins[0], blocked: c.blocked };
      for (const c of cands) if (winsAfter(c.tile, -1)) return { tile: c.tile, twin: -1, blocked: c.blocked };
      return { tile: cands[0].tile, twin: -1, blocked: cands[0].blocked };
    }
    /**
     * Shuffle: re-deal the faces still on the board (shelf tiles keep theirs) so the board can be cleared
     * from the current tray: a fresh tap order where the first closers pick up the shelf keys. Works from a
     * full tray too (the first taps then break with shelf tiles).
     */
    shuffle() {
      const rng = new SplitMix64(deriveSeed(this.board.seed || 1, 1000 + this.shuffleCount));
      const order = buildTapOrder(this.geom, this.present, rng);
      if (!order.length) return false;
      const hold = Math.max(1, Math.min(this.board.hold || 2, this.hold));
      const freeAt = tapFreeSteps(this.geom, order, this.present);
      const { pairs, trayClosers } = pairTapOrder(order, rng, hold, this.board.closeBias == null ? 0.5 : this.board.closeBias, this.tray.slice(), this.board.deep || 0, freeAt);
      // board faces per match key; one copy of each shelf key goes to that shelf tile's closer
      const byKey = new Map();
      for (let i = 0; i < this.geom.n; i++) if (this.present[i]) { const k = matchKey(this.faces[i]); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(this.faces[i]); }
      const prevFaces = this.faces.slice(), prevSolution = this.solution;
      const faces = this.faces.slice();
      for (const t of this.tray) {
        const k = matchKey(this.faces[t]); const list = byKey.get(k);
        if (!list || !list.length) return false; // cannot happen while the parity invariant holds
        faces[trayClosers[t]] = list.splice(rng.nextInt(list.length), 1)[0];
      }
      const labels = [...byKey.entries()].filter(([, f]) => f.length).map(([key, f]) => ({ key, faces: f }));
      // free steps replay over the board as it is (cleared and shelf tiles are gone)
      assignFaces(this.geom, pairs, labels, rng, this.board.trapDensity || 0, faces, this.board.spread || 0, this.present);
      this.faces = faces;
      this.solution = order;
      this.shuffleCount++;
      this.history.push({ type: 'shuffle', prevFaces, prevSolution });
      return true;
    }
    serialize() {
      return { v: 2, boardId: this.board.boardId, layoutId: this.layout.layoutId, faces: this.faces.slice(), present: Array.from(this.present), tray: this.tray.slice(), slots: this.slots, revives: this.revives, history: this.history.map((h) => Object.assign({}, h)), shuffleCount: this.shuffleCount, moves: this.moves, taps: this.taps, solution: this.solution ? this.solution.slice() : null };
    }
    static restore(layout, board, s) {
      const g = new Game(layout, board, { faces: s.faces, slots: s.slots });
      g.present = Uint8Array.from(s.present);
      g.tray = (s.tray || []).slice();
      g.history = s.history || [];
      g.shuffleCount = s.shuffleCount || 0;
      g.moves = s.moves || 0;
      g.taps = s.taps || 0;
      g.revives = s.revives || 0;
      g.solution = s.solution || null;
      return g;
    }
  }

  return { BONUS_SETS, TRAY_SLOTS, TRAY_HOLD, matchKey, facesMatch, SplitMix64, deriveSeed, buildGeometry, isFreeIn, isFreeZ1, freeList, buildRemovalOrder, buildTapOrder, pairTapOrder, tapFreeSteps, heldKeys, checkTaps, freeSteps, trapScore, groupPairs, assignFaces, boardLabels, boardTileCount, generateDeal, generateTrayDeal, solve, solveTray, Game };
});
