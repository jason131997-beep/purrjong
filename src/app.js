/* Purrjong browser prototype UI. Rules live in core.js; this file is view + persistence + juice.
   v4: Vita-style shelf play (tap a free cat onto a 4-slot shelf; two matching cats break), Vita-style undo,
   synthesized SFX + offline-rendered music (src/audio.js), haptics (src/haptics.js). */
(function () {
  'use strict';
  const D = window.PURRJONG_DATA, C = window.PurrjongCore;
  const LAYOUTS = Object.fromEntries(D.layouts.layouts.map((l) => [l.layoutId, l]));
  const BOARDS = D.boards.boards;
  const CATS = Object.fromEntries(D.cats.cats.map((c) => [c.id, c]));
  const SUIT_LETTER = { garden: 'G', teahouse: 'T', nightmarket: 'N', festival: 'F', grove: 'B', pond: 'K', blossom: 'H', snowy: 'Y', moonlit: 'M' };
  const RS = window.PurrRares;
  // v5 chapters: boards 1-30 become chapters 1-3 (their old scenes); chapters 4-8 are boards 31-80.
  const CHAPTERS = D.boards.chapters || [{ n: 1, id: 'garden', name: 'Tea Garden', scene: 'garden', from: 1, to: BOARDS.length, newCats: [] }];
  const chapterOf = (id) => CHAPTERS.find((c) => id >= c.from && id <= c.to) || CHAPTERS[0];
  const SCENES = ['garden', 'teahouse', 'nightmarket', 'grove', 'pond', 'blossom', 'snowy', 'moonlit'];
  // per-suit tile numbers for helper marks (suit letter + index within the suit)
  const SUIT_NUM = {};
  for (const c of D.cats.cats) if (c.suit) { SUIT_NUM[c.suit] = SUIT_NUM[c.suit] || []; SUIT_NUM[c.suit].push(c.id); }
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const params = new URLSearchParams(location.search);
  const STORE = 'purrjong.v2';
  const noSave = params.has('fresh');
  // Economy v3 ("harder" retune): help is scarce. See README "Fish economy".
  const HELP_COST = 60;          // fish per hint or shuffle once the free stock is gone
  const UNDO_FREE = 3;           // free undos per board
  const UNDO_COST = 15;          // fish per undo after that
  const REVIVE_COST = 60;        // fish per revive after the free one on each board (native: rewarded ad)
  const PAY = { clear: 8, noHelp: 4, chainMax: 3, daily: 12 };
  const DIM_UNTIL = 5;           // blocked tiles are dimmed on boards 1-5 unless the player opts in
  const PROFILE_VERSION = 4;
  const A = window.PurrAudio || { play() {}, set() {}, unlock() {}, startMusic() {}, stopMusic() {} };
  const H = window.PurrHaptics || { fire() {}, set() {} };

  // ---------------------------------------------------------------- profile + save
  const defaults = () => ({ v: PROFILE_VERSION, fish: 20, hints: 1, shuffles: 1, cleared: {}, stars: {}, best: {}, album: {}, daily: {}, rares: {}, rareState: { pity: 0, last: null }, tipsSeen: {}, howtoSeen: false, settings: { showBlocked: false, marks: false, motion: false, sound: true, music: true, sfxVol: 0.7, musicVol: 0.3, haptics: true, track: 'rotate', trackIdx: 0 }, current: null, coachDone: {} });
  let migratedNote = '';
  let P = (function load() {
    if (noSave) return defaults();
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (s) {
        const p = Object.assign(defaults(), s);
        p.settings = Object.assign(defaults().settings, s.settings || {});
        p.stars = p.stars || {};
        // v5 (rare cats): new fields default safely on older saves; nothing else changes
        p.rares = p.rares || {}; p.rareState = Object.assign({ pity: 0, last: null }, p.rareState || {});
        p.tipsSeen = p.tipsSeen || {}; p.howtoSeen = !!p.howtoSeen; // v5.1 onboarding: older saves see the intro before board 1
        if ((s.v || 0) < 3) {
          // v3 retune: boards were re-dealt (old mid-board saves no longer fit) and help got scarce.
          p.hints = Math.min(p.hints, 1); p.shuffles = Math.min(p.shuffles, 1); p.fish = Math.min(p.fish, HELP_COST);
          delete p.settings.dim; p.settings.showBlocked = false;
        }
        if ((s.v || 0) < PROFILE_VERSION) {
          // v4 shelf play: boards re-dealt for the tray (mid-board saves dropped). Cleared boards, stars,
          // album, fish and stock are kept. Sound was opt-in before; it now has music + SFX on by default.
          p.current = null;
          p.settings.sound = true; p.settings.music = true;
          p.v = PROFILE_VERSION;
          migratedNote = 'New: the cat shelf! Boards were re-dealt for shelf play. Your cleared boards and stars are kept.';
        }
        if (p.current && (!p.current.state || p.current.state.v !== 2)) p.current = null; // pre-tray save shape
        return p;
      }
    } catch (e) { /* ignore */ }
    return defaults();
  })();
  function save() { if (!noSave) try { localStorage.setItem(STORE, JSON.stringify(P)); } catch (e) { /* ignore */ } }
  /** Dimming blocked tiles makes boards much easier: tutorial boards only, or by choice. */
  function dimOn() {
    if (P.settings.showBlocked) return true;
    return !!(board && !board.isDaily && board.boardId <= DIM_UNTIL);
  }
  const mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  /** Reduced motion: the in-game setting or the system preference. */
  const RM = () => !!P.settings.motion || mqReduce.matches;
  function applySettings() {
    app.classList.toggle('dim', dimOn());
    app.classList.toggle('marks', !!P.settings.marks);
    app.classList.toggle('reduce-motion', RM());
    $('optBlocked').checked = !!P.settings.showBlocked; $('optMarks').checked = !!P.settings.marks; $('optMotion').checked = !!P.settings.motion;
    $('optSound').checked = !!P.settings.sound; $('optMusic').checked = !!P.settings.music; $('optHaptics').checked = !!P.settings.haptics;
    $('volSound').value = Math.round((P.settings.sfxVol == null ? 0.7 : P.settings.sfxVol) * 100);
    $('volMusic').value = Math.round((P.settings.musicVol == null ? 0.3 : P.settings.musicVol) * 100);
    $('volSound').disabled = !P.settings.sound; $('volMusic').disabled = !P.settings.music;
    const hn = $('optHapticsNote');
    if (hn) hn.textContent = H.supported ? 'Taps, matches and a full shelf' : 'Not available in this browser';
    A.set({ sound: !!P.settings.sound, music: !!P.settings.music, sfxVol: P.settings.sfxVol == null ? 0.7 : P.settings.sfxVol, musicVol: P.settings.musicVol == null ? 0.3 : P.settings.musicVol, track: P.settings.track || 'rotate', trackIdx: P.settings.trackIdx | 0 });
    const ot = $('optTrack');
    if (ot) {
      if (!ot.options.length) ot.innerHTML = '<option value="rotate">Rotate all</option>' + (A.tracks || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
      ot.value = P.settings.track || 'rotate'; ot.disabled = !P.settings.music;
      trackNote();
    }
    H.set(!!P.settings.haptics);
    const note = $('optBlockedNote');
    if (note) note.textContent = (board && !board.isDaily && board.boardId <= DIM_UNTIL && !P.settings.showBlocked) ? `Shown on boards 1–${DIM_UNTIL} while you learn` : 'Off by default from board 6: harder';
  }
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', () => applySettings());

  // ---------------------------------------------------------------- sound + haptics (src/audio.js, src/haptics.js)
  const sfx = (name, arg) => A.play(name, arg);
  function trackNote() {
    const n = $('optTrackNote'); if (!n) return;
    const id = A.current, t = (A.tracks || []).find((x) => x.id === id);
    n.textContent = t ? `Now playing: ${t.name}` : (P.settings.track === 'rotate' || !P.settings.track ? 'A new track each level' : '');
  }
  A.onTrack = (idx) => { P.settings.trackIdx = idx; save(); trackNote(); };
  const buzz = (name) => H.fire(name);
  // iOS only plays the switch tick inside a user gesture. WebKit forwards a gesture to timers started within
  // it (up to ~1 s), so when the shelf is idle the tap handler schedules the land / break / full / win ticks
  // for the moment the animation reaches them, instead of firing them later from animation callbacks.
  const pre = { full: -1, win: false };
  const buzzLater = (name, ms) => { if (ms <= 0) buzz(name); else setTimeout(() => buzz(name), ms); };
  // iOS needs the AudioContext started inside a real gesture: touchend / click / pointerup (not pointerdown)
  const unlockAudio = () => { A.unlock(); if (P.settings.music) A.startMusic(); };
  for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });

  // ---------------------------------------------------------------- scenes + ambient petals
  function setScene(id) {
    const el = $('scene'); if (!el) return;
    el.classList.remove(...SCENES);
    if (SCENES.includes(id) && id !== 'garden') el.classList.add(id);
  }
  function sceneForBoard(b) {
    if (b && b.scene) return b.scene;
    if (!b) return 'garden';
    if (typeof b.boardId === 'number') return chapterOf(b.boardId).scene;
    if (b.boardId >= 20) return 'nightmarket';
    if (b.boardId >= 10) return 'teahouse';
    return 'garden';
  }
  function startAmbience() {
    const a = $('ambience'); if (!a || P.settings.motion) { if (a) a.innerHTML = ''; return; }
    if (a.childElementCount) return;
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div'); d.className = 'drift';
      d.innerHTML = '<svg viewBox="-8 -8 16 16"><path d="M0,6 C-6,2 -6,-5 -2.5,-7 L0,-4.5 L2.5,-7 C6,-5 6,2 0,6 Z" fill="#F2B8C2" stroke="#2B2A28" stroke-width=".7" stroke-opacity=".35"/></svg>';
      d.style.left = (8 + Math.random() * 84) + '%';
      d.style.animationDuration = (10 + Math.random() * 14) + 's';
      d.style.animationDelay = (Math.random() * 10) + 's';
      d.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px');
      d.style.setProperty('--r', (Math.random() * 400 - 200) + 'deg');
      a.appendChild(d);
    }
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dailyBoardDef() {
    // Mid-size seeded daily from the board 12–19 layout pool (68–92 tiles)
    const pool = BOARDS.filter((b) => b.boardId >= 12 && b.boardId <= 19);
    const key = todayKey();
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    const base = pool[Math.abs(h) % pool.length];
    const seed = (Math.abs(h) >>> 0) ^ 0xD41A2026;
    return Object.assign({}, base, {
      boardId: 'daily',
      name: 'Daily',
      seed,
      trapDensity: 0.7,
      hard: false,
      introduces: 'Daily puzzle',
      tip: 'Same board worldwide today. Three free undos.',
      isDaily: true,
    });
  }

  // ---------------------------------------------------------------- helpers
  const art = (face) => `art/cats/${face}.svg`;
  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }
  // Tips live in the header (over the board title), never over the board, so they can't hide a hinted cat.
  let tipTimer = 0;
  function tip(msg, ms) {
    const t = $('tip'); t.textContent = msg; t.classList.add('show');
    t.parentElement.classList.add('tipping');
    clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, ms || 3500);
  }
  function hideTip() { clearTimeout(tipTimer); const t = $('tip'); t.classList.remove('show'); t.parentElement.classList.remove('tipping'); }
  function show(name) { for (const s of ['home', 'album', 'play']) $(s).hidden = s !== name; $('fly').hidden = name !== 'play'; }
  function purse() { return `<span title="Fish">🐟 ${P.fish}</span>`; }
  function markFor(face) {
    const c = CATS[face]; if (!c) return '';
    if (c.bonusSet) return c.bonusSet === 'seasons' ? 'S' : 'L';
    if (c.rarity) return '★';
    return (SUIT_LETTER[c.suit] || '') + ((SUIT_NUM[c.suit] || []).indexOf(c.id) + 1);
  }

  // ---------------------------------------------------------------- home
  function shapeSVG(l) {
    const sx = 1, sy = 4 / 3;
    let r = '';
    for (const [x, y, z] of l.tiles) {
      const fill = ['#CFE3D6', '#8FC0AB', '#5E9C86', '#3F7563'][z] || '#3F7563';
      r += `<rect x="${x * sx - z * 0.35 + 0.1}" y="${y * sy - z * 0.35 + 0.1}" width="${2 * sx - 0.2}" height="${2 * sy - 0.2}" rx="0.3" fill="${fill}" stroke="#2B2A28" stroke-opacity=".35" stroke-width=".12"/>`;
    }
    return `<svg class="shape" viewBox="-0.8 -0.8 ${l.width * sx + 1.6} ${l.height * sy + 1.6}" preserveAspectRatio="xMidYMid meet">${r}</svg>`;
  }
  function boardCard(b, next) {
    const l = LAYOUTS[b.layoutId];
    const cleared = P.cleared[b.boardId];
    const inProgress = P.current && P.current.boardId === b.boardId;
    const lucky = (b.bonusSets || []).includes('lucky');
    const seasons = (b.bonusSets || []).includes('seasons');
    const bonusLabel = lucky ? ' + Lucky' : seasons ? ' + Seasons' : '';
    const st = (P.stars && P.stars[b.boardId]) || 0;
    const bt = P.best && P.best[b.boardId];
    return `<button class="bcard${seasons ? ' seasons' : ''}${lucky ? ' lucky' : ''}${cleared ? ' done' : ''}${!cleared && b.boardId === next ? ' is-next' : ''}" data-board="${b.boardId}">
        ${cleared ? '<div class="mini-seal">Cleared</div>' : ''}${!cleared && b.boardId === next ? '<div class="new">Next</div>' : ''}${inProgress && !cleared ? '<div class="new">Resume</div>' : ''}
        <div class="num">${b.boardId}</div>${shapeSVG(l)}<div class="nm">${l.name}</div>
        <div class="meta">${l.tileCount} tiles · ${l.layers} layers${bonusLabel}</div>${cleared || b.hard ? `<div class="bfoot">${cleared ? `<span class="stars" aria-label="${st} of 3 stars">${starStr(st)}</span>` : ''}${b.hard ? '<span class="hard-badge">Hard</span>' : ''}</div>` : ''}${bt ? `<div class="btime" aria-label="Best time ${fmtTime(bt)}">⏱ ${fmtTime(bt)}</div>` : ''}</button>`;
  }
  function albumTotals() {
    const metAll = params.has('albumAll');
    const commons = D.cats.cats.filter((c) => !c.rarity), rares = D.cats.cats.filter((c) => c.rarity);
    return {
      common: commons.filter((c) => metAll || (P.album[c.id] || 0) > 0).length, commonTotal: commons.length,
      rare: rares.filter((c) => metAll || (P.rares[c.id] || 0) > 0).length, rareTotal: rares.length,
    };
  }
  function renderHome() {
    const next = (BOARDS.find((b) => !P.cleared[b.boardId]) || {}).boardId;
    const curCh = chapterOf(next || BOARDS.length);
    setScene(curCh.scene);
    startAmbience();
    $('purseHome').innerHTML = purse();
    const clearedCount = Object.keys(P.cleared).filter((k) => String(k) !== 'daily' && P.cleared[k]).length;
    if ($('homeSub')) $('homeSub').textContent = `Chapter ${curCh.n} · ${curCh.name}`;
    $('boardGrid').innerHTML = CHAPTERS.map((ch) => {
      const bs = BOARDS.filter((b) => b.boardId >= ch.from && b.boardId <= ch.to);
      const done = bs.filter((b) => P.cleared[b.boardId]).length;
      const stars = bs.reduce((a, b) => a + ((P.stars && P.stars[b.boardId]) || 0), 0);
      const cats = (ch.newCats || []).map((id) => `<img src="${art(id)}" alt="" class="${(P.album[id] || 0) > 0 ? '' : 'unmet'}">`).join('');
      const fresh = ch.n >= 4 && done === 0;
      return `<section class="chapter" id="chapter-${ch.n}" data-chapter="${ch.n}">
        <header class="chap chap-${ch.scene}" style="--scene:url('${new URL(`art/scenes/${ch.scene}.svg`, location.href).href}')">
          <div class="chap-body"><small>Chapter ${ch.n}${fresh ? ' <i class="chap-new">New</i>' : ''}</small><b>${ch.name}</b>
          <span>Boards ${ch.from}–${ch.to} · ${done}/${bs.length} cleared · <em>★ ${stars}/${bs.length * 3}</em></span></div>
          ${cats ? `<div class="chap-cats" aria-label="New cats">${cats}</div>` : ''}
          <div class="chap-bar"><i style="width:${Math.round((done / bs.length) * 100)}%"></i></div>
        </header>
        <div class="chap-grid">${bs.map((b) => boardCard(b, next)).join('')}</div></section>`;
    }).join('');
    const tot = albumTotals();
    $('albumCount').textContent = `${tot.common}/${tot.commonTotal} · ★${tot.rare}`;
    // bring the chapter you're playing into view (once per render, instant)
    const sc = $('homeScroll'), target = next ? document.querySelector(`#boardGrid [data-board="${next}"]`) : null;
    if (sc && target && curCh.n > 1 && !params.has('top')) requestAnimationFrame(() => { sc.scrollTop = Math.max(0, target.closest('.chapter').offsetTop - 6); });
    else if (sc) sc.scrollTop = 0;
    // Daily stub: unlocks after board 5
    const dailyBtn = $('btnDaily');
    if (dailyBtn) {
      const unlocked = !!P.cleared[5] || clearedCount >= 5 || params.has('daily');
      dailyBtn.hidden = !unlocked;
      if (unlocked) {
        const key = todayKey();
        const done = !!(P.daily && P.daily[key]);
        dailyBtn.classList.toggle('done', done);
        $('dailyLabel').textContent = done ? 'Daily cleared' : "Today's puzzle";
        $('dailyMeta').textContent = done ? key + ' · come back tomorrow' : key + ' · same seed worldwide';
        dailyBtn.querySelector('.daily-go').textContent = done ? 'Replay' : 'Play';
      }
    }
  }
  $('boardGrid').addEventListener('click', (e) => {
    const c = e.target.closest('[data-board]'); if (c) startBoard(Number(c.dataset.board));
  });

  function starStr(n) { return '<b>' + '★'.repeat(n) + '</b>' + '☆'.repeat(3 - n); }
  /** 3 = no hints, shuffles or undos; 2 = no hints or shuffles; 1 = cleared. */
  function starsFor(cur) { return cur.usedHelp ? 1 : cur.usedUndo ? 2 : 3; }

  // ---------------------------------------------------------------- album
  function renderAlbum() {
    const metAll = params.has('albumAll');
    const suits = (D.cats.suits || []).map((x) => [x.name + (x.chapter ? ` · Chapter ${x.chapter}` : ''), (c) => c.suit === x.id]);
    const groups = suits.concat([['Seasons', (c) => c.bonusSet === 'seasons'], ['Lucky', (c) => c.bonusSet === 'lucky']]);
    let html = groups.map(([name, f]) => {
      const cs = D.cats.cats.filter(f);
      const n = cs.filter((c) => metAll || (P.album[c.id] || 0) > 0).length;
      return `<h4>${name} <small>${n}/${cs.length}</small></h4><div class="album-grid">${cs.map((c) => {
        const k = P.album[c.id] || 0; const isMet = k > 0 || metAll;
        return `<div class="acard${isMet ? '' : ' locked'}"><img src="${art(c.id)}" alt=""><div><b>${isMet ? c.name : '???'}</b><small>${isMet ? c.bio : 'Match this cat to meet them.'}</small>${isMet ? `<span class="stamp">● met${k >= 50 ? ' ● 50' : ''}${k >= 200 ? ' ● 200' : ''}</span>` : ''}</div></div>`;
      }).join('')}</div>`;
    }).join('');
    // Rare cats: collection hunt. Undiscovered ones show as silhouettes with their tier.
    const tiers = (D.cats.rarities || []).slice().reverse();
    const rareCats = D.cats.cats.filter((c) => c.rarity);
    const found = rareCats.filter((c) => metAll || (P.rares[c.id] || 0) > 0).length;
    const odds = RS ? RS.odds({}) : null;
    html = `<div class="rare-head"><h4>Rare cats <small>${found}/${rareCats.length} found</small></h4>
      <p>Rare cats sometimes sneak onto a board (from board 4). Match one to collect it.${odds ? ` Odds per board: Rare ${Math.round(odds.rare * 100)}% · Epic ${Math.round(odds.epic * 100)}% · Legendary ${Math.round(odds.legendary * 100)}%, a bit more on Hard boards and the longer you go without one.` : ''}</p></div>` +
      tiers.map((t) => {
        const cs = rareCats.filter((c) => c.rarity === t.id);
        return `<h5 class="tier-h tier-${t.id}">${t.name}</h5><div class="album-grid rare-grid">${cs.map((c) => {
          const k = P.rares[c.id] || 0, isMet = k > 0 || metAll;
          return `<div class="acard rcard tier-${c.rarity}${isMet ? '' : ' locked'}"><img src="${art(c.id)}" alt=""><div><i class="tier-chip">${t.name}</i><b>${isMet ? c.name : '?'}</b><small>${isMet ? c.bio : 'Not found yet. Keep playing!'}</small>${isMet ? `<span class="stamp">Matched ×${k}</span>` : ''}</div></div>`;
        }).join('')}</div>`;
      }).join('') + html;
    $('albumList').innerHTML = html;
    const tot = albumTotals();
    $('albumMet').textContent = `${tot.common}/${tot.commonTotal} cats · ${tot.rare}/${tot.rareTotal} rare`;
  }

  // ---------------------------------------------------------------- play state
  let game = null, board = null, layout = null, els = [], M = null, busy = false;
  let lastMatchAt = 0, combo = 0, blockedTipShown = false, coachStage = 0, warnedAt = -1, startGen = 0;
  // ---- collectible rare cats: a cosmetic skin over one cat of the board (src/rares.js). Rules never see it.
  let rare = null; // { id, tier, base } for the current board
  const skin = (face) => (rare && face === rare.base ? rare.id : face);
  const isRareFace = (face) => !!(rare && face === rare.base);
  function rollRare(keep) {
    if (!RS) return null;
    const force = params.get('rare');
    if (force) return RS.roll(board, game.faces, P.rareState, Math.random, { force });
    if (keep) return keep.rare; // Retry keeps this board's roll (no re-roll fishing, no lost rare)
    const got = RS.roll(board, game.faces, P.rareState, Math.random);
    RS.afterRoll(P.rareState, board, got);
    return got;
  }
  const hiddenBoard = new Set();  // present in the rules but drawn elsewhere (flying back from the shelf)
  const lifted = new Set();       // tapped, waiting in the animation queue (drawn lifted on the board)

  // motion tokens: one easing family, consistent timings (ms)
  const EASE = { out: 'cubic-bezier(.22, 1, .36, 1)', inOut: 'cubic-bezier(.65, 0, .35, 1)', spring: 'cubic-bezier(.34, 1.56, .64, 1)', in: 'cubic-bezier(.55, 0, 1, .45)' };
  const T = { fly: 300, slide: 210, land: 170, squash: 90, pop: 210, back: 300, enter: 380 };
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** WAAPI with a promise that always settles (also when cancelled or when animations are off). */
  function anim(el, frames, opts) {
    if (!el.animate) return Promise.resolve();
    const a = el.animate(frames, opts);
    // watchdog: never let a stalled animation (backgrounded tab, iOS quirks) block the queue or the sheets
    const max = ((opts && opts.duration) || 0) + ((opts && opts.delay) || 0) + 400;
    return Promise.race([a.finished.then(() => a, () => a), wait(max).then(() => a)]);
  }

  // ---------------------------------------------------------------- board timer
  // Active play time only: starts at the first tap, pauses while the app is hidden, a sheet is open or the
  // board is not on screen. Stored in P.current.ms so a resumed board keeps its clock. Real local time only:
  // no fake percentiles or leaderboards (that is the native Game Center plan, see README).
  let clockAt = null;
  const fmtTime = (ms, tenths) => {
    const t = Math.max(0, ms || 0), s = Math.floor(t / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const base = (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
    return tenths ? base + '.' + Math.floor((t % 1000) / 100) : base;
  };
  function clockRunning() {
    return !!(game && board && P.current && !$('play').hidden && !document.hidden && $('win').hidden
      && $('deadSheet').hidden && $('setSheet').hidden && $('howto').hidden && $('tipCard').hidden && !game.isWon() && !game.over && (game.taps > 0 || P.current.ms > 0));
  }
  function clockTick() {
    const now = performance.now(), run = clockRunning();
    if (run && clockAt != null && P.current) P.current.ms = (P.current.ms || 0) + Math.min(1000, Math.max(0, now - clockAt));
    clockAt = run ? now : null;
    const el = $('timer');
    if (el && P.current) {
      el.textContent = fmtTime(P.current.ms);
      el.classList.toggle('paused', !run && (P.current.ms || 0) > 0);
      const best = !board || board.isDaily ? null : (P.best || {})[board.boardId];
      el.title = best ? 'Best ' + fmtTime(best, true) : 'Board time';
    }
  }
  setInterval(clockTick, 250);
  document.addEventListener('visibilitychange', () => { clockTick(); if (document.hidden && P.current) save(); });
  window.addEventListener('pagehide', () => { clockTick(); if (P.current) save(); });

  function startBoard(id, opts) {
    opts = opts || {};
    resetFly();
    pre.full = -1; pre.win = false;
    if (id === 'daily' || opts.daily) board = dailyBoardDef();
    else board = BOARDS.find((b) => b.boardId === id) || BOARDS[0];
    layout = LAYOUTS[board.layoutId];
    setScene(sceneForBoard(board));
    startAmbience();
    const prevCur = P.current;
    let freshRare = false;
    if (!opts.restart && P.current && P.current.boardId === board.boardId && P.current.state && P.current.state.v === 2 && P.current.state.faces && P.current.state.faces.length === layout.tiles.length) {
      game = C.Game.restore(layout, board, P.current.state);
      if (P.current.undoFree == null) P.current.undoFree = UNDO_FREE;
      // resume: the same rare is still there after a reload
      rare = RS && RS.validSaved(P.current.rare, game.faces) ? P.current.rare : null;
    } else {
      game = new C.Game(layout, board);
      if (!opts.restart || opts.daily) A.nextTrack(); // playlist: every new level starts the next track (Retry keeps it)
      const keep = opts.restart && prevCur && prevCur.boardId === board.boardId && prevCur.rareRolled ? { rare: RS && RS.validSaved(prevCur.rare, game.faces) ? prevCur.rare : null } : null;
      rare = rollRare(keep);
      freshRare = !!rare;
      P.current = { boardId: board.boardId, ms: 0, state: game.serialize(), usedHelp: false, usedUndo: false, chains: 0, undoFree: UNDO_FREE, isDaily: !!board.isDaily, rare: rare || null, rareRolled: true, newRares: [] };
    }
    hintMarks = null; coachI = -1;
    busy = false; combo = 0; lastMatchAt = 0; blockedTipShown = false; coachStage = 0; warnedAt = -1;
    hiddenBoard.clear(); lifted.clear();
    $('boardLabel').innerHTML = board.isDaily ? (`Daily · ` + todayKey()) : (`Board ${board.boardId} · ${layout.name}${board.hard ? ' <span class="hard-pill">Hard</span>' : ''}`);
    applySettings();
    show('play');
    hideSheets(); $('win').hidden = true;
    clockAt = null; clockTick();
    buildBoard();
    refresh();
    renderTrayInstant();
    save();
    if (game.taps === 0) boardEntry();
    resetTips();
    // first time ever (or an older save reaching board 1): the How to Play intro comes first
    if (!noTips && !P.howtoSeen && !board.isDaily && board.boardId === 1) openHowto();
    const sg = ++startGen;
    afterIntro(() => {
      if (sg !== startGen) return;
      const cards = boardStartTips();
      // boards 1-3 teach with the coach paw: its header text replaces the board tip (no duplicate text)
      const coachWill = !noTips && !board.isDaily && game.taps === 0 && board.boardId <= 3 && !(P.coachDone && P.coachDone[board.boardId]);
      if (board.tip && game.taps === 0 && !coachWill && !cards.includes('undim')) tip(board.tip, 4800);
      if (rare && (freshRare || game.taps === 0) && !cards.includes('rare')) setTimeout(() => toast(`✨ Something ${RS.TIERS[rare.tier].name.toLowerCase()} is hiding on this board…`, 2600), board.tip && game.taps === 0 ? 900 : 300);
      if (!board.isDaily && game.taps === 0) setTimeout(() => { if (sg === startGen) requestAnimationFrame(maybeCoach); }, RM() ? 0 : 520);
      if (cards.length) setTimeout(() => { if (sg === startGen) cards.forEach((k) => tipCard(k)); }, RM() ? 60 : 760);
    });
    if (game.isStuck()) setTimeout(showDead, 300);
  }

  /** Smooth board entry: tiles settle in layer by layer (transform/opacity only). */
  function boardEntry() {
    if (RM()) return;
    els.forEach((e, i) => {
      const p = game.geom.pos[i];
      const delay = Math.min(520, p.z * 110 + (p.y * 9 + p.x * 4) * (els.length > 60 ? 0.6 : 1));
      anim(e, [{ opacity: 0, transform: 'translateY(-16px) scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: T.enter, delay, easing: EASE.out, fill: 'backwards' });
    });
    anim($('shelf'), [{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: EASE.out }); // opacity only: slot rects stay exact
  }

  // Coach paw and hint paw are attached to the tile elements themselves (children of .tile), so they move with
  // the tile, survive no stale coordinates, and are rebuilt with the board on resize.
  const PAW_SVG = '<svg viewBox="0 0 48 48"><ellipse cx="24" cy="30" rx="10" ry="8.5"/><circle cx="10" cy="18" r="4.5"/><circle cx="18" cy="11" r="4.5"/><circle cx="30" cy="11" r="4.5"/><circle cx="38" cy="18" r="4.5"/></svg>';
  let coachI = -1;
  function raise(e, on) { if (on) e.style.zIndex = String(60000 + (Number(e.dataset.z0) || 0)); else e.style.zIndex = e.dataset.z0 || ''; }
  function hideCoach() {
    const e = coachI >= 0 && els[coachI];
    if (e) { e.classList.remove('coach-target'); const p = e.querySelector('.coach-paw'); if (p) p.remove(); if (!e.classList.contains('hint')) raise(e, false); }
    coachI = -1;
  }
  function maybeCoach() {
    if (!board || board.isDaily) return;
    if (P.coachDone && P.coachDone[board.boardId]) return;
    if (board.boardId === 1 && game.taps === 0) {
      // a free cat whose twin is free too, so the first two taps break a pair
      const free = game.freeTiles();
      for (const a of free) for (const b of free) if (a !== b && C.facesMatch(game.faces[a], game.faces[b])) { coachStage = 1; showCoach(a, 'Tap this free cat: it goes to the shelf. Two matching cats pop!'); return; }
    } else if (board.boardId === 2 && game.taps === 0) {
      const blocked = [];
      for (let i = 0; i < game.tileCount; i++) if (game.present[i] && !game.isFree(i)) blocked.push(i);
      if (blocked.length) showCoach(blocked[0], 'Dimmed cats are blocked. Tap the free cats around it first.');
    } else if (board.boardId === 3 && game.taps === 0) {
      const covered = [];
      for (let i = 0; i < game.tileCount; i++) if (game.present[i] && game.blockReason(i) === 'covered') covered.push(i);
      if (covered.length) showCoach(covered[0], 'This cat is covered. Tap the cat on top to reach it.');
    }
  }
  function showCoach(i, msg) {
    hideCoach();
    if (msg) tip(msg, 6000);
    const e = els[i]; if (!e) return;
    coachI = i; e.classList.add('coach-target'); raise(e, true);
    const p = document.createElement('div'); p.className = 'coach-paw'; p.innerHTML = PAW_SVG; e.appendChild(p);
  }
  function markCoachDone() {
    if (!board || board.isDaily) return;
    if (board.boardId <= 3) { P.coachDone = P.coachDone || {}; P.coachDone[board.boardId] = true; save(); }
    hideCoach();
  }
  /** Board 1, after the first cat lands on the shelf: point at its free twin. */
  function coachTwin(tile) {
    if (!board || board.boardId !== 1 || coachStage !== 1) return;
    coachStage = 2;
    const twin = game.freeTiles().find((j) => C.facesMatch(game.faces[j], game.faces[tile]));
    if (twin != null) showCoach(twin, 'Now tap its twin: the pair pops!');
    else hideCoach();
  }

  // ---------------------------------------------------------------- board view
  function computeMetrics() {
    const wrap = $('boardWrap').getBoundingClientRect();
    const Lz = layout.layers, cols = layout.width / 2, rows = layout.height / 2;
    const SH = 0.115, BAND = 0.2; // layer lift per z, tile thickness + shadow (tile.css)
    const twW = (wrap.width - 20) / (cols + (Lz - 1) * SH + BAND);
    const twH = (wrap.height - 16) / (rows * 4 / 3 + (Lz - 1) * SH + BAND);
    const tw = Math.max(28, Math.floor(Math.min(twW, twH, 86)));
    const th = tw * 4 / 3, s = tw * SH;
    return { tw, th, s, hx: tw / 2, hy: th / 2, Lz, W: cols * tw + (Lz - 1) * s + tw * BAND, H: rows * th + (Lz - 1) * s + tw * BAND };
  }
  function place(i) {
    const p = game.geom.pos[i], e = els[i];
    e.style.left = (p.x * M.hx + (M.Lz - 1 - p.z) * M.s) + 'px';
    e.style.top = (p.y * M.hy + (M.Lz - 1 - p.z) * M.s) + 'px';
    e.dataset.z0 = String(p.z * 1000 + p.y * 20 + p.x);
    e.style.zIndex = e.dataset.z0;
    e.style.setProperty('--z', String(p.z));
  }
  let pressI = -1;
  function buildBoard() {
    const b = $('board');
    const ci = coachI; coachI = -1;
    b.innerHTML = '';
    b.style.setProperty('--layers', String(layout.layers));
    M = computeMetrics();
    b.style.width = M.W + 'px'; b.style.height = M.H + 'px';
    b.style.setProperty('--tw', M.tw + 'px');
    els = game.geom.pos.map((_, i) => {
      const e = document.createElement('div');
      e.className = 'tile';
      e.style.setProperty('--tw', M.tw + 'px');
      e.innerHTML = `<img alt="" draggable="false"><span class="mark"></span>`;
      // press-down on pointerdown, commit on pointerup: pointerup is a real user gesture on iOS
      // (needed for the haptic tick and the audio unlock) and lets the press read as a physical click.
      e.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        if (busy || !game.present[i] || lifted.has(i)) return;
        if (pressI >= 0 && els[pressI]) els[pressI].classList.remove('press');
        pressI = i; e.classList.add('press');
      });
      e.addEventListener('pointerup', (ev) => {
        if (pressI !== i) return;
        e.classList.remove('press'); pressI = -1;
        if (ev.isTrusted && ev.clientX != null) { // finger slid off the tile: no tap
          const r = e.getBoundingClientRect(), pad = 14;
          if (ev.clientX < r.left - pad || ev.clientX > r.right + pad || ev.clientY < r.top - pad || ev.clientY > r.bottom + pad) return;
        }
        onTap(i);
      });
      e.addEventListener('pointercancel', () => { e.classList.remove('press'); if (pressI === i) pressI = -1; });
      b.appendChild(e);
      return e;
    });
    els.forEach((_, i) => place(i));
    if (ci >= 0) showCoach(ci);
  }
  function refresh() {
    for (let i = 0; i < els.length; i++) {
      const e = els[i], face = skin(game.faces[i]);
      if (e.dataset.face !== face) {
        e.dataset.face = face;
        e.querySelector('img').src = art(face);
        e.querySelector('.mark').textContent = markFor(face);
        e.classList.toggle('bonus', !!(CATS[face] && CATS[face].bonusSet));
        const tier = (CATS[face] && CATS[face].rarity) || '';
        e.classList.toggle('rare', !!tier); if (tier) e.dataset.tier = tier; else delete e.dataset.tier;
        const gl = e.querySelector('.glint');
        if (tier && !gl) { const g = document.createElement('i'); g.className = 'glint'; e.appendChild(g); } else if (!tier && gl) gl.remove();
        e.setAttribute('aria-label', (CATS[face] || {}).name || face);
      }
      const present = !!game.present[i];
      const drawn = (present && !hiddenBoard.has(i)) || lifted.has(i);
      e.style.display = drawn ? '' : 'none';
      e.style.visibility = '';
      e.classList.toggle('lift', lifted.has(i));
      const free = present && game.isFree(i);
      e.classList.toggle('blocked', present && !free);
    }
    const left = game.remaining, total = game.tileCount;
    $('tilesLeft').textContent = `${left} left`;
    $('progressInk').style.strokeDasharray = `${((total - left) / total) * 100} 100`;
    $('hintBadge').textContent = P.hints > 0 ? P.hints : HELP_COST;
    $('hintBadge').classList.toggle('fish', P.hints <= 0);
    $('shuffleBadge').textContent = P.shuffles > 0 ? P.shuffles : HELP_COST;
    $('shuffleBadge').classList.toggle('fish', P.shuffles <= 0);
    const uf = P.current ? P.current.undoFree : 0;
    $('undoBadge').textContent = uf > 0 ? uf : UNDO_COST;
    $('undoBadge').classList.toggle('fish', uf <= 0);
    $('btnUndo').disabled = !game.canUndo;
    $('btnFinish').hidden = !game.canAutoFinish() || busy || running;
    const n = game.tray.length;
    $('shelf').classList.toggle('warn', n === game.slots - 1);
    $('shelf').classList.toggle('full', n >= game.slots);
  }
  function persist() { P.current.state = game.serialize(); save(); }

  // ---------------------------------------------------------------- shelf view (fly layer)
  const fly = $('fly');
  let vt = [];          // visual shelf: [{ tile, el, face }] left to right (may lag the rules while animating)
  let slotRects = [];
  function measureSlots() {
    slotRects = Array.from(document.querySelectorAll('#slots .slot')).map((s) => s.getBoundingClientRect());
    return slotRects;
  }
  function slotXY(k, count) {
    const r = slotRects; const n = r.length;
    if (!n) return { x: 0, y: 0 };
    if (count <= n || n < 2) { const q = r[Math.min(k, n - 1)]; return { x: q.left, y: q.top }; }
    const step = (r[n - 1].left - r[0].left) / (count - 1); // overflow (a match into a full shelf): squeeze
    return { x: r[0].left + k * step, y: r[0].top };
  }
  const ttw = () => (slotRects[0] ? slotRects[0].width : 48);
  function makeTrayEl(face) {
    face = skin(face);
    const el = document.createElement('div'); el.className = 'tt';
    const tier = (CATS[face] && CATS[face].rarity) || '';
    const f = document.createElement('div'); f.className = 'tile tface' + (CATS[face] && CATS[face].bonusSet ? ' bonus' : '') + (tier ? ' rare' : '');
    if (tier) f.dataset.tier = tier;
    f.style.setProperty('--tw', ttw() + 'px');
    f.innerHTML = `<img alt="" draggable="false" src="${art(face)}"><span class="mark">${markFor(face)}</span>${tier ? '<i class="glint"></i>' : ''}`;
    el.appendChild(f);
    return el;
  }
  const tf = (x, y, s) => `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
  function setXY(entry, x, y, s) { entry.x = x; entry.y = y; entry.s = s; entry.el.style.transform = tf(x, y, s); }
  /** Slide a shelf tile to (x, y, s): transform-only, final value set inline first so nothing flickers at the end. */
  function moveTo(entry, x, y, s, dur, easing) {
    const from = tf(entry.x, entry.y, entry.s);
    setXY(entry, x, y, s);
    if (!dur || from === entry.el.style.transform) return Promise.resolve();
    return anim(entry.el, [{ transform: from }, { transform: entry.el.style.transform }], { duration: dur, easing: easing || EASE.out });
  }
  function layoutShelf(dur, except) {
    const ps = [];
    vt.forEach((e, k) => { if (e === except) return; const p = slotXY(k, vt.length); ps.push(moveTo(e, p.x, p.y, 1, dur)); });
    return Promise.all(ps);
  }
  let gen = 0;          // bumps on every board (re)start: in-flight jobs from an old board bail out
  function resetFly() {
    gen++; Q.length = 0; flushing = false;
    for (const e of vt) e.el.remove();
    vt = [];
    fly.querySelectorAll('.tt, .pt, .ring, .glow').forEach((n) => n.remove());
  }
  /** Draw the shelf from the rules with no animation (board start, restore, resize, after a flush). */
  function renderTrayInstant() {
    measureSlots();
    for (const e of vt) e.el.remove();
    vt = game.tray.map((t) => ({ tile: t, face: game.faces[t], el: makeTrayEl(game.faces[t]) }));
    vt.forEach((e, k) => { const p = slotXY(k, vt.length); setXY(e, p.x, p.y, 1); fly.appendChild(e.el); });
  }
  /** Arc flight between two rects (sampled quadratic Bezier, eased), with a gentle scale swell and tilt. */
  function flyArc(entry, from, to, dur, opts) {
    opts = opts || {};
    const P0 = { x: from.x, y: from.y }, P2 = { x: to.x, y: to.y };
    const up = P2.y < P0.y;
    const P1 = up ? { x: P0.x + (P2.x - P0.x) * 0.18, y: P2.y - 26 } : { x: P2.x + (P0.x - P2.x) * 0.18, y: P0.y - 26 };
    const dir = P2.x >= P0.x ? 1 : -1, N = 14, frames = [];
    for (let k = 0; k <= N; k++) {
      const t = easeOutCubic(k / N), u = 1 - t;
      const x = u * u * P0.x + 2 * u * t * P1.x + t * t * P2.x;
      const y = u * u * P0.y + 2 * u * t * P1.y + t * t * P2.y;
      const s = (from.s + (to.s - from.s) * t) * (1 + 0.07 * Math.sin(Math.PI * t));
      frames.push({ offset: k / N, transform: tf(x, y, s) + ` rotate(${(opts.tilt === false ? 0 : 5 * dir * Math.sin(Math.PI * t)).toFixed(2)}deg)` });
    }
    setXY(entry, to.x, to.y, to.s);
    if (!dur) return Promise.resolve();
    return anim(entry.el, frames, { duration: dur, easing: 'linear' });
  }
  function boardRect(i) { const r = els[i].getBoundingClientRect(); return { x: r.left, y: r.top, s: r.width / ttw() }; }
  async function decoded(el) {
    const img = el.querySelector('img');
    if (img && img.decode) await Promise.race([img.decode().catch(() => {}), wait(60)]);
  }

  // ---------------------------------------------------------------- particles + combo
  const SPARK = '<svg viewBox="-10 -10 20 20"><path d="M0,-9 C1.2,-2 2,-1.2 9,0 C2,1.2 1.2,2 0,9 C-1.2,2 -2,1.2 -9,0 C-2,-1.2 -1.2,-2 0,-9Z" fill="#F4D27A" stroke="#C9A44C" stroke-width=".8"/></svg>';
  const PETAL = '<svg viewBox="-8 -8 16 16"><path d="M0,6 C-6,2 -6,-5 -2.5,-7 L0,-4.5 L2.5,-7 C6,-5 6,2 0,6 Z" fill="#F2B8C2" stroke="#2B2A28" stroke-width=".7" stroke-opacity=".35"/></svg>';
  const PAWP = '<svg viewBox="0 0 24 24"><g fill="#8FC1A9" stroke="#3F7563" stroke-width="1"><ellipse cx="12" cy="15.5" rx="5" ry="4.2"/><circle cx="5.4" cy="9.6" r="2.2"/><circle cx="9.5" cy="5.8" r="2.2"/><circle cx="14.5" cy="5.8" r="2.2"/><circle cx="18.6" cy="9.6" r="2.2"/></g></svg>';
  function burst(x, y, strength, tier) {
    if (RM()) return;
    const n = (tier ? 24 : 13) + Math.min(8, (strength || 1) * 2);
    // soft gold flash + ring behind the particles (transform/opacity only)
    const glow = document.createElement('div'); glow.className = 'glow';
    glow.style.left = x + 'px'; glow.style.top = y + 'px'; fly.appendChild(glow);
    anim(glow, [{ transform: 'scale(.35)', opacity: 0 }, { transform: 'scale(1)', opacity: 0.95, offset: 0.25 }, { transform: 'scale(1.35)', opacity: 0 }], { duration: 460, easing: EASE.out }).then(() => glow.remove());
    const ring = document.createElement('div'); ring.className = 'ring';
    ring.style.left = x + 'px'; ring.style.top = y + 'px'; fly.appendChild(ring);
    anim(ring, [{ transform: 'scale(.3)', opacity: 0.9 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 460, easing: EASE.out }).then(() => ring.remove());
    for (let k = 0; k < n; k++) {
      const p = document.createElement('div'); p.className = 'pt';
      p.innerHTML = k % 3 === 0 ? SPARK : k % 3 === 1 ? PETAL : PAWP;
      p.style.left = x + 'px'; p.style.top = y + 'px';
      fly.appendChild(p);
      if (tier) p.classList.add('tier-' + tier);
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.45, d = (tier ? 60 : 46) + Math.random() * (tier ? 60 : 38);
      const dx = Math.cos(a) * d * 1.15, dy = Math.sin(a) * d * 0.75 - 6, r = Math.random() * 260 - 130, sc = 0.85 + Math.random() * 0.55;
      anim(p, [
        { transform: 'translate(0,0) scale(.25) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx * 0.78}px, ${dy * 0.78}px) scale(${sc}) rotate(${r * 0.6}deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy + 18}px) scale(${sc * 0.75}) rotate(${r}deg)`, opacity: 0 },
      ], { duration: (tier ? 1000 : 620) + Math.random() * (tier ? 500 : 200), easing: EASE.out }).then(() => p.remove());
    }
    if (tier) { // tier-coloured flash + a second, slower ring of sparkles
      const g2 = document.createElement('div'); g2.className = 'glow rare-glow tier-' + tier;
      g2.style.left = x + 'px'; g2.style.top = y + 'px'; fly.appendChild(g2);
      anim(g2, [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1.6)', opacity: 1, offset: 0.3 }, { transform: 'scale(2.4)', opacity: 0 }], { duration: 1100, easing: EASE.out }).then(() => g2.remove());
      for (let k = 0; k < 10; k++) {
        const p = document.createElement('div'); p.className = 'pt tier-' + tier; p.innerHTML = SPARK;
        p.style.left = x + 'px'; p.style.top = y + 'px'; fly.appendChild(p);
        const a = (k / 10) * Math.PI * 2, d = 90 + Math.random() * 30;
        anim(p, [{ transform: 'translate(0,0) scale(.2)', opacity: 0 }, { transform: `translate(${Math.cos(a) * d * 0.6}px, ${Math.sin(a) * d * 0.5}px) scale(1.3) rotate(90deg)`, opacity: 1, offset: 0.4 },
          { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d * 0.8}px) scale(.4) rotate(220deg)`, opacity: 0 }], { duration: 1500, delay: 120, easing: EASE.out, fill: 'backwards' }).then(() => p.remove());
      }
    }
  }
  /** "RARE: Pearl!" banner under the shelf. */
  function rareBanner(id) {
    const el = $('rareBanner'), c = CATS[id]; if (!el || !c) return;
    el.className = 'rare-banner tier-' + c.rarity;
    el.innerHTML = `<b>${RS.TIERS[c.rarity].name.toUpperCase()}</b> ${c.name}!`;
    const sr = $('shelf').getBoundingClientRect();
    el.style.top = (sr.bottom + 10) + 'px';
    if (RM()) { anim(el, [{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 1800 }); return; }
    // easing per keyframe (an overall easing would squash the hold): pop in, hold ~1.5 s, fade
    anim(el, [{ opacity: 0, transform: 'translate(-50%, -30%) scale(.5)', easing: EASE.out }, { opacity: 1, transform: 'translate(-50%, 0) scale(1.12)', offset: 0.1, easing: EASE.out }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.18 },
      { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.86, easing: 'ease-in' }, { opacity: 0, transform: 'translate(-50%, 8%) scale(.96)' }], { duration: 2400 });
  }
  /** First discovery: a "New cat collected!" card pops in the middle of the screen (non-blocking). */
  function newCatCard(id) {
    const c = CATS[id], el = $('newCat'); if (!c || !el) return;
    el.className = 'newcat tier-' + c.rarity; el.hidden = false;
    $('newCatImg').src = art(id); $('newCatTier').textContent = RS.TIERS[c.rarity].name; $('newCatName').textContent = c.name; $('newCatBio').textContent = c.bio;
    const done = () => { el.hidden = true; };
    if (RM()) { anim(el, [{ opacity: 1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], { duration: 2600 }).then(done); return; }
    anim(el, [{ opacity: 0, transform: 'translate(-50%, -50%) scale(.4) rotate(-6deg)', easing: EASE.out }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1.08) rotate(2deg)', offset: 0.1, easing: EASE.out },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0)', offset: 0.16 }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.9, easing: 'ease-in' },
      { opacity: 0, transform: 'translate(-50%, -46%) scale(.94)' }], { duration: 3000 }).then(done);
  }
  function showCombo(n, x) {
    // pops just under the shelf (the header above is too tight), over everything else in the fly layer
    const el = $('combo');
    el.textContent = n === 2 ? 'Purrfect!' : `×${n} combo`;
    el.classList.toggle('big', n >= 3);
    const sr = $('shelf').getBoundingClientRect();
    const half = el.offsetWidth / 2 || 60;
    el.style.left = Math.max(half + 8, Math.min(innerWidth - half - 8, x)) + 'px';
    el.style.top = (sr.bottom + 8) + 'px';
    if (RM()) { anim(el, [{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 900 }); return; }
    anim(el, [
      { opacity: 0, transform: 'translate(-50%, -40%) scale(.6)' },
      { opacity: 1, transform: 'translate(-50%, 0) scale(1.12)', offset: 0.2 },
      { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'translate(-50%, 10%) scale(.94)' },
    ], { duration: 1000, easing: EASE.out });
  }

  // ---------------------------------------------------------------- animation queue
  // The rules update instantly on every tap (so the board is always tappable); the shelf animation plays
  // job by job. When jobs pile up (fast tapping) each runs faster (down to 0.3x), so the shelf never lags far behind.
  const Q = []; let running = false, flushing = false, idleWaiters = [];
  function enqueue(job) { Q.push(job); if (!running) runQueue(); }
  async function runQueue() {
    running = true; refresh();
    while (Q.length) {
      const job = Q.shift();
      // catch up when taps pile up: 1 pending -> 0.6x, 2-3 -> 0.45x, more -> 0.3x (same curves, just quicker)
      const behind = Q.length, catchUp = behind === 0 ? 1 : behind === 1 ? 0.6 : behind <= 3 ? 0.45 : 0.3;
      const speed = flushing ? 0 : catchUp * (RM() ? 0.01 : 1);
      try { await runJob(job, speed); } catch (e) { console.warn(e); }
    }
    running = false;
    idleWaiters.splice(0).forEach((r) => r());
    onIdle();
  }
  function idle() { return running ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve(); }
  async function flush() { if (!running) return; flushing = true; await idle(); flushing = false; }

  async function runJob(job, speed) {
    if (job.type !== 'add') return;
    const i = job.tile, D = (ms) => Math.round(ms * speed), g = gen;
    const stale = () => g !== gen;
    measureSlots();
    const entry = { tile: i, face: game.faces[i], el: makeTrayEl(game.faces[i]) };
    const from = boardRect(i);
    setXY(entry, from.x, from.y, from.s);
    await decoded(entry.el);
    if (stale()) return;
    fly.appendChild(entry.el);
    lifted.delete(i); els[i].classList.remove('lift'); els[i].style.display = 'none'; // same frame as the flyer appears
    let idx = vt.length;
    if (job.partner >= 0) { const pk = vt.findIndex((e) => e.tile === job.partner); if (pk >= 0) idx = pk + 1; }
    vt.splice(idx, 0, entry);
    const to = slotXY(idx, vt.length);
    layoutShelf(D(T.slide), entry);
    await flyArc(entry, from, { x: to.x, y: to.y, s: 1 }, D(T.fly));
    if (stale()) { entry.el.remove(); return; }
    const face = entry.el.firstChild;
    if (job.partner < 0) {
      sfx('land'); if (!job.pre) buzz('land');
      if (speed) anim(face, [{ transform: 'scale(1.07, .93)' }, { transform: 'scale(.98, 1.02)', offset: 0.55 }, { transform: 'none' }], { duration: D(T.land), easing: EASE.out });
      if (job.coachTwin) coachTwin(i);
      if (job.warn) {
        sfx('warn'); if (!job.pre) buzz('warn');
        if (!tipCard('shelf3') && !(P.coachDone = P.coachDone || {}).warn) { P.coachDone.warn = true; save(); tip('3 of 4 slots used: a 4th cat without a pair ends the round!', 3200); }
      }
      return;
    }
    // ---- break: squash together, pop with sparkles/petals/paws, then the shelf closes the gap
    const pe = vt[idx - 1];
    const pair = [pe, entry].filter(Boolean);
    const midX = pair.reduce((a, e) => a + e.x, 0) / pair.length + ttw() / 2, midY = pair[0].y + ttw() * 2 / 3;
    sfx('land');
    if (speed) {
      await Promise.all(pair.map((e, k) => anim(e.el.firstChild, [{ transform: 'none' }, { transform: `translateX(${k ? -5 : 5}px) scale(1.1, .9)` }], { duration: D(T.squash), easing: EASE.inOut, fill: 'forwards' })));
    }
    if (job.rare) { sfx('rare', job.rare.tier); if (!job.pre) buzz('rare'); rareBanner(job.rare.id); if (job.newRare) setTimeout(() => newCatCard(job.rare.id), RM() ? 0 : 650); }
    else { sfx('match', job.combo); if (!job.pre) buzz('match'); }
    burst(midX, midY, job.combo, job.rare ? job.rare.tier : null);
    if (job.combo >= 2) showCombo(job.combo, midX);
    if (job.combo === 3 || job.combo === 6) setTimeout(() => sfx('meow'), 160);
    const pops = pair.map((e, k) => anim(e.el.firstChild, [
      { transform: `translateX(${k ? -5 : 5}px) scale(1.1, .9)`, opacity: 1, filter: 'brightness(1)' },
      { transform: 'scale(1.2)', opacity: 1, filter: 'brightness(1.25)', offset: 0.35 },
      { transform: 'scale(.15) rotate(' + (k ? 14 : -14) + 'deg)', opacity: 0, filter: 'brightness(1.4)' },
    ], { duration: D(T.pop), easing: EASE.in, fill: 'forwards' }));
    vt = vt.filter((e) => !pair.includes(e));
    await wait(D(T.pop * 0.45));
    const closing = layoutShelf(D(T.slide));
    await Promise.all(pops);
    pair.forEach((e) => e.el.remove());
    await closing;
  }

  function onIdle() {
    refresh();
    if (!game) return;
    if (game.isWon()) { setTimeout(win, RM() ? 0 : 220); return; }
    if (game.isStuck()) { sfx('full'); if (pre.full !== game.taps) buzz('full'); setTimeout(showDead, RM() ? 0 : 260); }
  }

  // ---------------------------------------------------------------- input
  function shakeBoard() {
    if (RM()) return;
    anim($('board'), [{ transform: 'none' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(1px)' }, { transform: 'none' }], { duration: 300, easing: EASE.out });
  }
  function onTap(i) {
    if (busy || !game || !game.present[i] || lifted.has(i) || !$('deadSheet').hidden) return;
    clockTick();
    if (!game.isFree(i)) {
      const e = els[i]; e.classList.remove('wiggle'); void e.offsetWidth; e.classList.add('wiggle');
      setTimeout(() => e.classList.remove('wiggle'), 700);
      shakeBoard(); sfx('blocked'); buzz('blocked');
      if (tipCard('blocked', { tile: i, why: game.blockReason(i) })) return;
      if (board.boardId <= 3 && !blockedTipShown) {
        blockedTipShown = true;
        tip(game.blockReason(i) === 'covered' ? 'Something is on top. Shelve it first.' : 'Boxed in. Free a side first.');
      }
      return;
    }
    if (game.over) { showDead(); return; } // round is over: board input is locked until Revive / Retry
    if (!game.canTap(i)) return;
    clearHint();
    if (!(board.boardId === 1 && coachStage === 1)) markCoachDone();
    const r = game.tap(i);
    sfx('tap'); buzz('tap');
    lifted.add(i);
    const job = { type: 'add', tile: i, partner: r.partner, combo: 0, rare: null };
    if (r.broke) {
      const now = Date.now();
      combo = now - lastMatchAt < 3200 ? combo + 1 : 1;
      lastMatchAt = now;
      job.combo = combo;
      if (combo > 1) P.current.chains = (P.current.chains || 0) + 1;
      if (isRareFace(game.faces[i])) {
        // collectible rare pair: counts toward the rare collection, not the base cat
        const first = !((P.rares[rare.id] || 0) > 0);
        P.rares[rare.id] = (P.rares[rare.id] || 0) + 1;
        job.rare = rare;
        if (first) { job.newRare = true; P.current.newRares = (P.current.newRares || []).concat(rare.id); }
      } else for (const f of [game.faces[i], game.faces[r.partner]]) P.album[f] = (P.album[f] || 0) + (CATS[f] && CATS[f].bonusSet ? 1 : 0.5);
      if (coachStage === 2) { markCoachDone(); coachStage = 3; }
    } else {
      if (coachStage === 1) job.coachTwin = true;
      if (game.tray.length === game.slots - 1 && warnedAt !== game.taps) { warnedAt = game.taps; job.warn = true; }
    }
    if (H.isIOS && !running && !Q.length) { // see buzzLater: schedule while we still hold the gesture
      const k = RM() ? 0 : 1, tLand = k * T.fly;
      job.pre = true;
      if (r.broke) buzzLater(job.rare ? 'rare' : 'match', tLand + k * T.squash);
      else { buzzLater('land', tLand); if (job.warn) buzzLater('warn', tLand + 110); }
      if (game.isWon()) { pre.win = true; buzzLater('win', tLand + k * (T.squash + T.pop + 60)); }
      else if (game.isStuck()) { pre.full = game.taps; buzzLater('full', tLand + k * (T.land + 120)); }
    }
    persist();
    refresh();
    enqueue(job);
    if (game.over) {
      // the sheet normally opens when the landing animation finishes (onIdle); this is the safety net
      const g0 = gen;
      setTimeout(() => { if (g0 === gen && game && game.over) showDead(); }, RM() ? 60 : 1400);
    }
  }

  // ---------------------------------------------------------------- undo / hint / shuffle / finish
  // ---- hints (v5): the highlight is a class on the tile elements themselves (glow ring, bounce, paw child),
  // the rest of the board dims, and it stays until the next tap or action. It is re-applied after a re-layout.
  let hintMarks = null; // { tiles: [board tiles], shelf: [shelf tiles], tap: tile to tap }
  function clearHint() {
    hintMarks = null;
    const b = $('board'); if (b) b.classList.remove('hinting');
    els.forEach((e) => {
      if (!e.classList.contains('hint')) return;
      e.classList.remove('hint'); const pw = e.querySelector('.hint-paw'); if (pw) pw.remove();
      if (!e.classList.contains('coach-target')) raise(e, false);
    });
    fly.querySelectorAll('.tface.hint').forEach((e) => e.classList.remove('hint'));
  }
  function applyHint() {
    if (!hintMarks || !game) return;
    $('board').classList.add('hinting');
    for (const t of hintMarks.tiles) {
      const e = els[t]; if (!e || !game.present[t]) continue;
      e.classList.add('hint'); raise(e, true);
      if (t === hintMarks.tap && !e.querySelector('.hint-paw')) { const p = document.createElement('div'); p.className = 'hint-paw'; p.innerHTML = PAW_SVG; e.appendChild(p); }
    }
    for (const t of hintMarks.shelf) { const v = vt.find((x) => x.tile === t); if (v) v.el.firstChild.classList.add('hint'); }
  }
  function payUndo(free) {
    if (free) return true;
    if (P.current.undoFree > 0) { P.current.undoFree--; return true; }
    if (P.fish >= UNDO_COST) { P.fish -= UNDO_COST; toast(`−${UNDO_COST} fish`); return true; }
    toast(`No free undos left on this board (${UNDO_COST} fish each).`);
    return false;
  }
  /**
   * Vita-style undo: the last cat moved to the shelf flies back to its exact spot on the board. If that
   * move broke a pair, the pair comes back: the shelf cat reappears and the newer one flies home.
   * A shuffle is undone as a whole (faces restored).
   */
  async function undo(opts) {
    opts = opts || {};
    if (busy || !game.canUndo) return;
    if (game.over) { showDead(); return; }
    if (!payUndo(!!opts.free)) return;
    busy = true;
    try {
      await flush();
      clearHint(); hideSheets(); hideCoach();
      P.current.usedUndo = true;
      const h = game.undo();
      pre.full = -1;
      persist();
      sfx('undo'); buzz('undo');
      if (h.type === 'shuffle') { flipAll(); await wait(160); refresh(); return; }
      measureSlots();
      const D = RM() ? 0 : 1;
      let entry;
      if (h.partner < 0) {
        entry = vt.find((e) => e.tile === h.tile) || null;
        if (entry) vt.splice(vt.indexOf(entry), 1);
      } else {
        // pair comes back: shelf cat at its old index, the newer one next to it, both popping in
        const pe = { tile: h.partner, face: game.faces[h.partner], el: makeTrayEl(game.faces[h.partner]) };
        entry = { tile: h.tile, face: game.faces[h.tile], el: makeTrayEl(game.faces[h.tile]) };
        vt.splice(h.at, 0, pe);
        const pp = slotXY(h.at, vt.length + 1), tp = slotXY(h.at + 1, vt.length + 1);
        setXY(pe, pp.x, pp.y, 1); setXY(entry, tp.x, tp.y, 1);
        await Promise.all([decoded(pe.el), decoded(entry.el)]);
        fly.appendChild(pe.el); fly.appendChild(entry.el);
        vt.splice(h.at + 1, 0, entry); layoutShelf(D * T.slide, null); vt.splice(h.at + 1, 1);
        if (D) {
          await Promise.all([pe, entry].map((e) => anim(e.el.firstChild, [{ transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: EASE.spring })));
          await wait(60);
        }
      }
      hiddenBoard.add(h.tile);
      refresh();
      if (entry) {
        const dest = boardRect(h.tile);
        layoutShelf(D * T.slide);
        await flyArc(entry, { x: entry.x, y: entry.y, s: 1 }, dest, D * T.back, { tilt: true });
        entry.el.remove();
      }
      hiddenBoard.delete(h.tile);
      refresh();
      const e = els[h.tile];
      if (D) anim(e, [{ transform: 'scale(1.06)' }, { transform: 'none' }], { duration: 180, easing: EASE.out });
      sfx('land');
      combo = 0;
    } finally { busy = false; refresh(); }
  }
  function spend(kind) {
    if (P[kind] > 0) { P[kind]--; return true; }
    if (tipCard('fish', { kind })) return false; // first time out: explain fish before charging any
    if (P.fish >= HELP_COST) { P.fish -= HELP_COST; toast(`−${HELP_COST} fish`); return true; }
    toast(kind === 'hints' ? 'No hints left. Undo sends the last cat home.' : 'No shuffles left. Try Undo or Retry.');
    return false;
  }
  function refund(kind) { P[kind]++; }
  async function hint() {
    if (busy) return;
    await flush();
    if (hintMarks) { // already showing: don't charge again, just nudge
      const t = els[hintMarks.tap]; if (t && !RM()) anim(t, [{ transform: 'none' }, { transform: 'translateY(-8px) scale(1.08)' }, { transform: 'none' }], { duration: 360, easing: EASE.spring, composite: 'add' });
      toast('Tap the glowing cat with the paw.', 1800); return;
    }
    clearHint();
    if (game.over) { showDead(); return; }
    const h = game.hint({ maxNodes: 60000 });
    if (!h) { showDead(); return; }
    // Truthful and free when it can't help: no winning line exists from here.
    if (h.safe === false) { toast('No winning line from here. Undo a few cats back (free undos first).', 3400); return; }
    if (!spend('hints')) return;
    P.current.usedHelp = true; persist();
    refresh();
    sfx('hint'); buzz('hint');
    // settle the board first: finish the entry animation so the highlight sits on tiles at rest
    els.forEach((e) => { if (e.getAnimations) e.getAnimations().forEach((a) => { try { a.finish(); } catch (err) { /* infinite */ } }); });
    hideCoach(); hideTip();
    let withT = (h.with || []).slice();
    if (!withT.length && h.safe && !h.onTray) {
      // show the pair: a free twin that still keeps a win open after both taps (checked, then undone)
      for (let u = 0; u < game.tileCount && !withT.length; u++) {
        if (u === h.tile || !game.present[u] || !game.isFree(u) || !C.facesMatch(game.faces[u], game.faces[h.tile])) continue;
        const r1 = game.tap(h.tile); if (!r1) break;
        const r2 = game.over ? null : game.tap(u);
        const ok = r2 && !game.over && game.isSolvable(6000) === true;
        if (r2) game.undo();
        game.undo();
        if (ok) withT = [u];
      }
    }
    hintMarks = { tiles: [], shelf: [], tap: h.tile };
    for (const t of [h.tile].concat(withT)) (game.present[t] ? hintMarks.tiles : hintMarks.shelf).push(t);
    applyHint();
    tip(hintMarks.shelf.length ? 'Tap the cat with the paw: it matches the glowing cat on your shelf.' : withT.length ? 'Tap the cat with the paw, then its glowing twin.' : 'Tap the cat with the paw.', 4200);
    if (h.safe === null) toast('This cat is a fine move, but I could not check it all the way to a win.', 3200);
  }
  function flipAll() {
    if (RM()) return;
    els.forEach((e, i) => { if (game.present[i]) anim(e, [{ transform: 'none' }, { transform: 'scaleX(.05)', offset: 0.5 }, { transform: 'none' }], { duration: 340, delay: (i % 9) * 12, easing: EASE.inOut }); });
  }
  async function shuffle() {
    if (busy) return;
    if (game.remaining < 1) return;
    if (game.over) { showDead(); return; }
    await flush();
    if (!spend('shuffles')) return;
    clearHint();
    if (!game.shuffle()) { refund('shuffles'); toast('No shuffle can fix this layout. Try Undo.'); refresh(); return; }
    P.current.usedHelp = true; persist();
    hideSheets();
    sfx('shuffle');
    flipAll();
    setTimeout(refresh, RM() ? 0 : 170);
  }
  async function finish() {
    if (!game.canAutoFinish() || busy) return;
    busy = true; clearHint(); $('btnFinish').hidden = true;
    await flush();
    for (const t of game.autoFinishTaps()) {
      busy = false; onTap(t); busy = true;
      await wait(RM() ? 0 : 110);
    }
    busy = false;
  }

  // ---------------------------------------------------------------- sheets
  function reviveFree() { return !game || game.revives === 0; }
  function showDead() {
    if (!game || !game.isStuck() || busy) { if (game && game.isStuck() && busy) setTimeout(showDead, 200); return; }
    if (!$('deadSheet').hidden) return;
    clearHint(); hideCoach(); hideTip();
    clockTick(); $('deadScrim').hidden = false; $('deadSheet').hidden = false;
    $('deadTitle').textContent = 'Out of space!';
    $('deadText').textContent = `All ${game.slots} slots filled without a pair. Revive sends every cat on the shelf back to its spot.`;
    const free = reviveFree(), r = $('deadRevive');
    r.textContent = free ? 'Revive (Free)' : `Revive · ${REVIVE_COST} fish`;
    r.disabled = !free && P.fish < REVIVE_COST;
    $('deadNote').textContent = free ? 'Free once per board' : `You have ${P.fish} fish`;
    tipCard('revive');
  }
  /** Revive: every shelf cat flies back to its exact board spot (reverse flight), then play continues. */
  async function revive() {
    if (busy || !game || !game.over) return;
    const free = reviveFree();
    if (!free) {
      if (P.fish < REVIVE_COST) { toast(`Revive costs ${REVIVE_COST} fish.`); return; }
      P.fish -= REVIVE_COST; toast(`−${REVIVE_COST} fish`);
    }
    buzz('revive'); // inside the tap gesture (iOS)
    busy = true;
    try {
      await flush();
      hideSheets(); clearHint();
      const tiles = game.revive();
      P.current.usedHelp = true; pre.full = -1; combo = 0;
      persist();
      sfx('undo');
      measureSlots();
      const D = RM() ? 0 : 1;
      const back = vt.filter((e) => tiles.includes(e.tile));
      vt = vt.filter((e) => !tiles.includes(e.tile));
      back.forEach((e) => hiddenBoard.add(e.tile));
      refresh();
      // staggered reverse flights, newest first (the way they came in, backwards)
      await Promise.all(back.slice().reverse().map(async (e, k) => {
        if (D) await wait(k * 70);
        await flyArc(e, { x: e.x, y: e.y, s: 1 }, boardRect(e.tile), D * T.back, { tilt: true });
        e.el.remove();
        hiddenBoard.delete(e.tile); refresh();
        if (D) anim(els[e.tile], [{ transform: 'scale(1.06)' }, { transform: 'none' }], { duration: 180, easing: EASE.out });
        sfx('land');
      }));
      tip(free ? 'Revived! The next revive on this board costs fish.' : 'Revived!', 2200);
    } finally { busy = false; refresh(); }
  }
  function hideSheets() { clockTick(); for (const id of ['deadScrim', 'deadSheet', 'setScrim', 'setSheet']) $(id).hidden = true; clockTick(); }

  // ---------------------------------------------------------------- win
  function win() {
    if (!game || !game.isWon() || !$('win').hidden) return;
    const first = !P.cleared[board.boardId];
    P.cleared[board.boardId] = true;
    const stars = starsFor(P.current);
    if (!board.isDaily) { P.stars = P.stars || {}; P.stars[board.boardId] = Math.max(P.stars[board.boardId] || 0, stars); }
    const bonus = P.current.usedHelp ? 0 : PAY.noHelp, chains = Math.min(PAY.chainMax, P.current.chains || 0);
    const fish = PAY.clear + bonus + chains;
    P.fish += fish;
    const moves = game.moves;
    const newRares = (P.current.newRares || []).filter((id) => CATS[id]);
    clockTick();
    const time = Math.round(P.current.ms || 0);
    const bestKey = board.isDaily ? null : board.boardId;
    P.best = P.best || {};
    const prevBest = bestKey == null ? null : P.best[bestKey];
    const record = bestKey != null && time > 0 && prevBest != null && time < prevBest;
    if (bestKey != null && time > 0 && (prevBest == null || time < prevBest)) P.best[bestKey] = time;
    let awarded = fish;
    if (board.isDaily) { P.daily = P.daily || {}; P.daily[todayKey()] = true; awarded = fish + PAY.daily; P.fish += PAY.daily; }
    P.current = null; save();
    sfx('win'); if (!pre.win) buzz('win');
    pre.win = false;
    $('winTitle').textContent = board.isDaily ? (`Daily · ` + todayKey()) : (`Board ${board.boardId} · ${layout.name}`);
    const extra = first && board.boardId === 3 ? ' · Album unlocked' : (first && board.boardId === 5 ? ' · Daily unlocked' : (board.isDaily ? ' · Daily stamp!' : ''));
    $('winText').textContent = `${moves} pairs · +${awarded} fish${bonus ? ' (no-help bonus!)' : ''}${chains ? ` · ${chains} purr chain${chains > 1 ? 's' : ''}` : ''}${extra}`;
    $('winStars').innerHTML = '<b>' + '<i>★</i>'.repeat(stars) + '</b>' + '<i>☆</i>'.repeat(3 - stars);
    $('winStars').setAttribute('aria-label', `${stars} of 3 stars`);
    const wt = $('winTime');
    wt.innerHTML = `<span class="t">${fmtTime(time, true)}</span>` + (record ? `<b class="rec">New record!</b><small>was ${fmtTime(prevBest, true)}</small>`
      : bestKey != null && prevBest != null ? `<small>Best ${fmtTime(prevBest, true)}</small>` : bestKey != null && time > 0 ? '<small>First best time</small>' : '');
    wt.classList.toggle('record', record);
    const wn = $('winNew');
    wn.hidden = !newRares.length;
    wn.innerHTML = newRares.map((id) => `<div class="win-new-cat tier-${CATS[id].rarity}"><img src="${art(id)}" alt=""><div><b>New cat collected!</b><span>${RS.TIERS[CATS[id].rarity].name} · ${CATS[id].name}</span></div></div>`).join('');
    $('winStarsNote').textContent = stars === 3 ? 'Perfect: no hints, shuffles or undos' : stars === 2 ? 'No hints or shuffles (3 stars = no undos too)' : '3 stars = no hints, shuffles or undos';
    if (board.isDaily) $('btnNext').textContent = 'Boards';
    else $('btnNext').textContent = board.boardId < BOARDS.length ? 'Next' : 'Boards';
    const cats = [...new Set(game.faces.map(skin))].filter((f) => CATS[f] && !CATS[f].bonusSet).sort((a, b) => (CATS[b].rarity ? 1 : 0) - (CATS[a].rarity ? 1 : 0));
    $('parade').innerHTML = cats.slice(0, 5).map((f) => `<img src="${art(f)}" alt="">`).join('');
    const st = $('sealStamp'); st.style.animation = 'none'; void st.offsetWidth; st.style.animation = '';
    $('win').hidden = false;
    resetFly();
    celebrate(cats, stars);
    if (record) celebrateRecord();
  }
  /** "New record!": a stamp pop, a bright chime run and a success haptic once the stars have landed. */
  function celebrateRecord() {
    const rec = document.querySelector('#winTime .rec'); if (!rec) return;
    const at = 1250;
    setTimeout(() => { sfx('star', 3); setTimeout(() => sfx('star', 4), 120); setTimeout(() => sfx('star', 5), 240); buzz('win'); }, at);
    if (!RM()) {
      anim(rec, [{ transform: 'scale(0) rotate(-12deg)', opacity: 0 }, { transform: 'scale(1.3) rotate(4deg)', opacity: 1, offset: 0.6 }, { transform: 'rotate(-3deg)', opacity: 1 }], { duration: 460, delay: at, easing: EASE.out, fill: 'backwards' })
        .then(() => anim(rec, [{ boxShadow: '0 0 0 0 rgba(217,164,65,.7)' }, { boxShadow: '0 0 0 12px rgba(217,164,65,0)' }], { duration: 900, iterations: 2, easing: EASE.out }));
      const r = rec.getBoundingClientRect();
      const fx = document.createElement('div'); fx.className = 'rec-sparks'; fx.style.left = (r.left + r.width / 2) + 'px'; fx.style.top = (r.top + r.height / 2) + 'px';
      document.body.appendChild(fx);
      for (let k = 0; k < 14; k++) {
        const d = document.createElement('i'); fx.appendChild(d);
        const a = (k / 14) * Math.PI * 2, dist = 46 + (k % 3) * 18;
        anim(d, [{ transform: 'translate(0,0) scale(.4)', opacity: 0 }, { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0.1 }, { transform: `translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist}px) scale(.2)`, opacity: 0 }], { duration: 760, delay: at + 120, easing: EASE.out, fill: 'backwards' });
      }
      setTimeout(() => fx.remove(), at + 1400);
    }
  }
  /** Board-clear juice: petals and little cat tiles rain down, the cats hop, stars pop in one by one. */
  function celebrate(cats, stars) {
    const petals = $('petals'); petals.innerHTML = '';
    const W = window.innerWidth, Hh = window.innerHeight;
    if (!RM()) {
      for (let k = 0; k < 26; k++) {
        const tileRain = k % 3 === 0 && cats.length;
        const p = document.createElement('div');
        p.className = tileRain ? 'rain' : 'petal';
        p.innerHTML = tileRain ? `<img src="${art(cats[k % cats.length])}" alt="">` : PETAL;
        if (!tileRain) { p.style.width = '16px'; p.style.height = '16px'; }
        petals.appendChild(p);
        const x = Math.random() * W, drift = Math.random() * 90 - 45, rot = Math.random() * 540 - 270, dur = 1900 + Math.random() * 1300, delay = Math.random() * 900;
        anim(p, [
          { transform: `translate(${x}px, -60px) rotate(0deg)` },
          { transform: `translate(${x + drift * 0.6}px, ${Hh * 0.45}px) rotate(${rot * 0.5}deg)`, offset: 0.45 },
          { transform: `translate(${x + drift}px, ${Hh + 60}px) rotate(${rot}deg)` },
        ], { duration: dur, delay, easing: 'cubic-bezier(.3, .1, .6, 1)', fill: 'both' }).then(() => p.remove());
      }
      const mat = document.querySelector('#win .mat img');
      anim(mat, [
        { transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-26px) scale(.96, 1.05)', offset: 0.18 }, { transform: 'translateY(0) scale(1.08, .92)', offset: 0.34 },
        { transform: 'translateY(-14px) scale(.98, 1.03)', offset: 0.5 }, { transform: 'translateY(0) scale(1.04, .96)', offset: 0.64 },
        { transform: 'translateY(-5px)', offset: 0.78 }, { transform: 'translateY(0) scale(1)' },
      ], { duration: 1300, delay: 380, easing: EASE.inOut });
      Array.from($('parade').children).forEach((img, k) => {
        anim(img, [{ transform: 'translateY(14px) scale(.4)', opacity: 0 }, { transform: 'translateY(-10px) scale(1.05)', opacity: 1, offset: 0.55 }, { transform: 'none', opacity: 1 }], { duration: 420, delay: 600 + k * 90, easing: EASE.spring, fill: 'backwards' })
          .then(() => anim(img, [{ transform: 'none' }, { transform: 'translateY(-8px)', offset: 0.5 }, { transform: 'none' }], { duration: 520, delay: 200 + k * 80, iterations: 2, easing: EASE.inOut }));
      });
    }
    Array.from($('winStars').querySelectorAll('b i')).forEach((s, k) => {
      setTimeout(() => sfx('star', k), 520 + k * 190);
      if (!RM()) anim(s, [{ transform: 'scale(0) rotate(-30deg)', opacity: 0 }, { transform: 'scale(1.35) rotate(8deg)', opacity: 1, offset: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 380, delay: 500 + k * 190, easing: EASE.out, fill: 'backwards' });
    });
  }

  // ---------------------------------------------------------------- wiring
  const click = (fn) => (ev) => { sfx('click'); buzz('click'); fn(ev); };
  $('btnUndo').addEventListener('click', () => undo());
  $('btnHint').addEventListener('click', hint);
  $('btnShuffle').addEventListener('click', shuffle);
  $('btnFinish').addEventListener('click', click(finish));
  $('deadRevive').addEventListener('click', () => { sfx('click'); revive(); });
  $('deadRetry').addEventListener('click', click(() => { hideSheets(); startBoard(board.boardId, { restart: true }); }));
  $('deadHome').addEventListener('click', click(() => { hideSheets(); board = null; resetFly(); applySettings(); renderHome(); show('home'); }));
  // the game-over sheet can't be dismissed by tapping outside it (that left a locked board with no way out)
  $('deadScrim').addEventListener('click', () => { if (!game || !game.over) hideSheets(); });
  $('btnHome').addEventListener('click', click(() => { clearHint(); hideCoach(); hideTip(); board = null; resetFly(); applySettings(); renderHome(); show('home'); }));
  $('btnNext').addEventListener('click', click(() => {
    $('win').hidden = true;
    if (board && board.isDaily) { renderHome(); show('home'); return; }
    if (board.boardId < BOARDS.length) startBoard(board.boardId + 1);
    else { renderHome(); show('home'); }
  }));
  if ($('btnDaily')) $('btnDaily').addEventListener('click', click(() => startBoard('daily', { daily: true, restart: true })));
  $('btnWinHome').addEventListener('click', click(() => { $('win').hidden = true; renderHome(); show('home'); }));
  $('btnAlbum').addEventListener('click', click(() => { renderAlbum(); show('album'); }));
  $('btnAlbumBack').addEventListener('click', click(() => { renderHome(); show('home'); }));
  const openSettings = () => { clockTick(); applySettings(); $('setScrim').hidden = false; $('setSheet').hidden = false; $('optRestart').hidden = !game || $('play').hidden; };
  $('btnSettings').addEventListener('click', click(openSettings));
  $('btnSettingsHome').addEventListener('click', click(openSettings));
  $('setScrim').addEventListener('click', hideSheets);
  $('optClose').addEventListener('click', click(hideSheets));
  for (const [id, key] of [['optBlocked', 'showBlocked'], ['optMarks', 'marks'], ['optMotion', 'motion'], ['optSound', 'sound'], ['optMusic', 'music'], ['optHaptics', 'haptics']]) {
    $(id).addEventListener('change', (e) => {
      P.settings[key] = e.target.checked; applySettings(); save();
      if (key === 'sound' && e.target.checked) { A.unlock(); sfx('match', 3); }
      if (key === 'music') { if (e.target.checked) { A.unlock(); A.startMusic(); } else A.stopMusic(); }
      if (key === 'haptics' && e.target.checked) buzz('match');
      if (key === 'motion') startAmbience();
    });
  }
  $('optTrack').addEventListener('change', (e) => {
    P.settings.track = e.target.value; save();
    A.unlock(); A.set({ track: P.settings.track }); A.startMusic(); setTimeout(trackNote, 400);
  });
  for (const [id, key] of [['volSound', 'sfxVol'], ['volMusic', 'musicVol']]) {
    $(id).addEventListener('input', (e) => { P.settings[key] = Number(e.target.value) / 100; applySettings(); });
    $(id).addEventListener('change', () => { save(); if (key === 'sfxVol') sfx('tap'); });
  }
  $('optRestart').addEventListener('click', click(() => { hideSheets(); startBoard(board.boardId, { restart: true }); }));
  $('optReset').addEventListener('click', () => { if (confirm('Reset all Purrjong progress on this device?')) { P = defaults(); save(); applySettings(); hideSheets(); resetFly(); renderHome(); show('home'); } });
  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(async () => { if (game && !$('play').hidden) { await flush(); buildBoard(); refresh(); renderTrayInstant(); applyHint(); } }, 120); });

  // ---------------------------------------------------------------- onboarding: How to Play intro + one-time tip cards
  // Plain-language help for people who have never played mahjong solitaire. The intro shows once (first launch,
  // or before board 1 on an older save); tip cards fire the first time something happens and are remembered in
  // the save (P.tipsSeen). Both pause the board timer. Tip cards are placed so they never cover the tiles, shelf
  // or sheet they talk about (or a hinted cat). ?notips=1 turns all of it off for automation.
  const noTips = params.has('notips');
  const SVG_ICON = (id) => { const b = $(id); const s = b && b.querySelector('svg'); return s ? s.outerHTML : ''; };
  const mt = (face, x, y, cls, z) => `<div class="tile mt ${cls || ''}" style="left:${x}px;top:${y}px;--z:${z || 0}"><img src="${art(face)}" alt=""></div>`;
  const mini = (face) => `<span class="tile mtile"><img src="${art(face)}" alt=""></span>`;
  const mshelf = (x, y, faces, cls) => `<div class="mshelf ${cls || ''}" style="left:${x}px;top:${y}px">${[0, 1, 2, 3].map((k) => `<span class="mslot">${faces && faces[k] ? `<span class="tile mtile"><img src="${art(faces[k])}" alt=""></span>` : ''}</span>`).join('')}</div>`;
  function howtoSlides() {
    return [
      { title: 'Clear every cat', text: 'Match cats in pairs. When the board is empty, you win!',
        stage: `<div class="stage" style="width:168px;height:120px">
          ${mt('calico', 0, 44, 'g2')}${mt('siamese', 42, 44, 'g3')}${mt('siamese', 84, 44, 'g3')}${mt('calico', 126, 44, 'g2')}
          ${mt('tabby', 21, 30, 'g1', 1)}${mt('tabby', 105, 30, 'g1', 1)}<div class="mstamp">All clear!</div></div>` },
      { title: 'Only free cats can be tapped', text: 'A cat is <b>free</b> when nothing sits on top of it <b>and</b> its left or right side is open. Blocked cats just wiggle.',
        stage: `<div class="stage" style="width:172px;height:132px">
          ${mt('calico', 0, 50)}${mt('snow', 44, 50, 'blk')}${mt('siamese', 88, 50, 'blk')}${mt('tabby', 132, 50)}${mt('tuxedo', 40, 42, 'lift1', 1)}
          <i class="mbadge ok" style="left:49px;top:14px">✓</i><i class="mbadge ok" style="left:9px;top:112px">✓</i>
          <i class="mbadge no" style="left:53px;top:112px">✕</i><i class="mbadge no" style="left:97px;top:112px">✕</i><i class="mbadge ok" style="left:141px;top:112px">✓</i></div>
          <div class="mlegend"><span><i class="mbadge ok">✓</i> free</span><span><i class="mbadge no">✕</i> blocked: covered, or both sides boxed in</span></div>` },
      { title: 'Tap cats onto the shelf', text: 'Every cat you tap goes to the shelf. When two matching cats meet there, they pop and leave.',
        stage: `<div class="stage" style="width:240px;height:182px">
          ${mt('tabby', 40, 10, 'fa')}${mt('siamese', 100, 4)}${mt('tabby', 160, 10, 'fb')}${mshelf(20, 112)}</div>
          <div class="mrow"><span class="mpair">${mini('spring')}${mini('autumn')}</span><span>Seasons match <b>any</b> Season</span></div>
          <div class="mrow"><span class="mpair">${mini('lucky-gold')}${mini('lucky-jade')}</span><span>Lucky cats match <b>any</b> Lucky cat</span></div>` },
      { title: "Don't fill the shelf", text: 'Four cats with no pair fill the shelf, and the round ends. <b>Revive</b> sends them back to the board (free once per board). Plan ahead: tap a cat when you can also reach its twin.',
        stage: `<div class="stage" style="width:220px;height:150px"><div class="mchip">Out of space!</div>${mshelf(10, 40, ['tabby', 'calico', 'siamese', 'snow'], 'full')}
          <span class="mrevive">Revive (Free)</span></div>` },
      { title: 'Helpers and extras', text: '',
        stage: `<div class="mseals"><div><span class="seal mseal">${SVG_ICON('btnUndo')}<span>Undo</span></span><small>Take back the last cat</small></div>
          <div><span class="seal mseal mhint">${SVG_ICON('btnHint')}<span>Hint</span></span><small>Shows a safe cat to tap</small></div>
          <div><span class="seal mseal">${SVG_ICON('btnShuffle')}<span>Shuffle</span></span><small>Mixes the cats left</small></div></div>
          <ul class="mlist"><li><i>🐟</i><span>Free helpers run out. <b>Fish</b> buy more, and you earn fish by clearing boards.</span></li>
          <li><i class="mstar">★</i><span>Get <b>3 stars</b> by winning without help, and beat your <b>best time</b>.</span></li>
          <li><img src="${art('cosmos')}" alt=""><span><b>Rare cats</b> sometimes hide on a board. Match them to collect them in the Album.</span></li></ul>` },
    ];
  }
  let howtoIdx = 0, introWaiters = [];
  const howtoOpen = () => !$('howto').hidden;
  /** Run fn now, or once the intro closes (board-start tips and the coach wait for it). */
  function afterIntro(fn) { if (howtoOpen()) introWaiters.push(fn); else fn(); }
  function openHowto() {
    const slides = howtoSlides();
    $('howtoTrack').innerHTML = slides.map((s, k) => `<section class="howto-slide" aria-label="${k + 1} of ${slides.length}"><div class="howto-art">${s.stage}</div><h3>${s.title}</h3>${s.text ? `<p>${s.text}</p>` : ''}</section>`).join('');
    $('howtoDots').innerHTML = slides.map((_, k) => `<button class="hdot" data-k="${k}" aria-label="Card ${k + 1}"></button>`).join('');
    clearHint(); hideTip();
    $('howto').hidden = false; clockTick();
    howtoIdx = 0; $('howtoTrack').scrollLeft = 0; howtoSync();
  }
  function howtoSync() {
    const tr = $('howtoTrack'), n = tr.children.length;
    howtoIdx = Math.max(0, Math.min(n - 1, Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth))));
    [...$('howtoDots').children].forEach((d, k) => d.classList.toggle('on', k === howtoIdx));
    [...tr.children].forEach((s, k) => s.classList.toggle('on', k === howtoIdx));
    $('howtoNext').textContent = howtoIdx === n - 1 ? "Let's play!" : 'Next';
  }
  function howtoGo(k) { const tr = $('howtoTrack'); tr.scrollTo({ left: k * tr.clientWidth, behavior: RM() ? 'auto' : 'smooth' }); howtoIdx = k; setTimeout(howtoSync, RM() ? 0 : 380); }
  function closeHowto() {
    $('howto').hidden = true; P.howtoSeen = true; save(); clockTick();
    const w = introWaiters; introWaiters = []; w.forEach((f) => f());
    if (tipQueue.length) setTimeout(nextTip, 200);
  }
  $('howtoTrack').addEventListener('scroll', () => { clearTimeout(howtoSync.t); howtoSync.t = setTimeout(howtoSync, 60); }, { passive: true });
  $('howtoNext').addEventListener('click', click(() => { const n = $('howtoTrack').children.length; howtoSync(); if (howtoIdx >= n - 1) closeHowto(); else howtoGo(howtoIdx + 1); }));
  $('howtoSkip').addEventListener('click', click(closeHowto));
  $('howtoDots').addEventListener('click', (e) => { const d = e.target.closest('.hdot'); if (d) howtoGo(Number(d.dataset.k)); });
  $('btnHelp').addEventListener('click', click(openHowto));
  $('optHowto').addEventListener('click', click(() => { hideSheets(); openHowto(); }));
  $('optResetTips').addEventListener('click', click(() => { P.tipsSeen = {}; P.coachDone = {}; save(); toast('Tips will show again as you play.'); }));

  // ---- one-time tip cards
  const TIP_TITLE = { hints: 'Out of free hints', shuffles: 'Out of free shuffles' };
  function tipDef(key, ctx) {
    ctx = ctx || {};
    const present = (f) => { const r = []; for (let i = 0; i < game.tileCount; i++) if (game.present[i] && f(game.faces[i])) r.push(i); return r; };
    switch (key) {
      case 'blocked': return { title: 'That cat is stuck', text: ctx.why === 'covered' ? "Something's on top of it. Tap the cat on top first." : "Both of its sides are blocked. Clear a cat next to it first.", sub: 'Free cats have nothing on top and an open left or right side.', tiles: [ctx.tile] };
      case 'shelf3': return { title: 'Careful: 3 on the shelf', text: 'One more cat without a match fills the shelf and ends the round.', sub: 'Next, tap a cat that matches one on the shelf.', shelf: true };
      case 'revive': return { title: 'Shelf full: round over', text: '<b>Revive</b> sends the shelf cats back to their spots so you can keep going. Free once per board, then it costs fish.', sub: 'Or Retry to start the board fresh.', shelf: true, sheet: true };
      case 'seasons': return { title: 'Season cats', text: 'Any two Season cats match each other: spring with autumn works!', art: C.BONUS_SETS.seasons, tiles: present((f) => C.BONUS_SETS.seasons.includes(f)) };
      case 'lucky': return { title: 'Lucky cats', text: 'Any two Lucky cats match each other, whatever their colour.', art: C.BONUS_SETS.lucky, tiles: present((f) => C.BONUS_SETS.lucky.includes(f)) };
      case 'rare': return rare ? { title: `A ${RS.TIERS[rare.tier].name.toLowerCase()} cat is here!`, text: `${CATS[rare.id].name} has a shiny frame. Match the pair to collect it in your Album.`, art: [rare.id], tiles: present((f) => f === rare.base) } : null;
      case 'fish': return { title: TIP_TITLE[ctx.kind] || 'Out of free helpers', text: `Each extra hint or shuffle costs ${HELP_COST} fish. You have ${P.fish} fish.`, sub: P.fish >= HELP_COST ? `Tap ${ctx.kind === 'shuffles' ? 'Shuffle' : 'Hint'} again to buy one. Clear boards to earn more fish.` : 'Clear boards to earn more fish (more when you win without help).' };
      case 'hard': return { title: 'Hard board', text: 'Fewer safe moves on this one. Look before you tap, and try to keep the shelf at 2 cats or fewer.', sub: 'Stars and best times work the same.' };
      case 'undim': return { title: 'No more dimming', text: "From here on, blocked cats won't be dimmed. Check for cats on top and boxed-in sides yourself.", sub: 'You can turn it back on in Settings: Show blocked tiles.' };
    }
    return null;
  }
  let tipQueue = [], tipOpen = null;
  const tipsSeen = () => (P.tipsSeen = P.tipsSeen || {});
  /** Show a one-time tip card (queued if one is up). Returns true if it will show. */
  function tipCard(key, ctx) {
    if (noTips || tipsSeen()[key] || !game || $('play').hidden) return false;
    if (tipOpen === key || tipQueue.some((q) => q.key === key)) return true;
    tipQueue.push({ key, ctx });
    if (!tipOpen) setTimeout(nextTip, 0);
    return true;
  }
  function nextTip() {
    if (tipOpen || !tipQueue.length || howtoOpen()) return;
    const { key, ctx } = tipQueue.shift();
    const d = tipDef(key, ctx); if (!d) { nextTip(); return; }
    tipOpen = key; tipsSeen()[key] = true; save(); // remembered once it has actually been shown
    $('tipCardTitle').textContent = d.title;
    $('tipCardText').innerHTML = d.text + (d.sub ? `<small>${d.sub}</small>` : '');
    $('tipCardArt').innerHTML = (d.art || []).map(mini).join('');
    $('tipCardArt').hidden = !(d.art && d.art.length);
    const card = $('tipCard'); card.dataset.key = key;
    $('tipBlock').hidden = false; card.hidden = false; card.style.top = '0px';
    hideTip();
    // spotlight what the card is about
    (d.tiles || []).forEach((t) => { const e = els[t]; if (e) { e.classList.add('tip-focus'); raise(e, true); } });
    if (d.shelf) $('shelf').classList.add('tip-focus');
    placeTip(d);
    clockTick();
    if (!RM()) anim(card, [{ opacity: 0, transform: 'translate(-50%, 10px) scale(.96)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)' }], { duration: 240, easing: EASE.out });
    sfx('hint');
  }
  /** Put the card where it covers none of: its tiles, the shelf (if relevant), the sheet, hinted cats. */
  function placeTip(d) {
    const card = $('tipCard'), ch = card.offsetHeight, H = window.innerHeight;
    const avoid = [];
    for (const t of (d.tiles || [])) if (els[t] && game.present[t]) avoid.push(els[t].getBoundingClientRect());
    if (hintMarks) for (const t of hintMarks.tiles) if (els[t]) avoid.push(els[t].getBoundingClientRect());
    const shelfR = $('shelf').getBoundingClientRect();
    if (d.shelf) avoid.push(shelfR);
    const sheetR = !$('deadSheet').hidden ? $('deadSheet').getBoundingClientRect() : null;
    if (d.sheet && sheetR) avoid.push(sheetR);
    const safeB = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-b')) || 0;
    const cands = [
      H - ch - 12 - safeB,                  // bottom, over the Undo/Hint/Shuffle bar
      shelfR.bottom + 10,                   // just under the shelf
      Math.max(8, shelfR.top - ch - 8),     // over the header
      d.shelf ? shelfR.bottom + 10 : 8,
    ];
    if (sheetR && d.sheet) cands.unshift(Math.max(8, Math.min(shelfR.bottom + 10, sheetR.top - ch - 10)));
    const overlap = (top) => avoid.reduce((a, r) => { const y0 = Math.max(top, r.top), y1 = Math.min(top + ch, r.bottom); return a + Math.max(0, y1 - y0) * Math.max(1, r.width); }, 0);
    let best = cands[0], bo = Infinity;
    for (const c of cands) { const top = Math.max(4, Math.min(H - ch - 4, c)), o = overlap(top); if (o < bo - 0.5) { bo = o; best = top; } }
    card.style.top = Math.round(best) + 'px';
  }
  function closeTip() {
    if (!tipOpen) return;
    tipOpen = null;
    $('tipCard').hidden = true; $('tipBlock').hidden = true;
    els.forEach((e) => { if (e.classList.contains('tip-focus')) { e.classList.remove('tip-focus'); if (!e.classList.contains('hint') && !e.classList.contains('coach-target')) raise(e, false); } });
    $('shelf').classList.remove('tip-focus');
    clockTick();
    if (tipQueue.length) setTimeout(nextTip, 180);
  }
  function resetTips() { tipQueue = []; if (tipOpen) closeTip(); }
  $('tipCardOk').addEventListener('click', click(closeTip));
  $('tipBlock').addEventListener('click', () => { const c = $('tipCard'); if (!RM()) anim(c, [{ transform: 'translate(-50%, 0)' }, { transform: 'translate(-50%, 0) scale(1.03)' }, { transform: 'translate(-50%, 0)' }], { duration: 220 }); });
  /** Tip cards a board can show when it starts (first time each). */
  function boardStartTips() {
    if (noTips || !board || game.taps !== 0) return [];
    const out = [];
    if (!board.isDaily && board.boardId > DIM_UNTIL && !P.settings.showBlocked && !tipsSeen().undim) out.push('undim');
    if (board.hard && !tipsSeen().hard) out.push('hard');
    if (game.faces.some((f) => C.BONUS_SETS.seasons.includes(f)) && !tipsSeen().seasons) out.push('seasons');
    if (game.faces.some((f) => C.BONUS_SETS.lucky.includes(f)) && !tipsSeen().lucky) out.push('lucky');
    if (rare && !tipsSeen().rare) out.push('rare');
    return out;
  }

  // test / screenshot hooks (no UI)
  window.__purr = {
    get game() { return game; }, tap: onTap, undo, hint, shuffle, idle, flush,
    get busy() { return busy || running; }, get vt() { return vt.map((e) => e.tile); },
    get rare() { return rare; }, get hintMarks() { return hintMarks; }, get profile() { return P; },
    get tipOpen() { return tipOpen; }, clockRunning, openHowto,
  };

  document.addEventListener('touchstart', () => {}, { passive: true }); // lets iOS Safari apply :active (button press-down)
  // ---------------------------------------------------------------- boot
  applySettings();
  startAmbience();
  if (migratedNote) { save(); setTimeout(() => toast(migratedNote, 4600), 700); }
  const scr = params.get('screen');
  if (params.has('daily')) {
    startBoard('daily', { daily: true, restart: true });
  } else if (params.has('board')) {
    startBoard(Number(params.get('board')), { restart: params.has('fresh') });
    const k = Number(params.get('moves') || 0);
    for (let m = 0; m < k && game.solution && m < game.solution.length; m++) game.tap(game.solution[m]);
    if (k) { persist(); refresh(); renderTrayInstant(); }
    if (params.has('hint')) hint();
    if (params.has('win')) { for (const t of game.solution) if (game.present[t]) game.tap(t); renderTrayInstant(); win(); }
    if (params.has('dead')) showDead();
  } else if (scr === 'album') { renderAlbum(); show('album'); }
  else if (P.current) { startBoard(P.current.boardId); }
  else if (Object.keys(P.cleared).length === 0 && scr !== 'home') { startBoard(1); } // Section 9: board 1 is already dealt
  else { renderHome(); show('home'); }
})();
