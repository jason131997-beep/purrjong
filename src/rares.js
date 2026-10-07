/* Purrjong collectible rare cats (v5). Pure logic, no DOM: works in the browser (window.PurrRares) and node.
   A rare is a purely cosmetic re-skin: when a board starts, one cat on that board may be drawn as a rare cat.
   The rules (game.faces, solver, hints, shuffle) never see it, so solvability is untouched. Every copy of that
   cat on the board wears the skin, so what matches on screen is always what matches in the rules (a cat with
   only two copies is preferred, so it is usually exactly one rare pair). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PurrRares = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TIERS = {
    rare: { name: 'Rare', base: 0.12, color: '#A9B4C2', burst: ['#E9EEF5', '#A9B4C2'] },
    epic: { name: 'Epic', base: 0.04, color: '#D9A93C', burst: ['#F6D06B', '#B65CC8'] },
    legendary: { name: 'Legendary', base: 0.01, color: '#B98BEA', burst: ['#F28BA8', '#7EA8F0'] },
  };
  const ROSTER = {
    rare: ['pearl', 'ember', 'matcha', 'ronin', 'shinobi', 'hanami', 'kumo', 'tanuki'],
    epic: ['jade-guardian', 'ninetails', 'yurei', 'ryu', 'hoo'],
    legendary: ['cosmos', 'jade-emperor', 'tsukuyomi'],
  };
  const ALL = [].concat(ROSTER.rare, ROSTER.epic, ROSTER.legendary);
  const TIER_OF = {};
  for (const t of Object.keys(ROSTER)) for (const id of ROSTER[t]) TIER_OF[id] = t;
  const FIRST_BOARD = 4;        // eligible after board 3
  const PITY_STEP = 0.015;      // +1.5 points of total rare chance per board without a rare...
  const PITY_MAX = 0.15;        // ...up to +15 points
  const HARD_MULT = 1.25;       // Hard boards roll a little better
  const BONUS = { 'spring': 1, 'summer': 1, 'autumn': 1, 'winter': 1, 'lucky-white': 1, 'lucky-gold': 1, 'lucky-black': 1, 'lucky-jade': 1 };

  /** Per-tier odds for one board start. pity = boards played since the last rare (eligible boards only). */
  function odds(opts) {
    opts = opts || {};
    const mult = opts.hard ? HARD_MULT : 1;
    const base = TIERS.rare.base + TIERS.epic.base + TIERS.legendary.base;
    const total = Math.min(0.6, base * mult + Math.min(PITY_MAX, (opts.pity || 0) * PITY_STEP));
    const k = total / base; // pity and Hard scale every tier together, so the tier mix stays 12 : 4 : 1
    return { rare: TIERS.rare.base * k, epic: TIERS.epic.base * k, legendary: TIERS.legendary.base * k, total };
  }
  function eligible(board) {
    if (!board) return false;
    if (board.isDaily) return true;
    return typeof board.boardId === 'number' && board.boardId >= FIRST_BOARD;
  }
  /** Which cat to re-skin: a non-bonus cat with exactly 2 copies if the board has one, else any non-bonus cat. */
  function pickBase(board, faces, rand) {
    const count = {};
    for (const f of faces) if (!BONUS[f]) count[f] = (count[f] || 0) + 1;
    const ids = Object.keys(count).sort();
    if (!ids.length) return null;
    const pairs = ids.filter((id) => count[id] === 2);
    const from = pairs.length ? pairs : ids;
    return from[Math.floor(rand() * from.length) % from.length];
  }
  /**
   * Roll for a board start. rand: () => [0, 1) (Math.random in the app, seeded in tests; never the board seed,
   * so replays can differ). state: { pity, last }. Returns { id, tier, base } or null.
   */
  function roll(board, faces, state, rand, opts) {
    opts = opts || {};
    if (!eligible(board) && !opts.force) return null;
    const o = odds({ pity: (state && state.pity) || 0, hard: !!(board && board.hard) });
    let tier = null;
    if (opts.force) tier = TIER_OF[opts.force] || (TIERS[opts.force] ? opts.force : 'rare');
    else {
      const r = rand();
      tier = r < o.legendary ? 'legendary' : r < o.legendary + o.epic ? 'epic' : r < o.total ? 'rare' : null;
    }
    if (!tier) return null;
    let list = ROSTER[tier];
    let id = opts.force && TIER_OF[opts.force] ? opts.force : null;
    if (!id) {
      const last = state && state.last;
      const pool = list.filter((x) => x !== last); // never the same rare twice in a row
      id = pool[Math.floor(rand() * pool.length) % pool.length];
    }
    const base = pickBase(board, faces, rand);
    if (!base) return null;
    return { id, tier: TIER_OF[id], base };
  }
  /** Profile bookkeeping after a roll (pity counter, last rare). Mutates and returns state. */
  function afterRoll(state, board, got) {
    state = state || {};
    if (!eligible(board)) return state;
    if (got) { state.pity = 0; state.last = got.id; } else state.pity = (state.pity || 0) + 1;
    return state;
  }
  /** A saved roll is only reused if it still fits the board (same cat present). */
  function validSaved(saved, faces) {
    return !!(saved && TIER_OF[saved.id] && saved.base && faces.indexOf(saved.base) >= 0);
  }
  return { TIERS, ROSTER, ALL, TIER_OF, FIRST_BOARD, PITY_STEP, PITY_MAX, HARD_MULT, odds, eligible, pickBase, roll, afterRoll, validSaved };
});
