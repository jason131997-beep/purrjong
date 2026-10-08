/* Purrjong monetization layer (v5.3).
   Two halves:
   1. Policy (pure, node-testable): sessions, the interstitial frequency rules, rewarded daily caps, what a
      purchase grants, save normalisation. All numbers come from data/monetize.json.
   2. Providers: the web build ships MOCK providers only (a "Test ad" overlay, a "Test purchase, no charge"
      sheet). No ad network scripts, no payments, no tracking. The native iOS app swaps in real AdMob /
      StoreKit 2 providers behind the same interface (see docs/native/*.swift and docs/monetization-plan.md):
        showInterstitial(placement) -> Promise<void>
        showRewarded(placement)     -> Promise<{ rewarded: boolean }>
        purchase(productId)         -> Promise<{ ok: boolean, transactionId?, cancelled? }>
        restorePurchases()          -> Promise<{ productIds: string[] }>
      A native shell can inject `window.PurrNativeMonetize` with those four methods and it is used instead. */
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root.PurrMonetize = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ state (lives in the save as P.monetize)
  function freshState() {
    return {
      v: 1,
      adFree: false,          // Remove Ads (or Starter Pack) owned: no interstitials. Rewarded stays opt-in.
      owned: {},              // non-consumables owned: { productId: true }
      purchases: [],          // ledger of grants applied in this save: [{ id, at, tx, fish }]
      sessions: 0, lastSeenAt: 0,
      playMsSinceAd: 0,       // active board time since the last interstitial
      boardsSinceAd: 0,       // boards finished (won or lost and continued) since the last interstitial
      lastInterstitialAt: 0, lastRewardedAt: 0,
      interstitials: 0, rewardedTotal: 0,
      rewardedDay: { day: '', count: 0, by: {} },
      pendingRare: 0,         // Starter Pack: guaranteed rare cats still to appear
      dev: { fastRules: false },
    };
  }
  /** Fill in anything missing (older saves have no monetize block at all): save-compatible both ways. */
  function normalize(s) {
    const f = freshState();
    if (!s || typeof s !== 'object') return f;
    const o = Object.assign(f, s);
    o.owned = Object.assign({}, s.owned || {});
    o.purchases = Array.isArray(s.purchases) ? s.purchases.slice(-50) : [];
    o.rewardedDay = Object.assign({ day: '', count: 0, by: {} }, s.rewardedDay || {});
    o.rewardedDay.by = Object.assign({}, o.rewardedDay.by || {});
    o.dev = Object.assign({ fastRules: false }, s.dev || {});
    for (const k of ['sessions', 'lastSeenAt', 'playMsSinceAd', 'boardsSinceAd', 'lastInterstitialAt', 'lastRewardedAt', 'interstitials', 'rewardedTotal', 'pendingRare']) o[k] = Number(o[k]) || 0;
    o.adFree = !!o.adFree;
    return o;
  }
  function dayKey(now) {
    const d = new Date(now);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ------------------------------------------------------------------ sessions + play time
  /** A new session starts at app launch when the app was away for more than session.gapMinutes. */
  function startSession(s, cfg, now) {
    const gap = ((cfg.session && cfg.session.gapMinutes) || 30) * 60000;
    if (!s.lastSeenAt || now - s.lastSeenAt > gap || s.sessions === 0) s.sessions++;
    s.lastSeenAt = now;
    return s.sessions;
  }
  function touch(s, now) { s.lastSeenAt = now; }
  function addPlay(s, ms) { if (ms > 0) s.playMsSinceAd += ms; }
  function boardEnded(s) { s.boardsSinceAd++; }

  // ------------------------------------------------------------------ interstitial rules
  function rules(s, cfg) {
    const base = Object.assign({}, cfg.interstitial || {});
    return s.dev && s.dev.fastRules ? Object.assign(base, cfg.devFastRules || {}) : base;
  }
  /**
   * Should an interstitial show now, at a board end the player just continued from?
   * ctx: { boardId (number | 'daily'), highestCleared, now, noAds }.
   * Returns { show, reasons: [why not...], waitMs (play time still needed), boardsNeeded }.
   */
  function interstitialCheck(s, cfg, ctx) {
    const r = rules(s, cfg), now = ctx.now, reasons = [];
    if (!r.enabled) reasons.push('interstitials are off in config');
    if (ctx.noAds) reasons.push('?noads=1');
    if (s.adFree) reasons.push('Remove Ads owned');
    if (s.sessions <= (r.noAdsInFirstSessions || 0)) reasons.push('first session');
    const minBoard = r.minBoard || 1;
    const played = ctx.boardId === 'daily' ? (ctx.highestCleared || 0) : Number(ctx.boardId) || 0;
    if (played < minBoard) reasons.push(`no ads until board ${minBoard} is played (this was ${ctx.boardId === 'daily' ? 'the Daily' : 'board ' + played})`);
    const needMs = (r.minPlaySecondsSinceAd || 0) * 1000, waitMs = Math.max(0, needMs - s.playMsSinceAd);
    if (waitMs > 0) reasons.push(`needs ${Math.ceil(waitMs / 1000)} s more play`);
    const boardsNeeded = Math.max(0, (r.minBoardsBetween || 1) - s.boardsSinceAd);
    if (boardsNeeded > 0) reasons.push(`needs ${boardsNeeded} more board${boardsNeeded === 1 ? '' : 's'}`);
    const sinceRewarded = s.lastRewardedAt ? now - s.lastRewardedAt : Infinity, skipMs = (r.skipAfterRewardedSeconds || 0) * 1000;
    if (sinceRewarded < skipMs) reasons.push(`rewarded ad ${Math.round(sinceRewarded / 1000)} s ago`);
    return { show: reasons.length === 0, reasons, waitMs, boardsNeeded, rules: r };
  }
  function noteInterstitial(s, now) {
    s.lastInterstitialAt = now; s.playMsSinceAd = 0; s.boardsSinceAd = 0; s.interstitials++;
  }

  // ------------------------------------------------------------------ rewarded caps
  function rollDay(s, now) {
    const k = dayKey(now);
    if (s.rewardedDay.day !== k) s.rewardedDay = { day: k, count: 0, by: {} };
    return s.rewardedDay;
  }
  /** { ok, left (for this placement today), reason }. Ad-free buyers can still opt in. */
  function rewardedCheck(s, cfg, placement, now) {
    const rw = cfg.rewarded || {}, pl = (rw.placements || {})[placement];
    if (!pl) return { ok: false, left: 0, reason: 'unknown placement ' + placement };
    const day = rollDay(s, now);
    const used = day.by[placement] || 0;
    const left = Math.max(0, Math.min((pl.perDay || 0) - used, (rw.dailyCap || 0) - day.count));
    return { ok: left > 0, left, reason: left > 0 ? '' : (day.count >= (rw.dailyCap || 0) ? 'daily ad limit reached' : 'limit for this reward reached today') };
  }
  function noteRewarded(s, placement, now) {
    const day = rollDay(s, now);
    day.count++; day.by[placement] = (day.by[placement] || 0) + 1;
    s.lastRewardedAt = now; s.rewardedTotal++;
  }

  // ------------------------------------------------------------------ products + grants
  function product(cfg, idOrKey) { return (cfg.products || []).find((p) => p.id === idOrKey || p.key === idOrKey) || null; }
  /** Non-consumables can be bought once; consumables any time. */
  function canBuy(s, cfg, idOrKey) {
    const p = product(cfg, idOrKey); if (!p) return false;
    if (p.type === 'nonConsumable' && s.owned[p.id]) return false;
    if (p.key === 'removeAds' && s.adFree && s.owned[p.id]) return false;
    return true;
  }
  /** Apply a completed purchase to the save state. Returns what the app must hand out: { fish, adFree, rareCat }. */
  function applyPurchase(s, cfg, idOrKey, tx, now) {
    const p = product(cfg, idOrKey); if (!p) return null;
    const g = p.grants || {};
    if (p.type === 'nonConsumable') s.owned[p.id] = true;
    if (g.adFree) s.adFree = true;
    if (g.rareCat) s.pendingRare += g.rareCat;
    s.purchases.push({ id: p.id, at: now, tx: tx || null, fish: g.fish || 0 });
    if (s.purchases.length > 50) s.purchases = s.purchases.slice(-50);
    return { fish: g.fish || 0, adFree: !!g.adFree, rareCat: g.rareCat || 0, product: p };
  }
  /** Restore re-applies entitlements only (ad-free, owned flags). One-time fish/rare grants are not paid twice. */
  function applyRestore(s, cfg, productIds) {
    const restored = [];
    for (const id of productIds || []) {
      const p = product(cfg, id); if (!p || p.type !== 'nonConsumable') continue;
      if (!s.owned[p.id]) restored.push(p.id);
      s.owned[p.id] = true;
      if ((p.grants || {}).adFree) s.adFree = true;
    }
    return restored;
  }
  function resetPurchases(s) { s.owned = {}; s.adFree = false; s.purchases = []; s.pendingRare = 0; }

  // ------------------------------------------------------------------ mock providers (browser only)
  function mockProviders(cfg, opts) {
    opts = opts || {};
    const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    const storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const speed = opts.speed || 1; // ?adfast=1 shortens the timers for automation
    const mk = cfg.mock || {};
    const ledgerKey = mk.storeLedgerKey || 'purrjong.mockstore';
    // the mock "App Store account": non-consumables survive Reset progress, like a real Apple ID would
    const ledger = {
      get() { try { return JSON.parse(storage.getItem(ledgerKey)) || { nonConsumables: [] }; } catch (e) { return { nonConsumables: [] }; } },
      add(id) { const l = ledger.get(); if (!l.nonConsumables.includes(id)) l.nonConsumables.push(id); try { storage.setItem(ledgerKey, JSON.stringify(l)); } catch (e) { /* */ } },
      clear() { try { storage.removeItem(ledgerKey); } catch (e) { /* */ } },
    };
    let layer = null;
    function el(html) { const d = doc.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
    function open(node) {
      close();
      layer = node; doc.body.appendChild(node);
      if (opts.onOpen) opts.onOpen();
    }
    function close() { if (layer) { layer.remove(); layer = null; if (opts.onClose) opts.onClose(); } }
    const art = '<div class="ad-art"><img src="art/logo.svg" alt=""><div><b>Your ad here</b><span>Placeholder for a real ad from the ad network in the iOS app.</span></div></div>';
    function showInterstitial(placement) {
      const secs = mk.interstitialCloseAfterSeconds || 5;
      return new Promise((resolve) => {
        const n = el(`<div class="ad-layer" id="adLayer" role="dialog" aria-modal="true" aria-label="Test ad" data-kind="interstitial" data-placement="${placement || ''}">
          <div class="ad-top"><span class="ad-label">Test ad</span><button class="ad-close" id="adClose" disabled aria-label="Close ad"><span id="adCount">${secs}</span></button></div>
          ${art}<p class="ad-note">Interstitial · ${placement || 'test'} · no real ad network in the web build</p></div>`);
        open(n);
        const btn = n.querySelector('#adClose'), cnt = n.querySelector('#adCount');
        let left = secs;
        const t = setInterval(() => {
          left--; if (left > 0) { cnt.textContent = String(left); return; }
          clearInterval(t); btn.disabled = false; btn.classList.add('ready'); cnt.textContent = '✕';
        }, 1000 * speed);
        btn.addEventListener('click', () => { if (btn.disabled) return; close(); resolve(); });
      });
    }
    function showRewarded(placement) {
      const secs = mk.rewardedSeconds || 5;
      return new Promise((resolve) => {
        const n = el(`<div class="ad-layer rewarded" id="adLayer" role="dialog" aria-modal="true" aria-label="Test rewarded ad" data-kind="rewarded" data-placement="${placement || ''}">
          <div class="ad-top"><span class="ad-label">Test ad · reward</span><button class="ad-close early" id="adClose" aria-label="Close without reward">✕</button></div>
          ${art}
          <div class="ad-reward"><div class="ad-ring"><b id="adCount">${secs}</b></div><span id="adMsg">Watch to the end to get your reward</span></div>
          <button class="pill ad-claim" id="adClaim" hidden>Get reward</button>
          <p class="ad-note">Rewarded · ${placement || 'test'} · closing early gives no reward</p></div>`);
        open(n);
        const cnt = n.querySelector('#adCount'), msg = n.querySelector('#adMsg'), claim = n.querySelector('#adClaim'), x = n.querySelector('#adClose');
        let left = secs, done = false;
        const t = setInterval(() => {
          left--; if (left > 0) { cnt.textContent = String(left); return; }
          clearInterval(t); done = true; cnt.textContent = '✓'; msg.textContent = 'Reward earned!'; claim.hidden = false; n.classList.add('done');
        }, 1000 * speed);
        claim.addEventListener('click', () => { close(); resolve({ rewarded: true }); });
        x.addEventListener('click', () => { clearInterval(t); close(); resolve({ rewarded: done }); });
      });
    }
    function purchase(productId) {
      const p = product(cfg, productId);
      return new Promise((resolve) => {
        if (!p) { resolve({ ok: false, error: 'unknown product' }); return; }
        const n = el(`<div class="ad-layer buy" id="buyLayer" role="dialog" aria-modal="true" aria-label="Test purchase">
          <div class="buy-sheet"><div class="grab"></div><span class="buy-test">Test purchase, no charge</span>
          <h3>${p.name}</h3><p>${p.blurb || ((p.grants || {}).fish ? (p.grants.fish).toLocaleString('en-US') + ' fish' : '')}</p>
          <div class="buy-price">${p.price} <small>test price</small></div>
          <div class="sheet-actions"><button class="pill ghost" id="buyCancel">Cancel</button><button class="pill" id="buyOk">Buy (test)</button></div>
          <small class="buy-fine">In the App Store app this is Apple's purchase sheet with the real local price.</small></div></div>`);
        open(n);
        n.querySelector('#buyCancel').addEventListener('click', () => { close(); resolve({ ok: false, cancelled: true }); });
        n.querySelector('#buyOk').addEventListener('click', () => {
          if (p.type === 'nonConsumable') ledger.add(p.id);
          close(); resolve({ ok: true, transactionId: 'test-' + Date.now().toString(36) });
        });
      });
    }
    function restorePurchases() { return Promise.resolve({ productIds: ledger.get().nonConsumables.slice() }); }
    return { kind: 'mock', showInterstitial, showRewarded, purchase, restorePurchases, ledger, isOpen: () => !!layer, closeAll: close };
  }

  // ------------------------------------------------------------------ orchestrator used by the app
  /**
   * createMonetization({ config, state: () => P.monetize, save, onAdStart, onAdEnd, noAds, speed })
   * Wraps policy + provider. The app never talks to a provider directly.
   */
  function createMonetization(o) {
    const cfg = o.config, st = o.state;
    const native = typeof window !== 'undefined' && window.PurrNativeMonetize;
    const prov = native || mockProviders(cfg, { speed: o.speed, onOpen: o.onAdStart, onClose: o.onAdEnd });
    const now = () => (o.now ? o.now() : Date.now());
    let showing = false;
    const api = {
      config: cfg, provider: prov,
      get showing() { return showing || (prov.isOpen ? prov.isOpen() : false); },
      isAdFree: () => !!st().adFree,
      interstitialStatus(ctx) { return interstitialCheck(st(), cfg, Object.assign({ now: now(), noAds: o.noAds }, ctx)); },
      /** Board finished and the player continued: count it, then show an interstitial if every rule allows. */
      async atBoardEnd(ctx) {
        boardEnded(st());
        const c = interstitialCheck(st(), cfg, Object.assign({ now: now(), noAds: o.noAds }, ctx));
        o.save();
        if (!c.show) return false;
        await api.showInterstitial('board_end', true);
        return true;
      },
      async showInterstitial(placement, counted) {
        showing = true;
        try { await prov.showInterstitial(placement); } finally { showing = false; }
        noteInterstitial(st(), now()); if (!counted) { /* forced from the dev panel: still resets the clock */ }
        o.save();
      },
      rewardedStatus: (placement) => rewardedCheck(st(), cfg, placement, now()),
      /** Opt-in rewarded ad. Resolves { rewarded }. Caps apply (dev "force" passes force=true). */
      async showRewarded(placement, force) {
        const c = rewardedCheck(st(), cfg, placement, now());
        if (!c.ok && !force) return { rewarded: false, capped: true, reason: c.reason };
        showing = true;
        let r;
        try { r = await prov.showRewarded(placement); } finally { showing = false; }
        if (r && r.rewarded) { noteRewarded(st(), placement, now()); o.save(); }
        return { rewarded: !!(r && r.rewarded) };
      },
      product: (id) => product(cfg, id),
      products: () => (cfg.products || []).slice(),
      canBuy: (id) => canBuy(st(), cfg, id),
      async purchase(id) {
        if (!canBuy(st(), cfg, id)) return { ok: false, owned: true };
        const r = await prov.purchase(product(cfg, id).id);
        if (!r || !r.ok) return { ok: false, cancelled: !!(r && r.cancelled) };
        const g = applyPurchase(st(), cfg, id, r.transactionId, now());
        o.save();
        return Object.assign({ ok: true }, g);
      },
      async restorePurchases() {
        const r = await prov.restorePurchases();
        const restored = applyRestore(st(), cfg, (r && r.productIds) || []);
        o.save();
        return { restored, owned: Object.keys(st().owned) };
      },
      resetPurchases() { resetPurchases(st()); if (prov.ledger) prov.ledger.clear(); o.save(); },
    };
    return api;
  }

  return { freshState, normalize, dayKey, startSession, touch, addPlay, boardEnded, rules, interstitialCheck, noteInterstitial,
    rewardedCheck, noteRewarded, product, canBuy, applyPurchase, applyRestore, resetPurchases, mockProviders, createMonetization };
});
