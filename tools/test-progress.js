#!/usr/bin/env node
/* Unit tests for src/progress.js (v5.5.1 classic-campaign open). Run: node tools/test-progress.js */
'use strict';
const PG = require('../src/progress.js');
const C = PG.CLASSIC_THROUGH;
let failed = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failed++; console.error('FAIL', name, 'got', g, 'want', w); }
  else console.log('ok  ', name);
}
function ok(name, cond) { eq(name, !!cond, true); }

ok('classic through is 80', C === 80);

// empty save: 1-80 open, 81+ locked, play target is board 1 (not 80)
const empty = {};
ok('board 1 always open', PG.earned(empty, 1));
ok('board 80 always open', PG.earned(empty, 80));
ok('board 40 always open', PG.isUnlocked(empty, 40));
ok('board 81 locked until 80 is cleared', !PG.earned(empty, 81));
ok('board 82 locked', !PG.earned(empty, 82));
eq('playTarget empty is board 1', PG.playTarget(empty, 110), { id: 1, replay: false });
eq('chapter 1 open', PG.chapterLock({ from: 1, to: 9 }, empty), { locked: false, after: 0 });
eq('chapter 8 open', PG.chapterLock({ from: 71, to: 80 }, empty), { locked: false, after: 70 });
eq('chapter 9 locked until 80', PG.chapterLock({ from: 81, to: 90 }, empty), { locked: true, after: 80 });
eq('canStart 80 empty ok', PG.canStart(80, { cleared: empty }, { total: 110 }), { ok: true });
eq('canStart 81 empty blocked', PG.canStart(81, { cleared: empty }, { total: 110 }).ok, false);
eq('highestEarned empty is 80', PG.highestEarned(empty, 110), 80);

// mid-classic progress still starts at the first uncleared classic board
const mid = {}; for (let i = 1; i <= 12; i++) mid[i] = true;
eq('playTarget after 12 is 13', PG.playTarget(mid, 110), { id: 13, replay: false });
ok('board 80 still open mid-campaign', PG.isUnlocked(mid, 80));
ok('board 81 still locked mid-campaign', !PG.isUnlocked(mid, 81));
eq('newlyUnlocked mid-classic is null (next already open)', PG.newlyUnlocked(mid, 12, 110), null);

// completed all 80 (pre-merge player)
const all80 = {}; for (let i = 1; i <= 80; i++) all80[String(i)] = true; // string keys, as in JSON.parse
ok('81 open after 80 cleared (string keys)', PG.isUnlocked(all80, 81));
ok('82 still locked', !PG.isUnlocked(all80, 82));
eq('playTarget after 80 is 81', PG.playTarget(all80, 110), { id: 81, replay: false });
eq('chapter 9 open after 80', PG.chapterLock({ from: 81, to: 90 }, all80), { locked: false, after: 80 });
eq('chapter 10 locked', PG.chapterLock({ from: 91, to: 100 }, all80), { locked: true, after: 90 });
eq('newlyUnlocked 80 opens 81', PG.newlyUnlocked({ ...all80, 80: false }, 80, 110) || PG.newlyUnlocked((() => { const c = {}; for (let i = 1; i <= 79; i++) c[i] = true; return c; })(), 80, 110), 81);
eq('canStart 81 after 80', PG.canStart(81, { cleared: all80 }, { total: 110 }), { ok: true });
eq('canStart 82 after 80', PG.canStart(82, { cleared: all80 }, { total: 110 }).ok, false);

// sequential in the new chapters
const through81 = Object.assign({}, all80, { 81: true });
ok('82 open after 81', PG.isUnlocked(through81, 82));
ok('83 locked after 81', !PG.isUnlocked(through81, 83));
eq('playTarget after 81 is 82', PG.playTarget(through81, 110), { id: 82, replay: false });
eq('newlyUnlocked 81 opens 82', PG.newlyUnlocked(all80, 81, 110), 82);

// all 110 cleared: replay last
const all110 = {}; for (let i = 1; i <= 110; i++) all110[i] = true;
eq('playTarget all cleared replays 110', PG.playTarget(all110, 110), { id: 110, replay: true });

// unlockAll override
ok('unlockAll opens 110', PG.isUnlocked(empty, 110, { unlockAll: true }));
eq('chapter 11 open with override', PG.chapterLock({ from: 101, to: 110 }, empty, { unlockAll: true }), { locked: false, after: 100 });

console.log(failed ? `\n${failed} failed` : '\nall progress tests ok');
process.exit(failed ? 1 : 0);
