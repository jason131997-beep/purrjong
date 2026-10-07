/*
 * Purrjong audio: every sound is synthesized at runtime with the Web Audio API (no samples), and the
 * music is our own offline renders (tools/build-music.py -> theme.m4a, tools/build-playlist.py -> 5 more tracks).
 *   - Playlist: 'rotate' (default) moves to the next track on every new level and, on long levels, crossfades
 *     to the next track after the current one has played through once (capped at MAX_PLAY s). Or stay on one track.
 *   - iOS Safari: the AudioContext starts suspended; unlock() runs inside the first touchend/click.
 *   - Music plays from a decoded AudioBuffer with loopStart/loopEnd, so it is gapless (no <audio loop> gap).
 *   - Mixing: sfx bus + music bus -> master -> soft compressor; sfx share a small synthetic room reverb.
 *   - navigator.audioSession 'ambient' (iOS 17+): mixes with the player's own music and respects the
 *     silent switch, like native casual games.
 */
(function () {
  'use strict';
  // generated from art/audio/playlist.json (tools/build-playlist.py); all tracks are loudness-matched (EBU R128)
  const TRACKS = [{"id": "theme", "name": "Tea Garden Shelf", "file": "art/audio/theme.m4a", "pad": 0.5, "loop": 91.428571}, {"id": "garden", "name": "Morning Garden", "file": "art/audio/garden.m4a", "pad": 0.5, "loop": 80.0}, {"id": "teahouse", "name": "Tea House Steam", "file": "art/audio/teahouse.m4a", "pad": 0.5, "loop": 87.272721}, {"id": "nightmarket", "name": "Lantern Night Market", "file": "art/audio/nightmarket.m4a", "pad": 0.5, "loop": 87.272721}, {"id": "festival", "name": "Festival Steps", "file": "art/audio/festival.m4a", "pad": 0.5, "loop": 88.888889}, {"id": "rain", "name": "Rain on the Eaves", "file": "art/audio/rain.m4a", "pad": 0.5, "loop": 88.0}];
  const XF = 3.0;        // crossfade seconds (track changes)
  const MAX_PLAY = 165;  // rotate even if a track is longer than this
  const S = { sound: true, music: true, sfxVol: 0.7, musicVol: 0.3, track: 'rotate', trackIdx: 0 };
  let ctx = null, master, sfxBus, musicBus, revIn, noiseBuf = null;
  let cur = null, wantMusic = false, onTrack = null;   // cur: { idx, src, gain, startedAt, loop }
  const bufs = new Map();                           // track idx -> Promise<AudioBuffer|null> (current + next only)
  let musicSrc = null;                              // kept for the musicPlaying getter
  let unlocked = false;

  function make() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch (e) { /* older iOS */ }
    ctx = new AC({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
    comp.connect(ctx.destination);
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(comp);
    sfxBus = ctx.createGain(); sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.connect(master);
    // small room: synthetic decaying stereo noise IR
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.1), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) { lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; d[i] = lp * Math.pow(1 - i / len, 3.2); }
    }
    conv.buffer = ir;
    revIn = ctx.createGain(); revIn.gain.value = 0.22;
    revIn.connect(conv); conv.connect(sfxBus);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    applyLevels(true);
    return ctx;
  }
  function applyLevels(now) {
    if (!ctx) return;
    const t = ctx.currentTime, tc = now ? 0.001 : 0.08;
    sfxBus.gain.setTargetAtTime(S.sound ? S.sfxVol * 0.9 : 0, t, tc);
    musicBus.gain.setTargetAtTime(S.music ? S.musicVol * 0.55 : 0, t, tc);
  }
  /** Call from inside a user gesture (touchend / click). Safe to call often. */
  function unlock() {
    if (!make()) return;
    if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    if (!unlocked) {
      unlocked = true;
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
    }
    if (wantMusic && S.music) startMusic();
  }
  function set(opts) {
    const prevTrack = S.track;
    Object.assign(S, opts || {});
    applyLevels();
    if (!S.music) { stopMusic(true); return; }
    if (opts && opts.track && opts.track !== prevTrack && opts.track !== 'rotate') { const i = TRACKS.findIndex((t) => t.id === opts.track); if (i >= 0) switchTo(i); return; }
    if (wantMusic && unlocked) startMusic();
  }

  // ---------------------------------------------------------------- music (playlist)
  const pinned = () => (S.track && S.track !== 'rotate' ? TRACKS.findIndex((t) => t.id === S.track) : -1);
  function wantedIdx() { const p = pinned(); return p >= 0 ? p : ((S.trackIdx | 0) % TRACKS.length + TRACKS.length) % TRACKS.length; }
  function load(idx) {
    if (bufs.has(idx)) return bufs.get(idx);
    if (location.protocol === 'file:' || !ctx) return Promise.resolve(null); // fetch is blocked on file://
    const vm = document.querySelector('meta[name="purrjong-version"]'); // cache-bust with the page stamp
    const p = fetch(TRACKS[idx].file + (vm ? '?v=' + encodeURIComponent(vm.content) : ''))
      .then((r) => { if (!r.ok) throw new Error('music ' + r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => { const q = ctx.decodeAudioData(ab, res, rej); if (q && q.then) q.then(res, rej); }))
      .catch(() => { bufs.delete(idx); return null; });
    bufs.set(idx, p);
    // keep memory small on phones: only the playing track and the one we're moving to stay decoded
    for (const k of [...bufs.keys()]) if (k !== idx && (!cur || k !== cur.idx)) bufs.delete(k);
    return p;
  }
  let switching = -1;
  /** Crossfade to track idx (fade the old one out over XF while the new one fades in). */
  function switchTo(idx, fade) {
    if (!ctx || !S.music || !wantMusic) { S.trackIdx = idx; return; }
    if (cur && cur.idx === idx) return;
    switching = idx;
    load(idx).then((buf) => {
      if (!buf || switching !== idx || !S.music || !wantMusic) return;
      switching = -1;
      const T = TRACKS[idx], t = ctx.currentTime, f = fade == null ? XF : fade;
      const src = ctx.createBufferSource(); src.buffer = buf;
      src.loop = true; src.loopStart = T.pad; src.loopEnd = Math.min(buf.duration, T.pad + T.loop);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + f);
      src.connect(g); g.connect(musicBus);
      src.start(t + 0.03, T.pad);
      if (cur) fadeOut(cur, f);
      cur = { idx, src, gain: g, startedAt: t, loop: T.loop };
      musicSrc = src;
      S.trackIdx = idx;
      if (onTrack) onTrack(idx, T);
    });
  }
  function fadeOut(c, f) {
    const t = ctx.currentTime;
    // equal-power-ish: a slightly slower start than linear so the dip in the middle of the crossfade is small
    c.gain.gain.cancelScheduledValues(t); c.gain.gain.setValueAtTime(Math.max(0.0001, c.gain.gain.value), t);
    c.gain.gain.setTargetAtTime(0.0001, t + f * 0.15, f / 3.2);
    try { c.src.stop(t + f + 0.4); } catch (e) { /* already stopped */ }
  }
  function startMusic() {
    wantMusic = true;
    if (!ctx || !S.music || cur || switching >= 0) return;
    switchTo(wantedIdx(), 2.5);
  }
  function stopMusic(keepWanted) {
    if (!keepWanted) wantMusic = false;
    switching = -1;
    if (!cur || !ctx) return;
    fadeOut(cur, 0.6);
    cur = null; musicSrc = null;
  }
  /** New level: in rotate mode, crossfade to the next track in the playlist. */
  function nextTrack() {
    if (pinned() >= 0) return;
    const base = cur ? cur.idx : wantedIdx();
    const idx = (base + 1) % TRACKS.length;
    if (!ctx || !cur) { S.trackIdx = idx; if (onTrack) onTrack(idx, TRACKS[idx]); if (ctx && wantMusic && S.music && unlocked) startMusic(); return; }
    switchTo(idx);
  }
  // long levels: after a full play-through (or MAX_PLAY s), crossfade to the next track; prefetch ahead of time
  setInterval(() => {
    if (!ctx || !cur || ctx.state !== 'running' || pinned() >= 0 || switching >= 0) return;
    const el = ctx.currentTime - cur.startedAt, len = Math.min(cur.loop, MAX_PLAY);
    if (el >= len - 25) load((cur.idx + 1) % TRACKS.length);
    if (el >= len - XF) nextTrack();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend && ctx.suspend();
    else if (unlocked) ctx.resume && ctx.resume();
  });

  // ---------------------------------------------------------------- synthesis helpers
  // 'suspended' right after unlock() is fine: nodes scheduled now play the moment resume() lands (first tap is not lost)
  const ready = () => !!(ctx && S.sound && unlocked && ctx.state !== 'closed' && !document.hidden);
  function env(g, t, a, peak, d, sustain) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(sustain || 0.0001, t + a, d / 3);
  }
  function osc(type, f, t, dur, peak, opts) {
    opts = opts || {};
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + (opts.glide || dur * 0.6));
    if (opts.detune) o.detune.value = opts.detune;
    env(g, t, opts.a || 0.003, peak, dur);
    o.connect(g); g.connect(opts.dest || sfxBus);
    if (opts.rev) { const r = ctx.createGain(); r.gain.value = opts.rev; g.connect(r); r.connect(revIn); }
    o.start(t); o.stop(t + dur + 0.3);
    return o;
  }
  function noise(t, dur, peak, filter, opts) {
    opts = opts || {};
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    s.playbackRate.value = opts.rate || 1;
    const f = ctx.createBiquadFilter(); f.type = filter.type; f.frequency.setValueAtTime(filter.f, t); f.Q.value = filter.q || 1;
    if (filter.to) f.frequency.exponentialRampToValueAtTime(filter.to, t + dur);
    const g = ctx.createGain();
    if (opts.swell) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + dur * 0.45); g.gain.linearRampToValueAtTime(0.0001, t + dur); }
    else env(g, t, opts.a || 0.002, peak, dur);
    s.connect(f); f.connect(g); g.connect(sfxBus);
    if (opts.rev) { const r = ctx.createGain(); r.gain.value = opts.rev; g.connect(r); r.connect(revIn); }
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.3);
  }
  const jitter = (x, p) => x * (1 + (Math.random() * 2 - 1) * p);
  // D major pentatonic, rising with the combo (bright, never dissonant)
  const PENTA = [587.33, 659.25, 739.99, 880, 987.77, 1174.66, 1318.51, 1479.98, 1760];

  function bell(f, t, peak, len, rev) {
    osc('sine', f, t, len, peak, { rev: rev == null ? 0.5 : rev });
    osc('sine', f * 2.003, t, len * 0.45, peak * 0.32, { rev: 0.4 });
    osc('sine', f * 3.01, t, len * 0.22, peak * 0.12, { rev: 0.3 });
    osc('triangle', f * 4.2, t, 0.05, peak * 0.08);
  }
  function knock(f, t, peak, len) { // wooden: pitched body + filtered click
    osc('sine', f * 1.5, t, len * 0.5, peak * 0.6, { to: f, glide: 0.025 });
    osc('triangle', f * 0.5, t, len, peak * 0.35, { to: f * 0.42, glide: len });
    noise(t, 0.022, peak * 0.55, { type: 'bandpass', f: f * 3.2, q: 2.2 });
  }

  // ---------------------------------------------------------------- the sound set
  const SFX = {
    tap() { const t = ctx.currentTime; knock(jitter(820, 0.04), t, 0.32, 0.07); },
    land() { const t = ctx.currentTime; knock(jitter(520, 0.03), t, 0.26, 0.09); noise(t, 0.05, 0.05, { type: 'lowpass', f: 900 }); },
    match(combo) {
      const t = ctx.currentTime, i = Math.min(PENTA.length - 3, Math.max(0, (combo || 1) - 1));
      bell(PENTA[i], t, 0.16, 1.1);
      bell(PENTA[i + 2], t + 0.07, 0.11, 0.9);
      // soft crunch: a few tiny bright grains
      for (let k = 0; k < 6; k++) noise(t + 0.01 + Math.random() * 0.07, 0.012, 0.09 * Math.random() + 0.04, { type: 'bandpass', f: 2200 + Math.random() * 3000, q: 1.6 });
      noise(t, 0.09, 0.05, { type: 'highpass', f: 2500 });
    },
    blocked() {
      const t = ctx.currentTime;
      osc('sine', 130, t, 0.16, 0.34, { to: 68, glide: 0.12 });
      noise(t, 0.06, 0.12, { type: 'lowpass', f: 420 });
    },
    warn() { const t = ctx.currentTime; osc('triangle', 392, t, 0.18, 0.09, { a: 0.01, rev: 0.3 }); },
    full() {
      const t = ctx.currentTime;
      osc('triangle', 440, t, 0.2, 0.12, { a: 0.01, rev: 0.35 });
      osc('triangle', 349.23, t + 0.17, 0.32, 0.12, { a: 0.01, rev: 0.35 });
      knock(300, t, 0.15, 0.1);
    },
    undo() {
      const t = ctx.currentTime;
      noise(t, 0.28, 0.16, { type: 'bandpass', f: 2600, to: 380, q: 1.4 }, { swell: true });
      knock(560, t + 0.27, 0.18, 0.08);
    },
    shuffle() {
      const t = ctx.currentTime;
      for (let k = 0; k < 16; k++) { const u = k / 15; const at = t + 0.5 * (u * u * 0.4 + u * 0.6); noise(at, 0.014, 0.07 + 0.05 * Math.sin(u * Math.PI), { type: 'bandpass', f: jitter(3200, 0.2), q: 2.5 }); }
      noise(t, 0.5, 0.05, { type: 'bandpass', f: 1200, to: 2400, q: 0.8 }, { swell: true });
    },
    win() {
      const t = ctx.currentTime;
      [0, 2, 3, 4, 5, 7].forEach((n, k) => bell(PENTA[n], t + k * 0.11, 0.13, 1.2));
      [293.66, 369.99, 440, 587.33].forEach((f) => osc('sine', f, t + 0.7, 2.2, 0.05, { a: 0.25, rev: 0.6 }));
      for (let k = 0; k < 10; k++) osc('sine', PENTA[5 + (k % 4)] * 2, t + 0.75 + k * 0.06, 0.25, 0.025, { rev: 0.7 });
    },
    star(k) { const t = ctx.currentTime; bell(PENTA[3 + 2 * (k || 0)], t, 0.11, 0.8); },
    click() { const t = ctx.currentTime; osc('sine', 1350, t, 0.035, 0.12, { to: 900, glide: 0.03 }); noise(t, 0.012, 0.05, { type: 'highpass', f: 3000 }); },
    hint() { const t = ctx.currentTime; bell(PENTA[2], t, 0.08, 0.6); bell(PENTA[4], t + 0.09, 0.07, 0.7); },
    meow() {
      // tiny synthetic meow: buzzy source through two moving formants, pitch up-then-down
      const t = ctx.currentTime, d = 0.42;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(560, t); o.frequency.linearRampToValueAtTime(820, t + d * 0.35); o.frequency.linearRampToValueAtTime(600, t + d);
      const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 7; vg.gain.value = 9; vib.connect(vg); vg.connect(o.frequency);
      const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
      f1.type = 'bandpass'; f1.Q.value = 6; f1.frequency.setValueAtTime(700, t); f1.frequency.linearRampToValueAtTime(1100, t + d * 0.4); f1.frequency.linearRampToValueAtTime(650, t + d);
      f2.type = 'bandpass'; f2.Q.value = 8; f2.frequency.setValueAtTime(1700, t); f2.frequency.linearRampToValueAtTime(2300, t + d * 0.4); f2.frequency.linearRampToValueAtTime(1500, t + d);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.06); g.gain.linearRampToValueAtTime(0.1, t + d * 0.7); g.gain.linearRampToValueAtTime(0.0001, t + d);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g); g.connect(lp); lp.connect(sfxBus);
      const r = ctx.createGain(); r.gain.value = 0.3; lp.connect(r); r.connect(revIn);
      o.start(t); vib.start(t); o.stop(t + d + 0.05); vib.stop(t + d + 0.05);
    },
  };
  let lastAt = {};
  function play(name, arg) {
    if (!ready() || !SFX[name]) return;
    const now = ctx.currentTime;
    if (lastAt[name] && now - lastAt[name] < 0.025) return; // never stack the same sound in one frame
    lastAt[name] = now;
    try { SFX[name](arg); } catch (e) { /* never let audio break play */ }
  }

  window.PurrAudio = { unlock, set, play, startMusic, stopMusic, nextTrack, tracks: TRACKS.map((t) => ({ id: t.id, name: t.name })),
    set onTrack(fn) { onTrack = fn; }, get current() { return cur ? TRACKS[cur.idx].id : null; },
    get state() { return ctx ? ctx.state : 'none'; }, get musicPlaying() { return !!cur; } };
})();
