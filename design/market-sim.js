// 도파민 센터 시세 엔진 프로토타입. 시안에서는 브라우저가 돌리고, 본 개발 때 서버(GameLoop)로 옮긴다.
//
// 틱 수익률 r = 시장 요인 × 베타 + 업종 요인 × 업종 베타 + 개별 노이즈 × 변동성 군집
//             + 뉴스 반응(즉시 → 따라붙음 → 과열 되돌림) + 적정가 회귀
//             + RSI 기울기(국면에 따라 역추세/추세) + 지지·저항 + 점프
// 뉴스의 숨은 충격값은 엔진 안에만 있고, 밖으로 내보내는 뉴스 객체에는 없다.
(function () {
  const DEFAULTS = {
    ticksPerBar: 10,        // 시안: 10틱 = 1분봉 하나 (실서버는 60)
    ticksPerDay: 80,        // 게임 하루
    barMs: 60000,
    warmupBars: 720,        // 시작 전 과거 차트
    maxBars: 1500,
    newsGap: [6, 14],       // 뉴스 간격(틱)
    marketSigma: 0.0007,
    sectorSigma: 0.0012,    // 같은 업종끼리 상관 약 0.4~0.5
    kappa: 0.0006,          // 적정가 회귀 강도 (반감기 약 1,150틱)
    rsiPeriod: 14,
    rsiWeight: 0.25,        // RSI 기울기 최대치 = 개별 σ의 25%
    regimeSwitch: 1 / 400,  // 국면 전환 확률(틱당)
    flipChance: 0.15,       // 뉴스 반응이 반대로 나올 확률
    srLookback: 60,         // 전고점·전저점을 볼 봉 수
    srBand: 0.004,          // 지지·저항이 작동하는 거리 (0.4%)
    srWeight: 0.35,         // 지지·저항 기울기 최대치 = 개별 σ의 35%
    gradCap: 8e9,           // 신흥주 → 주식 승격: 검증 성공 1회 이상 + 시총 80억 달러
    gradPER: 15,
    delistPrice: 0.1,       // 신흥주 상장폐지: 가격 $0.10 미만 또는 시총 5천만 달러 미만
    delistCap: 5e7,
  };
  const KIND = {
    stock: {sigma: 0.0012, betaM: 1, betaS: 1, jump: 0},
    coin: {sigma: 0.0025, betaM: 0.6, betaS: 1.8, jump: 0.002},
    venture: {sigma: 0.0035, betaM: 0.5, betaS: 0.8, jump: 0.003},
  };

  function mulberry32(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  function create({assets, sectors, spares = [], seed = 20261021, now = Date.now(), options = {}}) {
    const cfg = {...DEFAULTS, ...options};
    const T = window.NewsTemplates;
    const rand = mulberry32(seed);
    const uni = (a, b) => a + (b - a) * rand();
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    const sign = () => (rand() < 0.5 ? -1 : 1);

    const startTime = Math.floor(now / cfg.barMs) * cfg.barMs - (cfg.warmupBars - 1) * cfg.barMs;
    let tick = 0, nextNewsAt = 3, warm = true;
    const news = [], scheduled = [], marketPending = [], sectorPending = {};
    const venturesBusy = new Set(), sparePool = spares.map(s => ({...s}));
    const state = {};

    function addAsset(def) {
      sectorPending[def.sector] ??= [];
      state[def.sym] = {
        ...def, ...KIND[def.market], def,
        prev: def.price,
        eps: def.market === "stock" ? def.price / def.fairPER : null,
        anchor: def.price,
        shares: def.cap ? def.cap / def.price : null,
        var: 1, regime: rand() < 0.5 ? "range" : "trend",
        pending: [], bars: [], rsi: 50, avgGain: 0, avgLoss: 0, lastClose: def.price,
        hi: null, lo: null, breakBar: -1, volBoost: 0, successes: 0, stage: null,
      };
    }
    assets.forEach(addAsset);
    for (const k in sectors) sectorPending[k] ??= [];

    // ---------- 충격 ----------
    function impulse(list, total, n = Math.round(uni(15, 40)), delay = 0) {
      const w = Array.from({length: n}, (_, i) => Math.exp(-i / (n / 3)));
      const s = w.reduce((a, b) => a + b, 0);
      list.push({total, w: w.map(x => x / s), i: 0, delay});
    }
    function drain(list) {
      let sum = 0;
      for (let j = list.length - 1; j >= 0; j--) {
        const it = list[j];
        if (it.delay > 0) { it.delay--; continue; }
        sum += it.total * it.w[it.i++];
        if (it.i >= it.w.length) list.splice(j, 1);
      }
      return sum;
    }
    // 뉴스 반응 모양: 즉시 45% → 따라붙어 (55% + 과열분) → 과열분만큼 되돌림. 합계는 total.
    function react(list, total) {
      const over = rand() < 0.6 ? uni(0.1, 0.5) : 0;
      impulse(list, total * 0.45, Math.round(uni(3, 8)));
      impulse(list, total * (0.55 + over), Math.round(uni(20, 40)), 3);
      if (over) impulse(list, -total * over, Math.round(uni(30, 60)), Math.round(uni(45, 75)));
    }
    // 의도한 충격 → 실제 반영량 (0.3~1.5배, 가끔 반대)
    const realize = (intended, flip = cfg.flipChance) => intended * uni(0.3, 1.5) * (rand() < flip ? -1 : 1);

    // ---------- 시간 ----------
    const gameDate = (t = tick) => {
      const d = Math.floor(t / cfg.ticksPerDay);
      return {year: Math.floor(d / 360) + 1, month: Math.floor(d % 360 / 30) + 1, day: d % 30 + 1};
    };
    const barTime = (t = tick) => startTime + Math.floor((t - 1) / cfg.ticksPerBar) * cfg.barMs;
    const nid = () => Math.floor(rand() * 2 ** 32).toString(36) + tick.toString(36);
    const capOf = a => (a.shares ? a.shares * a.price : null);

    function publish(n) {
      const item = {id: nid(), tick, at: barTime(Math.max(1, tick)), date: gameDate(), ...n,
        priceAt: Object.fromEntries((n.symbols || []).filter(s => state[s]).map(s => [s, state[s].price]))};
      news.unshift(item);
      if (news.length > 300) news.pop();
      return item;
    }
    const fillOf = a => s => s.replaceAll("{name}", a.name).replaceAll("{sym}", a.sym)
      .replaceAll("{product}", a.product || "주력 제품").replaceAll("{tech}", a.tech || "핵심 기술");

    // ---------- 뉴스 ----------
    function marketNews() {
      const good = rand() < 0.5, tpl = pick(good ? T.market.good : T.market.bad);
      react(marketPending, realize((good ? 1 : -1) * uni(0.004, 0.012)));
      return publish({kind: "시장", headline: tpl.h, body: tpl.b, symbols: []});
    }
    function sectorNews() {
      const members = key => Object.values(state).filter(a => a.sector === key).map(a => a.sym);
      const key = pick(Object.keys(sectors).filter(k => k !== "venture" && members(k).length)), name = sectors[key];
      const good = rand() < 0.5, tpl = pick(good ? T.sector.good : T.sector.bad);
      react(sectorPending[key], realize((good ? 1 : -1) * uni(0.006, 0.02)));
      return publish({kind: "업종", sector: key, headline: `${name} 업종 · ${tpl.h}`, body: tpl.b.replaceAll("{sector}", name), symbols: members(key)});
    }
    function companyNews() {
      const a = pick(Object.values(state).filter(x => x.market !== "venture"));
      const good = rand() < 0.5, src = a.market === "coin" ? T.coin : T.company, tpl = pick(good ? src.good : src.bad);
      react(a.pending, realize((good ? 1 : -1) * (a.market === "coin" ? uni(0.02, 0.06) : uni(0.01, 0.04))));
      if (tpl.eps && a.eps) a.eps *= 1 + (good ? 1 : -1) * uni(0.02, 0.08); // 실적·가이던스 → 적정가 이동
      const fill = fillOf(a);
      return publish({kind: a.market === "coin" ? "코인" : "기업", headline: `${a.name} · ${fill(tpl.h)}`, body: fill(tpl.b), symbols: [a.sym]});
    }
    // 신흥주 3단계 검증: 최초 주장 → 재현 시험 → 성공/실패
    function ventureEvent() {
      const free = Object.values(state).filter(a => a.market === "venture" && !venturesBusy.has(a.sym));
      if (!free.length) return companyNews();
      const a = pick(free), success = rand() < 0.5, eventId = nid(), fill = fillOf(a);
      venturesBusy.add(a.sym);
      const stage = (i, tpl) => publish({kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(tpl.h)}`, body: fill(tpl.b), symbols: [a.sym],
        event: {id: eventId, index: i, total: 3, label: ["최초 보도", "추가 확인", success ? "확인" : "정정"][i]}});
      react(a.pending, realize(uni(0.05, 0.15)));
      a.stage = "기술검증";
      const first = stage(0, T.venture[0]);
      const t1 = tick + Math.round(uni(25, 50)), t2 = t1 + Math.round(uni(25, 50));
      scheduled.push({at: t1, run: () => { if (!state[a.sym]) return; react(a.pending, realize(sign() * uni(0, 0.05))); stage(1, T.venture[1]); }});
      scheduled.push({at: t2, run: () => {
        venturesBusy.delete(a.sym);
        if (!state[a.sym]) return;
        // 결과는 로그 기준 대칭: 성공 +35%~+120%, 실패 -33%~-63%. 적정가(앵커)도 같은 만큼 이동
        const move = success ? uni(0.3, 0.8) : -uni(0.4, 1.0);
        a.anchor *= Math.exp(move);
        react(a.pending, move);
        if (success) a.successes++;
        a.stage = success ? "매출검증" : "상장유지심사";
        stage(2, T.venture[success ? 2 : 3]);
      }});
      return first;
    }
    function noiseNews() {
      const tpl = pick(T.noise);
      return publish({kind: "잡담", headline: tpl.h, body: tpl.b, symbols: []});
    }
    function makeNews() {
      const r = rand();
      // 과거 차트 구간 앞 80%에서는 신흥주 검증을 생략해 시작가 맞추기(rebase) 때 비율이 극단적이지 않게
      const ventureOk = !warm || tick > cfg.warmupBars * cfg.ticksPerBar * 0.8;
      return r < 0.15 ? marketNews() : r < 0.40 ? sectorNews() : r < 0.83 ? companyNews() : r < 0.90 && ventureOk ? ventureEvent() : noiseNews();
    }

    // ---------- 신흥주 승격 · 상장폐지 · 신규 상장 ----------
    function graduate(a) {
      const fill = fillOf(a);
      Object.assign(a, KIND.stock, {market: "stock", sector: "newgrowth", sigma: 0.0016, fairPER: cfg.gradPER, eps: a.price / cfg.gradPER, stage: null});
      sectorPending.newgrowth ??= [];
      publish({kind: "기업", headline: `${a.name}(${a.sym}) · ${fill(T.listing.graduate.h)}`, body: fill(T.listing.graduate.b), symbols: [a.sym]});
      scheduled.push({at: tick + Math.round(uni(40, 80)), run: listNew}); // 신흥주 자리 채우기
    }
    function delist(a) {
      const fill = fillOf(a);
      publish({kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(T.listing.delist.h)}`, body: fill(T.listing.delist.b), symbols: [a.sym], delisted: true});
      delete state[a.sym];
      sparePool.push(a.def); // 나중에 재상장 후보로
      scheduled.push({at: tick + Math.round(uni(40, 80)), run: listNew});
    }
    function listNew() {
      const i = sparePool.findIndex(d => !state[d.sym]); if (i < 0) return;
      const [d] = sparePool.splice(i, 1), price = Math.round(uni(2, 10) * 100) / 100;
      addAsset({...d, market: "venture", sector: "venture", price, cap: price * Math.round(uni(5e7, 2e8))});
      const a = state[d.sym], fill = fillOf(a);
      a.bars.push({timestamp: barTime(), open: price, high: price, low: price, close: price, volume: 0});
      publish({kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(T.listing.ipo.h)}`, body: fill(T.listing.ipo.b), symbols: [a.sym]});
    }
    function reviewListings() {
      for (const a of Object.values(state)) {
        if (a.market !== "venture" || venturesBusy.has(a.sym)) continue;
        if (a.successes >= 1 && capOf(a) >= cfg.gradCap) graduate(a);
        else if (a.price < cfg.delistPrice || capOf(a) < cfg.delistCap) delist(a);
      }
    }

    // ---------- 가격 ----------
    function updateBarStats(a) {
      const ch = a.price - a.lastClose, p = cfg.rsiPeriod;
      a.avgGain = (a.avgGain * (p - 1) + Math.max(ch, 0)) / p;
      a.avgLoss = (a.avgLoss * (p - 1) + Math.max(-ch, 0)) / p;
      a.rsi = a.avgLoss === 0 ? 100 : 100 - 100 / (1 + a.avgGain / a.avgLoss);
      a.lastClose = a.price;
      const recent = a.bars.slice(-cfg.srLookback);
      if (recent.length >= 20) { a.hi = Math.max(...recent.map(b => b.high)); a.lo = Math.min(...recent.map(b => b.low)); }
    }
    // 전고점·전저점·라운드 넘버 근처에서 머뭇거림. 위에 있는 선은 저항(아래로), 아래 선은 지지(위로)
    function srTilt(a) {
      const step = 10 ** Math.floor(Math.log10(a.price)) / 2;
      const levels = [a.hi, a.lo, Math.ceil(a.price / step) * step, Math.floor(a.price / step) * step];
      let t = 0;
      for (const L of levels) {
        if (!L) continue;
        const d = Math.log(L / a.price);
        if (d > 0 && d < cfg.srBand) t -= 1 - d / cfg.srBand;
        else if (d < 0 && -d < cfg.srBand) t += 1 + d / cfg.srBand;
      }
      return Math.max(-1, Math.min(1, t)) * cfg.srWeight * a.sigma;
    }
    // 전고점 돌파·전저점 이탈: 거래량 급증 + 같은 방향으로 한 번 더 밀어줌 (봉당 1회)
    function checkBreak(a, before, barIndex) {
      if (!a.hi || a.breakBar === barIndex) return;
      const up = before <= a.hi && a.price > a.hi * (1 + cfg.srBand / 2);
      const down = before >= a.lo && a.price < a.lo * (1 - cfg.srBand / 2);
      if (!up && !down) return;
      react(a.pending, (up ? 1 : -1) * a.sigma * uni(4, 9));
      a.volBoost = 10; a.breakBar = barIndex;
    }

    function step() {
      tick++;
      const published = [], before = news.length ? news[0].id : null;
      for (let j = scheduled.length - 1; j >= 0; j--) if (scheduled[j].at <= tick) { const s = scheduled.splice(j, 1)[0]; s.run(); }
      if (tick >= nextNewsAt) { makeNews(); nextNewsAt = tick + Math.round(uni(...cfg.newsGap)); }

      const m = gauss() * cfg.marketSigma + drain(marketPending);
      const sec = {};
      for (const k in sectorPending) sec[k] = gauss() * cfg.sectorSigma + drain(sectorPending[k]);
      const barIndex = Math.floor((tick - 1) / cfg.ticksPerBar);
      const barStart = (tick - 1) % cfg.ticksPerBar === 0, barEnd = tick % cfg.ticksPerBar === 0;

      for (const a of Object.values(state)) {
        if (rand() < cfg.regimeSwitch) a.regime = a.regime === "range" ? "trend" : "range";
        const fair = a.eps ? a.eps * a.fairPER : a.anchor;
        const pull = -cfg.kappa * (a.market === "coin" ? 0.3 : 1) * Math.log(a.price / fair);
        // 박스권: 과매수면 하락 쪽으로, 추세장: 강한 쪽으로 약하게
        const rsiTilt = (a.rsi - 50) / 50 * cfg.rsiWeight * a.sigma * (a.regime === "range" ? -1 : 0.5);
        const shock = drain(a.pending);
        const noise = gauss() * a.sigma * Math.sqrt(a.var);
        let r = a.betaM * m + a.betaS * (sec[a.sector] || 0) + noise + pull + rsiTilt + srTilt(a) + shock;
        if (a.jump && rand() < a.jump) r += gauss() * a.sigma * 6;
        const open = a.price;
        a.price = Math.max(0.01, a.price * Math.exp(r));
        const z = noise / a.sigma;
        a.var = Math.min(4, Math.max(0.5, 0.97 * a.var + 0.03 * (z * z + (shock / a.sigma) ** 2)));
        checkBreak(a, open, barIndex);

        const vol = Math.round(uni(40, 160) * (1 + Math.abs(r) / a.sigma) * (a.volBoost-- > 0 ? 3 : 1));
        if (barStart || !a.bars.length) {
          a.bars.push({timestamp: barTime(), open, high: Math.max(open, a.price), low: Math.min(open, a.price), close: a.price, volume: vol});
          if (a.bars.length > cfg.maxBars) a.bars.splice(0, a.bars.length - cfg.maxBars);
        } else {
          const b = a.bars[a.bars.length - 1];
          b.high = Math.max(b.high, a.price); b.low = Math.min(b.low, a.price); b.close = a.price; b.volume += vol;
        }
        if (barEnd) updateBarStats(a);
      }
      if (tick % cfg.ticksPerDay === 0) {
        for (const a of Object.values(state)) a.prev = a.price;
        if (!warm) reviewListings();
      }
      for (const n of news) { if (n.id === before) break; published.push(n); }
      return {news: published, barClosed: barEnd};
    }

    // 시작 가격 맞추기: 과거 차트를 먼저 만든 뒤 전체를 비율로 늘이거나 줄여 마지막 가격 = 설정한 시작가.
    // 그리고 시작가를 적정가로 다시 잡는다 (주식 EPS = 가격 / 적정 PER, 그 외 앵커 = 가격).
    function rebase() {
      for (const a of Object.values(state)) {
        const k = a.def.price / a.price;
        for (const b of a.bars) { b.open *= k; b.high *= k; b.low *= k; b.close *= k; }
        for (const key of ["price", "prev", "lastClose", "avgGain", "avgLoss", "hi", "lo"]) if (a[key] != null) a[key] *= k;
        for (const n of news) if (n.priceAt[a.sym]) n.priceAt[a.sym] *= k;
        if (a.market === "stock") a.eps = a.price / a.fairPER; else a.anchor = a.price;
        a.successes = 0;
        if (!venturesBusy.has(a.sym)) a.stage = null;
      }
      warm = false;
    }

    for (let i = 0; i < cfg.warmupBars * cfg.ticksPerBar; i++) step();
    rebase();

    return {
      cfg, state, news, step, gameDate,
      get tick() { return tick; },
      bars: sym => state[sym]?.bars || [],
      per: sym => (state[sym]?.eps ? state[sym].price / state[sym].eps : null),
      cap: sym => (state[sym] ? capOf(state[sym]) : null),
    };
  }

  window.MarketSim = {create};
})();
