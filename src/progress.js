/* Purrjong level locks (v5.4). Pure functions, node-testable; app.js uses window.PurrProgress.
   Rule: board 1 is always open; board N+1 opens once board N is cleared. There is no stored "unlocked" list:
   it is derived from P.cleared, so every existing save keeps each board it has cleared plus the board after it
   (that is the whole save migration, even for saves that skipped around before locks existed).
   The Daily opens after board 6 (the dimmed tutorial boards 1-5 plus the first full board); anyone who already
   played a Daily keeps it. Developer "Unlock all boards" / ?unlockall=1 opens everything for testing, but the
   home Play button still follows real progress. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PurrProgress = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAILY_AFTER = 6;
  const isCleared = (cleared, id) => !!(cleared && (cleared[id] || cleared[String(id)]));

  /** Unlocked by progress alone (ignores the developer override). */
  function earned(cleared, id) {
    id = Number(id);
    if (!(id >= 1)) return false;
    return id === 1 || isCleared(cleared, id) || isCleared(cleared, id - 1);
  }
  /** Can this board be played? opts.unlockAll = developer override. */
  function isUnlocked(cleared, id, opts) {
    if (opts && opts.unlockAll) return Number(id) >= 1;
    return earned(cleared, id);
  }
  /** Home Play target: the furthest board unlocked by progress that is not cleared yet; all cleared = replay the last. */
  function playTarget(cleared, total) {
    for (let id = total; id >= 1; id--) if (earned(cleared, id) && !isCleared(cleared, id)) return { id, replay: false };
    return { id: total, replay: true };
  }
  /** 'Beat Board 7 to unlock' for board 8. */
  function lockReason(id) { return `Beat Board ${Number(id) - 1} to unlock`; }
  /** A chapter is locked while none of its boards are playable; it opens after the board before its first one. */
  function chapterLock(ch, cleared, opts) {
    for (let id = ch.from; id <= ch.to; id++) if (isUnlocked(cleared, id, opts)) return { locked: false, after: ch.from - 1 };
    return { locked: true, after: ch.from - 1 };
  }
  /** After clearing board id: the board that this clear newly opened (by progress), or null. clearedBefore = before the win. */
  function newlyUnlocked(clearedBefore, id, total) {
    const next = Number(id) + 1;
    if (!(next <= total)) return null;
    if (earned(clearedBefore, next)) return null;
    const after = Object.assign({}, clearedBefore, { [id]: true });
    return earned(after, next) ? next : null;
  }
  function dailyUnlocked(cleared, daily, opts) {
    if (opts && opts.unlockAll) return true;
    if (isCleared(cleared, DAILY_AFTER)) return true;
    return !!(daily && Object.keys(daily).some((k) => daily[k])); // grandfathered: already played a Daily before locks
  }
  /** Guard for every way into a board (cards, Play, Next, Resume, deep links): { ok, reason }. */
  function canStart(target, profile, opts) {
    const p = profile || {};
    if (target === 'daily') return dailyUnlocked(p.cleared, p.daily, opts) ? { ok: true } : { ok: false, reason: `Beat Board ${DAILY_AFTER} to unlock the Daily` };
    const id = Number(target);
    if (!(id >= 1) || (opts && opts.total && id > opts.total)) return { ok: false, reason: 'No such board' };
    return isUnlocked(p.cleared, id, opts) ? { ok: true } : { ok: false, reason: lockReason(id) };
  }
  /** Highest board open by progress (for chapter teasers and the album). */
  function highestEarned(cleared, total) {
    let h = 1;
    for (let id = 1; id <= total; id++) if (earned(cleared, id)) h = id;
    return h;
  }
  return { DAILY_AFTER, earned, isUnlocked, playTarget, lockReason, chapterLock, newlyUnlocked, dailyUnlocked, canStart, highestEarned };
});
