(() => {
  'use strict';

  const ATTR_DONE = 'data-enhancer-done';
  const cache = new Map();
  const inFlight = new Map();
  const CONCURRENCY = 3;
  let activeRequests = 0;
  const queue = [];

  // ─── Global State ────────────────────────────────────────────────────────

  const state = {
    xp: null,
    settings: null,
    currentTab: '',
    totals: {
      deposits: { sum: 0, symbol: '€' },
      withdrawals: { sum: 0, symbol: '€' },
      rewards: { sum: 0, symbol: '€' },
      tips: {
        sent: 0,
        received: 0,
        symbol: '€',
        displayCurrency: 'EUR',
        /** When true, sent/received are already in displayCurrency (fiat); do not run crypto→fiat again */
        tipsInFiat: true
      },
      casino: { pnl: 0, avgRtp: 0, count: 0, symbol: '€' }
    },
    isFetchingAPI: false,
    hasInitialFetched: false,
    lastHref: '',
    lastTotalsFetchAt: 0,
    apiDisabled: {
      deposits: false,
      withdrawals: false,
      rewards: false
    },
    apiDisabledUntil: {
      deposits: 0,
      withdrawals: 0,
      rewards: 0
    },
    ratesBaseFiat: 'USD',
    cryptoRates: {},
    ratesFetchedAt: 0,
    isFetchingRates: false,
    save() {
      try { localStorage.setItem('ext_thrill_totals', JSON.stringify(this.totals)); } catch (e) {}
      try {
        localStorage.setItem('ext_thrill_api_backoff', JSON.stringify({
          apiDisabled: this.apiDisabled,
          apiDisabledUntil: this.apiDisabledUntil
        }));
      } catch (e) {}
    },
    load() {
      try {
        const saved = localStorage.getItem('ext_thrill_totals');
        if (saved) {
          const parsed = JSON.parse(saved);
          Object.assign(this.totals, parsed);
        }
      } catch (e) {}
      try {
        const raw = localStorage.getItem('ext_thrill_api_backoff');
        if (raw) {
          const p = JSON.parse(raw);
          if (p.apiDisabled) Object.assign(this.apiDisabled, p.apiDisabled);
          if (p.apiDisabledUntil) Object.assign(this.apiDisabledUntil, p.apiDisabledUntil);
        }
      } catch (e) {}
    }
  };

  state.load();

  // ─── Shared Utilities ───────────────────────────────────────────────────

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      drain();
    });
  }

  function drain() {
    while (activeRequests < CONCURRENCY && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      activeRequests++;
      fn().then(resolve).catch(reject).finally(() => { activeRequests--; drain(); });
    }
  }

  function parseAmount(amountObj) {
    if (!amountObj) return 0;
    // Handle both old-style 'amount' and new HAR-style 'cryptoAmount' structures
    const rawVal = amountObj.value ?? amountObj.cryptoAmount?.value;
    if (!rawVal) return 0;

    const raw = BigInt(rawVal);
    const dec = amountObj.decimals ?? amountObj.cryptoAmount?.decimals ?? 18;
    const divisor = BigInt(10 ** dec);
    const whole = Number(raw / divisor);
    const remainder = Number(raw % divisor) / (10 ** dec);
    return whole + remainder;
  }

  async function fetchXPData() {
    if (state.xp) return state.xp;
    try {
      const res = await fetch('/api/reward/v1/players/self/xp', { credentials: 'include' });
      if (!res.ok) return null;
      state.xp = await res.json();
      return state.xp;
    } catch (e) {
      return null;
    }
  }

  async function fetchPlayerSettings() {
    if (state.settings) return state.settings;
    try {
      const res = await fetch('/api/v1/player/settings', { credentials: 'include' });
      if (!res.ok) return null;
      state.settings = await res.json();
      return state.settings;
    } catch {
      return null;
    }
  }

  function parseRate(rateObj) {
    if (!rateObj?.value) return null;
    const raw = BigInt(rateObj.value);
    const dec = rateObj.decimals ?? 18;
    const divisor = BigInt(10 ** dec);
    const whole = Number(raw / divisor);
    const remainder = Number(raw % divisor) / (10 ** dec);
    return whole + remainder;
  }

  /** Always awaited when aggregating tips / mixed-crypto totals — avoids stale or missing rates */
  async function loadExchangeRatesNow(baseFiat = 'EUR') {
    try {
      const res = await fetch(`/api/v1/exchange-rates/fiats/${baseFiat}/cryptos`, { credentials: 'include' });
      if (!res.ok) return;
      const json = await res.json();
      const map = {};
      (json?.rates || []).forEach(r => {
        const value = parseRate(r.rate);
        if (r.cryptoCurrency && value) map[r.cryptoCurrency] = value;
      });
      if (Object.keys(map).length) {
        state.cryptoRates = map;
        state.ratesBaseFiat = json?.baseFiatCurrency || baseFiat;
        state.ratesFetchedAt = Date.now();
      }
    } catch {}
  }

  async function fetchCryptoRates(baseFiat = 'EUR') {
    if (state.isFetchingRates) return;
    const now = Date.now();
    if (state.ratesFetchedAt && (now - state.ratesFetchedAt) < FX_REFETCH_MS) return;
    state.isFetchingRates = true;
    try {
      await loadExchangeRatesNow(baseFiat);
    } finally {
      state.isFetchingRates = false;
    }
  }

  function formatCurrency(val, symbol = '€') {
    const sign = val >= 0 ? '+' : '-';
    return `${sign}${symbol}${Math.abs(val).toFixed(2)}`;
  }

  function formatUsd(val) {
    const sign = val >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(val).toFixed(2)}`;
  }

  function fiatSymbol(code) {
    const c = (code || '').toUpperCase();
    if (c === 'EUR') return '€';
    if (c === 'USD') return '$';
    if (c === 'GBP') return '£';
    return `${c} `;
  }

  function formatFiat(val, code) {
    const sign = val >= 0 ? '+' : '-';
    const sym = fiatSymbol(code);
    return `${sign}${sym}${Math.abs(val).toFixed(2)}`;
  }

  function toFiatIfCrypto(amount, symbolOrCode) {
    if (!symbolOrCode) return null;
    const code = String(symbolOrCode).trim().toUpperCase();
    const rate = state.cryptoRates[code];
    if (!rate) return null;
    // API/Crypto: "crypto units per 1 baseFiat", so fiat = crypto / rate.
    return amount / rate;
  }

  /** Tip API row: sum in crypto must be converted per currency — never add USDT + SOL as one number. */
  function tipRowCryptoAmount(item) {
    const ca = item?.cryptoAmount;
    if (!ca?.value) return null;
    const amount = parseAmount({ value: ca.value, decimals: ca.decimals ?? 18 });
    const code = ca.currency;
    if (!code || !amount) return null;
    return { amount, code: String(code).toUpperCase() };
  }

  /**
   * Smallest DOM block that still contains the row’s “Balance …” subline (Thrill cards are often divs, not li).
   * Used so we only count one amount span per transaction (nested highlight spans were inflating totals ~2×).
   */
  function transactionRowRootForSpan(span, listRoot) {
    let p = span.parentElement;
    for (let d = 0; d < 30 && p && p !== listRoot; d++) {
      if (/\bBalance\b/i.test(p.textContent || '')) return p;
      p = p.parentElement;
    }
    const li = span.closest('li');
    if (li && listRoot.contains(li)) return li;
    const role = span.closest('[role="listitem"]');
    if (role && listRoot.contains(role)) return role;
    const link = span.closest('a');
    if (link && listRoot.contains(link)) return link;
    return span.parentElement || span;
  }

  function elementIsVisible(el) {
    if (!el?.isConnected) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 12 && r.height >= 12;
  }

  /** Pick the real history list, not the filter chip; Thrill often keeps two responsive copies in the DOM (~2× totals). */
  function queryBestListForScrape(selector) {
    const nodes = [...document.querySelectorAll(selector)];
    const scored = nodes.map(el => {
      const n = el.querySelectorAll('.text-foreground-highlight-1 span, .text-foreground-primary span').length;
      return { el, n };
    }).filter(x => x.n > 0);
    if (!scored.length) return document.querySelector(selector);
    const vis = scored.filter(x => elementIsVisible(x.el));
    const pool = vis.length ? vis : scored;
    pool.sort((a, b) => b.n - a.n);
    return pool[0].el;
  }

  /** Collapse duplicate list copies: same card text → count once (balance line often differs between DOM clones). */
  function rowContentFingerprint(root) {
    return (root.textContent || '')
      .replace(/\s+/g, ' ')
      .replace(/\bBalance\s*[€$£]?\s*[\d.,]+\b/gi, '')
      .trim()
      .slice(0, 280);
  }

  function signedAmountFromSpan(span) {
    const amountGroup = span.closest('.text-foreground-highlight-1, .text-foreground-primary') || span.parentElement;
    const text = (amountGroup?.textContent || span.textContent || '').trim();
    const sign = text.startsWith('-') ? -1 : 1;
    const value = parseFloat(span.textContent.replace(/[^0-9,.]/g, '').replace(',', ''));
    if (isNaN(value)) return null;
    return Math.round(value * sign * 100) / 100;
  }

  /**
   * Thrill often keeps two full list copies (e.g. responsive); fingerprints may still differ slightly.
   * If every distinct amount appears an even number of times, treat as duplicated rows and halve.
   * (Rare edge case: two real txs with the same amount may be merged — unlikely for fiat totals.)
   */
  function collapseEvenDuplicateAmounts(signedVals) {
    if (signedVals.length < 2) return signedVals;
    const freq = new Map();
    signedVals.forEach(v => freq.set(v, (freq.get(v) || 0) + 1));
    if (![...freq.values()].every(c => c % 2 === 0)) return signedVals;
    const out = [];
    freq.forEach((c, v) => {
      for (let i = 0; i < c / 2; i++) out.push(v);
    });
    return out;
  }

  function transactionValue(item) {
    return parseAmount(item) || parseAmount(item.amount) || 0;
  }

  function extractItems(json) {
    if (!json || typeof json !== 'object') return [];
    return json.items || json.content || json.data || [];
  }

  const TIPS_PAGE_SIZE = 10;
  /** Documented in API/global — list endpoint (not per-sessionId). */
  const GAME_SESSIONS_PAGE_SIZE = 10;
  const CASINO_RUN_MS = 350;
  const TOTALS_REFETCH_MS = 60000;
  const API_404_BACKOFF_MS = 10 * 60 * 1000;
  const FX_REFETCH_MS = 30 * 60 * 1000;
  /**
   * `.../payment/.../transactions/searches` and reward `.../rewards/transactions/searches` return 404 on thrill.com;
   * totals for those categories come from the DOM scraper on each history tab. Set true only after confirming live URLs in Network.
   */
  const ENABLE_LEGACY_PAYMENT_REWARD_SEARCH = false;
  let casinoRunTimer = null;
  let casinoPass = 0;

  async function postPagedList(url, pageSize) {
    const all = [];
    let page = 0;
    for (let guard = 0; guard < 500; guard++) {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageSize, pageNumber: page })
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      let json;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      const batch = extractItems(json);
      all.push(...batch);
      if (json?.isLastBatch === true) break;
      if (batch.length < pageSize) break;
      page++;
    }
    return all;
  }

  async function firstWorkingPost(urls, pageSize = 100) {
    let saw404 = false;
    for (const url of urls) {
      try {
        return await postPagedList(url, pageSize);
      } catch (e) {
        if (e?.status === 404) saw404 = true;
        continue;
      }
    }
    if (saw404) {
      const err = new Error('All candidate endpoints returned 404');
      err.all404 = true;
      throw err;
    }
    return [];
  }

  // ─── Casino / Game Sessions Handler ──────────────────────────────────────

  function sessionRowToCacheData(session) {
    if (!session?.id) return null;
    const c = session.payout?.currency?.cryptoCurrency ?? session.underlyingCurrency ?? 'SOL';
    return {
      pnlCrypto: parseAmount(session.payout),
      multiplier: session.multiplier ?? 0,
      currency: session.underlyingCurrency || c,
      displayCurrency: session.currency || null
    };
  }

  /**
   * GET /api/v1/transactions/game-sessions?pageSize=&pageNumber= (see API/global).
   * Fills cache so cards resolve without N× single-session requests.
   */
  async function prefetchGameSessionsIntoCache() {
    const ps = GAME_SESSIONS_PAGE_SIZE;
    let page = 0;
    for (let guard = 0; guard < 500; guard++) {
      const url = `/api/v1/transactions/game-sessions?pageSize=${ps}&pageNumber=${page}`;
      const res = await fetch(url, { credentials: 'include', headers: { 'content-type': 'application/json' } });
      if (!res.ok) break;
      let json;
      try {
        json = await res.json();
      } catch {
        break;
      }
      const batch = json?.content || [];
      for (const row of batch) {
        const data = sessionRowToCacheData(row);
        if (data) cache.set(row.id, data);
      }
      if (json?.isLastBatch === true) break;
      if (batch.length < ps) break;
      page++;
    }
  }

  async function fetchSessionData(sessionId) {
    if (cache.has(sessionId)) return cache.get(sessionId);
    if (inFlight.has(sessionId)) return inFlight.get(sessionId);

    const promise = enqueue(async () => {
      try {
        const url = `/api/v1/transactions/game-sessions?sessionId=${sessionId}&pageNumber=0&pageSize=1`;
        const res = await fetch(url, { credentials: 'include', headers: { 'content-type': 'application/json' } });
        if (!res.ok) throw new Error();
        const json = await res.json();
        const session = json?.content?.[0];
        if (!session) throw new Error();

        const data = sessionRowToCacheData(session);
        if (!data) throw new Error();
        cache.set(sessionId, data);
        return data;
      } catch {
        return null;
      } finally {
        inFlight.delete(sessionId);
      }
    });

    inFlight.set(sessionId, promise);
    return promise;
  }

  const TransactionAPI = {
    depositUrls(kind) {
      const k = encodeURIComponent(kind);
      return [
        `/api/payment/v1/players/self/${k}/transactions/searches`,
        `/api/v1/payment/players/self/${k}/transactions/searches`,
        `/api/payments/v1/players/self/${k}/transactions/searches`,
        `/api/payment/v2/players/self/${k}/transactions/searches`
      ];
    },

    rewardUrls() {
      return [
        '/api/reward/v1/players/self/rewards/transactions/searches',
        '/api/reward/v2/players/self/rewards/transactions/searches'
      ];
    },

    async fetchDepositsOrWithdrawals(kind) {
      if (!ENABLE_LEGACY_PAYMENT_REWARD_SEARCH) return [];
      if (state.apiDisabled[kind] && Date.now() < (state.apiDisabledUntil[kind] || 0)) return [];
      try {
        return await firstWorkingPost(this.depositUrls(kind), 100);
      } catch (e) {
        if (e?.all404) {
          state.apiDisabled[kind] = true;
          state.apiDisabledUntil[kind] = Date.now() + API_404_BACKOFF_MS;
          state.save();
        }
        return [];
      }
    },

    async fetchRewardsAggregate() {
      if (!ENABLE_LEGACY_PAYMENT_REWARD_SEARCH) return [];
      if (state.apiDisabled.rewards && Date.now() < (state.apiDisabledUntil.rewards || 0)) return [];
      let combined = [];
      try {
        combined = await firstWorkingPost(this.rewardUrls(), 100);
      } catch (e) {
        if (e?.all404) {
          state.apiDisabled.rewards = true;
          state.apiDisabledUntil.rewards = Date.now() + API_404_BACKOFF_MS;
          state.save();
          return [];
        }
      }
      if (!combined.length) {
        let rain = [];
        let cd = [];
        try { rain = await firstWorkingPost(['/api/reward/v1/players/self/rain/transactions/searches'], 100); } catch {}
        try { cd = await firstWorkingPost(['/api/reward/v1/players/self/cashdrop/transactions/searches'], 100); } catch {}
        combined = [...rain, ...cd];
      }
      return combined;
    },

    async fetchAllTips() {
      const url = '/api/transfer/v1/players/self/tips/transactions/searches';
      try {
        return await postPagedList(url, TIPS_PAGE_SIZE);
      } catch {
        return [];
      }
    },

    async calculateTotals() {
      if (state.isFetchingAPI) return;
      state.isFetchingAPI = true;
      DashboardUI.update();

      const settings = await fetchPlayerSettings();
      const baseFiat = settings?.fiatCurrency || 'EUR';
      await loadExchangeRatesNow(baseFiat);

      let depList = [];
      let wdList = [];
      let rewList = [];
      const tipList = await this.fetchAllTips();

      try {
        depList = await this.fetchDepositsOrWithdrawals('deposits');
      } catch {}
      try {
        wdList = await this.fetchDepositsOrWithdrawals('withdrawals');
      } catch {}
      try {
        rewList = await this.fetchRewardsAggregate();
      } catch {}

      const summary = {
        deposits: { sum: 0, symbol: '€', inFiat: false, displayCurrency: baseFiat },
        withdrawals: { sum: 0, symbol: '€', inFiat: false, displayCurrency: baseFiat },
        rewards: { sum: 0, symbol: '€', inFiat: false, displayCurrency: baseFiat },
        tips: {
          sent: 0,
          received: 0,
          symbol: fiatSymbol(baseFiat),
          displayCurrency: baseFiat,
          tipsInFiat: true
        }
      };

      depList.forEach(item => {
        summary.deposits.sum += transactionValue(item);
        summary.deposits.symbol = item.cryptoAmount?.currency ?? item.amount?.underlyingCurrency ?? summary.deposits.symbol;
      });
      wdList.forEach(item => {
        summary.withdrawals.sum += transactionValue(item);
        summary.withdrawals.symbol = item.cryptoAmount?.currency ?? item.amount?.underlyingCurrency ?? summary.withdrawals.symbol;
      });
      rewList.forEach(item => {
        summary.rewards.sum += transactionValue(item);
        summary.rewards.symbol = item.cryptoAmount?.currency ?? item.amount?.underlyingCurrency ?? summary.rewards.symbol;
      });
      tipList.forEach(item => {
        const row = tipRowCryptoAmount(item);
        if (!row) return;
        const fiatVal = toFiatIfCrypto(row.amount, row.code);
        if (fiatVal == null) return;
        if (item.type === 'SENT') summary.tips.sent += fiatVal;
        else if (item.type === 'RECEIVED') summary.tips.received += fiatVal;
      });

      Object.keys(summary).forEach(k => {
        const hasData = k === 'tips' ? (summary.tips.sent !== 0 || summary.tips.received !== 0) : (summary[k].sum !== 0);
        if (hasData) state.totals[k] = summary[k];
      });

      state.isFetchingAPI = false;
      state.save();
      DashboardUI.update();

      queueMicrotask(() => {
        const u = location.href;
        if (u.includes('transactionType=deposits') || u.includes('transactionType=withdrawals') ||
            u.includes('transactionType=rewards') || u.includes('transactionType=rain') ||
            u.includes('transactionType=cashdrop') || u.includes('transactionType=tip')) {
          GenericScraper.run();
          DashboardUI.update();
        }
      });
    }
  };

  const CasinoHandler = {
    getWageredInfo(card) {
      const subtextEl = [...card.querySelectorAll('div, span, p')].find(el => 
        el.textContent.includes('·') && el.children.length === 0
      );
      const text = subtextEl ? subtextEl.textContent : card.textContent;
      const m = text.match(/[·•]\s*([^0-9\s.-]{1,3})?\s*([0-9,.]+)\s*([^0-9\s.-]{1,3})?/);
      if (!m) return null;
      return { symbol: (m[1] || m[3] || '').trim(), value: parseFloat(m[2].replace(',', '')) };
    },

    setBadge(card, pnlText, rtpText, pnlColor, rtpColor) {
      card.querySelector('.ext-pnl-container')?.remove();
      const betEl = card.querySelector('.typ-label-large.font-bold.whitespace-nowrap.uppercase');
      if (!betEl) return;

      const container = document.createElement('div');
      container.className = 'ext-pnl-container';
      Object.assign(container.style, {
        display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end',
        marginLeft: '15px', verticalAlign: 'middle', lineHeight: '1.1'
      });

      const pnlBadge = document.createElement('span');
      pnlBadge.textContent = pnlText;
      Object.assign(pnlBadge.style, { fontWeight: 'bold', fontSize: '13px', color: pnlColor, whiteSpace: 'nowrap' });

      const rtpBadge = document.createElement('span');
      rtpBadge.textContent = rtpText;
      Object.assign(rtpBadge.style, { fontSize: '13px', color: rtpColor, whiteSpace: 'nowrap', fontWeight: 'bold' });

      container.appendChild(rtpBadge);
      container.appendChild(pnlBadge);
      betEl.appendChild(container);
    },

    async processCard(card, pass) {
      if (card.hasAttribute(ATTR_DONE) || pass !== casinoPass) return;

      const a = card.querySelector('a[href*="gameSession="]');
      const m = a?.href.match(/gameSession=([a-f0-9-]{36})/i);
      if (!m) return;
      const sessionId = m[1];

      const data = await fetchSessionData(sessionId);
      if (pass !== casinoPass || !data) return;

      const wagered = this.getWageredInfo(card);
      if (!wagered || data.multiplier === undefined) return;

      const isWin = data.multiplier >= 1;
      const localPnl = wagered.value * (data.multiplier - 1);

      state.totals.casino.pnl += localPnl;
      state.totals.casino.count++;
      state.totals.casino.avgRtp = (state.totals.casino.avgRtp * (state.totals.casino.count - 1) + (data.multiplier * 100)) / state.totals.casino.count;
      state.totals.casino.symbol = wagered.symbol;

      const pnlText = `${isWin ? '+' : '-'}${wagered.symbol}${Math.abs(localPnl).toFixed(2)}`;
      const rtpVal = data.multiplier * 100;
      const rtpText = `${rtpVal.toFixed(1)}% RTP`;
      const rtpColor = rtpVal >= 99 ? '#19fb9b' : (rtpVal >= 95 ? '#ffb02e' : '#ff5f5f');
      this.setBadge(card, pnlText, rtpText, isWin ? '#19fb9b' : '#ff5f5f', rtpColor);
      card.setAttribute(ATTR_DONE, '1');
    },

    async run() {
      const list = document.querySelector('[aria-label="Game Sessions"]');
      if (!list) return;
      await prefetchGameSessionsIntoCache();
      const pass = ++casinoPass;
      list.querySelectorAll('li').forEach(li => li.removeAttribute(ATTR_DONE));
      state.totals.casino.pnl = 0;
      state.totals.casino.count = 0;
      state.totals.casino.avgRtp = 0;
      const cards = [...list.querySelectorAll('li')];
      await Promise.all(cards.map(li => this.processCard(li, pass)));
      if (pass !== casinoPass) return;
      state.save();
      DashboardUI.update();
    },

    scheduleRun() {
      if (casinoRunTimer) return;
      casinoRunTimer = setTimeout(() => {
        casinoRunTimer = null;
        if (location.href.includes('transactionType=casino')) void this.run();
      }, CASINO_RUN_MS);
    }
  };

  // ─── Unified Dashboard UI ────────────────────────────────────────────────

  const DashboardUI = {
    injectStyles() {
      if (document.getElementById('ext-companion-styles')) return;
      const style = document.createElement('style');
      style.id = 'ext-companion-styles';
      style.textContent = `
        .ext-dashboard {
          background: rgba(255, 255, 255, 0.03);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 16px 24px;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 24px;
          color: #fff;
          font-family: inherit;
          animation: slideDown 0.3s ease-out;
          transition: all 0.3s ease-out;
        }
        @keyframes slideDown { from { transform: translateY(-10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }
        
        .ext-container-inner { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 24px; width: 100%; }
        .ext-main-content { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
        .ext-logo-section { display: flex; align-items: center; gap: 12px; padding-right: 20px; border-right: 1px solid rgba(255,255,255,0.1); min-width: max-content; }
        .ext-stats-section { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
        
        .ext-stat-group { display: flex; flex-direction: column; gap: 2px; min-width: max-content; position: relative; }
        .ext-stat-group:not(:last-child):after {
          content: ""; position: absolute; right: -12px; top: 20%; height: 60%; width: 1px; background: rgba(255,255,255,0.1);
        }
        .ext-stat-label { font-size: 10px; font-weight: 800; text-transform: uppercase; color: rgba(255,255,255,0.4); letter-spacing: 0.6px; }
        .ext-stat-value { font-size: 16px; font-weight: 800; transition: color 0.3s ease; }
        
        .ext-xp-container { min-width: 280px; flex: 1 0 auto; transition: all 0.3s ease; }
        
        @media (max-width: 1024px) {
          .ext-xp-container { flex: 1 1 100%; margin-top: 5px; }
          .ext-logo-section { border-right: none; padding-right: 0; }
        }
        @media (max-width: 640px) {
          .ext-dashboard { padding: 16px; gap: 16px; }
          .ext-stat-group:after { display: none; }
          .ext-stats-section { justify-content: space-between; width: 100%; }
        }
      `;
      document.head.appendChild(style);
    },

    update() {
      this.injectStyles();
      const container = document.querySelector('main.sm\\:rounded-40 > div > div:first-child') || 
                        document.querySelector('main.sm\\:rounded-40 div.flex.flex-col.items-start') ||
                        document.querySelector('main.sm\\:rounded-40') ||
                        document.querySelector('main > div > div:first-child');
      if (!container) return;

      let dash = document.getElementById('ext-companion-dashboard');
      if (!dash) {
        dash = document.createElement('div');
        dash.id = 'ext-companion-dashboard';
        dash.className = 'ext-dashboard';
        container.prepend(dash);
      }

      const { totals } = state;
      const stats = [];

      if (totals.casino.count > 0) {
        const fiat = toFiatIfCrypto(totals.casino.pnl, totals.casino.symbol);
        stats.push(`
          <div class="ext-stat-group">
            <span class="ext-stat-label">Casino PNL</span>
            <span class="ext-stat-value" style="color: ${totals.casino.pnl >= 0 ? '#19fb9b' : '#ff5f5f'}" title="${formatCurrency(totals.casino.pnl, totals.casino.symbol)}">${fiat !== null ? formatFiat(fiat, state.ratesBaseFiat) : formatCurrency(totals.casino.pnl, totals.casino.symbol)}</span>
          </div>
          <div class="ext-stat-group">
            <span class="ext-stat-label">Avg RTP</span>
            <span class="ext-stat-value" style="color: ${totals.casino.avgRtp >= 96 ? '#19fb9b' : '#ffb02e'}">${totals.casino.avgRtp.toFixed(1)}%</span>
          </div>
        `);
      }

      if (totals.deposits.sum !== 0) {
        const dc = totals.deposits.displayCurrency || state.ratesBaseFiat;
        let depStr;
        if (totals.deposits.inFiat === true) {
          depStr = formatFiat(totals.deposits.sum, dc);
        } else {
          const fiat = toFiatIfCrypto(totals.deposits.sum, totals.deposits.symbol);
          depStr = fiat !== null ? formatFiat(fiat, state.ratesBaseFiat) : `${totals.deposits.symbol}${totals.deposits.sum.toFixed(2)}`;
        }
        stats.push(`
          <div class="ext-stat-group">
            <span class="ext-stat-label">Deposits</span>
            <span class="ext-stat-value" style="color: #ff5f5f" title="Deposits (${dc})">${depStr}</span>
          </div>
        `);
      }

      if (totals.withdrawals.sum !== 0) {
        const wd = Math.abs(totals.withdrawals.sum);
        const dc = totals.withdrawals.displayCurrency || state.ratesBaseFiat;
        let wdStr;
        if (totals.withdrawals.inFiat === true) {
          wdStr = `${fiatSymbol(dc)}${wd.toFixed(2)}`;
        } else {
          const fiat = toFiatIfCrypto(wd, totals.withdrawals.symbol);
          wdStr = fiat !== null ? `${fiatSymbol(state.ratesBaseFiat)}${fiat.toFixed(2)}` : `${totals.withdrawals.symbol}${wd.toFixed(2)}`;
        }
        stats.push(`
          <div class="ext-stat-group">
            <span class="ext-stat-label">Withdrawn</span>
            <span class="ext-stat-value" style="color: #19fb9b" title="Withdrawals (${dc})">${wdStr}</span>
          </div>
        `);
      }

      if (totals.rewards.sum !== 0) {
        const dc = totals.rewards.displayCurrency || state.ratesBaseFiat;
        let rewStr;
        if (totals.rewards.inFiat === true) {
          rewStr = `${fiatSymbol(dc)}${totals.rewards.sum.toFixed(2)}`;
        } else {
          const fiat = toFiatIfCrypto(totals.rewards.sum, totals.rewards.symbol);
          rewStr = fiat !== null ? `${fiatSymbol(state.ratesBaseFiat)}${fiat.toFixed(2)}` : `${totals.rewards.symbol}${totals.rewards.sum.toFixed(2)}`;
        }
        stats.push(`
          <div class="ext-stat-group">
            <span class="ext-stat-label">Rewards/Rain</span>
            <span class="ext-stat-value" style="color: #19fb9b" title="Rewards (${dc})">${rewStr}</span>
          </div>
        `);
      }

      if (totals.tips.sent !== 0 || totals.tips.received !== 0) {
        const dc = totals.tips.displayCurrency || state.ratesBaseFiat || 'EUR';
        const inFiat = totals.tips.tipsInFiat !== false;
        let sentStr;
        let recvStr;
        if (inFiat) {
          sentStr = formatFiat(-totals.tips.sent, dc);
          recvStr = formatFiat(totals.tips.received, dc);
        } else {
          const sf = toFiatIfCrypto(totals.tips.sent, totals.tips.symbol);
          const rf = toFiatIfCrypto(totals.tips.received, totals.tips.symbol);
          sentStr = sf != null ? formatFiat(-sf, state.ratesBaseFiat) : `-${totals.tips.symbol}${totals.tips.sent.toFixed(2)}`;
          recvStr = rf != null ? formatFiat(rf, state.ratesBaseFiat) : `+${totals.tips.symbol}${totals.tips.received.toFixed(2)}`;
        }
        stats.push(`
          <div class="ext-stat-group" title="Tips sent (${dc})">
            <span class="ext-stat-label">Tips Sent</span>
            <span class="ext-stat-value" style="color: #ff5f5f">${sentStr}</span>
          </div>
          <div class="ext-stat-group" title="Tips received (${dc})">
            <span class="ext-stat-label">Tips Received</span>
            <span class="ext-stat-value" style="color: #19fb9b">${recvStr}</span>
          </div>
        `);
      }

      const statsHtml = state.isFetchingAPI ? `
          <div style="display: flex; align-items: center; gap: 8px; color: #3cc0ff; font-weight: 700; font-size: 11px; text-transform: uppercase; animation: pulse 1.5s infinite;">
            <div style="width: 4px; height: 4px; background: #3cc0ff; border-radius: 50%;"></div>
            Scanning via API...
          </div>
        ` : (stats.length > 0 ? stats.join('') : '<span style="opacity: 0.5; font-size: 11px; font-weight: 700; text-transform: uppercase;">Navigate tabs to scan history</span>');

      const xp = state.xp;
      const rankHtml = xp ? `
        <div class="ext-xp-container" title="${xp.currentXp.toFixed(2)} / ${xp.nextTier.xpThreshold} XP">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span class="ext-stat-label">Rank Progress</span>
            <span class="ext-rank-badge" style="font-size: 11px; font-weight: 950; background: linear-gradient(90deg, #19fb9b, #3cc0ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-transform: uppercase;">
              ${xp.currentTier.name} <span style="opacity:0.3; margin: 0 4px; color: #fff; -webkit-text-fill-color: #fff;">→</span> ${xp.nextTier.name}
              <span style="margin-left: 8px; font-size: 10px; color: #fff; -webkit-text-fill-color: #fff; opacity: 0.9;">[${Math.min(100, (xp.currentXp / xp.nextTier.xpThreshold) * 100).toFixed(1)}%]</span>
            </span>
          </div>
          <div class="ext-progress-bg" style="height: 6px; background: rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden;">
            <div class="ext-progress-fill" style="width: ${Math.min(100, (xp.currentXp / xp.nextTier.xpThreshold) * 100)}%; height: 100%; background: linear-gradient(90deg, #19fb9b, #3cc0ff); box-shadow: 0 0 10px rgba(25, 251, 155, 0.3); transition: width 1s ease;"></div>
          </div>
        </div>
      ` : '';

      const fullHtml = `
        <div class="ext-container-inner">
          <div class="ext-main-content">
            <div class="ext-logo-section">
              <div style="width: 36px; height: 36px; background: linear-gradient(135deg, #19fb9b 0%, #3cc0ff 100%); border-radius: 10px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 15px rgba(25, 251, 155, 0.25);">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 950; letter-spacing: 0.8px; line-height: 1.1; background: linear-gradient(90deg, #19fb9b, #3cc0ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-family: 'Outfit', sans-serif;">THRILL COMPANION</span>
                <span style="font-size: 8px; opacity: 0.5; font-weight: 800; text-transform: uppercase;">Advanced Analytics</span>
              </div>
            </div>
            <div class="ext-stats-section">
              ${statsHtml}
            </div>
          </div>
          ${rankHtml}
        </div>
      `;

      if (dash.innerHTML !== fullHtml) dash.innerHTML = fullHtml;
    }
  };

  const GenericScraper = {
    run() {
      const url = location.href;
      if (url.includes('transactionType=deposits')) {
        this.sumSimple('[aria-label*="Deposit"]', 'deposits');
      } else if (url.includes('transactionType=withdrawals')) {
        this.sumSimple('[aria-label*="Withdrawal"]', 'withdrawals');
      } else if (url.includes('transactionType=rewards') || url.includes('transactionType=rain') || url.includes('transactionType=cashdrop')) {
        const labels = ['[aria-label*="Reward"]', '[aria-label*="Rain"]', '[aria-label*="Cashdrop"]'];
        this.sumSimple(labels.join(','), 'rewards');
      } else if (url.includes('transactionType=tip')) {
        this.sumTips();
      }
    },

    sumSimple(selector, stateKey) {
      const list = queryBestListForScrape(selector);
      if (!list) return;
      let total = 0;
      let symbol = '€';

      /** One span per card: group by row root (Balance subline defines the card on Thrill). Prefer highlight (main amount) over primary (often balance). */
      const byRoot = new Map();
      list.querySelectorAll('.text-foreground-highlight-1 span, .text-foreground-primary span').forEach(span => {
        const parentLine = (span.parentElement?.textContent || span.textContent || '').trim();
        if (/^Balance\s*[€$£]?/i.test(parentLine)) return;

        const root = transactionRowRootForSpan(span, list);
        const rawVal = parseFloat(span.textContent.replace(/[^0-9,.]/g, '').replace(',', ''));
        if (isNaN(rawVal)) return;

        const tier = span.closest('.text-foreground-highlight-1') ? 2 : span.closest('.text-foreground-primary') ? 1 : 0;
        const score = tier * 1e12 + Math.abs(rawVal);

        const prev = byRoot.get(root);
        if (!prev || score > prev.score) byRoot.set(root, { span, score });
      });

      /** Two responsive / hidden-DOM copies of the same list → identical row fingerprints; keep one. */
      const deduped = new Map();
      byRoot.forEach((data, root) => {
        const fp = rowContentFingerprint(root);
        const prev = deduped.get(fp);
        if (!prev || data.score > prev.score) deduped.set(fp, data);
      });

      const signedRaw = [];
      deduped.forEach(({ span }) => {
        const s = signedAmountFromSpan(span);
        if (s != null) {
          signedRaw.push(s);
          const symMatch = span.textContent.match(/[^0-9,.\s]+/);
          if (symMatch) symbol = symMatch[0];
        }
      });
      const signedUse = collapseEvenDuplicateAmounts(signedRaw);
      total = signedUse.reduce((a, b) => a + b, 0);
      const parsed = signedUse.length;
      if (!parsed) return;

      state.totals[stateKey].sum = total;
      state.totals[stateKey].symbol = symbol;
      state.totals[stateKey].inFiat = true;
      state.totals[stateKey].displayCurrency = state.settings?.fiatCurrency || 'EUR';
      state.save();
      DashboardUI.update();
    },

    sumTips() {
      const list = document.querySelector('[aria-label*="Tip"]');
      if (!list) return;
      let sent = 0;
      let received = 0;
      let symbol = '€';
      let parsedRows = 0;

      list.querySelectorAll('li').forEach(card => {
        const titleEl = card.querySelector('span.mt-\\[-0\\.2em\\].h-\\[2em\\].truncate');
        const amountSpan = card.querySelector('.text-foreground-highlight-1 span, .text-foreground-primary span');
        if (!amountSpan) return;
        
        const typeText = ((titleEl?.textContent || '') + ' ' + (card.textContent || '')).trim().toLowerCase();
        const amountText = (amountSpan.parentElement?.textContent || amountSpan.textContent || '').trim();
        const sign = amountText.startsWith('-') ? -1 : 1;
        const value = parseFloat(amountSpan.textContent.replace(/[^0-9,.]/g, '').replace(',', ''));
        if (isNaN(value)) return;
        parsedRows++;

        symbol = amountSpan.textContent.match(/[^0-9,.\s]+/)?.[0] || '€';

        if (typeText.includes('receiv')) {
          received += value;
        } else if (typeText.includes('sent')) {
          sent += value;
        } else if (sign < 0) {
          sent += value;
        } else {
          received += value;
        }
      });
      if (parsedRows === 0) return;
      state.totals.tips.received = received;
      state.totals.tips.sent = sent;
      state.totals.tips.symbol = symbol;
      state.totals.tips.tipsInFiat = true;
      state.totals.tips.displayCurrency = state.settings?.fiatCurrency || 'EUR';
      state.save();
      DashboardUI.update();
    }
  };

  function maybeRefreshTotalsForSpa() {
    const path = location.pathname || '';
    if (!path.includes('/account/transactions')) return;
    const now = Date.now();
    if (now - state.lastTotalsFetchAt < TOTALS_REFETCH_MS) return;
    state.lastTotalsFetchAt = now;
    TransactionAPI.calculateTotals();
  }

  let runTimeout = null;
  async function runAll() {
    if (!state.xp) await fetchXPData();
    const settings = state.settings || await fetchPlayerSettings();
    fetchCryptoRates(settings?.fiatCurrency || 'EUR');

    const href = location.href;
    const hrefChanged = href !== state.lastHref;
    if (hrefChanged) state.lastHref = href;

    if (!state.hasInitialFetched) {
      state.hasInitialFetched = true;
      state.lastTotalsFetchAt = Date.now();
      TransactionAPI.calculateTotals();
    } else if (hrefChanged && location.pathname.includes('/account/transactions')) {
      maybeRefreshTotalsForSpa();
    }

    if (runTimeout) clearTimeout(runTimeout);
    runTimeout = setTimeout(() => {
      const url = location.href;
      if (url.includes('transactionType=casino')) {
        CasinoHandler.scheduleRun();
      } else {
        GenericScraper.run();
      }
      DashboardUI.update();
    }, 100);
  }

  function onNavigation() {
    runAll();
  }

  const _pushState = history.pushState;
  history.pushState = function () {
    _pushState.apply(this, arguments);
    queueMicrotask(onNavigation);
  };
  const _replaceState = history.replaceState;
  history.replaceState = function () {
    _replaceState.apply(this, arguments);
    queueMicrotask(onNavigation);
  };
  window.addEventListener('popstate', onNavigation);

  const observer = new MutationObserver((mutations) => {
    const significantChange = mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0);
    if (significantChange) runAll();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  runAll();
})();
