/* ============================================================================
   Nadelio Home v5 - vanilla port of the Fable "DC" component.
   No framework, no build, no external request. Reproduces, faithfully:
     - state / renderVals() / re-render model (was DCLogic + {{ }} bindings)
     - <sc-for> / <sc-if> semantics (list repetition / conditional render)
     - the three.js instrument (initScene/buildClusters/frame/resize/...)
     - the focus guard loop, the reveal schedule, the live pass counter
     - the scale/range/presence tooltips (open on hover + focus + tap,
       close on leave / blur / Escape / outside tap, anti-overflow positioning)
     - the transparency drawer (12 named AIs, per-question x per-AI grid)
   v5 recomposition (vs v4): the VERDICT is now the hero - a giant Archivo
   Black headline (min(6.4vh,...)) with its sub-phrase, revealed last as the
   climax. The 3D instrument, the "part de voix" share bar and the confidence
   brackets serve it as proof. The bottom dock went from 4 cards to 3
   (questions, presence, action) via repeat(3,1fr). The live log is gone;
   the "comment on mesure" block is static copy.
   Palette: brass #C6A15B, sage #93A06E, terracotta #B57C5D / #AE7A64.
   v6 lift (owner: "un poil trop sombre"): ground, card, hairlines and the
   muted ramp were each raised one notch (was ground #14100C / card #171310)
   while every text token stayed >=4.5:1 against its real background (large
   bold display text >=3:1), recomputed with the real relative-luminance
   formula, worst case (card #231D18) noted below:
   #958772 (was #8A7D68) 4.75:1 on card, 4.9:1 on ground - smallest data
   labels (axis ticks, field column headers);
   #A39784 (was #9A8D78) 5.81:1 on card, 5.99:1 on ground - every section
   label/eyebrow;
   #B2A694 (was #A99C88) 6.96:1 on card, 7.18:1 on ground - secondary body
   copy (verdict sub-text, drawer footnote);
   #AE7A64 (was #A66F57) 4.58:1 on card, 4.72:1 on ground - sienna "absent"
   state, small text;
   #B57C5D (was #B07452) 4.77:1 on card, 4.91:1 on ground - sienna on the big
   Archivo Black figures (only needs 3:1, still cleared 4.5:1).
   Ground #211A14 (was #14100C), card #231D18 (was #171310), hairline border
   #362E24 (was #2A241C), input/card border #463B30 (was #3A3128), link
   underline #564D3C (was #4A4234). Ink #E8DFD2, brass #C6A15B and sage
   #93A06E were left untouched: already 12-14:1 / 6.9-7.1:1 / 6.0-6.1:1 on
   the new ground/card, comfortably clear as accents.
   density and breath were editor sliders; in production they are constants = 1.
   three.js is provided by window.THREE (self-hosted vendor script).
   ============================================================================ */
(function () {
  'use strict';

  /* ---------- constants (copied verbatim from the source) ---------- */
  var ZLO = 0, ZHI = 100;
  var BRASS = '#C6A15B', SAGE = '#93A06E', SIENNA = '#B57C5D', INK = '#D8CDBB';
  var SUPPORT_EMAIL = 'adam.chabbi94@gmail.com';

  /* Example quick-picks: REAL brands. The chips no longer replay demo data,
     they run a real audit through the backend, exactly like a typed brand. */
  var EXAMPLES = ['Qonto', 'Pennylane', 'Alan'];

  /* ============================================================================
     i18n (whole page, chrome + every JS-built string)
     ============================================================================
     v2 was FR authored end to end (markup AND every dynamic string built in
     this file). The rest of the site (index.html) is EN authored with a FR
     dictionary applied at runtime, detected the same way: ?lang=fr forces
     French, ?lang=en forces English, otherwise navigator.language decides,
     English is the default. This page must behave identically for a visitor:
     an English visitor gets English, a French visitor gets French, ?lang=
     forces either - regardless of which language the brand being audited
     happens to trade in. (index.html's result screen additionally mixes in
     the audited brand's own language via isFR(d)/_curFR, because that page
     interleaves one persistent English chrome with many independent per-brand
     audits over time. v2 has no such split: the chrome and the result screen
     are the same continuous instrument built by this one script, so mixing
     languages mid-page would read as broken, not intentional. One flag -
     PAGE_FR - drives the whole page here.)
     Implementation: v2.html markup stays FR authored (unchanged visually,
     data-i18n/-html/-aria/-ph attributes added for applyChromeLang() to swap
     in the EN dictionary below when the visitor is NOT French). Every dynamic
     string this file builds (verdict, cards, insight, drawer, dossier, errors,
     the downloadable HTML file) is wrapped in T(en, fr), same helper and
     argument order as index.html's, EN first because English is the site's
     default language. */
  function pageLang() {
    try {
      var p = new URLSearchParams(window.location.search).get('lang');
      if (p === 'fr') return 'fr';
      if (p === 'en') return 'en';
    } catch (e) {}
    return /^fr/i.test(navigator.language || navigator.userLanguage || '') ? 'fr' : 'en';
  }
  var PAGE_FR = (pageLang() === 'fr');
  /* Tiny chrome translator for JS-built strings, identical contract to
     index.html's T(en,fr): English unless the visitor is French. */
  function T(en, fr) { return PAGE_FR ? fr : en; }

  /* EN dictionary for the static chrome (v2.html markup is FR authored, so
     unlike index.html's SITE_FR this dictionary is only applied when the
     visitor is NOT French). Keys map 1:1 to the data-i18n* attributes added
     to v2.html. */
  var SITE_EN = {
    badge: 'Google + AI, bounded measurement',
    transp: 'transparency ›',
    eyebrow: 'AI visibility audit',
    h1: 'AI answers your customers. Are you in the answer?',
    measureCue: 'measure >',
    inputAria: 'brand name to measure',
    runBtn: 'Run an audit',
    or: 'or',
    howWeMeasure: 'how we measure',
    howWeMeasureBody: 'We ask your questions to Google and to one AI, several times each. The answers vary a little, so we give an interval rather than one exact number.',
    cloudConverges: 'the cloud converges',
    readingInProgress: 'reading in progress',
    verdictLabel: 'verdict',
    gapThatMatters: 'the gap that matters',
    scaleAria: 'measurement scale, learn more',
    idToggle: 'identity & market ›',
    idUrlPh: 'Official website (locks the exact company)',
    idUrlAria: 'brand official website',
    idMarketLabel: 'market',
    idMarketAria: 'market measured',
    idMarketAuto: 'Auto',
    idUpdateBtn: 'Update',
    footSupport: 'Contact support',
    footWhy: 'Why Nadelio?',
    footHow: 'How we measure',
    footPay: 'Pay on results',
    footRoadmap: 'Roadmap',
    footLegal: 'Legal and terms'
  };
  /* Localizes the static chrome (markup already in the DOM, never re-created
     by this script). Called once, first thing in init(), before the first
     render() - so there is no visible flash for an English visitor. */
  function applyChromeLang() {
    document.documentElement.setAttribute('lang', PAGE_FR ? 'fr' : 'en');
    if (PAGE_FR) return; // French is the authored default markup, nothing to swap
    var nodes = document.querySelectorAll('[data-i18n],[data-i18n-html],[data-i18n-aria],[data-i18n-ph]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var kt = el.getAttribute('data-i18n');
      if (kt && SITE_EN[kt] != null) el.textContent = SITE_EN[kt];
      var kh = el.getAttribute('data-i18n-html');
      if (kh && SITE_EN[kh] != null) el.innerHTML = SITE_EN[kh];
      var ka = el.getAttribute('data-i18n-aria');
      if (ka && SITE_EN[ka] != null) el.setAttribute('aria-label', SITE_EN[ka]);
      var kp = el.getAttribute('data-i18n-ph');
      if (kp && SITE_EN[kp] != null) el.setAttribute('placeholder', SITE_EN[kp]);
    }
  }

  var TIP_TEXT = {
    scale: T(
      'The real scale runs 0 to 100. We zoom into the useful band to make the gap readable, so the gap looks bigger than it is on the full 100. The numbers and the proportions stay exact, the axis always shows its zoom window.',
      'L\'échelle réelle va de 0 à 100. On zoome sur la zone utile pour rendre l\'écart lisible : l\'écart parait donc plus grand qu\'il ne l\'est sur 100. Les chiffres et les proportions restent exacts, l\'axe indique toujours sa fenêtre de zoom.'
    ),
    range: T(
      'The real score sits in this interval 95 times out of 100. The narrower it is, the surer the measurement.',
      'Le vrai score se trouve dans cette fourchette 95 fois sur 100. Plus elle est étroite, plus la mesure est sûre.'
    ),
    presence: T(
      'How many of your questions the brand shows up in. Absent from one question, it is invisible to everyone who asks it.',
      'Dans combien de vos questions la marque ressort. Absente d\'une question, elle est invisible pour tous ceux qui la posent.'
    )
  };

  /* The single REAL result the whole view renders from. null = idle / measuring
     (nothing measured yet). buildResult(d) fills it from the /api/analyze body. */
  var currentResult = null;

  /* Empty card content used at idle / during measuring (the dock cards are held
     at opacity 0 then, so this is never actually read by a human). */
  var BLANK_CARD = {
    verdictTitle: '', verdictColor: '#93A06E', verdictText: '',
    ia: { big: '', bigColor: '#A39784', line: '', rival: '' },
    google: { big: '', bigColor: '#A39784', line: '', owners: '' },
    deep: { free: '', adds: '', delivered: false }
  };

  /* density and breath were editor sliders -> constants = 1 in production */
  var props = { density: 1, breath: 1 };

  /* Boot IDLE (not measuring, not settled): the page never auto-runs an audit,
     because every real audit costs money. The user triggers it (run button,
     Enter, or an example chip). focus/inputValue seed the input with an example. */
  var state = {
    focus: 'Qonto', measuring: false, settled: false,
    unknownMsg: '', inputValue: 'Qonto', passCount: 0,
    /* elapsedS: real, honest elapsed-seconds counter shown next to "mesure en
       cours" (see startMeasureTick). A real audit takes 30-60s; before this
       the only feedback during that wait was the 3D cloud's breathing, which
       is OFF entirely under prefers-reduced-motion (frame()/startLoop() never
       run - see `reduced`), leaving those visitors with a static screen and
       no sense that anything was happening. Ticking wall-clock seconds is
       real feedback, never a fabricated progress percentage. */
    elapsedS: 0,
    tip: { open: false }, drawerOpen: false,
    /* payError: a Stripe return (?paid) failed to verify or to run. Forces the
       "lecture en cours" overlay to stay up (like measuring) but with its own
       message + retry, and keeps the passcounter honest ("paiement", not
       "mesure en cours"). Cleared the moment a normal measurement starts. */
    payError: false
  };

  /* ---------- DOM refs (persistent nodes, never re-created) ---------- */
  var screenEl, mountEl, axisEl, axisAreaEl, inputEl, regionEl, overlayEl,
      verdictEl, verdictTitleEl, verdictTextEl, verdictBrandEl, verdictStaleEl,
      insightEl, insightTextEl, fieldEl, ticksEl, scaleLabelEl,
      passCounterEl, unknownEl, runBtn, brandsHost, transpBtn, cardEls = [],
      subBannerEl, belowEl, deepDocEl, shareEl,
      /* identity + market control (resolver moat, see runReal/renderIdentity) */
      identityEl, idToggleBtn, idPanelEl, officialUrlEl, marketSelectEl, idUpdateBtn;
  /* the overlay's original "le nuage converge / lecture en cours" markup,
     captured once at init so the Stripe-return paid flow (which borrows this
     same node) can hand it back exactly as it found it. */
  var defaultOverlayHTML = '';

  /* ---------- three.js state ---------- */
  var renderer, scene, camera, group, sprite, material, points,
      targets, dirs, meta, ro, rafId, pollIv, measureStart, reduced, resizeDebounceT;
  /* targetsBase / baseColors: pristine copies of targets/colA taken right
     after buildClusters allocates them - the restore point setClusterHighlight
     / clearClusterHighlight mutate back to, and (for targetsBase) the anchor
     a hovered cluster's particles are dilated outward from. clusterRanges maps
     a brand name -> {start,count,cx,cy} in the flat particle buffers, built in
     buildClusters's 'result' branch. sceneMode ('dormant' | 'measuring' |
     'result') is what frame() reads every tick to pick the right animation -
     it is derived fresh on every buildClusters call, never set elsewhere. */
  var targetsBase, baseColors, clusterRanges = null, sceneMode = 'dormant';

  /* ---------- lifecycle / focus / reveal / log state ---------- */
  var revealT, logIv, focusArmed, focusOutHandler, userInteracted,
      visHandler, interactHandler, keyHandler,
      tipOverH, tipOutH, tipFocusInH, tipFocusOutH, tipClickH, hoverTipEl = null;
  /* ---------- cloud <-> field hover (settled only, one-directional) ---------- */
  var fieldOverH, fieldOutH, fieldHoverEl = null, hoverBrand = null;

  /* ---------- tracked dynamic node lists (for surgical re-render) ---------- */
  var axisBrandNodes = [], brandBtnNodes = [], lastChipFocus = null, lastContentSig = null;
  var lastTicksSig = null;

  /* ---------- real-audit control (async flow) ---------- */
  var measureGen = 0;                 /* guards against overlapping runs */
  var slowNoteEl = null, slowNoteT = null;   /* "instrument waking" note (>8s) */
  var MIN_LOAD_MS = 1200;             /* minimum loading display so the animation reads */
  /* Whether the visitor has explicitly confirmed the identified entity for the
     CURRENT result. Reset to false every time a new measurement starts; a paid
     checkout on a low-confidence identification is blocked until this is true
     (see startCheckout / showIdentityConfirm). */
  var identityConfirmed = false;

  /* A paid deep audit is single-use and takes 30-60s. If the tab is closed or
     reloaded mid-run, the ?paid= URL is already scrubbed (see resumeDeepAudit),
     so without this the session id would be unrecoverable even though Stripe
     still shows it unconsumed. Persisted to sessionStorage (survives a reload,
     not a new tab) and cleared only once the deep dossier actually renders or
     the session is confirmed already spent. */
  var PENDING_DEEP_KEY = 'ndl_pending_deep';
  function savePendingDeep(sessionId, brand) {
    try { sessionStorage.setItem(PENDING_DEEP_KEY, JSON.stringify({ sessionId: sessionId, brand: brand || '' })); } catch (e) {}
  }
  function readPendingDeep() {
    try {
      var raw = sessionStorage.getItem(PENDING_DEEP_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && o.sessionId) ? o : null;
    } catch (e) { return null; }
  }
  function clearPendingDeep() {
    try { sessionStorage.removeItem(PENDING_DEEP_KEY); } catch (e) {}
  }

  /* ---------- tooltip / drawer nodes ---------- */
  var tipEl = null, lastTipSig = '';
  var drawerScrim = null, drawerDialog = null, drawerCloseBtn = null, lastDrawerOpen = false;
  /* the element that had focus right before the drawer opened (usually the
     "transparence" link) - aria-modal="true" alone does not trap focus or
     restore it; both are done by hand below (buildDrawer/teardownDrawer). */
  var preDrawerFocusEl = null, drawerTrapHandler = null;

  /* ============================ helpers ============================ */
  /* Escapes ALL five HTML-significant characters, because the output is used
     in BOTH text nodes and double-quoted HTML attributes (title=, href=) built
     by string concatenation. Escaping only & < > left a reflected-XSS hole via
     ?brand= for any attribute site (a brand name containing a double quote
     broke out of title="..."). */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- first-party funnel events ----------------
     Same contract as index.html: POST /api/event with an ALLOWLISTED name.
     app.py's _EVENT_ALLOWLIST rejects anything else with a 400, so the map
     below is the whole permitted vocabulary and nothing dynamic is ever sent.
     sendBeacon so the event survives the Stripe redirect; fetch keepalive as
     the fallback. Fail-open and silent: analytics must never break the page
     or block a measurement. This is separate from /assets/v2/track.js, which
     is the generic click tracker posting to /api/track. */
  var EVENT_ALLOWED = {
    input_submitted: 1, result_seen: 1, sample_seen: 1, plan_shown: 1,
    deep_click: 1, monitor_click: 1, checkout_started: 1
  };
  function track(name, extra) {
    try {
      if (!EVENT_ALLOWED[name]) return;
      /* An explicit brand wins: at input_submitted time currentResult still
         holds the PREVIOUS audit, so attributing the event to it would credit
         the wrong company. */
      var brand = (extra && extra.brand) ? String(extra.brand) : '';
      if (!brand) {
        try { brand = String((currentResult && currentResult.focusName) || (state && state.inputValue) || ''); } catch (e) {}
      }
      var payload = { name: name, brand: brand.slice(0, 120) };
      var mk = '';
      try { mk = String((currentResult && currentResult.market) || ''); } catch (e) {}
      if (mk) payload.market = mk.slice(0, 60);
      if (extra && extra.tier) payload.tier = String(extra.tier).slice(0, 40);
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/event', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: body, keepalive: true
        }).catch(function () {});
      }
    } catch (e) {}
  }
  /* Only ever emit http(s) links built from backend-supplied strings (SERP /
     evidence sources are third-party content Nadelio did not author) - never a
     javascript: or data: URL. Returns '' (renders no link) for anything else. */
  function safeHttpUrl(u) {
    var s = String(u || '').trim();
    return (/^https?:\/\//i).test(s) ? s : '';
  }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5); }

  /* Reads a fetch Response as TEXT first, then JSON.parses it, keeping the
     verbatim text alongside the parsed body. /api/share requires the EXACT
     raw text of a live /api/analyze response (a JS re-stringify would
     reformat floats and reorder keys, and the server verifies its signature
     over a canonical re-serialization of whatever we send it back - any
     drift there is a false "invalid signature", not a security hole, but it
     would silently break sharing). Used for both runReal and runDeepMeasure's
     /api/analyze call so the raw text is always available on a settled
     result (see buildResult callers attaching it to currentResult.raw). */
  function readJsonWithRaw(res) {
    return res.text().then(function (t) {
      var body;
      try { body = JSON.parse(t); } catch (e) { body = {}; }
      return { ok: res.ok, status: res.status, body: body, raw: t };
    });
  }

  /* ---------- adaptive measurement window ----------
     The projection window [ZLO,ZHI] is recomputed per render from the bracketed
     brands (focus + rival). Two close scores (78 vs 73) would be crushed on a
     fixed 0..100 axis; zooming to the useful band makes the real gap legible
     WITHOUT magnifying it (positions/distances stay exact). Idle -> 0..100. */
  function computeWindow(R) {
    if (!R || !R.rows || !R.rows.length) return { lo: 0, hi: 100 };
    var lows = [], highs = [];
    R.rows.forEach(function (r) { lows.push(r.s - r.m); highs.push(r.s + r.m); });
    var dataLo = Math.min.apply(null, lows), dataHi = Math.max.apply(null, highs);
    var margin = Math.max(8, dataHi - dataLo);
    var lo = Math.max(0, Math.floor((dataLo - margin) / 5) * 5);
    var hi = Math.min(100, Math.ceil((dataHi + margin) / 5) * 5);
    /* minimum span 25: expand symmetrically, clamp to [0,100], keep round */
    if (hi - lo < 25) {
      var need = 25 - (hi - lo);
      lo -= need / 2; hi += need / 2;
      if (lo < 0) { hi += -lo; lo = 0; }
      if (hi > 100) { lo -= (hi - 100); hi = 100; }
      lo = Math.max(0, Math.floor(lo / 5) * 5);
      hi = Math.min(100, Math.ceil(hi / 5) * 5);
    }
    return { lo: lo, hi: hi };
  }
  /* set the module projection knobs from the current result (used by brackets,
     region band, tick labels AND the 3D cluster projection, so all stay aligned) */
  function applyWindow() {
    var w = computeWindow(currentResult);
    ZLO = w.lo; ZHI = w.hi;
    return w;
  }
  /* pick a round tick step (multiple of 5/10/25/50) yielding 4..6 labels */
  function tickStep(span) {
    var cands = [5, 10, 25, 50];
    for (var i = 0; i < cands.length; i++) {
      if (Math.floor(span / cands[i]) + 1 <= 6) return cands[i];
    }
    return 50;
  }
  /* trim a SERP host for compact display (drop a leading www.) */
  function shortHost(h) { return String(h || '').replace(/^www\./, ''); }

  /* ============================ refs (was ref="{{ ... }}") ============================ */
  function mountRef(el) { mountEl = el; }
  function inputRef(el) {
    inputEl = el;
    if (el && !userInteracted) { el.focus({ preventScroll: true }); armFocusLoop(); }
  }
  function axisRef(el) { axisEl = el; }

  function armFocusLoop() {
    if (focusArmed) return;
    focusArmed = true;
    var attempt = function () {
      if (userInteracted || state.drawerOpen || !inputEl) return;
      if (document.activeElement === document.body || document.activeElement === null) inputEl.focus({ preventScroll: true });
    };
    focusOutHandler = function (e) {
      if (userInteracted || state.drawerOpen) return;
      if (!e.relatedTarget || e.relatedTarget === document.body) requestAnimationFrame(attempt);
    };
    document.addEventListener('focusout', focusOutHandler);
    window.addEventListener('load', attempt, { once: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(attempt);
  }

  /* ============================ lifecycle ============================ */
  function componentDidMount() {
    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    measureStart = performance.now();
    /* No auto-run: the page boots idle. The reveal is triggered by a real audit
       (run button / Enter / example chip), and driven by DATA ARRIVAL, not a timer. */
    var tryFocus = function () {
      if (inputEl && (document.activeElement === document.body || document.activeElement === null)) inputEl.focus({ preventScroll: true });
    };
    tryFocus();
    var tries = 0;
    pollIv = setInterval(function () {
      if (window.THREE && mountEl && axisEl) { clearInterval(pollIv); initScene(); }
      else if (++tries > 120) { clearInterval(pollIv); }
    }, 50);
    visHandler = function () { if (document.hidden) stopLoop(); else startLoop(); };
    document.addEventListener('visibilitychange', visHandler);
    interactHandler = function (ev) {
      if (ev.isTrusted) userInteracted = true;
      if (state.tip.open && state.tip.pinned) {
        var t = ev.target;
        if (!(t && t.closest && (t.closest('[data-tip]') || t.closest('[role=tooltip]')))) closeTip(true);
      }
    };
    document.addEventListener('pointerdown', interactHandler, true);
    document.addEventListener('wheel', interactHandler, { capture: true, passive: true });
    keyHandler = function (e) {
      /* The auto-refocus loop (armFocusLoop/componentDidUpdate) only ever
         disarmed on pointerdown/wheel (see interactHandler), so a keyboard-
         only visitor tabbing through the page (transparence link, dock
         links...) kept getting yanked back into the brand input every time
         focus briefly landed on <body>. Any real keydown is just as much a
         sign of active use as a click. */
      if (e.isTrusted) userInteracted = true;
      if (e.key === 'Escape') { if (state.drawerOpen) closeDrawer(); if (state.tip.open) closeTip(true); }
    };
    document.addEventListener('keydown', keyHandler);

    /* tooltip triggers - event delegation reproduces the DC per-element
       onMouseEnter/onMouseLeave/onFocus/onBlur/onClick bindings, which is
       required because [data-tip] nodes (range, presence) are re-rendered. */
    tipOverH = function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (el && el !== hoverTipEl) { hoverTipEl = el; openTip(el, false); }
    };
    tipOutH = function (e) {
      if (!hoverTipEl) return;
      var to = e.relatedTarget;
      if (to && hoverTipEl.contains && hoverTipEl.contains(to)) return;
      hoverTipEl = null;
      closeTip(false);
    };
    tipFocusInH = function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (el) openTip(el, false);
    };
    tipFocusOutH = function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (el) closeTip(false);
    };
    tipClickH = function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!el) return;
      e.preventDefault();
      var id = el.getAttribute('data-tip');
      if (state.tip.open && state.tip.pinned && state.tip.id === id) closeTip(true);
      else openTip(el, true);
    };
    document.addEventListener('mouseover', tipOverH);
    document.addEventListener('mouseout', tipOutH);
    document.addEventListener('focusin', tipFocusInH);
    document.addEventListener('focusout', tipFocusOutH);
    document.addEventListener('click', tipClickH);

    /* cloud <-> field hover - one directional (field row -> cluster), same
       delegation pattern as the tooltip triggers above (the rows are rebuilt
       on every new settled result, see renderField). Only ever matches while
       #ndl-field actually has rows (settled), so this is a no-op at idle,
       while measuring, and on error. */
    fieldOverH = function (e) {
      var el = e.target.closest ? e.target.closest('.ndl-field-row') : null;
      if (el && el !== fieldHoverEl) { fieldHoverEl = el; setClusterHighlight(el.getAttribute('data-brand') || ''); }
    };
    fieldOutH = function (e) {
      if (!fieldHoverEl) return;
      var to = e.relatedTarget;
      if (to && fieldHoverEl.contains && fieldHoverEl.contains(to)) return;
      fieldHoverEl = null;
      clearClusterHighlight();
    };
    document.addEventListener('mouseover', fieldOverH);
    document.addEventListener('mouseout', fieldOutH);
  }

  function componentDidUpdate(prevProps, prevState) {
    if (prevProps && prevProps.density !== props.density) {
      if (scene) buildClusters(clusterRows(), false, clusterFocus());
    }
    if (prevState && !prevState.settled && state.settled && !userInteracted && !state.drawerOpen && inputEl && (document.activeElement === document.body || document.activeElement === null)) {
      inputEl.focus({ preventScroll: true });
    }
  }

  /* kept for fidelity; the page never unmounts the component in production */
  function componentWillUnmount() {
    stopLoop(); clearInterval(pollIv); clearTimeout(revealT); clearInterval(logIv);
    stopMeasureTick();
    if (focusOutHandler) document.removeEventListener('focusout', focusOutHandler);
    document.removeEventListener('wheel', interactHandler, { capture: true });
    document.removeEventListener('visibilitychange', visHandler);
    document.removeEventListener('pointerdown', interactHandler, true);
    document.removeEventListener('keydown', keyHandler);
    document.removeEventListener('mouseover', tipOverH);
    document.removeEventListener('mouseout', tipOutH);
    document.removeEventListener('focusin', tipFocusInH);
    document.removeEventListener('focusout', tipFocusOutH);
    document.removeEventListener('click', tipClickH);
    document.removeEventListener('mouseover', fieldOverH);
    document.removeEventListener('mouseout', fieldOutH);
    if (ro) ro.disconnect();
    if (renderer) renderer.dispose();
  }

  /* ============================ tooltips ============================ */
  function openTip(el, pin) {
    var id = el.getAttribute('data-tip');
    var r = el.getBoundingClientRect();
    var W = 264;
    var vw = window.innerWidth || 1;
    var x = r.left + r.width / 2 - W / 2;
    x = Math.max(12, Math.min(x, vw - W - 12));
    var above = r.top > 170;
    var top = above ? Math.round(r.top - 8) : Math.round(r.bottom + 8);
    var wasPinned = state.tip.open && state.tip.pinned;
    setState({ tip: { open: true, id: id, x: Math.round(x), top: top, transform: above ? 'translateY(-100%)' : 'none', pinned: pin || wasPinned } });
  }
  function closeTip(force) {
    if (!force && state.tip.pinned) return;
    if (state.tip.open) setState({ tip: { open: false } });
  }

  function renderTip() {
    var tip = state.tip;
    var sig = tip && tip.open ? (tip.id + '|' + tip.x + '|' + tip.top + '|' + tip.transform) : '';
    if (sig === lastTipSig) return;
    lastTipSig = sig;
    if (tip && tip.open) {
      var text = TIP_TEXT[tip.id] || '';
      if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.setAttribute('role', 'tooltip');
        tipEl.innerHTML = '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:#D8CDBB;"></div>';
        screenEl.appendChild(tipEl);
      }
      tipEl.setAttribute('style', 'position:fixed;z-index:60;left:' + (tip.x || 0) + 'px;top:' + (tip.top || 0) + 'px;transform:' + (tip.transform || 'none') + ';width:264px;background:#292216;border:1px solid #463B30;padding:13px 15px;box-shadow:0 10px 34px rgba(0,0,0,0.55);animation:tipIn 0.14s ease;pointer-events:none;');
      tipEl.firstChild.textContent = text;
    } else if (tipEl && tipEl.parentNode) {
      tipEl.parentNode.removeChild(tipEl);
      tipEl = null;
    }
  }

  /* ============================ transparency drawer ============================ */
  function openDrawer() {
    userInteracted = true;
    closeTip(true);
    /* captured BEFORE the drawer mounts, so focus can return to exactly where
       it started (usually the "transparence" trigger) once it closes. */
    preDrawerFocusEl = document.activeElement;
    setState({ drawerOpen: true });
    setTimeout(function () { if (drawerCloseBtn) drawerCloseBtn.focus(); }, 40);
  }
  /* aria-modal="true" on the dialog does not, by itself, hide the rest of the
     page from assistive tech - a screen reader can still read straight
     through into the hero behind the scrim. Marks every OTHER direct child
     of the root aria-hidden while the drawer is open, restoring whatever was
     there before (never clobbering a real aria-hidden the app itself set). */
  function setBackgroundHidden(hidden) {
    if (!screenEl) return;
    var kids = screenEl.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === drawerScrim || k === drawerDialog) continue;
      if (hidden) {
        k.setAttribute('data-ndl-prev-ah', k.hasAttribute('aria-hidden') ? k.getAttribute('aria-hidden') : '__none__');
        k.setAttribute('aria-hidden', 'true');
      } else {
        var prev = k.getAttribute('data-ndl-prev-ah');
        k.removeAttribute('data-ndl-prev-ah');
        if (prev === '__none__' || prev === null) k.removeAttribute('aria-hidden');
        else k.setAttribute('aria-hidden', prev);
      }
    }
  }

  /* focus trap: aria-modal="true" is a hint, not an enforcement - without this,
     Tab/Shift+Tab walk straight out of the dialog into the hidden background.
     Cycles among the dialog's own focusable elements only. */
  function trapDrawerFocus(e) {
    if (e.key !== 'Tab' || !drawerDialog) return;
    var focusable = drawerDialog.querySelectorAll('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])');
    if (!focusable.length) { e.preventDefault(); return; }
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!drawerDialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  function closeDrawer() {
    setState({ drawerOpen: false });
    /* teardownDrawer() has already run synchronously inside the setState
       above (setState -> render -> syncDrawer -> teardownDrawer), so the
       drawer's own nodes are gone and it is safe to hand focus back. Falls
       back to the transparency trigger (still in the DOM) if the original
       triggering element is gone for any reason. */
    var back = (preDrawerFocusEl && document.contains(preDrawerFocusEl)) ? preDrawerFocusEl : transpBtn;
    preDrawerFocusEl = null;
    if (back && back.focus) back.focus();
  }

  function buildDrawer(v) {
    drawerScrim = document.createElement('div');
    drawerScrim.setAttribute('style', 'position:fixed;inset:0;z-index:70;background:rgba(8,6,4,0.6);animation:scrimIn 0.2s ease;');
    drawerScrim.addEventListener('click', closeDrawer);

    drawerDialog = document.createElement('div');
    drawerDialog.setAttribute('role', 'dialog');
    drawerDialog.setAttribute('aria-modal', 'true');
    drawerDialog.setAttribute('aria-label', T('The measurement in detail', 'Le détail de la mesure'));
    drawerDialog.setAttribute('style', 'position:fixed;top:0;right:0;bottom:0;z-index:71;width:min(620px,95vw);background:#211A14;border-left:1px solid #362E24;display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,0.5);animation:drawerIn 0.28s cubic-bezier(0.2,0.8,0.2,1);');

    var fn = esc(v.focusName || T('the brand', 'la marque'));
    var provider = esc(v.providerLabel || T('the AI', 'l\'IA'));
    var matrix = v.matrix || [];
    var owners = v.owners || [];
    var serpByQ = v.serpByQ || [];
    var runN = v.runN || 0;

    /* REAL granularity is PER-QUESTION x PER-BRAND: for each question, every brand
       the backend measured gets a cell = its rank in the one AI assistant (with
       primary/mentioned + cited/runs) and its Google (SERP) rank. There is NO
       12-AI matrix; the backend measures one assistant, N runs. */
    var srcNames = ['Google (SERP)', v.providerLabel || 'IA'];
    var srcChips = '';
    for (var i = 0; i < srcNames.length; i++) {
      srcChips += '<span style="font-size:11px;color:#C9BEAC;border:1px solid #362E24;padding:5px 9px;">' + esc(srcNames[i]) + '</span>';
    }

    /* column header = the brands, focus first and in brass */
    var headerCells = matrix.length ? matrix[0].cells : [];
    var K = headerCells.length;
    var gridCols = 'minmax(150px,1.4fr) repeat(' + Math.max(1, K) + ',minmax(104px,1fr))';
    var minW = 150 + Math.max(1, K) * 108;
    var hCols = '';
    for (var j = 0; j < headerCells.length; j++) {
      var hn = headerCells[j];
      hCols += '<div title="' + esc(hn.name) + '" style="font-size:10px;font-weight:' + (hn.isFocus ? '600' : '400') + ';color:' + (hn.isFocus ? BRASS : '#A39784') + ';text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(hn.name) + '</div>';
    }

    /* one cell = a brand's standing on a question: AI chip (primary=strong,
       mentioned=soft, absent=sienna outline) + cited/runs + Google rank. */
    function matrixCell(cell) {
      var aiTxt, aiBg, aiFg, aiBorder = 'transparent';
      if (cell.aiRank == null) {
        aiTxt = T('absent', 'absent'); aiBg = 'transparent'; aiFg = '#AE7A64'; aiBorder = 'rgba(181,124,93,0.55)';
      } else if (cell.aiKind === 'primary') {
        aiTxt = T('primary #', 'principal n') + cell.aiRank; aiBg = 'rgba(147,160,110,0.7)'; aiFg = '#141009';
      } else {
        aiTxt = T('cited #', 'cité n') + cell.aiRank; aiBg = 'rgba(147,160,110,0.28)'; aiFg = '#D8CDBB';
      }
      /* The count under the chip must match the chip's own claim: a
         "primary" chip is followed by how many of the N runs it was
         actually PRIMARY (never the presence count, which can be higher and
         would silently overstate primacy); a "cited" chip is followed by the
         honest presence count, which is exactly what "cited" means. */
      var subTxt = '';
      if (cell.aiRank != null && cell.runs) {
        subTxt = cell.aiKind === 'primary'
          ? T('primary ', 'principal ') + (cell.primaryHits != null ? cell.primaryHits : cell.cited) + '/' + cell.runs
          : T('cited ', 'cité ') + cell.cited + '/' + cell.runs;
      }
      var gTxt = cell.serpRank != null ? (T('Google #', 'Google n') + cell.serpRank) : T('Google absent', 'Google absent');
      var focusEdge = cell.isFocus ? 'border-top:2px solid ' + BRASS + ';' : 'border-top:2px solid transparent;';
      return '<div style="display:flex;flex-direction:column;gap:3px;padding:5px;background:#231D18;' + focusEdge + 'box-sizing:border-box;">' +
        '<div style="font-size:9.5px;line-height:1.2;text-align:center;padding:3px 4px;background:' + aiBg + ';border:1px solid ' + aiBorder + ';box-sizing:border-box;color:' + aiFg + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(aiTxt) + '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:4px;font-size:8.5px;color:#958772;font-variant-numeric:tabular-nums;">' +
          '<span>' + (subTxt ? esc(subTxt) : '&nbsp;') + '</span><span>' + esc(gTxt) + '</span>' +
        '</div>' +
      '</div>';
    }

    var rowsHtml = '';
    for (var ri = 0; ri < matrix.length; ri++) {
      var row = matrix[ri];
      var cellsHtml = '';
      for (var ci = 0; ci < row.cells.length; ci++) cellsHtml += matrixCell(row.cells[ci]);
      rowsHtml += '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:3px;align-items:stretch;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;color:#D8CDBB;display:flex;align-items:center;padding-right:8px;line-height:1.3;">« ' + esc(row.q) + ' »</div>' +
        cellsHtml + '</div>';
    }
    if (!matrix.length) {
      rowsHtml = '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#958772;">' + T('Run a measurement first to see the detail, question by question.', 'Lancez d\'abord une mesure pour voir le détail, question par question.') + '</div>';
    }

    /* "Qui tient Google" : the hosts that own the page, per question, making the
       aggregator ownership explicit. */
    var ownerHtml = '';
    for (var qi = 0; qi < serpByQ.length; qi++) {
      var sq = serpByQ[qi];
      var hostsHtml = '';
      if (sq.hosts.length) {
        for (var hi = 0; hi < sq.hosts.length; hi++) {
          hostsHtml += '<span style="font-size:10.5px;color:#C9BEAC;border:1px solid #362E24;padding:3px 7px;font-variant-numeric:tabular-nums;">' + esc(shortHost(sq.hosts[hi].host)) + ' <span style="color:#958772;">n' + sq.hosts[hi].rank + '</span></span>';
        }
      } else {
        hostsHtml = '<span style="font-size:10.5px;color:#958772;">' + T('page not captured', 'page non relevée') + '</span>';
      }
      ownerHtml += '<div style="display:flex;flex-direction:column;gap:5px;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;color:#B2A694;">« ' + esc(sq.q) + ' »</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:5px;">' + hostsHtml + '</div>' +
      '</div>';
    }
    if (!serpByQ.length) ownerHtml = '<div style="font-size:11.5px;color:#958772;">' + T('No Google page data.', 'Aucune donnée de page Google.') + '</div>';

    var s1 = matrix.length > 1 ? 's' : '', rs1 = runN > 1 ? 's' : '';
    /* Real model transparency (owner: "il manque de la transparence sur les
       IAs, les modeles utilises"): name the measurement date, the search
       floor (Google + the market label) and the EXACT assistant (provider
       label + model id), on top of the pass count this footnote already
       carried. v.aiModel / v.measuredAt come straight from app.py's
       /api/analyze response (additive fields, see buildResult) - both are
       guarded here so an older cached result missing either one just omits
       that clause instead of ever printing "undefined". */
    var measuredDate = v.measuredAt ? String(v.measuredAt).slice(0, 10) : '';
    var modelSuffix = v.aiModel ? (', ' + esc(v.aiModel)) : '';
    var assistantTxt = provider + modelSuffix;
    var marketTxt = v.market ? esc(v.market) : '';
    var floorSuffix = marketTxt ? (' (' + marketTxt + ')') : '';
    var footnoteTxt = !matrix.length
      ? T('Run a measurement to see the exact method, question by question.', 'Lancez une mesure pour voir la méthode exacte, question par question.')
      : (measuredDate ? T('Measured on ' + measuredDate + '. ', 'Mesuré le ' + measuredDate + '. ') : '') +
      T(
        matrix.length + ' question' + s1 + ' on Google' + floorSuffix + ' and 1 AI (' + assistantTxt + '), ' + runN + (runN > 1 ? ' passes' : ' pass') + ' per question, ' + matrix.length + ' Google read' + s1 + '. Each cell shows the brand real rank, with no hidden aggregation. The Deep Audit widens this same read to 5 questions and 8 passes per question, still on ' + provider + '.',
        matrix.length + ' question' + s1 + ' sur Google' + floorSuffix + ' et 1 IA (' + assistantTxt + '), ' + runN + ' passage' + rs1 + ' par question, ' + matrix.length + ' lecture' + s1 + ' de Google. Chaque case montre le rang réel de la marque, sans agrégation cachée. Le Deep Audit élargit cette même lecture à 5 questions et 8 passages par question, toujours sur ' + provider + '.'
      );
    drawerDialog.innerHTML =
      '<div style="flex:none;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);border-bottom:1px solid #362E24;">' +
        '<div style="display:flex;flex-direction:column;gap:5px;">' +
          '<div style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(17px,1.7vw,23px);letter-spacing:-0.01em;">' + T('The detail, unfiltered', 'Le détail, sans filtre') + '</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#B2A694;max-width:46ch;">' + T('Your questions asked to Google and to ' + provider + ', and where each brand shows up. Nothing is aggregated before you see it.', 'Vos questions posées à Google et à ' + provider + ', et où chaque marque ressort. Rien n\'est agrégé avant que vous le voyiez.') + '</div>' +
        '</div>' +
        '<button class="ndl-drawer-close" aria-label="' + T('close the detail', 'fermer le détail') + '" style="flex:none;cursor:pointer;background:none;border:1px solid #463B30;color:#B2A694;font-family:inherit;font-size:15px;line-height:1;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">✕</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto;overflow-x:hidden;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);display:flex;flex-direction:column;gap:22px;">' +
        '<div style="display:flex;flex-direction:column;gap:9px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('the sources queried', 'les sources interrogées') + '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + srcChips + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('each brand, question by question', 'chaque marque, question par question') + '</div>' +
            '<div style="font-size:10px;color:#958772;font-variant-numeric:tabular-nums;">' + runN + T(' AI reads per question', ' mesures IA par question') + '</div>' +
          '</div>' +
          '<div style="overflow-x:auto;overflow-y:hidden;">' +
            '<div style="min-width:' + minW + 'px;display:flex;flex-direction:column;gap:4px;">' +
              '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:3px;align-items:end;">' +
                '<div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#958772;">' + T('question', 'question') + '</div>' +
                hCols +
              '</div>' +
              rowsHtml +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:16px;padding-top:2px;">' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#B2A694;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.7);"></span>' + T('primary answer', 'réponse principale') + '</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#B2A694;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.28);"></span>' + T('cited lower', 'cité plus bas') + '</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#B2A694;"><span style="width:14px;height:10px;background:transparent;border:1px solid rgba(181,124,93,0.6);box-sizing:border-box;"></span>' + T('absent', 'absent') + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('who holds the Google page', 'qui tient la page Google') + '</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#958772;">' + T('Often the Google page is held not by the brands but by comparison sites and aggregators. Here are the leading domains, question by question.', 'Souvent, la page Google n\'est pas tenue par les marques mais par des comparateurs et des agrégateurs. Voici les domaines en tête, question par question.') + '</div>' +
          ownerHtml +
        '</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#958772;border-top:1px solid #362E24;padding-top:14px;">' + footnoteTxt + '</div>' +
      '</div>';

    screenEl.appendChild(drawerScrim);
    screenEl.appendChild(drawerDialog);
    drawerCloseBtn = drawerDialog.querySelector('.ndl-drawer-close');
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeDrawer);
    drawerTrapHandler = trapDrawerFocus;
    drawerDialog.addEventListener('keydown', drawerTrapHandler);
    setBackgroundHidden(true);
  }
  function teardownDrawer() {
    setBackgroundHidden(false);
    if (drawerDialog && drawerTrapHandler) drawerDialog.removeEventListener('keydown', drawerTrapHandler);
    drawerTrapHandler = null;
    if (drawerScrim && drawerScrim.parentNode) drawerScrim.parentNode.removeChild(drawerScrim);
    if (drawerDialog && drawerDialog.parentNode) drawerDialog.parentNode.removeChild(drawerDialog);
    drawerScrim = null; drawerDialog = null; drawerCloseBtn = null;
  }
  function syncDrawer(v) {
    if (state.drawerOpen === lastDrawerOpen) return;
    lastDrawerOpen = state.drawerOpen;
    if (state.drawerOpen) buildDrawer(v);
    else teardownDrawer();
  }

  /* ============================ reveal / loading ============================ */
  /* The reveal is the CLIMAX and is triggered by DATA ARRIVAL, not a timer. It
     keeps the exact demo choreography (verdict last, share rises, cards cascade,
     3D calms per verdict confidence) - only the trigger changed. */
  function reveal(gen) {
    if (gen !== measureGen) return;
    clearSlowNote();
    stopMeasureTick();
    /* The paid session is only "spent for good" from the visitor's point of
       view once its deep dossier has actually rendered - clear the reload-
       recovery marker (see resumeDeepAudit) exactly here, never earlier. */
    if (currentResult && currentResult.tier === 'deep') clearPendingDeep();
    setState({
      measuring: false, settled: true, payError: false,
      passCount: currentResult ? currentResult.passTotal : 0,
      unknownMsg: (currentResult && currentResult.notice) ? currentResult.notice : ''
    });
    /* the deep dossier (evidence, remediation report, geo score) lives below
       the fixed-height hero, only for a tier==='deep' result; hidden otherwise. */
    renderBelowFold();
    /* Funnel: a result actually rendered. plan_shown mirrors index.html, where
       it fires when a NON-deep result renders and therefore carries the offer
       (a deep result has already been paid for, so there is no plan to show). */
    if (currentResult) {
      track('result_seen', { tier: currentResult.tier || '' });
      if (currentResult.tier !== 'deep') track('plan_shown', { tier: currentResult.tier || '' });
    }
    /* The field and the insight only render on this reveal, and they push the
       axis down. A ResizeObserver on the axis does NOT fire on a pure position
       change, so the cloud would stay projected on the axis' OLD position and
       float over the field. Re-project once the new layout is settled (two
       frames: one for the DOM write, one for layout). */
    if (scene) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (gen !== measureGen) return;
          buildClusters(clusterRows(), false, clusterFocus());
          if (reduced) renderResolved();
        });
      });
    }
    setTimeout(function () {
      if (inputEl && !state.drawerOpen && (document.activeElement === document.body || document.activeElement === null)) inputEl.focus({ preventScroll: true });
    }, 80);
  }

  /* A real audit can take 30-60s. After 8s, append a subtle FR note (like
     index.html's slow-dyno note) inside the "lecture en cours" overlay, cleared
     on response. */
  function showSlowNote() {
    if (!overlayEl || slowNoteEl) return;
    slowNoteEl = document.createElement('div');
    slowNoteEl.setAttribute('style', 'font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#A39784;margin-top:2px;');
    slowNoteEl.textContent = T(
      'The instrument is waking up. The first measurement after a quiet period can take up to a minute.',
      'L\'instrument se réveille. La première mesure après une période calme peut prendre jusqu\'à une minute.'
    );
    overlayEl.appendChild(slowNoteEl);
  }
  function clearSlowNote() {
    clearTimeout(slowNoteT); slowNoteT = null;
    if (slowNoteEl && slowNoteEl.parentNode) slowNoteEl.parentNode.removeChild(slowNoteEl);
    slowNoteEl = null;
  }

  /* ---- real elapsed-time feedback during a measurement ----
     Ticks state.elapsedS once a second while state.measuring is true, so the
     pass counter reads "mesure en cours (12s)" instead of a static label that
     just jumps straight to the final count on settle. This is the ONLY motion
     feedback prefers-reduced-motion users get during the 30-60s wait (the 3D
     cloud's breathing is intentionally off for them, see `reduced`), and it
     is honest: real wall-clock seconds, never an invented percentage. */
  var measureTickIv = null, measureTickStart = 0;
  function startMeasureTick() {
    clearInterval(measureTickIv);
    measureTickStart = performance.now();
    setState({ elapsedS: 0 });
    measureTickIv = setInterval(function () {
      if (!state.measuring) { clearInterval(measureTickIv); measureTickIv = null; return; }
      setState({ elapsedS: Math.round((performance.now() - measureTickStart) / 1000) });
    }, 1000);
  }
  function stopMeasureTick() { clearInterval(measureTickIv); measureTickIv = null; }

  /* rows/focus the 3D instrument is built from: the real head-to-head once we
     have a result, else a neutral cloud that encodes NO score. At idle, while
     measuring and on failure, currentResult is null, so computeWindow(null)
     is always {lo:0,hi:100} - a fixed point (e.g. 70) would render as a real,
     confident measurement on that labelled axis before anything was measured.
     Centring on the window's midpoint with a span covering half the window
     spreads the cloud across most of the visible axis instead, which reads as
     "nothing measured" rather than "score 50". bounded:false keeps it out of
     the proven/behind classification (see clusterState). */
  function loadingRows() { return [{ n: '', s: 50, m: 50, bounded: false }]; }
  function clusterRows() { return (currentResult && currentResult.rows && currentResult.rows.length) ? currentResult.rows : loadingRows(); }
  function clusterFocus() { return (currentResult && currentResult.rows && currentResult.rows.length) ? currentResult.focusName : ''; }

  /* axis advantage/overlap band on the full 0..100 scale. */
  function regionBox(aScore, bScore, fill, borderColor, borderStyle) {
    var zspan = ZHI - ZLO;
    var lo = Math.max(0, Math.min(100, (aScore - ZLO) / zspan * 100));
    var hi = Math.max(0, Math.min(100, (bScore - ZLO) / zspan * 100));
    return { leftPct: lo.toFixed(2), widthPct: Math.max(0, hi - lo).toFixed(2), fill: fill, borderColor: borderColor, borderStyle: borderStyle };
  }

  /* ============================ three.js instrument ============================ */
  function initScene() {
    var THREE = window.THREE;
    var r;
    try {
      r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      if (!r.getContext()) throw new Error('no gl');
    } catch (e) { return; }
    renderer = r;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    mountEl.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, 16);
    camera.lookAt(0, 0, 0);
    group = new THREE.Group();
    scene.add(group);
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    var rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,0.45)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    sprite = new THREE.CanvasTexture(c);
    material = new THREE.PointsMaterial({ size: 0.045, vertexColors: true, map: sprite, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    resize();
    /* Debounced: a live window/container resize (dragging the browser edge)
       fires this callback many times a second, and each one used to rebuild
       the ENTIRE particle geometry (buildClusters allocates and uploads a
       fresh BufferGeometry for every point in the cloud). Coalescing to the
       last event in a 120ms quiet window keeps the resize itself smooth
       instead of stalling on repeated full rebuilds mid-drag. */
    ro = new ResizeObserver(function () {
      clearTimeout(resizeDebounceT);
      resizeDebounceT = setTimeout(resize, 120);
    });
    ro.observe(mountEl);
    ro.observe(axisEl);
    buildClusters(clusterRows(), true, clusterFocus());
    if (reduced) renderResolved(); else startLoop();
  }

  function pxToWorld(px, py) {
    var W = mountEl.clientWidth || 1, H = mountEl.clientHeight || 1;
    var worldH = 2 * 16 * Math.tan(camera.fov / 2 * Math.PI / 180);
    var wpp = worldH / H;
    return [(px - W / 2) * wpp, (H / 2 - py) * wpp, wpp];
  }

  function resize() {
    if (!renderer || !mountEl) return;
    var w = mountEl.clientWidth || 1, h = mountEl.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (points) buildClusters(clusterRows(), false, clusterFocus());
    if (reduced) renderResolved();
  }

  function clusterState(rows, i) {
    /* Single cluster (no rival, or the loading cloud): treat as settled/calm.
       During measuring the frame() loop overrides calmness anyway (measuring=1). */
    if (rows.length < 2) return 'proven';
    var l = rows[0], s2 = rows[1], r = rows[i];
    /* Never render "proven" (a confident, settled cluster) or "behind" from an
       UNBOUNDED read (half_width was null - a single successful run). Two bare
       points are not disjoint confidence bands; the honest visual state is the
       same "contested" (higher-motion, undecided) look computeVerdict now also
       falls back to for that case. */
    var bothBounded = l.bounded !== false && s2.bounded !== false;
    var proven = bothBounded && (l.s - l.m) > (s2.s + s2.m);
    if (i === 0) return proven ? 'proven' : 'contested';
    if (i === 1 && !proven) return 'contested';
    if (bothBounded && (l.s - l.m) > (r.s + r.m)) return 'behind';
    return 'contested';
  }

  function buildClusters(rowsIn, scattered, focusName) {
    var THREE = window.THREE;
    if (!THREE || !axisEl || !mountEl || !camera) return;
    if (!rowsIn || !rowsIn.length) return;
    var density = props.density != null ? props.density : 1;
    var mrect = mountEl.getBoundingClientRect();
    var arect = axisEl.getBoundingClientRect();
    if (arect.width < 10) return;
    var axL = arect.left - mrect.left, axW = arect.width, axY = arect.top - mrect.top;
    /* recompute the adaptive window here too: buildClusters is called from
       initScene / resize / runReal independently of renderVals, so the 3D cloud
       must project on the SAME [ZLO,ZHI] as the brackets/region/ticks. It depends
       only on currentResult (null while loading -> 0..100). */
    applyWindow();
    var zspan = ZHI - ZLO;
    clusterRanges = {};
    var pts = [];

    /* Three distinct readings, never one generic "loading" look (owner: "la
       partie animatique 3D ne sert a rien" - the cloud must always encode
       what is actually true right now, never decorate):
         - 'result'    a real settled or settling measurement - the existing
                       cluster-per-brand projection below (UNCHANGED): position
                       IS the score, spread IS the interval, agitation IS
                       instability. rowsIn carries real, named rows.
         - 'measuring' a run is actually in flight (state.measuring) but no
                       rows exist yet (rowsIn is the loadingRows() sentinel,
                       n:'') - readings streaming in: a directional flow that
                       gathers toward the axis line as the run goes on (see
                       frame()'s flowK, driven by state.elapsedS), brightening
                       with it. It never gathers onto any ONE position - there
                       is nothing to position yet.
         - 'dormant'   nothing running, nothing measured (idle boot, or a
                       failed measurement) - a calm, thin, low-intensity field
                       along the whole axis. No cluster, no position, no claim.
       Derived here, fresh, on every call - never cached - so a live resize or
       a Stripe-return resume mid-boot always reads the true current state. */
    var isRealResult = !!(rowsIn[0] && rowsIn[0].n !== '');
    var mode = isRealResult ? 'result' : (state.measuring ? 'measuring' : 'dormant');
    sceneMode = mode;

    if (mode === 'result') {
      var rows = rowsIn.slice().sort(function (a, b) { return b.s - a.s; });
      var l = rows[0], s2 = rows[1];
      var hasOverlap = false, oLo = 0, oHi = 0;
      if (rows.length >= 2) { oLo = Math.max(l.s - l.m, s2.s - s2.m); oHi = Math.min(l.s + l.m, s2.s + s2.m); hasOverlap = oLo < oHi; }
      var brass = [0.86, 0.68, 0.37], hot = [0.78, 0.44, 0.29];
      rows.forEach(function (r, i) {
        var st = clusterState(rows, i);
        /* clamp the cluster centre to the visible window so an out-of-range real
           score never throws the cloud off-canvas; the axis spans 0..100. */
        var sClamped = Math.max(ZLO, Math.min(ZHI, r.s));
        var cxPx = axL + (sClamped - ZLO) / zspan * axW;
        var w0 = pxToWorld(cxPx, axY);
        var x = w0[0], y = w0[1], wpp = w0[2];
        var R = Math.max(r.m / zspan * axW * wpp, 0.12);
        var isFocus = !!focusName && r.n === focusName;
        var dimK = st === 'behind' ? 0.45 : 1;
        var base;
        if (isFocus) base = [brass[0] * dimK, brass[1] * dimK, brass[2] * dimK];
        else { var k = (i === 0 ? 0.75 : i === 1 ? 0.5 : 0.3) * dimK; base = [0.91 * k, 0.87 * k, 0.82 * k]; }
        var calm = st === 'proven' ? 0.3 : st === 'contested' ? 1.7 : 0.75;
        var ringRes = st === 'proven' ? 0.014 : st === 'contested' ? 0.035 : 0.045;
        var nMul = st === 'behind' ? 0.5 : 1;
        var nRing = Math.round((isFocus ? 1600 : 1000) * density * nMul);
        var nCore = Math.round((isFocus ? 800 : 500) * density * nMul);
        var rangeStart = pts.length;
        for (var j = 0; j < nRing + nCore; j++) {
          var ring = j < nRing;
          var tx, ty, tz;
          if (ring) {
            var a = Math.random() * Math.PI * 2;
            var rr = R + gauss() * 0.03;
            tx = x + Math.cos(a) * rr; ty = y + Math.sin(a) * rr; tz = gauss() * 0.05;
          } else {
            tx = x + gauss() * R * 0.34; ty = y + gauss() * R * 0.34; tz = gauss() * 0.06;
          }
          var col = base;
          if (ring && i < 2 && hasOverlap) {
            var score = ZLO + ((tx / wpp) + (mountEl.clientWidth / 2) - axL) / axW * zspan;
            if (score > oLo && score < oHi) col = hot;
          }
          var dir = [gauss(), gauss(), gauss()];
          var len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
          pts.push({
            t: [tx, ty, tz], c: col,
            d: [dir[0] / len, dir[1] / len, dir[2] / len],
            res: ring ? ringRes : 0.06,
            burst: 1.2 + Math.random() * 2.0,
            ph: Math.random() * Math.PI * 2,
            fq: 0.5 + Math.random() * 1.2,
            stag: Math.random() * 0.35,
            calm: calm
          });
        }
        /* brand -> particle range + cluster centre, for the settled hover
           highlight (setClusterHighlight/clearClusterHighlight below) - one
           directional, field row -> cloud, never the reverse (the canvas
           keeps pointer-events:none, no raycasting). */
        clusterRanges[r.n] = { start: rangeStart, count: pts.length - rangeStart, cx: x, cy: y };
      });
    } else if (mode === 'measuring') {
      /* Same total budget as the dormant field (1500 * density) - a run in
         flight never costs more particles than idle. Spread across the FULL
         axis width (nothing has arrived, so nothing is positioned), each
         particle's own drift direction biased horizontal for a "current"
         feel; the actual gather-toward-the-axis and the brightening-with-
         elapsed-time both live in frame() (sceneMode==='measuring' branch),
         driven by state.elapsedS - never a fabricated percentage. */
      var N = Math.round(1500 * density);
      var flowCol = [0.6, 0.5, 0.36];
      for (var fj = 0; fj < N; fj++) {
        var fx = Math.random();
        var fcxPx = axL + fx * axW;
        var fw0 = pxToWorld(fcxPx, axY);
        var fdir = [gauss() * 1.6, gauss() * 0.8, gauss() * 0.6];
        var flen = Math.hypot(fdir[0], fdir[1], fdir[2]) || 1;
        /* the vertical spread is baked into the TARGET itself (not only into
           the per-frame breathing jitter below) - otherwise the static
           prefers-reduced-motion frame (which renders raw targets, no dir*amp
           applied - see renderResolved) would collapse the whole field onto
           the exact axis line, invisible against the DOM axis hairline
           already drawn there. This is the loose, pre-gather spread; frame()
           still shrinks the ADDITIONAL per-frame jitter toward it over
           elapsed time for the animated case. */
        pts.push({
          t: [fw0[0], fw0[1] + gauss() * 0.55, gauss() * 0.05], c: flowCol,
          d: [fdir[0] / flen, fdir[1] / flen, fdir[2] / flen],
          res: 0.32 + Math.random() * 0.9,
          burst: scattered ? (0.9 + Math.random() * 1.3) : 0,
          ph: Math.random() * Math.PI * 2,
          fq: 0.6 + Math.random() * 1.3,
          stag: Math.random() * 0.3,
          calm: 1
        });
      }
    } else {
      /* Dormant: idle boot AND a failed measurement read identically - not
         measured, full stop. A thin, low-intensity field loosely gathered
         along the axis's full width, slow drift, never converging to a
         point - the opposite of the old sparse ring (which spread a single
         fake "score:50" cluster wide enough to fill the axis, and once
         still read as a real, if very uncertain, measurement). This is not
         a cluster at all: no rival, no bounded/unbounded state, no score. */
      var Nd = Math.round(1500 * density);
      var dormCol = [0.32, 0.29, 0.24];
      for (var dj = 0; dj < Nd; dj++) {
        var dx = Math.random();
        var dcxPx = axL + dx * axW;
        var dw0 = pxToWorld(dcxPx, axY);
        var ddir = [gauss(), gauss(), gauss()];
        var dlen = Math.hypot(ddir[0], ddir[1], ddir[2]) || 1;
        /* baked into the target itself, same reasoning as the measuring
           branch above - the reduced-motion static frame renders raw
           targets, no per-frame jitter, so the spread has to already be
           there or the field collapses onto the invisible axis line. */
        pts.push({
          t: [dw0[0], dw0[1] + gauss() * 0.3, gauss() * 0.05], c: dormCol,
          d: [ddir[0] / dlen, ddir[1] / dlen, ddir[2] / dlen],
          res: 0.05 + Math.random() * 0.04,
          burst: scattered ? (0.7 + Math.random() * 1.0) : 0,
          ph: Math.random() * Math.PI * 2,
          fq: 0.16 + Math.random() * 0.26,
          stag: Math.random() * 0.4,
          calm: 0.55
        });
      }
    }

    var n = pts.length;
    var pos = new Float32Array(n * 3), colA = new Float32Array(n * 3);
    targets = new Float32Array(n * 3);
    dirs = new Float32Array(n * 3);
    meta = new Float32Array(n * 6);
    pts.forEach(function (p, i) {
      targets.set(p.t, i * 3); dirs.set(p.d, i * 3); colA.set(p.c, i * 3);
      meta[i * 6] = p.res; meta[i * 6 + 1] = p.burst; meta[i * 6 + 2] = p.ph; meta[i * 6 + 3] = p.fq; meta[i * 6 + 4] = p.stag; meta[i * 6 + 5] = p.calm;
      var amp = scattered ? p.burst : p.res;
      pos[i * 3] = p.t[0] + p.d[0] * amp; pos[i * 3 + 1] = p.t[1] + p.d[1] * amp; pos[i * 3 + 2] = p.t[2] + p.d[2] * amp;
    });
    /* pristine snapshots the hover highlight mutates FROM and restores TO
       (see setClusterHighlight/clearClusterHighlight) - taken once per build,
       never touched by frame()'s per-tick animation (which only ever writes
       `pos`, and - while measuring - the geometry's own live color buffer). */
    targetsBase = new Float32Array(targets);
    baseColors = new Float32Array(colA);
    if (points) { group.remove(points); points.geometry.dispose(); }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    points = new THREE.Points(geo, material);
    group.add(points);
    /* A hover in progress survives a rebuild (e.g. a live window resize while
       the pointer sits over a field row) by reapplying against the fresh
       ranges; anything else just clears it rather than risk indices that no
       longer match the new buffers. */
    if (hoverBrand && clusterRanges[hoverBrand]) setClusterHighlight(hoverBrand);
    else hoverBrand = null;
    if (reduced) renderResolved();
  }

  /* ============================ cloud <-> field hover ============================
     Settled only, one directional: hovering a #ndl-field row (see renderField's
     .ndl-field-row/data-brand, and the delegated fieldOverH/fieldOutH wired in
     componentDidMount) highlights that brand's cluster - brighter, and a touch
     larger via a radial dilation of its own particles away from their own
     cluster centre - and dims every other cluster; leaving restores both. The
     canvas itself never gets a listener and keeps pointer-events:none - this
     never raycasts, it only reads clusterRanges (built fresh in buildClusters,
     above) and mutates the EXISTING position/color buffers in place. No
     allocation here and no per-frame cost: this runs once per mouseenter/leave,
     never inside frame(). */
  function setClusterHighlight(brand) {
    if (!points || !targetsBase || !baseColors || !clusterRanges) return;
    /* The cloud only ever visualizes the two BRACKETED rows (focus + the one
       geo_rival - see buildResult's `rows`, and the axis brackets built from
       the very same list) - never the full #ndl-field table, which can list
       every measured competitor. Hovering a field row for a brand that has
       no cluster (not focus, not the bracketed rival) must be an honest
       no-op on the cloud - NOT a blanket dim of every real cluster, which
       would read as broken. */
    if (!brand || !clusterRanges.hasOwnProperty(brand)) { clearClusterHighlight(); return; }
    hoverBrand = brand;
    var colArr = points.geometry.attributes.color.array;
    colArr.set(baseColors);
    targets.set(targetsBase);
    for (var name in clusterRanges) {
      if (!clusterRanges.hasOwnProperty(name)) continue;
      var rg = clusterRanges[name];
      var isHover = name === brand;
      /* Additive blending stacks thousands of particles, so the dense cluster
         core saturates: a 0.32 per-particle dim leaves it looking almost
         untouched (verified on screenshots). 0.08 is what it actually takes
         for the de-emphasis to read; 1.5 keeps the hovered cluster clearly
         lifted without blowing out its core. */
      var mul = isHover ? 1.5 : 0.08;
      var i;
      for (i = rg.start; i < rg.start + rg.count; i++) {
        colArr[i * 3] = Math.min(1, baseColors[i * 3] * mul);
        colArr[i * 3 + 1] = Math.min(1, baseColors[i * 3 + 1] * mul);
        colArr[i * 3 + 2] = Math.min(1, baseColors[i * 3 + 2] * mul);
      }
      if (isHover) {
        var cx = rg.cx, cy = rg.cy, dil = 1.15;
        for (i = rg.start; i < rg.start + rg.count; i++) {
          targets[i * 3] = cx + (targetsBase[i * 3] - cx) * dil;
          targets[i * 3 + 1] = cy + (targetsBase[i * 3 + 1] - cy) * dil;
        }
      }
    }
    points.geometry.attributes.color.needsUpdate = true;
    if (reduced) renderResolved();
  }
  function clearClusterHighlight() {
    hoverBrand = null;
    if (!points || !targetsBase || !baseColors) return;
    points.geometry.attributes.color.array.set(baseColors);
    targets.set(targetsBase);
    points.geometry.attributes.color.needsUpdate = true;
    if (reduced) renderResolved();
  }

  function renderResolved() {
    if (!renderer || !points) return;
    var pos = points.geometry.attributes.position;
    pos.array.set(targets); pos.needsUpdate = true;
    renderer.render(scene, camera);
  }

  /* Throttled to ~30fps: this loop runs continuously the whole time the tab
     is visible (by design - the cloud is always gently "breathing"), so an
     uncapped rAF was spending full display-refresh-rate (60-120Hz) worth of
     particle-position math and draw calls on an ambient effect that reads
     identically at half that rate. requestAnimationFrame is still requested
     every frame (needed to keep sampling the clock cheaply) but the actual
     per-particle work (frame()) only runs on the frames that clear the
     interval, so the visible motion is unchanged. */
  var FRAME_INTERVAL_MS = 1000 / 30, lastFrameT = 0;
  function startLoop() {
    if (rafId || !renderer || reduced) return;
    lastFrameT = 0;
    var tick = function (now) {
      rafId = requestAnimationFrame(tick);
      if (now - lastFrameT < FRAME_INTERVAL_MS) return;
      lastFrameT = now;
      frame();
    };
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function frame() {
    if (!points) { renderer.render(scene, camera); return; }
    var now = performance.now();
    var t = now / 1000;
    var e = (now - measureStart) / 1000;
    var breath = props.breath != null ? props.breath : 1;
    var measuring = state.measuring;
    /* 'measuring' mode only: how far into the run we are, 0..1 over ~40s (a
       real run is 30-60s, see state.elapsedS/startMeasureTick) - drives both
       the gather-toward-the-axis (below) and the brightening-with-elapsed-
       time (the recolor pass after the position loop). Real wall-clock
       seconds, never a fabricated percentage. */
    var flowK = sceneMode === 'measuring' ? Math.max(0, Math.min(1, state.elapsedS / 40)) : 0;
    var pos = points.geometry.attributes.position.array;
    var n = pos.length / 3;
    for (var i = 0; i < n; i++) {
      var res = meta[i * 6], burst = meta[i * 6 + 1], ph = meta[i * 6 + 2], fq = meta[i * 6 + 3], stag = meta[i * 6 + 4], calm = meta[i * 6 + 5];
      var p = (e - 0.15 - stag) / 1.35;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      var k = Math.pow(1 - p, 3);
      /* 'result' keeps the ORIGINAL formula exactly (measuring ? 1 : calm) -
         no behaviour change there. 'dormant' just breathes at its own slow,
         calm rate. 'measuring' shrinks the breathing amplitude as the run
         goes on, so the flow visibly gathers toward the axis line without
         ever picking one position on it (the targets stay spread across the
         full width - see buildClusters). */
      var calmFactor = sceneMode === 'measuring' ? (1 - 0.72 * flowK) : (sceneMode === 'dormant' ? calm : (measuring ? 1 : calm));
      var breathe = (0.7 + 0.3 * Math.sin(t * fq + ph)) * calmFactor * breath;
      var amp = res * breathe + burst * k;
      pos[i * 3] = targets[i * 3] + dirs[i * 3] * amp;
      pos[i * 3 + 1] = targets[i * 3 + 1] + dirs[i * 3 + 1] * amp;
      pos[i * 3 + 2] = targets[i * 3 + 2] + dirs[i * 3 + 2] * amp;
    }
    points.geometry.attributes.position.needsUpdate = true;
    /* Intensity building with elapsed time (measuring only) - mutates the
       geometry's existing color buffer from the pristine baseColors snapshot,
       no allocation. Skipped entirely outside 'measuring' (dormant/result
       colors are set once in buildClusters and never touched per frame). */
    if (sceneMode === 'measuring' && baseColors) {
      var carr = points.geometry.attributes.color.array;
      var cScale = 0.42 + 0.58 * flowK;
      for (var ci = 0; ci < carr.length; ci++) carr[ci] = baseColors[ci] * cScale;
      points.geometry.attributes.color.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }

  /* ============================ paid push (Deep Audit checkout) ============================ */
  /* Ported from index.html startCheckout: same endpoint, headers and body. The
     subject is the measured brand (state.focus / the real result), the market is
     the audit's own market label. Transparent, non-manipulative: everything free
     is already shown; this only goes deeper. */
  /* Multiple Deep Audit CTAs can now exist on the page at once (the idle
     offers strip AND the post-result dock card, never both visible at the
     same time - see offersVisible in renderVals). Both share these two
     classes, so a single deepMsg/deepCtaLock call keeps whichever one is on
     screen in sync, exactly like index.html's document.querySelectorAll
     over [data-deepmsg]/[data-deepcta]. */
  function deepMsg(text, isError) {
    var els = document.querySelectorAll('.ndl-deep-msg');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = text || '';
      els[i].style.display = text ? 'block' : 'none';
      els[i].style.color = isError ? '#B57C5D' : '#958772';
    }
  }
  function deepCtaLock(locked) {
    var els = document.querySelectorAll('.ndl-deep-cta');
    for (var i = 0; i < els.length; i++) els[i].style.pointerEvents = locked ? 'none' : '';
  }
  /* ============================ identity + market control (console) ============================
     Ported from index.html's resolver ("Official website, locks the exact
     company" + Market select, index.html:732-743): the free flow forwarded
     only {brand:name} to /api/infer with no market and no official-URL lock,
     so a homonym (Payflows -> Stripe, Toucan -> Duolingo) or a non-US brand
     could be measured as the wrong entity/market with no visible control
     (panel finding, v2.html:59). Collapsed by default (see the toggle in
     v2.html) so the single-input console stays uncluttered; force-opened by
     renderIdentity below the instant a settled result comes back low
     confidence. */
  function toggleIdPanel(force) {
    if (!idPanelEl || !idToggleBtn) return;
    var open = (typeof force === 'boolean') ? force : (idPanelEl.style.display !== 'flex');
    idPanelEl.style.display = open ? 'flex' : 'none';
    idToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function getOfficialUrlInput() { return officialUrlEl ? officialUrlEl.value.trim() : ''; }
  function getMarketInput() { return marketSelectEl ? marketSelectEl.value.trim() : ''; }
  /* "Mettre a jour" in the panel, and the "changer" link inside the identity
     line (renderIdentity): re-runs the WHOLE free flow (/api/infer then
     /api/analyze) for the already-measured brand, now carrying whatever
     official_url/market the visitor just set - runReal reads both fields
     fresh on every call, so this needs no extra plumbing beyond re-running. */
  function onIdentityUpdate() {
    var brand = (currentResult && currentResult.focusName) || state.focus || (state.inputValue || '').trim();
    if (!brand) { if (inputEl) inputEl.focus(); return; }
    runMeasure(brand);
  }
  /* Plainly shows WHO and WHICH MARKET was measured, next to the verdict (see
     ndl-identity in v2.html) - a screenshot of the verdict alone must never
     leave that ambiguous. Never nags on high confidence (one quiet line);
     on low confidence, adds a visible warning AND force-opens the identity +
     market panel above, so the correction is reachable before the free
     result is trusted - extending the same guard startCheckout already
     enforces for the paid Deep Audit to the free result too. */
  function renderIdentity(R) {
    if (!identityEl) return;
    if (!R) { identityEl.innerHTML = ''; return; }
    var name = esc(R.identifiedAs || R.focusName || '');
    var url = safeHttpUrl(R.officialUrl);
    var urlHtml = url ? (' (<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="color:#B2A694;border-bottom:1px solid #564D3C;">' + esc(shortHost(url)) + '</a>)') : '';
    var marketTxt = R.market ? esc(R.market) : T('not set', 'non défini');
    var low = R.confidence === 'low';
    var html = '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#958772;">' +
      T('Measured for ', 'Mesure pour ') + '<b style="color:#B2A694;">' + name + '</b>' + urlHtml +
      T(', market ', ', marché ') + '<b style="color:#B2A694;">' + marketTxt + '</b> ' +
      '<button type="button" class="ndl-id-change" style="cursor:pointer;background:none;border:none;padding:0;font-family:inherit;font-size:11px;color:#958772;border-bottom:1px solid #564D3C;">' + T('change', 'changer') + '</button>' +
      '</div>';
    if (low) {
      html += '<div style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid #463B30;border-left:2px solid #B57C5D;background:#231D18;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#D8CDBB;">' +
        T('Low confidence: this may be the wrong company or market. Check the official website and the market above, then update.', 'Confiance faible : il peut s\'agir de la mauvaise entreprise ou du mauvais marché. Vérifiez le site officiel et le marché ci-dessus, puis mettez à jour.') +
        '</div></div>';
    }
    identityEl.innerHTML = html;
    var changeBtn = identityEl.querySelector('.ndl-id-change');
    if (changeBtn) changeBtn.addEventListener('click', function () {
      toggleIdPanel(true);
      if (officialUrlEl) { if (!officialUrlEl.value && url) officialUrlEl.value = url; officialUrlEl.focus(); }
    });
    if (low) toggleIdPanel(true);
  }
  /* Guard-rail ported from index.html's resolver: a bare name with no web
     evidence can resolve to a famous homonym (Payflows -> Stripe, Toucan ->
     Duolingo). The backend marks that "low" confidence (app.py _sanitize_
     strategy). Before spending 79 euro on possibly the WRONG company, the
     visitor must see who was identified and explicitly confirm it. Renders
     inline in the deep card (native to the v2 language, no modal). */
  function identityConfirmHTML(R) {
    var name = esc((R && (R.identifiedAs || R.focusName)) || '');
    var url = safeHttpUrl(R && R.officialUrl);
    var urlHtml = url ? (' (<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="color:#B2A694;border-bottom:1px solid #564D3C;">' + esc(shortHost(url)) + '</a>)') : '';
    return '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;padding:11px 13px;border:1px solid #463B30;background:#231D18;">' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#D8CDBB;">' + T('Before you pay, confirm: we identified ', 'Avant de payer, confirmez : nous avons identifié ') + '<b style="color:#E8DFD2;">' + name + '</b>' + urlHtml + '.</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="ndl-identity-yes" style="cursor:pointer;border:none;background:#C6A15B;color:#211A14;font-family:inherit;font-weight:600;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;padding:8px 12px;">' + T('Yes, start the payment', 'Oui, lancer le paiement') + '</button>' +
        '<button class="ndl-identity-no" style="cursor:pointer;border:1px solid #564D3C;background:none;color:#B2A694;font-family:inherit;font-size:10.5px;padding:8px 12px;">' + T('This is not my brand', 'Ce n\'est pas ma marque') + '</button>' +
      '</div>' +
    '</div>';
  }
  function showIdentityConfirm() {
    var card = cardEls[2];
    if (!card || card.querySelector('.ndl-identity-confirm')) return;
    deepCtaLock(true);
    var wrap = document.createElement('div');
    wrap.className = 'ndl-identity-confirm';
    wrap.innerHTML = identityConfirmHTML(currentResult);
    card.appendChild(wrap);
    var yes = wrap.querySelector('.ndl-identity-yes');
    var no = wrap.querySelector('.ndl-identity-no');
    if (yes) yes.addEventListener('click', function () {
      identityConfirmed = true;
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      startCheckout();
    });
    if (no) no.addEventListener('click', function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      deepCtaLock(false);
      deepMsg(T('Fix the brand name or URL, then run a new measurement.', 'Corrigez le nom ou l\'URL de la marque puis relancez une mesure.'), true);
      if (inputEl) inputEl.focus();
    });
  }
  function startCheckout() {
    /* Never let the idle offers CTA (reachable before any measurement, see
       the idle offers strip in v2.html) or a stray click race a measurement
       already in flight: state.measuring covers both a free run and a paid
       Deep Audit resume (runDeepMeasure), and starting checkout mid-run would
       read a brand that is about to change under it. Never silent: say why
       the click did nothing instead of swallowing it (see the no-silent-
       interaction audit, same message as runMeasure's own measuring guard). */
    if (state.measuring) { deepMsg(T('Measurement in progress, one moment.', 'Mesure en cours, un instant.'), false); return; }
    /* The 79-euro dossier must NEVER be buyable for a brand that has not been
       measured and identity-checked. At idle (currentResult still null - a
       fresh load, or after a failed run) there is nothing settled to sell:
       route to the free measurement first instead of ever resolving a brand
       to charge. This is the ONLY gate that matters here - once it holds,
       brand below can safely come from currentResult, and the low-confidence
       confirm right after always has a real result to confirm. */
    if (!currentResult) {
      var typed = (state.inputValue || '').trim();
      if (!typed) { if (inputEl) inputEl.focus(); deepMsg(T('Type your brand, then run the free measurement first.', 'Tapez votre marque, puis lancez d\'abord la mesure gratuite.'), true); return; }
      deepMsg(T('Running the free measurement first, the Deep Audit needs a settled result.', 'Lancement de la mesure gratuite d\'abord, le Deep Audit a besoin d\'un résultat.'), false);
      runMeasure(typed);
      return;
    }
    var brand = currentResult.focusName || state.focus || (state.inputValue || '').trim();
    if (!brand) { if (inputEl) inputEl.focus(); deepMsg(T('Run a measurement first, the Deep Audit needs a brand.', 'Lancez d\'abord un audit, le Deep Audit a besoin d\'une marque.'), true); return; }
    /* Never let a low-confidence identification reach checkout unconfirmed:
       the 79-euro dossier must never be sold on possibly the wrong company. */
    if (currentResult.confidence === 'low' && !identityConfirmed) {
      showIdentityConfirm();
      return;
    }
    var market = currentResult.market || '';
    /* Funnel: the visitor asked for the paid product. Fired here rather than on
       the raw click so an unconfirmed identity or a missing brand (both return
       above) never counts as intent to buy. */
    track('deep_click', { brand: brand, tier: 'deep' });
    deepCtaLock(true);
    deepMsg(T('Opening secure payment...', 'Ouverture du paiement sécurisé...'), false);
    fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: brand, hint: '', market: market }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, body: d }; }); })
      .then(function (r) {
        var d = r.body || {};
        if (!r.ok || !d.url) {
          deepMsg(d.error === 'payments not configured'
            ? T('Paid Deep Audit is not available yet. Check back soon.', 'Le Deep Audit par paiement n\'est pas encore disponible. Revenez bientôt.')
            : T('Cannot open payment right now. Try again in a moment.', 'Impossible d\'ouvrir le paiement pour le moment. Réessayez dans un instant.'), true);
          deepCtaLock(false);
          return;
        }
        /* The last and most valuable step before the money: Stripe is open and
           we are handing the visitor over. sendBeacon survives the navigation. */
        track('checkout_started', { brand: brand, tier: 'deep' });
        window.location = d.url;
      })
      .catch(function () {
        deepMsg(T('Cannot reach the server. Try again in a moment.', 'Impossible de joindre le serveur. Réessayez dans un instant.'), true);
        deepCtaLock(false);
      });
  }

  /* ============================ deep dossier (below the hero) ============================ */
  /* Renders ONLY for a tier==='deep' result, into #ndl-deepdoc (a sibling of
     the fixed-height hero, appended after it). The free hero stays a single
     screen; the deep dossier is deliberately the one place the page scrolls,
     because there is now a lot more to show, and it is what the 79 euro
     bought. Every field guarded: evidence/report/geo_score can all be absent
     if the backend could not produce them for this brand. */
  function scoreColorFor(s) { return s >= 71 ? SAGE : (s >= 41 ? BRASS : SIENNA); }
  var VERDICT_WORD_FR = { STABLE: 'stable', MODERE: 'modéré', VOLATIL: 'volatil', SINGLE_RUN: 'mesure unique' };
  /* Same words index.html uses for this exact verdict enum (verdictLabel),
     lowercased to match this page's own label casing. */
  var VERDICT_WORD_EN = { STABLE: 'stable', MODERE: 'moderate', VOLATIL: 'volatile', SINGLE_RUN: 'single measure' };
  function verdictWord(v) { return v ? ((PAGE_FR ? VERDICT_WORD_FR : VERDICT_WORD_EN)[v] || '') : ''; }
  /* Shared bilingual label for a brand's Google standing, used in the field
     table, the deep dossier and the downloadable HTML file alike. */
  function googleRankLabel(serpRank) { return serpRank != null ? T('Google rank ', 'Google rang ') + serpRank : T('absent from Google', 'absent de Google'); }

  function renderDeepDocHTML(R) {
    var geo = R.geo || {};
    var score = R.geoScore != null ? R.geoScore : (geo.point != null ? Math.round(geo.point) : null);
    var scoreColor = score != null ? scoreColorFor(score) : '#A39784';
    var hw = geo.half_width;
    var verdictTag = verdictWord(geo.verdict);

    var scoreBlock = score != null
      ? '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('AI visibility score', 'score de visibilité IA') + '</div>' +
          '<div style="display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;">' +
            '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(38px,4.6vw,58px);line-height:1;color:' + scoreColor + ';font-variant-numeric:tabular-nums;">' + score + '</span>' +
            (hw != null ? '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:14px;color:#A39784;font-variant-numeric:tabular-nums;">&plusmn;' + hw + '</span>' : '') +
            '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:12px;color:#958772;">/ 100</span>' +
          '</div>' +
          (verdictTag ? '<div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#958772;">' + esc(verdictTag) + '</div>' : '') +
        '</div>'
      : '';

    /* The paid session is consumed server side the moment this dossier
       renders (see reveal(): clearPendingDeep() fires exactly then), so a
       reload or a closed tab afterwards can never re-render it - there is no
       server copy left to fetch. This is the customer's only way to keep
       what they paid for, so it is offered here, before the recurring
       upsells, not buried after them. */
    var downloadBlock =
      '<div style="display:flex;flex-direction:column;gap:6px;padding-top:16px;border-top:1px solid #362E24;">' +
        '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('keep this dossier', 'garder ce dossier') + '</div>' +
        '<button class="ndl-dl-btn" id="ndl-download-btn" style="cursor:pointer;border:1px solid #463B30;background:#231D18;color:#E8DFD2;font-family:inherit;font-weight:600;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;padding:9px 14px;align-self:flex-start;">' + T('Download the dossier (HTML)', 'T&eacute;l&eacute;charger le dossier (HTML)') + '</button>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:10.5px;line-height:1.4;color:#A39784;max-width:32ch;">' + T('This payment is one time: without this file, reloading the page cannot show it again.', 'Ce paiement est unique&nbsp;: sans ce fichier, un rechargement de la page ne pourra plus le r&eacute;afficher.') + '</div>' +
      '</div>';

    var priceBlock =
      '<div style="display:flex;flex-direction:column;gap:6px;padding-top:16px;border-top:1px solid #362E24;">' +
        '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('keep measuring', 'continuer la mesure') + '</div>' +
        '<a class="ndl-mon-link" href="/settlement#pricing" data-ev="monitor_click_deep" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#C9BEAC;border-bottom:1px solid #564D3C;align-self:flex-start;">' + T('Track this brand, from 99&euro;/month', 'Suivre cette marque, dès 99&euro;/mois') + '</a>' +
        '<a class="ndl-mon-link" href="/settlement" data-ev="settlement_click_deep" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#B2A694;border-bottom:1px solid #564D3C;align-self:flex-start;">' + T('Performance settlement', 'Règlement de performance') + '</a>' +
      '</div>';

    var identityHtml = '';
    if (R.evidence && R.evidence.length) {
      var items = R.evidence.slice(0, 6).map(function (e) {
        var bits = [];
        if (e.site_name) bits.push('<b style="color:#E8DFD2;font-weight:600;">' + esc(e.site_name) + '</b>');
        if (e.title) bits.push(esc(e.title));
        if (e.description) bits.push('<span style="color:#958772;">' + esc(e.description) + '</span>');
        var src = safeHttpUrl(e.source || e.link || '');
        var srcHtml = src ? ' <a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer" style="color:#B2A694;border-bottom:1px solid #564D3C;">' + T('source', 'source') + '</a>' : '';
        return bits.length ? '<li style="margin-bottom:8px;line-height:1.55;">' + bits.join(', ') + srcHtml + '</li>' : '';
      }).join('');
      if (items) {
        identityHtml =
          '<div style="display:flex;flex-direction:column;gap:10px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('sourced evidence', 'preuve sourcée') + '</div>' +
            '<ul style="margin:0;padding-left:18px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;color:#C9BEAC;">' + items + '</ul>' +
          '</div>';
      }
    }

    var reportHtml = '';
    if (R.report) {
      var rep = R.report;
      var bsItems = (rep.blind_spots || []).map(function (b) {
        var by = (b.dominated_by || []).map(function (x) { return esc(x); }).join(', ');
        return '<li style="margin-bottom:8px;line-height:1.5;"><b style="color:#E8DFD2;font-weight:600;">' + esc(b.query) + '</b>' + (by ? T(', dominated by ', ', dominé par ') + by : '') + '</li>';
      }).join('');
      var actItems = (rep.actions || []).map(function (a) {
        return '<li style="margin-bottom:9px;line-height:1.55;">' + esc(a) + '</li>';
      }).join('');
      reportHtml =
        '<div style="display:flex;flex-direction:column;gap:18px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('remediation report', 'rapport de remédiation') + '</div>' +
            '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:8.5px;letter-spacing:0.08em;text-transform:uppercase;color:#958772;border:1px solid #362E24;padding:2px 6px;">' + T('AI generated', 'généré par IA') + '</span>' +
          '</div>' +
          (rep.verdict ? '<div style="border-left:2px solid #C6A15B;padding:2px 0 2px 14px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#D8CDBB;">' + esc(rep.verdict) + '</div>' : '') +
          (bsItems ? '<div><div style="font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#A39784;margin-bottom:8px;">' + T('named blind spots', 'angles morts nommés') + '</div><ul style="margin:0;padding-left:18px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;color:#C9BEAC;">' + bsItems + '</ul></div>' : '') +
          (actItems ? '<div><div style="font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#A39784;margin-bottom:8px;">' + T('action plan', 'plan d\'action') + '</div><ol style="margin:0;padding-left:20px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;color:#C9BEAC;">' + actItems + '</ol></div>' : '') +
        '</div>';
    }

    /* Escaped exactly ONCE, at output (line below): esc()'ing these fragments
       here too double-escaped any "&" in a provider/market label ("&amp;" ->
       "&amp;amp;") in the paid dossier. */
    var footNoteS1 = R.nQueries > 1 ? 's' : '', footNoteS2 = R.n > 1 ? 's' : '';
    var footNote = T(
      'Measured: ' + R.nQueries + ' question' + footNoteS1 + ', 1 AI (' + R.providerLabel + '), ' + R.n + (R.n > 1 ? ' passes' : ' pass') + ' per question' + (R.market ? ', market ' + R.market : '') + '.',
      'Mesuré : ' + R.nQueries + ' question' + footNoteS1 + ', 1 IA (' + R.providerLabel + '), ' + R.n + ' passage' + footNoteS2 + ' par question' + (R.market ? ', marché ' + R.market : '') + '.'
    );

    return (
      '<div style="max-width:960px;margin:0 auto;padding:clamp(32px,6vh,64px) clamp(16px,3vw,40px) clamp(48px,8vh,88px);display:flex;flex-direction:column;gap:28px;border-top:1px solid #362E24;">' +
        '<div style="display:flex;flex-direction:column;gap:6px;">' +
          '<div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#C6A15B;">' + T('deep audit, the dossier', 'deep audit, le dossier') + '</div>' +
          '<h2 style="margin:0;font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-weight:400;font-size:clamp(22px,2.6vw,34px);line-height:1.05;letter-spacing:-0.01em;color:#E8DFD2;">' + esc(R.focusName) + '</h2>' +
        '</div>' +
        '<div class="ndl-deepgrid">' +
          '<div style="display:flex;flex-direction:column;gap:28px;min-width:0;">' + identityHtml + (identityHtml && reportHtml ? '<div style="border-top:1px solid #362E24;"></div>' : '') + reportHtml + '</div>' +
          '<div style="display:flex;flex-direction:column;gap:0;">' + scoreBlock + downloadBlock + priceBlock + '</div>' +
        '</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#A39784;border-top:1px solid #362E24;padding-top:14px;">' + esc(footNote) + '</div>' +
      '</div>'
    );
  }

  /* Shows/hides #ndl-below (the deep dossier). Only ever populated for a
     settled tier==='deep' result; hidden on idle, error, or a free result (the
     free hero stays a single screen, see the hard constraint in the task). */
  function renderBelowFold() {
    if (!belowEl) return;
    var R = currentResult;
    var haveResult = !!(R && R.rows && R.rows.length);
    if (!state.settled || !haveResult || R.tier !== 'deep') {
      belowEl.style.display = 'none';
      if (deepDocEl) deepDocEl.innerHTML = '';
      return;
    }
    if (deepDocEl) {
      deepDocEl.innerHTML = renderDeepDocHTML(R);
      var dlBtn = deepDocEl.querySelector('#ndl-download-btn');
      if (dlBtn) dlBtn.addEventListener('click', downloadDossier);
    }
    belowEl.style.display = 'block';
  }

  /* ============================ standalone dossier export (download) ============================ */
  /* The paid session is consumed server side the instant the deep dossier
     renders (reveal() clears the pending-deep marker exactly then, see
     PENDING_DEEP_KEY above) - there is no server-side copy left afterwards,
     so a closed tab or a reload loses the 79-euro deliverable for good. This
     is the customer's own durable copy: a single self-contained HTML file,
     no external asset, no CDN, no remote font (system font stack only, so it
     opens and prints identically offline), inline styles throughout, and
     nothing in it that was not actually measured. Ported from index.html's
     downloadDossier(), rebuilt on v2's own result shape (buildResult's
     output) rather than the raw /api/analyze body index.html reads off
     window.__lastDeep. */
  function downloadDossier() {
    var R = currentResult;
    if (!R || R.tier !== 'deep') return;
    var brandName = R.focusName || T('brand', 'marque');
    var when = new Date().toISOString().slice(0, 10);
    var geo = R.geo || {};
    var score = R.geoScore != null ? R.geoScore : (geo.point != null ? Math.round(geo.point) : null);
    var hw = geo.half_width;
    var verdictTag = verdictWord(geo.verdict);
    var offUrl = safeHttpUrl(R.officialUrl);

    var fieldHtml = (R.fieldRows || []).map(function (f) {
      return '<tr' + (f.isFocus ? ' class="you"' : '') + '><td>' + esc(f.name) + (f.isFocus ? T(' (you)', ' (vous)') : '') + '</td><td>' + esc(aiLabel(f.ai)) + '</td><td>' + esc(googleRankLabel(f.serpRank)) + '</td><td>' + Math.round(f.share) + '%</td></tr>';
    }).join('');

    var evHtml = (R.evidence || []).slice(0, 6).map(function (e) {
      var bits = [];
      if (e.site_name) bits.push('<b>' + esc(e.site_name) + '</b>');
      if (e.title) bits.push(esc(e.title));
      if (e.description) bits.push(esc(e.description));
      var s = safeHttpUrl(e.source || e.link || '');
      return '<li>' + bits.join(', ') + (s ? ', <a href="' + esc(s) + '">' + esc(shortHost(s)) + '</a>' : '') + '</li>';
    }).join('');

    var rep = R.report || {};
    var bsHtml = (rep.blind_spots || []).map(function (b) {
      var by = (b.dominated_by || []).map(function (x) { return esc(x); }).join(', ');
      return '<li><b>' + esc(b.query) + '</b>' + (by ? T(', dominated by ', ', dominé par ') + by : '') + '</li>';
    }).join('');
    var actHtml = (rep.actions || []).map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('');
    var qHtml = (R.matrix || []).map(function (m) { return '<li>« ' + esc(m.q) + ' »</li>'; }).join('');

    var geoPm = hw != null ? (' <span style="font-size:22px;color:#8A8578;">&plusmn;' + hw + '</span>') : '';
    var geoVerdict = verdictTag ? (' <span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#4C7A5C;">' + esc(verdictTag) + '</span>') : '';
    var geoNote = hw != null
      ? T('95 percent confidence interval, across ' + R.n + ' AI reads.', 'Intervalle de confiance à 95 pour cent, sur ' + R.n + ' mesures IA.')
      : T('Single measurement, not bounded: not enough successful passes to compute a margin.', 'Mesure unique, non bornée : pas assez de passages réussis pour calculer une marge.');
    var footNoteS1 = R.nQueries > 1 ? 's' : '', footNoteS2 = R.n > 1 ? 's' : '';
    var footNote = T(
      'Measured: ' + R.nQueries + ' question' + footNoteS1 + ', 1 AI (' + R.providerLabel + '), ' + R.n + (R.n > 1 ? ' passes' : ' pass') + ' per question' + (R.market ? ', market ' + R.market : '') + '.',
      'Mesuré : ' + R.nQueries + ' question' + footNoteS1 + ', 1 IA (' + R.providerLabel + '), ' + R.n + ' passage' + footNoteS2 + ' par question' + (R.market ? ', marché ' + R.market : '') + '.'
    );

    var docLang = PAGE_FR ? 'fr' : 'en';
    var docTitle = T('Nadelio, Deep Audit: ' + brandName, 'Nadelio, Deep Audit ' + brandName);

    var doc = '<!doctype html><html lang="' + docLang + '"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(docTitle) + '</title><style>' +
      ':root{--sage:#3D6B5C;--sage-signal:#4C8F72;--surface:#EDEBE4;--card:#FBFAF6;--ink:#191510;--line:#D9D6CC;--muted:#6E6C64;}' +
      '*{box-sizing:border-box;}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--surface);line-height:1.55;margin:0;padding:40px 20px;}' +
      '.wrap{max-width:820px;margin:0 auto;}' +
      '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px;margin-bottom:20px;}' +
      '.badge{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;background:rgba(61,107,92,.12);color:var(--sage);padding:5px 11px;border-radius:8px;margin-bottom:14px;}' +
      'h1{font-size:28px;letter-spacing:-.01em;margin:0 0 6px;}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;}' +
      '.meta{font-size:13px;color:var(--muted);margin-bottom:18px;}' +
      '.geo{font-family:ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:48px;font-weight:700;letter-spacing:-.02em;color:var(--sage);}' +
      '.insight{background:rgba(61,107,92,.08);border-left:3px solid var(--sage-signal);padding:14px 16px;border-radius:0 10px 10px 0;margin:14px 0;}' +
      'table{border-collapse:collapse;width:100%;font-size:13px;}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);}th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em;}td{font-variant-numeric:tabular-nums;}' +
      'tr.you{background:rgba(61,107,92,.1);font-weight:600;}' +
      'a{color:var(--sage);}ul,ol{padding-left:20px;}li{margin-bottom:6px;}' +
      'footer{text-align:center;font-size:12px;color:var(--muted);margin-top:20px;}' +
      '@media print{body{background:#fff;padding:0;}.card{border:none;}}' +
      '</style></head><body><div class="wrap">' +
      '<div class="card"><span class="badge">' + T('Nadelio, Deep Audit, sourced', 'Nadelio, Deep Audit, sourcé') + '</span>' +
      '<h1>' + esc(brandName) + '</h1>' +
      '<div class="meta">' + T('Generated on ', 'Généré le ') + esc(when) + (R.market ? T(', market ', ', marché ') + esc(R.market) : '') + '.</div>' +
      (R.identifiedAs ? ('<h2>' + T('Verified identity', 'Identité vérifiée') + '</h2><p>' + esc(R.identifiedAs) + '</p>' + (offUrl ? ('<p class="meta">' + T('Official source: ', 'Source officielle : ') + '<a href="' + esc(offUrl) + '">' + esc(shortHost(offUrl)) + '</a></p>') : '')) : '') +
      (evHtml ? ('<h2>' + T('Sourced evidence', 'Preuve sourcée') + '</h2><ul>' + evHtml + '</ul>') : '') +
      '</div>' +
      '<div class="card"><h2>' + T('AI visibility score', 'Score de visibilité IA') + '</h2><div class="geo">' + (score != null ? score : '-') + geoPm + '<span style="font-size:20px;color:var(--muted);">/100</span></div>' + geoVerdict +
      '<p class="meta" style="margin-top:10px;">' + geoNote + '</p></div>' +
      '<div class="card"><h2>' + T('The measured field', 'Le champ mesuré') + '</h2><table><thead><tr><th>' + T('Brand', 'Marque') + '</th><th>' + T('In AI', 'En IA') + '</th><th>' + T('On Google', 'Sur Google') + '</th><th>' + T('Share of voice', 'Part de voix') + '</th></tr></thead><tbody>' + fieldHtml + '</tbody></table></div>' +
      (qHtml ? ('<div class="card"><h2>' + T('Questions asked', 'Questions posées') + '</h2><ul>' + qHtml + '</ul></div>') : '') +
      ((rep.verdict || bsHtml || actHtml) ? ('<div class="card"><h2>' + T('Remediation report', 'Rapport de remédiation') + '</h2><p style="color:#4C7A5C;font-size:12px;">' + T('AI generated recommendations, based on the measurement above.', 'Recommandations générées par IA, fondées sur la mesure ci-dessus.') + '</p>' +
        (rep.verdict ? ('<div class="insight">' + esc(rep.verdict) + '</div>') : '') +
        (bsHtml ? ('<h2 style="margin-top:16px;">' + T('Named blind spots', 'Angles morts nommés') + '</h2><ul>' + bsHtml + '</ul>') : '') +
        (actHtml ? ('<h2 style="margin-top:16px;">' + T('Action plan', 'Plan d\'action') + '</h2><ol>' + actHtml + '</ol>') : '') + '</div>') : '') +
      '<div class="card"><p class="meta" style="margin:0;">' + esc(footNote) + '</p></div>' +
      '<footer>Nadelio, nadelio.com, ' + esc(when) + '</footer>' +
      '</div></body></html>';

    var blob = new Blob([doc], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'nadelio-deep-audit-' + String(brandName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + when + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ============================ free-tier export (lighter standalone HTML) ============================
     downloadDossier() above is tier==='deep' only (it reads evidence/report,
     fields a free result never carries). Free visitors still measured a real,
     bounded result and deserve a durable copy of it: the same self-contained,
     no-CDN, system-font HTML pattern, trimmed to what a free read actually
     has - verdict, the bounded score, the measured field, the methodology
     footnote. Never the deep-only evidence/report sections. */
  function downloadFreeExport() {
    var R = currentResult;
    if (!R || R.tier === 'deep') return; // the deep dossier keeps its own richer export
    var brandName = R.focusName || T('brand', 'marque');
    var when = new Date().toISOString().slice(0, 10);
    var geo = R.geo || {};
    var point = geo.point;
    var hw = geo.half_width;
    var verdict = computeVerdict(R.focusName, R.geo, R.rival);
    var verdictTag = verdictWord(geo.verdict);
    var measuredDate = R.measuredAt ? String(R.measuredAt).slice(0, 10) : '';

    var fieldHtml = (R.fieldRows || []).map(function (f) {
      return '<tr' + (f.isFocus ? ' class="you"' : '') + '><td>' + esc(f.name) + (f.isFocus ? T(' (you)', ' (vous)') : '') + '</td><td>' + esc(aiLabel(f.ai)) + '</td><td>' + esc(googleRankLabel(f.serpRank)) + '</td><td>' + Math.round(f.share) + '%</td></tr>';
    }).join('');

    var footNoteS1 = R.nQueries > 1 ? 's' : '', footNoteS2 = R.n > 1 ? 's' : '';
    var footNote = T(
      'Measured: ' + R.nQueries + ' question' + footNoteS1 + ', 1 AI (' + R.providerLabel + (R.aiModel ? ', ' + R.aiModel : '') + '), ' + R.n + (R.n > 1 ? ' passes' : ' pass') + ' per question' + (R.market ? ', market ' + R.market : '') + (measuredDate ? ', measured on ' + measuredDate : '') + '.',
      'Mesuré : ' + R.nQueries + ' question' + footNoteS1 + ', 1 IA (' + R.providerLabel + (R.aiModel ? ', ' + R.aiModel : '') + '), ' + R.n + ' passage' + footNoteS2 + ' par question' + (R.market ? ', marché ' + R.market : '') + (measuredDate ? ', mesuré le ' + measuredDate : '') + '.'
    );

    var docLang = PAGE_FR ? 'fr' : 'en';
    var docTitle = T('Nadelio, AI visibility: ' + brandName, 'Nadelio, visibilité IA ' + brandName);
    var geoPm = hw != null ? (' <span style="font-size:22px;color:#8A8578;">&plusmn;' + hw + '</span>') : '';
    var geoVerdictHtml = verdictTag ? (' <span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#4C7A5C;">' + esc(verdictTag) + '</span>') : '';
    var geoNote = hw != null
      ? T('95 percent confidence interval, across ' + R.n + ' AI reads.', 'Intervalle de confiance à 95 pour cent, sur ' + R.n + ' mesures IA.')
      : T('Single measurement, not bounded: not enough successful passes to compute a margin.', 'Mesure unique, non bornée : pas assez de passages réussis pour calculer une marge.');

    var doc = '<!doctype html><html lang="' + docLang + '"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(docTitle) + '</title><style>' +
      ':root{--sage:#3D6B5C;--sage-signal:#4C8F72;--surface:#EDEBE4;--card:#FBFAF6;--ink:#191510;--line:#D9D6CC;--muted:#6E6C64;}' +
      '*{box-sizing:border-box;}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--surface);line-height:1.55;margin:0;padding:40px 20px;}' +
      '.wrap{max-width:820px;margin:0 auto;}' +
      '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px;margin-bottom:20px;}' +
      '.badge{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;background:rgba(61,107,92,.12);color:var(--sage);padding:5px 11px;border-radius:8px;margin-bottom:14px;}' +
      'h1{font-size:28px;letter-spacing:-.01em;margin:0 0 6px;}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;}' +
      '.meta{font-size:13px;color:var(--muted);margin-bottom:18px;}' +
      '.geo{font-family:ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:48px;font-weight:700;letter-spacing:-.02em;color:var(--sage);}' +
      '.insight{background:rgba(61,107,92,.08);border-left:3px solid var(--sage-signal);padding:14px 16px;border-radius:0 10px 10px 0;margin:14px 0;}' +
      'table{border-collapse:collapse;width:100%;font-size:13px;}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);}th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em;}td{font-variant-numeric:tabular-nums;}' +
      'tr.you{background:rgba(61,107,92,.1);font-weight:600;}' +
      'a{color:var(--sage);}' +
      'footer{text-align:center;font-size:12px;color:var(--muted);margin-top:20px;}' +
      '@media print{body{background:#fff;padding:0;}.card{border:none;}}' +
      '</style></head><body><div class="wrap">' +
      '<div class="card"><span class="badge">' + T('Nadelio, AI visibility read', 'Nadelio, lecture de visibilité IA') + '</span>' +
      '<h1>' + esc(brandName) + '</h1>' +
      '<div class="meta">' + T('Generated on ', 'Généré le ') + esc(when) + (R.market ? T(', market ', ', marché ') + esc(R.market) : '') + '.</div>' +
      (verdict.title ? ('<div class="insight">' + esc(verdict.title) + ' ' + esc(verdict.text) + '</div>') : '') +
      '</div>' +
      '<div class="card"><h2>' + T('AI visibility score', 'Score de visibilité IA') + '</h2><div class="geo">' + (point != null ? point : '-') + geoPm + '<span style="font-size:20px;color:var(--muted);">/100</span></div>' + geoVerdictHtml +
      '<p class="meta" style="margin-top:10px;">' + geoNote + '</p></div>' +
      '<div class="card"><h2>' + T('The measured field', 'Le champ mesuré') + '</h2><table><thead><tr><th>' + T('Brand', 'Marque') + '</th><th>' + T('In AI', 'En IA') + '</th><th>' + T('On Google', 'Sur Google') + '</th><th>' + T('Share of voice', 'Part de voix') + '</th></tr></thead><tbody>' + fieldHtml + '</tbody></table></div>' +
      '<div class="card"><p class="meta" style="margin:0;">' + esc(footNote) + '</p></div>' +
      '<footer>Nadelio, nadelio.com, ' + esc(when) + '</footer>' +
      '</div></body></html>';

    var blob = new Blob([doc], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'nadelio-' + String(brandName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + when + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ============================ share this result ============================
     The growth loop: a settled result (free OR deep) can be turned into a
     public, server-rendered page at /r/<token> with real bounded numbers on
     it - every share is itself an advertisement for the product. The ONLY
     input this ever sends is the verbatim raw text of the /api/analyze
     response this page already holds (currentResult.raw, see readJsonWithRaw
     above): the server re-verifies its own signature over that exact text
     before minting a token, so nothing invented can ever become a "measured
     by Nadelio" page (see app.py's _sign_share / /api/share). */
  function shareAffordanceHTML(tier) {
    var shareBtn =
      '<button id="ndl-share-btn" class="ndl-share-btn" data-ev="share_click" style="cursor:pointer;background:none;border:none;font-family:inherit;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding:0 0 2px;">'
      + T('Share this result', 'Partager ce résultat') + ' &rsaquo;</button>';
    /* The deep dossier already carries its own richer download button below
       the hero (see renderDeepDocHTML's downloadBlock) - never a second,
       competing export affordance for the same tier. */
    var exportBtn = (tier === 'deep') ? '' :
      '<button id="ndl-export-btn" class="ndl-share-btn" style="cursor:pointer;background:none;border:none;font-family:inherit;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding:0 0 2px;">'
      + T('Export (HTML)', 'Exporter (HTML)') + '</button>';
    return '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">'
      + '<span id="ndl-share-slot">' + shareBtn + '</span>' + exportBtn + '</div>';
  }

  /* Replaces ONLY the share button/status area, leaving the export button (a
     sibling, outside this slot) untouched. */
  function showShareMessage(msg) {
    var slot = document.getElementById('ndl-share-slot');
    if (!slot) return;
    slot.innerHTML = '<span style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#958772;">' + esc(msg) + '</span>';
  }

  function showShareLink(url) {
    var slot = document.getElementById('ndl-share-slot');
    if (!slot) return;
    slot.innerHTML =
      '<span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<a id="ndl-share-url" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:11px;color:#C9BEAC;border-bottom:1px solid #564D3C;">' + esc(url) + '</a>' +
        '<button id="ndl-share-copy" style="cursor:pointer;border:1px solid #463B30;background:none;color:#B2A694;font-family:inherit;font-size:10.5px;padding:4px 8px;">' + T('Copy link', 'Copier le lien') + '</button>' +
      '</span>';
    var copyBtn = document.getElementById('ndl-share-copy');
    var linkEl = document.getElementById('ndl-share-url');
    if (!copyBtn) return;
    copyBtn.addEventListener('click', function () {
      var reset = function () { copyBtn.textContent = T('Copy link', 'Copier le lien'); };
      var done = function () { copyBtn.textContent = T('Copied', 'Copié'); setTimeout(reset, 1600); };
      /* Select-fallback when the Clipboard API is unavailable (insecure
         context, older browser, permission denied): select the URL text so
         the visitor can copy it themselves with Ctrl+C / Cmd+C. Never claims
         "Copied" for a selection that was not actually written anywhere. */
      var selectFallback = function () {
        try {
          var range = document.createRange();
          range.selectNodeContents(linkEl);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}
        copyBtn.textContent = T('Selected, press Ctrl+C', 'Sélectionné, faites Ctrl+C');
        setTimeout(reset, 2400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, selectFallback);
      } else {
        selectFallback();
      }
    });
  }

  function onShareClick() {
    var R = currentResult;
    if (!R || !R.raw) return;
    var btn = document.getElementById('ndl-share-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = T('Sharing...', 'Partage...'); }
    fetch('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: R.raw })
    })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, body: d }; }); })
      .then(function (r) {
        if (currentResult !== R) return; // a new measurement started meanwhile
        var d = r.body || {};
        if (!r.ok || !d.url) {
          showShareMessage(d.error === 'sharing not configured'
            ? T('Sharing is not available yet.', 'Le partage n\'est pas encore disponible.')
            : T('Could not create the share link. Try again in a moment.', 'Impossible de créer le lien de partage. Réessayez dans un instant.'));
          return;
        }
        showShareLink(location.origin + d.url);
      })
      .catch(function () {
        if (currentResult !== R) return;
        showShareMessage(T('Cannot reach the server. Try again in a moment.', 'Impossible de joindre le serveur. Réessayez dans un instant.'));
      });
  }

  /* Rebuilds the share/export widget only when the settled result itself
     changes (called from the same lastContentSig gate as renderVerdict/
     renderField in render() below) - never on every keystroke, and always
     cleared back to nothing at idle/measuring (no stale "copied" state
     bleeding into a brand-new measurement). */
  function renderShareAffordance(v) {
    if (!shareEl) return;
    if (!v.haveResult) { shareEl.innerHTML = ''; return; }
    shareEl.innerHTML = shareAffordanceHTML(currentResult ? currentResult.tier : 'free');
    var sBtn = document.getElementById('ndl-share-btn');
    if (sBtn) sBtn.addEventListener('click', onShareClick);
    var eBtn = document.getElementById('ndl-export-btn');
    if (eBtn) eBtn.addEventListener('click', downloadFreeExport);
  }

  /* ============================ Stripe return (paid / sub) ============================ */
  /* Ported from index.html (resumeDeepAudit / resumeVerifyRetry / payError /
     runDeepAnalysis / resumeSubscription), recast in the v2 language: the
     Stripe return borrows the SAME #ndl-overlay node the normal "lecture en
     cours" loading state uses (state.measuring / state.payError both flip its
     opacity via renderVals()), so a paying customer always lands on the exact
     same instrument, mid read, never a blank or a dead page. */
  function payStepsHTML(lines) {
    var html = '<div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#A39784;">' + T('payment', 'paiement') + '</div>';
    html += '<div style="display:flex;flex-direction:column;gap:5px;margin-top:2px;">';
    lines.forEach(function (l) {
      var color = l.state === 'done' ? SAGE : (l.state === 'active' ? '#E8DFD2' : '#A39784');
      var mark = l.state === 'done' ? '&#10003; ' : '';
      var dots = l.state === 'active'
        ? '<span style="animation:dotpulse 1s infinite;">.</span><span style="animation:dotpulse 1s 0.25s infinite;">.</span><span style="animation:dotpulse 1s 0.5s infinite;">.</span>'
        : '';
      html += '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;color:' + color + ';">' + mark + esc(l.text) + dots + '</div>';
    });
    html += '</div>';
    return html;
  }
  function showPayStep(lines) {
    setState({ measuring: true, settled: false, payError: false });
    if (overlayEl) overlayEl.innerHTML = payStepsHTML(lines);
  }
  function showPayError(msg, retryFn) {
    stopMeasureTick();
    setState({ measuring: false, settled: false, payError: true });
    if (!overlayEl) return;
    overlayEl.innerHTML =
      '<div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#A39784;">' + T('payment', 'paiement') + '</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#D8CDBB;max-width:52ch;">' + esc(msg) + '</div>' +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:8px;flex-wrap:wrap;">' +
        (retryFn ? '<button class="ndl-pay-retry" style="cursor:pointer;border:none;background:#E8DFD2;color:#211A14;font-family:inherit;font-weight:600;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 14px;">' + T('Try again', 'Réessayer') + '</button>' : '') +
        '<a href="mailto:' + SUPPORT_EMAIL + '" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#B2A694;border-bottom:1px solid #564D3C;">' + T('Contact support', 'Contacter le support') + '</a>' +
      '</div>';
    if (retryFn) {
      var btn = overlayEl.querySelector('.ndl-pay-retry');
      if (btn) btn.addEventListener('click', retryFn);
    }
  }
  function resetOverlayContent() {
    if (overlayEl && defaultOverlayHTML) overlayEl.innerHTML = defaultOverlayHTML;
  }

  /* Runs the deep audit itself once a payment is confirmed (fresh session or a
     retried one). Same two-step /api/infer -> /api/analyze flow as a normal
     measurement, but {deep:true, paid_session} on the analyze call, exactly
     like index.html's runDeepAnalysis. A failure here never loses the
     payment: it always offers Retry + support, the audit can be re-run on the
     same paid_session (the slot is only consumed once analyze truly succeeds).
     `market` (optional) is the market the FREE preview already measured in
     (recovered from the Stripe session via /api/verify-payment) - forced onto
     both calls so the 79-euro dossier is never geolocated to a different
     market than the free read the customer paid on. */
  function runDeepMeasure(brand, sessionId, market) {
    var gen = ++measureGen;
    currentResult = null;
    identityConfirmed = false;
    measureStart = performance.now();
    setState({ focus: brand, inputValue: brand, measuring: true, settled: false, payError: false, unknownMsg: '', passCount: 0 });
    renderBelowFold();
    startMeasureTick();
    if (scene) buildClusters(loadingRows(), !reduced, '');
    if (reduced) renderResolved();
    showPayStep([
      { text: T('Payment confirmed', 'Paiement confirmé'), state: 'done' },
      { text: T('Audit running (30 to 60s)', 'Audit en cours (30 à 60s)'), state: 'active' },
      { text: T('Dossier ready', 'Dossier prêt'), state: 'pending' }
    ]);
    var loadStart = performance.now();
    var officialUrl = '';
    var inferBody = { brand: brand, deep: true };
    if (market) inferBody.market = market;
    fetch('/api/infer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inferBody) })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .catch(function () { return {}; })
      .then(function (inf) {
        if (gen !== measureGen) return null;
        officialUrl = (inf && inf.official_url) || '';
        var body = { live: true, brand: brand, deep: true, paid_session: sessionId };
        if (inf && !inf.error && inf.competitors && inf.competitors.length && inf.queries && inf.queries.length) {
          body.competitors = inf.competitors; body.queries = inf.queries; body.sector = inf.sector;
          body.market_label = inf.market; body.query_language = inf.query_language;
          /* Anchor the paid run's identity confirmation at least as well as
             the free one: forward what /api/infer resolved, so a low-confidence
             identification stays low-confidence here too (never silently
             upgraded just because the customer already paid). */
          body.identified_as = inf.identified_as; body.confidence = inf.confidence;
        }
        if (market) body.market = market;
        return fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(readJsonWithRaw);
      })
      .then(function (ana) {
        if (ana == null || gen !== measureGen) return;
        var d = ana.body || {};
        if (!ana.ok || d.error || !d.ranking || !d.geo || d.geo.point == null) {
          showPayError(T('Payment is confirmed but the audit did not complete. Try again or contact support, your payment is safe.', 'Le paiement est confirmé mais l\'audit n\'a pas abouti. Réessayez ou contactez le support, votre paiement est en sécurité.'), function () { runDeepMeasure(brand, sessionId, market); });
          return;
        }
        /* Same guard on the paid path: the backend falls back to its demo
           fixture on a live failure. A customer who just paid must never be
           handed another brand's sample as their dossier. */
        if (d.mode !== 'live') {
          showPayError(T('Payment is confirmed but the measurement did not complete. Try again or contact support, your payment is safe.', 'Le paiement est confirmé mais la mesure n\'a pas abouti. Réessayez ou contactez le support, votre paiement est en sécurité.'), function () { runDeepMeasure(brand, sessionId, market); });
          return;
        }
        /* The paid gate (app.py _resolve_paid_depth) fails CLOSED to a FREE
           2-question audit on six distinct backend conditions (expired
           session, restart, Stripe unreachable, ...) and still answers 200
           with mode:"live". Without this check a payer who hit one of those
           would silently be served the free tier AND shown the "Deep Audit,
           79 EUR" button again, having already paid once. Never present a
           non-deep response as the paid dossier, and never offer a naive
           retry here: the session is already durably consumed on Stripe, so
           retrying only re-runs the same downgrade. Support can unlock it. */
        if (d.tier !== 'deep') {
          showPayError(T('Payment is confirmed but the Deep Audit could not be unlocked automatically. Contact support with your Stripe receipt, we will run it for you, your payment is safe.', 'Le paiement est confirmé mais l\'audit approfondi n\'a pas pu être débloqué automatiquement. Contactez le support avec votre reçu Stripe, nous le lançons pour vous, votre paiement est en sécurité.'), null);
          return;
        }
        currentResult = buildResult(d);
        currentResult.officialUrl = officialUrl;
        /* see runReal's identical comment: the verbatim raw text is the ONLY
           thing /api/share will ever accept. */
        currentResult.raw = ana.raw || '';
        measureStart = performance.now();
        if (scene) buildClusters(currentResult.rows, !reduced, currentResult.focusName);
        if (reduced) renderResolved();
        resetOverlayContent();
        var wait = reduced ? 0 : Math.max(0, MIN_LOAD_MS - (performance.now() - loadStart));
        clearTimeout(revealT);
        revealT = setTimeout(function () { reveal(gen); }, wait);
      })
      .catch(function () {
        showPayError(T('Cannot reach the instrument. Your payment is safe, try again or contact support.', 'Impossible de joindre l\'instrument. Votre paiement est en sécurité, réessayez ou contactez le support.'), function () { runDeepMeasure(brand, sessionId, market); });
      });
  }

  function showConsumedMessage() {
    /* Terminal state - this session has nothing left to resume. */
    stopMeasureTick();
    clearPendingDeep();
    setState({ measuring: false, settled: false, payError: true });
    if (!overlayEl) return;
    overlayEl.innerHTML =
      '<div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#A39784;">' + T('payment', 'paiement') + '</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#D8CDBB;max-width:52ch;">' + T('This Deep Audit has already been used. Each payment unlocks one dossier. Run a new Deep Audit to get another one, or contact support if this is a mistake.', 'Ce Deep Audit a déjà été utilisé. Chaque paiement débloque un dossier unique. Lancez un nouveau Deep Audit pour en obtenir un autre, ou contactez le support si ceci est une erreur.') + '</div>' +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:8px;">' +
        '<a href="mailto:' + SUPPORT_EMAIL + '" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#B2A694;border-bottom:1px solid #564D3C;">' + T('Contact support', 'Contacter le support') + '</a>' +
      '</div>';
  }

  /* Entry point for a ?paid={CHECKOUT_SESSION_ID}&brand=<enc> return. Verifies
     first (never trusts the URL alone), then either runs the deep audit, says
     the session is already consumed, or offers Retry + support on failure.
     The URL is scrubbed immediately (a refresh must never resend the same
     link to Stripe's verify endpoint as a fresh navigation), but the session
     id is first persisted to sessionStorage (see PENDING_DEEP_KEY) and is only
     cleared once the deep dossier actually renders (reveal()) or the session
     is confirmed already spent (showConsumedMessage()) - so a reload or a
     crash mid-audit can always resume the SAME paid run instead of losing it. */
  function resumeDeepAudit(sessionId, brandParam) {
    savePendingDeep(sessionId, brandParam || '');
    try { history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
    if (brandParam) { if (inputEl) inputEl.value = brandParam; }
    setState({ focus: brandParam || state.focus, inputValue: brandParam || state.inputValue });
    showPayStep([{ text: T('Confirming payment', 'Confirmation du paiement'), state: 'active' }]);
    fetch('/api/verify-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, body: d }; }); })
      .then(function (r) {
        var d = r.body || {};
        if (!d.ok) {
          showPayError(T('We could not confirm this payment. If you were charged, try again or contact support with your Stripe receipt.', 'Nous n\'avons pas pu confirmer ce paiement. Si vous avez été débité, réessayez ou contactez le support avec votre reçu Stripe.'), function () { resumeDeepAudit(sessionId, brandParam); });
          return;
        }
        if (d.consumed) { showConsumedMessage(); return; }
        var brand = d.brand || brandParam || state.focus;
        /* d.market is the market the FREE preview was measured in, recovered
           from the Stripe session metadata - forces the paid dossier onto the
           same market instead of letting it re-infer a possibly different one. */
        runDeepMeasure(brand, sessionId, d.market || '');
      })
      .catch(function () {
        showPayError(T('Cannot confirm the payment right now. If you were charged, try again or contact support with your receipt.', 'Impossible de confirmer le paiement pour le moment. Si vous avez été débité, réessayez ou contactez le support avec votre reçu.'), function () { resumeDeepAudit(sessionId, brandParam); });
      });
  }

  /* Entry point for a ?sub={CHECKOUT_SESSION_ID} monitoring return. Purely a
     confirmation toast, it never touches the measurement state machine or the
     hero: the visitor can still type a brand and run a free audit underneath. */
  function showSubBanner(brand, tier, failed) {
    if (!subBannerEl) return;
    var html;
    if (failed) {
      html = '<div style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + T('monitoring', 'suivi') + '</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#D8CDBB;margin-top:4px;">' + T('We could not confirm this subscription. If you just paid, wait a moment and refresh, or contact support.', 'Nous n\'avons pas pu confirmer cet abonnement. Si vous venez de payer, patientez un instant et actualisez, ou contactez le support.') + '</div>';
    } else {
      var b = esc(brand || T('your brand', 'votre marque'));
      var t = tier ? esc(tier) : '';
      html = '<div style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#93A06E;">' + T('monitoring active', 'suivi actif') + '</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#D8CDBB;margin-top:4px;">' + T('Monitoring is active for ', 'Le suivi est actif pour ') + '<b style="color:#E8DFD2;">' + b + '</b>' + (t ? T(' (' + t + ' plan)', ' (plan ' + t + ')') : '') + T('. The first bounded measurement runs this week, you will be alerted the moment the score turns volatile.', '. La première mesure bornée tourne cette semaine, vous serez alerté dès que le score devient volatil.') + '</div>';
    }
    html += '<button class="ndl-subbanner-close" aria-label="' + T('close', 'fermer') + '" style="position:absolute;top:8px;right:8px;cursor:pointer;background:none;border:none;color:#A39784;font-family:inherit;font-size:13px;line-height:1;padding:4px;">&times;</button>';
    subBannerEl.innerHTML = html;
    subBannerEl.style.display = 'block';
    var closeBtn = subBannerEl.querySelector('.ndl-subbanner-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { subBannerEl.style.display = 'none'; });
  }
  function resumeSubscription(sessionId) {
    try { history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
    fetch('/api/verify-subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }) })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .catch(function () { return {}; })
      .then(function (d) {
        if (d && d.ok) showSubBanner(d.brand, d.tier, false);
        else showSubBanner(null, null, true);
      });
  }

  /* Reads ?paid / ?sub / ?brand once at boot and routes to the matching
     resume flow. ?paid takes priority (a returning payer must always land on
     a working page, per the task's hard requirement); then a sessionStorage-
     -persisted deep session interrupted earlier (reload recovery, see
     resumeDeepAudit); then ?sub; then a plain ?brand=, which only PREFILLS
     the input - it never auto-runs. A real audit costs money on every load
     (SERP + LLM calls), and this URL param is exactly the one an outreach
     link or a bare page share puts in front of link-preview bots and casual
     clicks with no user intent to spend anything; the visitor must press
     "Lancer un audit" themselves. */
  function bootstrapParams() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
    var paid = params ? params.get('paid') : null;
    var sub = params ? params.get('sub') : null;
    var brandParam = params ? (params.get('brand') || '').trim() : '';
    if (paid) { resumeDeepAudit(paid, brandParam); return; }
    var pending = readPendingDeep();
    if (pending) { resumeDeepAudit(pending.sessionId, pending.brand || ''); return; }
    if (sub) { resumeSubscription(sub); return; }
    if (brandParam) {
      setState({ focus: brandParam, inputValue: brandParam });
      try { history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
    }
  }

  /* ============================ measurement control ============================ */
  /* Real two-step flow, same-origin: /api/infer identifies the brand + proposes
     the queries, then /api/analyze runs the bounded audit. The loading animation
     starts optimistically at once; the reveal fires on DATA ARRIVAL. */
  function runMeasure(rawName) {
    /* Refuse to start a new run while one is already in flight (free OR paid -
       state.measuring covers both, see runDeepMeasure). Without this, one
       Enter/click during a 30-60s paid Deep Audit silently starts a competing
       free run: it bumps measureGen, so the paid result's own `gen !==
       measureGen` guard then discards it on arrival even though the server
       already delivered (and billed) it. DOM-enforced too, see render().
       Never silent though: a click/Enter while measuring must still say
       something, not just do nothing (see the no-silent-interaction audit). */
    if (state.measuring) { setState({ unknownMsg: T('Measurement in progress, one moment.', 'Mesure en cours, un instant.') }); return; }
    var name = (rawName || '').trim();
    if (!name) { setState({ unknownMsg: T('Type a brand name.', 'Tapez le nom d\'une marque.') }); return; }
    /* The visitor committed to a real measurement. Brand passed explicitly:
       currentResult still holds the previous audit at this point. */
    track('input_submitted', { brand: name });
    resetOverlayContent();
    var gen = ++measureGen;
    currentResult = null;
    identityConfirmed = false;
    setState({ focus: name, inputValue: name, measuring: true, settled: false, payError: false, unknownMsg: '', passCount: 0 });
    renderBelowFold();
    startMeasureTick();
    measureStart = performance.now();
    if (scene) buildClusters(loadingRows(), !reduced, '');
    if (reduced) renderResolved();
    clearSlowNote();
    slowNoteT = setTimeout(function () { if (gen === measureGen && state.measuring) showSlowNote(); }, 8000);
    runReal(name, gen);
  }

  function runReal(name, gen) {
    var loadStart = performance.now();
    var officialUrl = '';
    /* Forward the identity + market control (see toggleIdPanel above): empty
       strings when the panel was never touched, so the default flow is byte-
       for-byte the same request as before this fix. */
    var reqOfficialUrl = getOfficialUrlInput(), reqMarket = getMarketInput();
    fetch('/api/infer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: name, official_url: reqOfficialUrl, market: reqMarket }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, status: res.status, body: d }; }); })
      .then(function (inf) {
        if (gen !== measureGen) return null;
        var d = inf.body || {};
        officialUrl = d.official_url || '';
        var usable = inf.ok && !d.error && d.competitors && d.competitors.length && d.queries && d.queries.length;
        if (!usable) {
          /* Attribute the failure honestly. app.py answers 502 for BOTH its own
             breakage (missing key, or the identification model overloaded and
             giving up after its retries) AND for a genuine "Could not infer
             competitors for this brand". Only the latter is the visitor's
             brand: telling someone to check the spelling of their own company
             name because OUR model was overloaded blames them for our outage.
             The backend's error string is the only signal that separates the
             two, so match on it and default to blaming ourselves. */
          var errTxt = String((d && d.error) || '');
          var brandProblem = /could not infer competitors/i.test(errTxt);
          failMeasure(gen, inf.status === 429
            ? T('Too many requests, wait a moment.', 'Trop de requêtes, patientez un instant.')
            : brandProblem
              ? T('Brand not found. Check the spelling or paste your website.', 'Marque introuvable. Vérifiez l\'orthographe ou collez votre site.')
              : (inf.status >= 500)
                ? T('The instrument is briefly unavailable. Nothing was measured, try again in a moment.', 'L\'instrument est momentanément indisponible. Rien n\'a été mesuré, réessayez dans un instant.')
                : T('Brand not found. Check the spelling or paste your website.', 'Marque introuvable. Vérifiez l\'orthographe ou collez votre site.'));
          return null;
        }
        return fetch('/api/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            live: true, brand: d.brand || name, sector: d.sector,
            competitors: d.competitors, queries: d.queries,
            market_label: d.market, query_language: d.query_language,
            identified_as: d.identified_as, confidence: d.confidence
          })
        }).then(readJsonWithRaw);
      })
      .then(function (ana) {
        if (ana == null || gen !== measureGen) return;
        var d = ana.body || {};
        if (!ana.ok || d.error || !d.ranking || !d.geo || d.geo.point == null) {
          failMeasure(gen, (d.error === 'quota_ip')
            ? T('Daily limit reached (3 free audits per day, per visitor). Come back tomorrow or move to Pro monitoring.', 'Limite du jour atteinte (3 audits gratuits par jour, par visiteur). Revenez demain ou passez au suivi Pro.')
            : (d.error === 'quota_global' || ana.status === 429)
              ? T('Today\'s free measurements are used up for everyone. Come back tomorrow, or move to Pro monitoring.', 'Les mesures gratuites du jour sont épuisées pour tout le monde. Revenez demain, ou passez au suivi Pro.')
              : T('The measurement did not complete. Try again in a moment.', 'La mesure n\'a pas pu aboutir. Réessayez dans un instant.'));
          return;
        }
        /* When the live pipeline fails (a SERP or model hiccup), the backend
           still answers 200 with its DEMO fixture (mode "demo"), which is a
           different brand entirely. Never present that as this visitor's
           measurement: a tool whose whole promise is honesty cannot show
           someone else's numbers under your brand name. */
        if (d.mode !== 'live') {
          failMeasure(gen, T('The measurement did not complete for ' + name + '. Try again in a moment.', 'La mesure n\'a pas pu aboutir pour ' + name + '. Réessayez dans un instant.'));
          return;
        }
        currentResult = buildResult(d);
        currentResult.officialUrl = officialUrl;
        /* The exact raw response text, verbatim - the ONLY thing /api/share
           will ever accept (see readJsonWithRaw above and onShareClick
           below). Never rebuilt from `d`: a JS re-stringify would reformat
           floats and break the server's signature verification. */
        currentResult.raw = ana.raw || '';
        /* rebuild the 3D from the REAL rows and re-arm the burst so the cloud
           visibly converges on the reveal, whatever the fetch latency was. */
        measureStart = performance.now();
        if (scene) buildClusters(currentResult.rows, !reduced, currentResult.focusName);
        if (reduced) renderResolved();
        var wait = reduced ? 0 : Math.max(0, MIN_LOAD_MS - (performance.now() - loadStart));
        clearTimeout(revealT);
        revealT = setTimeout(function () { reveal(gen); }, wait);
      })
      .catch(function () {
        failMeasure(gen, T('Cannot reach the instrument. Nothing was measured.', 'Impossible de joindre l\'instrument. Rien n\'a été mesuré.'));
      });
  }

  function failMeasure(gen, msg) {
    if (gen !== measureGen) return;
    clearSlowNote();
    stopMeasureTick();
    clearTimeout(revealT);
    currentResult = null;
    setState({ measuring: false, settled: false, payError: false, unknownMsg: msg, passCount: 0 });
    if (scene) buildClusters(loadingRows(), false, '');
    if (reduced) renderResolved();
    renderBelowFold();
  }

  /* ============================ adapter: d -> view model ============================ */
  /* Turns the /api/analyze body into the single object renderVals() reads. The
     bounded head-to-head (focus vs top rival) is the honest core; we never invent
     scores for brands the backend did not bound. */
  /* brand-level AI standing across the real questions: best (lowest) rank seen,
     whether the brand is ever the PRIMARY answer, its coverage, and a cited/runs
     count taken on its best question. Every field guarded. */
  function aiSummary(entry, queries) {
    var best = null, primaryN = 0, presentN = 0, anyRuns = 0;
    (queries || []).forEach(function (q) {
      var c = entry && entry.ai_cells ? entry.ai_cells[q] : null;
      if (!c || c.rank == null) return;
      presentN += 1;
      if (c.kind === 'primary') primaryN += 1;
      if (c.runs) anyRuns = c.runs;
      if (best === null || c.rank < best.rank) best = c;
    });
    if (!best) return { present: false, primaryN: 0, presentN: 0, runs: anyRuns };
    var runs = best.runs || 0;
    var cons = best.consistency != null ? best.consistency : 0;
    var presenceCited = runs ? Math.round(cons / 100 * runs) : 0;
    /* "cited" = presence count (how many runs the brand showed up in this
       query at all). "primaryCited" = the true count of runs it was the
       PRIMARY answer (backend's primary_hits). These are DIFFERENT numbers
       and must never be swapped: presence overstates primacy. Falls back to
       the presence count only for an old cached response shaped before
       primary_hits shipped. */
    var primaryCited = best.primary_hits != null ? best.primary_hits : presenceCited;
    return {
      present: true, rank: Math.round(best.rank),
      kind: best.kind === 'primary' ? 'primary' : 'mentioned',
      consistency: cons, runs: runs, cited: presenceCited, primaryCited: primaryCited,
      primaryN: primaryN, presentN: presentN
    };
  }
  /* brand-level Google standing: best and worst SERP rank across the questions */
  function serpRange(entry, queries) {
    var best = null, worst = null;
    (queries || []).forEach(function (q) {
      var c = entry && entry.cells ? entry.cells[q] : null;
      if (c && c.rank != null) {
        if (best === null || c.rank < best) best = c.rank;
        if (worst === null || c.rank > worst) worst = c.rank;
      }
    });
    return { best: best, worst: worst };
  }
  /* compact FR label for a brand's AI standing (used in the named field) */
  function aiLabel(ai) {
    if (!ai || !ai.present) return T('absent from AI', 'absent de l\'IA');
    /* The count after the rank must match the claim before it: "primary"
       gets the PRIMARY-run count (ai.primaryCited), never the presence
       count, so a brand shown as "principal" never carries a bigger number
       than the runs it was actually the primary answer in. "mentioned" gets
       the honest presence count (ai.cited), which is what it always meant. */
    if (ai.kind === 'primary') {
      return T('primary', 'principal') + T(' #', ' n') + ai.rank +
        T(', primary ', ', principal ') + ai.primaryCited + '/' + ai.runs;
    }
    return T('mentioned', 'mentionné') + T(' #', ' n') + ai.rank + T(', cited ', ', cité ') + ai.cited + '/' + ai.runs;
  }

  /* ---------- the free planche: ONE real blind spot, named ----------
     What the Deep Audit would reveal is not a generic pitch, it is the next
     honest fact THIS measurement already points to: the first query where the
     focus brand has no cell at all (neither on Google nor in the AI answer),
     falling back to an AI-only or a Google-only gap, and who holds that
     answer today. Never invents a gap that is not in the data; returns
     {query:null} when the brand already covers everything measured. */
  function findHolder(query, ranking, useAI) {
    var best = null;
    (ranking || []).forEach(function (r) {
      var c = useAI ? (r.ai_cells ? r.ai_cells[query] : null) : (r.cells ? r.cells[query] : null);
      if (c && c.rank != null && (!best || c.rank < best.rank)) best = { name: r.brand, rank: c.rank };
    });
    return best;
  }
  function buildPlanche(focusEntry, queries, ranking) {
    if (!focusEntry || !queries || !queries.length) return { query: null, holder: null };
    var gapBoth = null, gapAI = null, gapSerp = null;
    for (var i = 0; i < queries.length; i++) {
      var q = queries[i];
      var hasAI = focusEntry.ai_cells && focusEntry.ai_cells[q] && focusEntry.ai_cells[q].rank != null;
      var hasSerp = focusEntry.cells && focusEntry.cells[q] && focusEntry.cells[q].rank != null;
      if (!hasAI && !hasSerp) { if (gapBoth === null) gapBoth = q; }
      else if (!hasAI) { if (gapAI === null) gapAI = q; }
      else if (!hasSerp) { if (gapSerp === null) gapSerp = q; }
    }
    var q2 = gapBoth || gapAI || gapSerp;
    if (!q2) return { query: null, holder: null };
    /* a Google-only gap names the Google holder, any AI-side gap names the AI holder */
    var useAI2 = q2 !== gapSerp;
    var holder = findHolder(q2, ranking, useAI2);
    return { query: q2, holder: holder ? holder.name : null };
  }

  function buildResult(d) {
    var focusName = d.brand || '';
    var geo = d.geo || null;
    var rival = (d.geo_rival && d.geo_rival.point != null) ? d.geo_rival : null;
    var queries = d.queries || [];
    var Q = queries.length;
    var n = (geo && geo.n) ? geo.n : 0;
    /* deep tier: d.tier==='deep' plus the paid-only fields it carries. Every
       field guarded, none of this is assumed present on a free response. */
    var tier = (d.tier === 'deep') ? 'deep' : 'free';
    var evidence = Array.isArray(d.evidence) ? d.evidence : [];
    var report = (d.report && typeof d.report === 'object') ? d.report : null;
    var geoScore = (d.geo_score != null) ? Math.max(0, Math.min(100, parseInt(d.geo_score, 10) || 0)) : null;

    /* rows: focus + (optional) rival, from their bounded scores only. The
       backend explicitly refuses to bound a single successful run (half_width
       null, verdict SINGLE_RUN, its own comment: "a bound on n=1 would be a
       lie") - defaulting that to +-1 here would draw a fabricated 95%
       confidence bracket on an interval that was never computed. Carry the
       null through as bounded:false and m:0 instead; renderVals/axisBrandHTML
       render a bare point (no bracket, no range text, no "why a range"
       tooltip) for an unbounded row. */
    var rows = [];
    if (geo && geo.point != null) {
      rows.push({ n: focusName, s: geo.point, m: (geo.half_width != null ? geo.half_width : 0), bounded: geo.half_width != null });
      if (rival) rows.push({ n: rival.brand, s: rival.point, m: (rival.half_width != null ? rival.half_width : 0), bounded: rival.half_width != null });
    }

    var ranking = d.ranking || [];
    var lc = String(focusName).toLowerCase();
    var focusEntry = ranking.find(function (r) { return String(r.brand).toLowerCase() === lc; }) || null;
    var planche = buildPlanche(focusEntry, queries, ranking);

    /* named competitive field: every brand the backend measured, with its real
       AI standing (rank + primary/mentioned + cited/runs) and Google standing. */
    var fieldRows = ranking.map(function (r) {
      return {
        name: r.brand,
        isFocus: String(r.brand).toLowerCase() === lc,
        share: Math.max(0, Number(r.share_of_voice) || 0),
        ai: aiSummary(r, queries),
        serpRank: serpRange(r, queries).best
      };
    });
    /* order the field by real AI visibility (primary before mentioned at equal
       rank, then absent), keeping share as the tie-break. */
    function aiScore(x) { return x.ai.present ? (x.ai.rank + (x.ai.kind === 'primary' ? 0 : 0.5)) : 999; }
    fieldRows.sort(function (a, b) { var dd = aiScore(a) - aiScore(b); return dd !== 0 ? dd : (b.share - a.share); });

    /* per-question x per-brand matrix (drawer), brand columns in field order */
    var rankByName = {};
    ranking.forEach(function (r) { rankByName[String(r.brand).toLowerCase()] = r; });
    var orderedNames = fieldRows.map(function (f) { return f.name; });
    var matrix = queries.map(function (q) {
      return {
        q: q,
        cells: orderedNames.map(function (nm) {
          var r = rankByName[String(nm).toLowerCase()] || {};
          var ai = r.ai_cells ? r.ai_cells[q] : null;
          var serp = r.cells ? r.cells[q] : null;
          var runs = ai && ai.runs != null ? ai.runs : n;
          var cons = ai && ai.consistency != null ? ai.consistency : null;
          return {
            name: nm, isFocus: String(nm).toLowerCase() === lc,
            aiRank: ai && ai.rank != null ? Math.round(ai.rank) : null,
            aiKind: ai ? (ai.kind === 'primary' ? 'primary' : 'mentioned') : null,
            /* cited = presence count for this query (how many of the runs it
               showed up at all); primaryHits = how many of the runs it was
               specifically the PRIMARY answer. Never use one for the other. */
            cited: (cons != null && runs) ? Math.round(cons / 100 * runs) : null,
            primaryHits: ai && ai.primary_hits != null ? ai.primary_hits : null,
            runs: runs || 0,
            serpRank: serp && serp.rank != null ? serp.rank : null
          };
        })
      };
    });

    /* who owns the Google page (often aggregators, not the brands) */
    var landscape = d.serp_landscape || {};
    var owners = (landscape.owners || []).map(function (o) { return { host: o.host, best_rank: o.best_rank, hits: o.hits }; });
    var serpByQ = queries.map(function (q) {
      var arr = (landscape.queries && landscape.queries[q]) ? landscape.queries[q] : [];
      return { q: q, hosts: arr.map(function (x) { return { host: x.host, rank: x.rank }; }) };
    });
    var oh = owners.map(function (o) { return shortHost(o.host); });
    var ownersPhrase = oh.length >= 2 ? (oh[0] + ', ' + oh[1]) : (oh.length === 1 ? oh[0] : '');

    /* focus per-question AI facts for the headline insight */
    var focusPrimaryN = 0, focusPresentN = 0, focusAbsentN = 0, focusPrimaryCited = null;
    queries.forEach(function (q) {
      var c = focusEntry && focusEntry.ai_cells ? focusEntry.ai_cells[q] : null;
      if (!c || c.rank == null) { focusAbsentN += 1; return; }
      focusPresentN += 1;
      if (c.kind === 'primary') {
        focusPrimaryN += 1;
        /* focusPrimaryCited must be the count of runs the brand was
           specifically the PRIMARY answer (backend's primary_hits), never
           the presence count derived from consistency - presence can be
           higher than primacy (present in 3/3 runs but primary in only 2),
           and this number feeds every "featured answer" / "réponse mise en
           avant" claim, so it must never overstate how often the brand
           actually held the primary spot. Falls back to the presence count
           only for an old cached response shaped before primary_hits shipped. */
        var rr = c.runs || 0, cc = c.consistency != null ? c.consistency : 0;
        var ph = c.primary_hits != null ? c.primary_hits : (rr ? Math.round(cc / 100 * rr) : 0);
        if (focusPrimaryCited === null || ph < focusPrimaryCited) focusPrimaryCited = ph;
      }
    });
    var focusAi = aiSummary(focusEntry, queries);
    var focusSerp = serpRange(focusEntry, queries);
    var runs = focusAi.runs || n || 0;
    var aiLeader = fieldRows.length ? fieldRows[0] : null;

    var ctx = {
      focusName: focusName, geo: geo, rival: rival, Q: Q, runs: runs,
      providerLabel: d.ai_provider_label || T('the AI', 'l\'IA'),
      focusAi: focusAi, focusSerp: focusSerp,
      focusPrimaryN: focusPrimaryN, focusPresentN: focusPresentN,
      focusAbsentN: focusAbsentN, focusPrimaryCited: focusPrimaryCited,
      fieldRows: fieldRows, aiLeader: aiLeader,
      owners: owners, ownersPhrase: ownersPhrase, hasFocusEntry: !!focusEntry,
      tier: tier, planche: planche
    };

    return {
      sig: focusName + '|' + (geo ? geo.point : '') + '|' + (rival ? rival.point : '') + '|' + n + '|' + Q + '|' + tier,
      focusName: focusName, geo: geo, rival: rival,
      rows: rows, fieldRows: fieldRows, matrix: matrix, owners: owners, serpByQ: serpByQ,
      nQueries: Q, n: n,
      passTotal: n * Q,                        /* n runs x Q queries, one assistant */
      providerLabel: d.ai_provider_label || T('the AI', 'l\'IA'),
      market: d.market || '',
      notice: d.notice || '',
      tier: tier, evidence: evidence, report: report, geoScore: geoScore, planche: planche,
      /* Real transparency (owner: "il manque de la transparence sur les IAs,
         les modeles utilises"): the exact model id app.py actually called for
         the AI-visibility runs, and the UTC instant the measurement completed.
         Both additive on the backend (see app.py's /api/analyze result dict)
         - guarded here too, so an older cached response without either field
         degrades to '' rather than showing "undefined" anywhere downstream. */
      aiModel: d.ai_model || '', measuredAt: d.measured_at || '',
      /* identity confirmation (see startCheckout / showIdentityConfirm): the
         backend only ever returns confidence "high" when real web evidence
         backed the identification (app.py _sanitize_strategy). officialUrl is
         NOT part of this response (only /api/infer returns it) - the callers
         (runReal/runDeepMeasure) attach it after buildResult() returns. */
      identifiedAs: d.identified_as || '', confidence: (d.confidence || '').toLowerCase().trim(),
      /* a cache hit is served verbatim from a prior run (possibly for a
         different visitor, possibly old) - never presented as this visitor's
         own fresh live measurement without saying so (see passCounter). */
      cached: !!d.cached,
      insight: buildInsight(ctx),
      cards: buildCards(ctx)
    };
  }

  /* The single most valuable pattern in the data: the AI-vs-Google divergence.
     Real, quantified, no doubt-planting, no dashes. Picks the branch the data
     supports (focus wins the AI answer / only mentioned / absent). */
  function buildInsight(c) {
    if (!c.hasFocusEntry || c.Q === 0) return '';
    var Y = c.Q, plural = Y > 1 ? 's' : '';
    if (c.focusPrimaryN >= 1) {
      /* citedTxt states the PRIMACY count (how many reads it was actually the
         primary answer), never the presence count, since it is attached to
         a "featured answer" claim - the word "primary"/"principal" makes the
         number's meaning explicit so it can never be misread as presence. */
      var citedTxt = T(
        (c.focusPrimaryCited && c.runs) ? ('primary in ' + c.focusPrimaryCited + ' of ' + c.runs + ' reads') : ('across ' + c.runs + ' reads'),
        (c.focusPrimaryCited && c.runs) ? ('principal sur ' + c.focusPrimaryCited + ' des ' + c.runs + ' mesures') : ('sur ' + c.runs + ' mesures')
      );
      /* "primary" (kind==='primary') is a coverage majority across runs, not a
         rank-1 guarantee (a brand named primary in 2 of 3 runs while ranked
         2nd on average still has kind==='primary'). Never assert "n1" here. */
      var s = T(
        'In AI, ' + c.focusName + ' is the featured answer on ' + c.focusPrimaryN + ' of your ' + Y + ' question' + plural + ', ' + citedTxt + '.',
        'En IA, ' + c.focusName + ' est la réponse mise en avant sur ' + c.focusPrimaryN + ' de vos ' + Y + ' question' + plural + ', ' + citedTxt + '.'
      );
      if (c.ownersPhrase) s += T(
        ' On Google, the comparison sites (' + c.ownersPhrase + ') hold the page. You are winning the AI answer, not the search ranking yet.',
        ' Sur Google, ce sont les comparateurs (' + c.ownersPhrase + ') qui tiennent la page. Vous gagnez la réponse IA, pas encore le référencement.'
      );
      else if (c.focusSerp.best != null) s += T(
        ' On Google, your best position is rank ' + c.focusSerp.best + '. The AI lead is real, hold it over time.',
        ' Sur Google, votre meilleure position est le rang ' + c.focusSerp.best + '. L\'avantage IA est réel, tenez-le dans le temps.'
      );
      else s += T(' The AI lead is real, hold it over time.', ' L\'avantage IA est réel, tenez-le dans le temps.');
      return s;
    }
    if (c.focusPresentN >= 1) {
      var lead = (c.aiLeader && !c.aiLeader.isFocus) ? c.aiLeader.name : '';
      var yr = c.focusAi.present ? c.focusAi.rank : null;
      var s2 = T(
        'In AI, ' + c.focusName + ' is cited but never in the lead' + (yr != null ? (' (best is #' + yr + ')') : '') + '.',
        'En IA, ' + c.focusName + ' est cité mais jamais en tête' + (yr != null ? (' (au mieux n' + yr + ')') : '') + '.'
      );
      if (lead) s2 += T(' ' + lead + ' is the featured answer.', ' C\'est ' + lead + ' qui est la réponse mise en avant.');
      if (c.ownersPhrase) s2 += T(
        ' And on Google, the page is still held by the comparison sites (' + c.ownersPhrase + ').',
        ' Et sur Google, la page reste tenue par les comparateurs (' + c.ownersPhrase + ').'
      );
      s2 += T(' The top spot is there to take.', ' La place de premier choix est à prendre.');
      return s2;
    }
    var lead2 = (c.aiLeader && c.aiLeader.ai.present && !c.aiLeader.isFocus) ? c.aiLeader.name : '';
    var s3 = T(
      'In AI, ' + c.focusName + ' does not appear on your ' + Y + ' question' + plural + '.',
      'En IA, ' + c.focusName + ' n\'apparaît pas sur vos ' + Y + ' question' + plural + '.'
    );
    if (lead2) s3 += T(' ' + lead2 + ' takes the answer.', ' C\'est ' + lead2 + ' qui prend la réponse.');
    if (c.ownersPhrase) s3 += T(
      ' On Google, the comparison sites (' + c.ownersPhrase + ') hold the page.',
      ' Sur Google, ce sont les comparateurs (' + c.ownersPhrase + ') qui tiennent la page.'
    );
    s3 += T(' You are invisible to anyone who asks these questions to an AI.', ' Vous êtes invisible pour qui pose ces questions à une IA.');
    return s3;
  }

  /* The verdict: bounded head-to-head. Confident and quantified, never planting
     doubt, never restating the visible numbers. Mirrors index.html boundedCompare. */
  function computeVerdict(focusName, geo, rival) {
    if (!geo || geo.point == null) return { title: '', color: INK, text: '', kind: 'none' };
    if (!rival) {
      var p = geo.point, t, txt;
      if (geo.verdict === 'SINGLE_RUN') {
        t = T('First measurement.', 'Première mesure.');
        txt = T(focusName + ' scores ' + p + ' out of 100 on this first read.', focusName + ' obtient ' + p + ' sur 100 sur cette première lecture.');
      } else if (geo.verdict === 'STABLE') {
        t = T('Position holds.', 'Position tenue.');
        txt = T(focusName + ' scores ' + p + ' out of 100, a level that holds across every measurement.', focusName + ' obtient ' + p + ' sur 100, un niveau qui tient à chaque mesure.');
      } else {
        t = T('Position measured.', 'Position mesurée.');
        txt = T(focusName + ' scores ' + p + ' out of 100, real visibility in AI answers.', focusName + ' obtient ' + p + ' sur 100, une visibilité réelle dans les réponses IA.');
      }
      return { title: t, color: SAGE, text: txt, kind: 'solo' };
    }
    /* Refuse the head-to-head entirely when either side is unbounded
       (half_width null, verdict SINGLE_RUN - only one run succeeded). Two bare
       points are not disjoint confidence bands: comparing them as points used
       to collapse a 1-point gap measured once into "une avance nette qui tient
       à chaque mesure" - a stability claim from a single measurement, exactly
       the over-claim this product exists to refuse. */
    if (geo.half_width == null || rival.half_width == null) {
      return {
        title: T('Too early to compare.', 'Trop tôt pour comparer.'), color: INK, kind: 'unbounded',
        text: T(
          focusName + ' and ' + rival.brand + ' are each measured only once on this read. Two brands are never separated on a single measurement.',
          focusName + ' et ' + rival.brand + ' ne sont mesurés qu\'une fois chacun sur cette lecture. On ne départage jamais deux marques sur une seule mesure.'
        )
      };
    }
    var gLow = geo.low, gHigh = geo.high, rLow = rival.low, rHigh = rival.high;
    var diff = geo.point - rival.point;
    if (gLow > rHigh) {
      var d1 = Math.max(1, Math.round(diff));
      var d1s = d1 > 1 ? 's' : '';
      return {
        title: T('Real lead.', 'Avance réelle.'), color: SAGE, kind: 'ahead',
        text: T(
          focusName + ' is ahead of ' + rival.brand + ' by ' + d1 + ' point' + d1s + ', a clear lead that holds across every measurement.',
          focusName + ' devance ' + rival.brand + ' de ' + d1 + ' point' + d1s + ', une avance nette qui tient à chaque mesure.'
        )
      };
    }
    if (gHigh < rLow) {
      var d2 = Math.max(1, Math.round(-diff));
      var d2s = d2 > 1 ? 's' : '';
      return {
        title: T(rival.brand + ' ahead, real gap.', rival.brand + ' devant, écart réel.'), color: SIENNA, kind: 'behind',
        text: T(
          rival.brand + ' leads ' + focusName + ' by ' + d2 + ' point' + d2s + ', a wide and consistent gap. The gap is real, it will need closing.',
          rival.brand + ' domine ' + focusName + ' de ' + d2 + ' point' + d2s + ', un écart large et régulier. Le retard est réel, il faudra le combler.'
        )
      };
    }
    var d3 = Math.abs(Math.round(diff));
    var gap = T(
      d3 === 0 ? 'are tied' : ('are within ' + d3 + ' point' + (d3 > 1 ? 's' : '')),
      d3 === 0 ? 'sont à égalité' : ('se tiennent à ' + d3 + ' point' + (d3 > 1 ? 's' : ''))
    );
    return {
      title: T('Too close to call.', 'Trop proche pour trancher.'), color: INK, kind: 'overlap',
      text: T(
        focusName + ' and ' + rival.brand + ' ' + gap + ', too close to call. We would rather say so than invent a winner.',
        focusName + ' et ' + rival.brand + ' ' + gap + ', trop proche pour les départager. On préfère le dire que d\'inventer un gagnant.'
      )
    };
  }

  /* The 3 dock cards, dense and specific: what happens in the AI answer, what
     happens on the Google page (and who owns it), and an honest paid push. */
  function buildCards(c) {
    var verdict = computeVerdict(c.focusName, c.geo, c.rival);
    var Y = c.Q, provider = c.providerLabel;

    /* card 0 - "en IA" : primary on X/Y, consistency, the main AI rival */
    var iaBig, iaColor, iaLine;
    if (c.focusPrimaryN >= 1) {
      iaBig = c.focusPrimaryN + ' / ' + Y; iaColor = SAGE;
      /* Same rule as buildInsight: this trailing count is the PRIMACY count,
         not presence, so it is worded "primary in .../principal sur ..." and
         can never be read as "cited/present X of Y" while the headline says
         "featured answer". */
      var citedTxt = T(
        (c.focusPrimaryCited && c.runs) ? (', primary in ' + c.focusPrimaryCited + ' of ' + c.runs) : '',
        (c.focusPrimaryCited && c.runs) ? (', principal sur ' + c.focusPrimaryCited + ' des ' + c.runs) : ''
      );
      iaLine = T(
        'Featured answer on ' + c.focusPrimaryN + ' of your ' + Y + ' question' + (Y > 1 ? 's' : '') + citedTxt + '.',
        'Réponse mise en avant sur ' + c.focusPrimaryN + ' de vos ' + Y + ' question' + (Y > 1 ? 's' : '') + citedTxt + '.'
      );
    } else if (c.focusAi.present) {
      iaBig = 'n' + c.focusAi.rank; iaColor = '#B57C5D';
      iaLine = T(
        'Best cited at rank ' + c.focusAi.rank + ', never in the lead, across ' + c.runs + ' passes.',
        'Cité au mieux au rang ' + c.focusAi.rank + ', jamais en tête, sur ' + c.runs + ' passages.'
      );
    } else {
      iaBig = T('absent', 'absent'); iaColor = '#B57C5D';
      iaLine = T(
        'No citation in ' + provider + ' answers across your ' + Y + ' questions.',
        'Aucune citation dans les réponses ' + provider + ' sur vos ' + Y + ' questions.'
      );
    }
    var iaRival = '';
    var rl = null;
    for (var i = 0; i < c.fieldRows.length; i++) { if (!c.fieldRows[i].isFocus && c.fieldRows[i].ai.present) { rl = c.fieldRows[i]; break; } }
    if (rl) iaRival = T('Main AI rival: ', 'Principal rival IA : ') + rl.name + ' (' + aiLabel(rl.ai) + ').';

    /* card 1 - "sur Google" : your best/worst rank + who owns the page */
    var gBig, gColor, gLine;
    if (c.focusSerp.best != null) {
      gBig = 'n' + c.focusSerp.best; gColor = '#C6A15B';
      gLine = (c.focusSerp.worst != null && c.focusSerp.worst !== c.focusSerp.best)
        ? T('You show up between rank ' + c.focusSerp.best + ' and rank ' + c.focusSerp.worst + '.', 'Vous figurez entre le rang ' + c.focusSerp.best + ' et le rang ' + c.focusSerp.worst + '.')
        : T('You show up at rank ' + c.focusSerp.best + '.', 'Vous figurez au rang ' + c.focusSerp.best + '.');
    } else {
      gBig = T('absent', 'absent'); gColor = '#B57C5D';
      gLine = T('You do not appear on the Google page for these questions.', 'Vous n\'apparaissez pas dans la page Google sur ces questions.');
    }
    var gOwners;
    if (c.owners.length) {
      gOwners = T('The page is held by ', 'La page est tenue par ') + c.owners.slice(0, 3).map(function (o) {
        return shortHost(o.host) + T(' (rank ', ' (rang ') + o.best_rank + ')';
      }).join(', ') + '.';
    } else {
      gOwners = T('No dominant domain identified on the page.', 'Aucun domaine dominant identifié sur la page.');
    }

    /* card 2 - "aller plus loin" : transparent paid push, tier aware. A deep
       tier result already delivered the dossier (rendered below the hero), so
       this card never re-sells the Deep Audit once it is bought, it only
       carries the recurring offers (monitoring, settlement). A free result
       keeps the ONE Deep Audit button on the whole screen here, anchored on
       79 euro, and names a REAL blind question from this measurement instead
       of a generic pitch (the planche). */
    var deepBlock;
    if (c.tier === 'deep') {
      deepBlock = {
        delivered: true, free: '',
        adds: T('Sourced dossier delivered below: evidence, named blind spots and the action plan.', 'Dossier sourcé livré ci-dessous : preuve, angles morts nommés et plan d\'action.')
      };
    } else {
      var free = T(
        'Free: ' + Y + ' question' + (Y > 1 ? 's' : '') + ', 1 AI (' + provider + '), ' + c.runs + ' pass' + (c.runs > 1 ? 'es' : '') + ' per question.',
        'Gratuit : ' + Y + ' question' + (Y > 1 ? 's' : '') + ', 1 IA (' + provider + '), ' + c.runs + ' passage' + (c.runs > 1 ? 's' : '') + ' par question.'
      );
      /* Ground truth (app.py): a Deep Audit measures 5 questions (vs 2 free)
         and 8 passages per question on the SAME assistant (vs c.runs, 3 by
         default) - a tighter confidence interval, never a second assistant.
         "plusieurs IA recoupées" / "triple mesure" both over-claimed this;
         the free card above already says c.runs, so state the real deep
         number (8) against it and name the assistant explicitly so nobody
         reads this as a cross-model check. */
      var adds;
      if (c.planche && c.planche.query) {
        var holderTxt = T(
          c.planche.holder ? (', where ' + c.planche.holder + ' holds the answer today') : '',
          c.planche.holder ? (', où ' + c.planche.holder + ' tient la réponse aujourd\'hui') : ''
        );
        adds = T(
          'The Deep Audit widens to 5 questions and 8 passes per question on ' + provider + ' (versus ' + c.runs + ' today), a tighter interval, and names your blind spots, for example "' + c.planche.query + '"' + holderTxt + '.',
          'Le Deep Audit élargit à 5 questions et 8 passages par question sur ' + provider + ' (contre ' + c.runs + ' aujourd\'hui), un intervalle plus étroit, et nomme vos angles morts, par exemple « ' + c.planche.query + ' »' + holderTxt + '.'
        );
      } else {
        adds = T(
          'The Deep Audit widens to 5 questions and 8 passes per question on ' + provider + ' (versus ' + c.runs + ' today), a tighter interval, and delivers a sourced action plan.',
          'Le Deep Audit élargit à 5 questions et 8 passages par question sur ' + provider + ' (contre ' + c.runs + ' aujourd\'hui), un intervalle plus étroit, et remet un plan d\'action sourcé.'
        );
      }
      deepBlock = { delivered: false, free: free, adds: adds };
    }

    return {
      verdictTitle: verdict.title, verdictColor: verdict.color, verdictText: verdict.text,
      ia: { big: iaBig, bigColor: iaColor, line: iaLine, rival: iaRival },
      google: { big: gBig, bigColor: gColor, line: gLine, owners: gOwners },
      deep: deepBlock
    };
  }

  /* ============================ renderVals() ============================ */
  /* Single source of truth. Reads currentResult (the real audit) when present,
     else returns a blank/idle view (no fake brackets, no fake numbers). */
  function renderVals() {
    var st = state;
    var R = currentResult;
    var haveResult = !!(R && R.rows && R.rows.length);
    /* recompute the adaptive projection window (ZLO/ZHI) from the real result so
       brackets, region band, tick labels AND the 3D cloud share one scale. */
    applyWindow();
    var zspan = ZHI - ZLO;

    /* ---- live attribution / staleness (the Yoyaku defect) ----
       A settled result must never be shown at full authority once the typed
       brand no longer matches what was actually measured: currentResult is
       null while idle or measuring (see runMeasure/failMeasure), so haveResult
       already gates this to "a real, settled result exists" - nothing to
       attribute at idle, no false staleness mid-measurement. Compared trimmed
       and case-insensitive, recomputed on every render (this fires on every
       input keystroke, not only blur, since the input's own 'input' listener
       already calls setState -> render on each change). */
    var stale = false, staleMsg = '';
    if (haveResult) {
      var typedTrim = String(st.inputValue || '').trim();
      var typedNorm = typedTrim.toLowerCase();
      var measuredNorm = String(R.focusName || '').trim().toLowerCase();
      stale = typedNorm !== measuredNorm;
      if (stale) {
        staleMsg = typedTrim
          ? T('Result for ' + R.focusName + '. Run the measurement for ' + typedTrim + '.', 'Résultat pour ' + R.focusName + '. Lancez la mesure pour ' + typedTrim + '.')
          : T('Result for ' + R.focusName + '. Type a brand to measure it.', 'Résultat pour ' + R.focusName + '. Tapez une marque pour la mesurer.');
      }
    }

    /* ---- axis brackets + advantage/overlap band (empty until a real result) ---- */
    var axisBrands = [];
    var region = { leftPct: '50.00', widthPct: '0.00', fill: 'transparent', borderColor: 'transparent', borderStyle: 'solid' };
    if (haveResult) {
      var sorted = R.rows.slice().sort(function (a, b) { return b.s - a.s; });
      var belowIdx = 0;
      axisBrands = sorted.map(function (r, i) {
        var isFocus = r.n === R.focusName;
        var cState = clusterState(sorted, i);
        var level = 0;
        if (!isFocus) { belowIdx += 1; level = belowIdx; }
        var bracketColor = isFocus ? BRASS : cState === 'behind' ? '#AE7A64' : '#958772';
        var bounded = r.bounded !== false;
        /* clamp to the visible 0..100 so an out-of-window real score never
           renders a negative-width or off-axis bracket; the axis spans 0..100.
           An unbounded row (m:0, see buildResult) collapses to a zero-width
           bracket - i.e. no visible bracket at all, just the point. */
        var lo = Math.max(0, Math.min(100, (r.s - r.m - ZLO) / zspan * 100));
        var hi = Math.max(0, Math.min(100, (r.s + r.m - ZLO) / zspan * 100));
        return {
          key: r.n, name: r.n,
          focus: isFocus, notFocus: !isFocus,
          loPct: lo.toFixed(2),
          wPct: Math.max(0, hi - lo).toFixed(2),
          midPct: Math.max(0, Math.min(100, (r.s - ZLO) / zspan * 100)).toFixed(2),
          bracketColor: bracketColor,
          nameColor: isFocus ? '#E8DFD2' : cState === 'behind' ? '#A39784' : '#A39784',
          scoreColor: isFocus ? BRASS : cState === 'behind' ? '#A39784' : '#B2A694',
          subColor: cState === 'behind' ? '#958772' : '#958772',
          scoreDisplay: r.s,
          /* A real 95% interval only when the backend actually bounded it.
             Never fabricate "entre X et Y" (nor its "why a range" tooltip,
             see axisBrandHTML) on a SINGLE_RUN read the backend explicitly
             refused to bound - that would sell a confidence claim that was
             never computed. */
          rangeText: bounded ? T('between ' + Math.max(0, r.s - r.m) + ' and ' + Math.min(100, r.s + r.m), 'entre ' + Math.max(0, r.s - r.m) + ' et ' + Math.min(100, r.s + r.m)) : T('single measurement, not bounded', 'mesure unique, non bornée'),
          showRange: isFocus && bounded,
          showSingle: isFocus && !bounded,
          leaderTop: isFocus ? 'calc(50% - 22px)' : 'calc(50% + 6px)',
          leaderH: isFocus ? 16 : level === 1 ? 12 : 30,
          labelPos: isFocus ? 'bottom:calc(50% + 24px)' : level === 1 ? 'top:calc(50% + 20px)' : 'top:calc(50% + 40px)'
        };
      });
      /* The advantage/overlap band is itself a certainty claim (a shaded
         "proven lead" or "overlap" zone) - only draw it when BOTH rows are
         actually bounded; otherwise leave the default transparent region so
         nothing implies a comparison that was never made (see computeVerdict). */
      if (sorted.length >= 2 && sorted[0].bounded !== false && sorted[1].bounded !== false) {
        var l = sorted[0], s2 = sorted[1];
        var proven = (l.s - l.m) > (s2.s + s2.m);
        region = proven
          ? regionBox(s2.s + s2.m, l.s - l.m, 'rgba(147,160,110,0.08)', 'rgba(147,160,110,0.6)', 'dashed')
          : regionBox(Math.max(l.s - l.m, s2.s - s2.m), Math.min(l.s + l.m, s2.s + s2.m), 'rgba(181,124,93,0.14)', 'rgba(181,124,93,0.7)', 'solid');
      }
    }

    /* ---- example quick-pick chips (each runs a REAL audit) ---- */
    var brands = EXAMPLES.map(function (name) {
      return {
        key: name, name: name,
        run: function () { runMeasure(name); },
        border: name === st.focus ? '#958772' : '#463B30',
        color: name === st.focus ? '#E8DFD2' : '#958772'
      };
    });

    /* ---- named competitive field (replaces the anonymous share bar) ---- */
    var fieldRows = [], focusName = st.focus;
    if (haveResult) {
      focusName = R.focusName;
      fieldRows = R.fieldRows.map(function (f) {
        var g = googleRankLabel(f.serpRank);
        return {
          name: f.name, isFocus: f.isFocus,
          nameColor: f.isFocus ? BRASS : '#C9BEAC',
          ai: aiLabel(f.ai),
          aiColor: !f.ai.present ? '#AE7A64' : f.ai.kind === 'primary' ? '#93A06E' : '#B2A694',
          google: g,
          googleColor: f.serpRank != null ? '#958772' : '#AE7A64',
          sharePct: f.share,
          /* The bar width IS the share (0-100), never normalized to the
             leader's share - normalizing to the leader always drew the top
             brand's bar at full width even when its label read e.g. "33%",
             and the 3%-floor drew a visible bar for a brand measured at 0%. */
          shareW: Math.max(0, Math.min(100, Math.round(f.share))),
          shareColor: f.isFocus ? BRASS : 'rgba(216,205,187,0.28)',
          shareLabel: Math.round(f.share) + '%'
        };
      });
    }

    var card = haveResult ? R.cards : BLANK_CARD;
    var insight = haveResult ? R.insight : '';
    /* dynamic scale label: shows the zoom window once a result is present,
       UNLESS that window is the whole 0..100 scale (a real result can still
       land there, see computeWindow) - in which case "zoom 0 a 100" would be
       redundant with the scale itself, so fall back to the plain "echelle"
       label. When actually zoomed, drop the trailing "of 100" / "sur 100":
       "zoom {lo} a {hi}" already says everything the "of 100" repeated. */
    var isFullScale = (ZLO === 0 && ZHI === 100);
    var scaleLabel = (haveResult && !isFullScale)
      ? T('zoom ' + ZLO + ' to ' + ZHI, 'zoom ' + ZLO + ' à ' + ZHI)
      : T('scale 0 to 100', 'échelle 0 à 100');

    /* ---- pass counter: real total once settled, indeterminate while measuring ----
       R.n is the number of AI responses actually read (one API call per run,
       each covering every question) - R.passTotal (n x nQueries) counts
       question-coverage, not responses, and was mislabelled "réponses lues"
       (doubling the true count for a 2-question audit). A cached result is
       surfaced honestly here too: it is not this visitor's own fresh
       measurement (see buildResult / app.py _cache). */
    var passCounter;
    if (st.settled && haveResult) {
      passCounter = T(
        R.n + ' AI response' + (R.n > 1 ? 's' : '') + ' read across ' + R.nQueries + ' question' + (R.nQueries > 1 ? 's' : '') + (R.cached ? ', cached measurement' : ''),
        R.n + ' réponse' + (R.n > 1 ? 's' : '') + ' IA lues sur ' + R.nQueries + ' question' + (R.nQueries > 1 ? 's' : '') + (R.cached ? ', mesure en cache' : '')
      );
    }
    else if (st.payError) passCounter = T('payment', 'paiement');
    /* real elapsed seconds (see startMeasureTick), not a fabricated percentage -
       the only progress feedback prefers-reduced-motion users get while the
       breathing 3D cloud is intentionally off for them (see `reduced`). */
    else if (st.measuring) passCounter = T('measuring', 'mesure en cours') + (st.elapsedS ? (', ' + st.elapsedS + 's') : '');
    else passCounter = T('waiting', 'en attente');

    var revealed = st.settled && haveResult;
    var contentSig = revealed ? ('R|' + R.sig) : ((st.measuring ? 'M|' : 'I|') + st.focus);

    /* ---- dock mode (see swapDockContent/populateDockCards) ----
       The 3-card dock is the page's best above-the-fold real estate and must
       never sit empty: 'result' once a real measurement has settled (the per-
       audit "en IA / sur Google / aller plus loin" cards); 'error' on any
       failed measurement OR a Stripe payError (recovery copy, deliberately
       NOT a payment pitch: never sell a Deep Audit at the exact moment a
       measurement, or a payment, just failed); 'idle' otherwise, which also
       covers 'measuring' (a run in flight is neither an error nor a result
       yet) and carries the three products (this used to be a separate strip
       below an internally-scrolling fold nobody ever reached - folded into
       the dock so it is finally visible). Idle copy here names no brand and
       claims nothing about the visitor's measurement, since nothing has been
       measured yet. */
    var mode = revealed ? 'result' : ((st.unknownMsg || st.payError) ? 'error' : 'idle');

    return {
      measuring: st.measuring, settled: st.settled, haveResult: haveResult, contentSig: contentSig,
      mode: mode,
      measuringOverlayOp: (st.measuring || st.payError) ? 1 : 0,
      verdictOp: revealed ? 1 : 0,
      verdictTy: st.settled ? 0 : 14,
      proofOp: revealed ? 1 : 0,
      passColor: st.measuring ? '#C6A15B' : '#958772',
      inputValue: st.inputValue,
      hasUnknown: !!st.unknownMsg, unknownMsg: st.unknownMsg,
      brands: brands, axisBrands: axisBrands, region: region, card: card,
      zlo: ZLO, zhi: ZHI, scaleLabel: scaleLabel,
      fieldRows: fieldRows, insight: insight,
      passCounter: passCounter, focusName: focusName,
      matrix: haveResult ? R.matrix : [], owners: haveResult ? R.owners : [], serpByQ: haveResult ? R.serpByQ : [],
      market: haveResult ? R.market : '',
      providerLabel: haveResult ? R.providerLabel : T('the AI', 'l\'IA'),
      runN: haveResult ? R.n : 0, nQueries: haveResult ? R.nQueries : 0,
      stale: stale, staleMsg: staleMsg,
      aiModel: haveResult ? (R.aiModel || '') : '', measuredAt: haveResult ? (R.measuredAt || '') : ''
    };
  }

  /* ============================ DOM generation (was the <x-dc> markup) ============================ */
  function axisBrandHTML(ab) {
    var s = '';
    s += '<div style="position:absolute;left:' + ab.loPct + '%;width:' + ab.wPct + '%;top:calc(50% - 6px);height:12px;border-left:2px solid ' + ab.bracketColor + ';border-right:2px solid ' + ab.bracketColor + ';box-sizing:border-box;transition:left 0.6s cubic-bezier(0.2,0.8,0.2,1),width 0.6s cubic-bezier(0.2,0.8,0.2,1);">';
    s += '<div style="position:absolute;left:0;right:0;top:5px;height:1px;background:' + ab.bracketColor + ';opacity:0.5;"></div>';
    s += '</div>';
    s += '<div style="position:absolute;left:' + ab.midPct + '%;top:' + ab.leaderTop + ';width:1px;height:' + ab.leaderH + 'px;background:#463B30;transition:left 0.6s cubic-bezier(0.2,0.8,0.2,1);"></div>';
    s += '<div style="position:absolute;left:' + ab.midPct + '%;' + ab.labelPos + ';transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:1px;white-space:nowrap;transition:left 0.6s cubic-bezier(0.2,0.8,0.2,1);">';
    s += '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10.5px;letter-spacing:0.06em;color:' + ab.nameColor + ';">' + esc(ab.name) + '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-weight:500;color:' + ab.scoreColor + ';font-variant-numeric:tabular-nums;">' + esc(ab.scoreDisplay) + '</span></span>';
    if (ab.showRange) {
      /* Bounded: a real 95% interval was computed, the tooltip explaining it
         is honest to show. */
      s += '<span style="display:inline-flex;align-items:center;gap:5px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:10.5px;color:' + ab.subColor + ';">' + esc(ab.rangeText);
      if (ab.focus) {
        s += '<button data-tip="range" class="ndl-tip-dot" aria-label="pourquoi une fourchette" style="cursor:help;background:none;border:1px solid #958772;border-radius:50%;width:13px;height:13px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;font-size:8px;line-height:1;color:#958772;">i</button>';
      }
      s += '</span>';
    } else if (ab.showSingle) {
      /* Unbounded (SINGLE_RUN): no interval was computed, so no "why a range"
         tooltip either - just the honest caveat, plain text. */
      s += '<span style="display:inline-flex;align-items:center;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:10.5px;color:' + ab.subColor + ';">' + esc(ab.rangeText) + '</span>';
    }
    s += '</div>';
    return s;
  }

  /* Signature of the axis brand brackets: renderAxisBrands used to be called
     UNCONDITIONALLY on every single render() (including every keystroke while
     typing, before any result exists), tearing down and rebuilding every node
     every time - wasted DOM churn (item: perf), and worse, it also destroyed
     the "pourquoi une fourchette" info-dot the instant it received keyboard
     focus (focusin -> openTip -> setState -> render -> renderAxisBrands
     removes and recreates that very button), which silently killed focus and
     closed the tooltip it was trying to open. Only rebuild when the actual
     bracket geometry/labels changed. */
  var lastAxisBrandsSig = '';
  function axisBrandsSig(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      parts.push(a.key + ':' + a.loPct + ':' + a.wPct + ':' + a.midPct + ':' + a.scoreDisplay + ':' + a.bracketColor + ':' + a.rangeText + ':' + a.showRange + ':' + a.showSingle);
    }
    return parts.join('|');
  }

  function renderAxisBrands(list) {
    var i;
    for (i = 0; i < axisBrandNodes.length; i++) {
      if (axisBrandNodes[i].parentNode) axisBrandNodes[i].parentNode.removeChild(axisBrandNodes[i]);
    }
    axisBrandNodes = [];
    var html = '';
    for (i = 0; i < list.length; i++) html += axisBrandHTML(list[i]);
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) {
      var node = tmp.firstChild;
      tmp.removeChild(node);
      axisBrandNodes.push(node);
      axisAreaEl.appendChild(node);
    }
  }

  function renderBrands(list) {
    var i;
    for (i = 0; i < brandBtnNodes.length; i++) {
      if (brandBtnNodes[i].parentNode) brandBtnNodes[i].parentNode.removeChild(brandBtnNodes[i]);
    }
    brandBtnNodes = [];
    for (i = 0; i < list.length; i++) {
      (function (b) {
        var btn = document.createElement('button');
        btn.className = 'ndl-chip';
        btn.setAttribute('style', 'cursor:pointer;background:transparent;font-family:inherit;font-size:11px;padding:7px 10px;border:1px solid ' + b.border + ';color:' + b.color + ';');
        btn.textContent = b.name;
        btn.addEventListener('click', b.run);
        brandBtnNodes.push(btn);
        brandsHost.appendChild(btn);
      })(list[i]);
    }
  }

  /* dynamic axis ticks: 4..6 round labels spanning [ZLO,ZHI] plus 5-unit minor
     ticks, positioned proportionally. Regenerated only when the window changes. */
  function renderTicks(v) {
    if (!ticksEl) return;
    var sig = v.zlo + '|' + v.zhi;
    if (sig === lastTicksSig) return;
    lastTicksSig = sig;
    var zlo = v.zlo, zhi = v.zhi, span = (zhi - zlo) || 1;
    var step = tickStep(span);
    var html = '', pos, val;
    /* minor ticks every 5 units (skip where a major label sits) */
    for (val = Math.ceil(zlo / 5) * 5; val <= zhi + 0.001; val += 5) {
      if (val % step === 0) continue;
      pos = ((val - zlo) / span * 100).toFixed(2);
      html += '<div style="position:absolute;left:' + pos + '%;top:calc(50% - 2px);width:1px;height:5px;background:#362E24;"></div>';
    }
    /* major ticks + round labels */
    for (val = Math.ceil(zlo / step) * step; val <= zhi + 0.001; val += step) {
      pos = ((val - zlo) / span * 100).toFixed(2);
      html += '<div style="position:absolute;left:' + pos + '%;top:calc(50% - 4px);width:1px;height:9px;background:#3A3228;"></div>';
      html += '<div style="position:absolute;left:' + pos + '%;top:calc(50% + 11px);transform:translateX(-50%);font-size:9px;color:#958772;font-variant-numeric:tabular-nums;">' + val + '</div>';
    }
    ticksEl.innerHTML = html;
  }

  /* named competitive field: one compact row per measured brand (focus in brass),
     its AI standing, its Google standing and a share-of-voice bar. Horizontal
     scroll protects the layout on narrow widths. */
  function renderField(v) {
    if (!fieldEl) return;
    if (!v.fieldRows.length) { fieldEl.innerHTML = ''; return; }
    var rowCols = 'minmax(74px,1fr) minmax(126px,1.4fr) minmax(84px,0.9fr) 92px';
    var head =
      '<div style="display:grid;grid-template-columns:' + rowCols + ';gap:10px;align-items:baseline;font-size:8.5px;letter-spacing:0.14em;text-transform:uppercase;color:#958772;">' +
        '<span>' + T('brand', 'marque') + '</span><span>' + T('in AI', 'en IA') + '</span><span>' + T('on Google', 'sur Google') + '</span><span style="text-align:right;">' + T('share of voice', 'part de voix') + '</span>' +
      '</div>';
    var rows = '';
    for (var i = 0; i < v.fieldRows.length; i++) {
      var f = v.fieldRows[i];
      rows +=
        '<div class="ndl-field-row" data-brand="' + esc(f.name) + '" style="display:grid;grid-template-columns:' + rowCols + ';gap:10px;align-items:center;">' +
          '<span style="font-size:11.5px;font-weight:' + (f.isFocus ? '600' : '400') + ';color:' + f.nameColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(f.name) + '</span>' +
          '<span style="font-size:10px;color:' + f.aiColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(f.ai) + '</span>' +
          '<span style="font-size:10px;color:' + f.googleColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(f.google) + '</span>' +
          '<span style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">' +
            '<span style="position:relative;width:52px;height:5px;background:#2F261D;"><span style="position:absolute;left:0;top:0;bottom:0;width:' + f.shareW + '%;background:' + f.shareColor + ';"></span></span>' +
            '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:10px;color:' + (f.isFocus ? BRASS : '#958772') + ';font-variant-numeric:tabular-nums;min-width:26px;text-align:right;">' + esc(f.shareLabel) + '</span>' +
          '</span>' +
        '</div>';
    }
    fieldEl.innerHTML =
      '<div style="overflow-x:auto;overflow-y:hidden;">' +
        '<div style="min-width:400px;display:flex;flex-direction:column;gap:6px;">' + head + rows + '</div>' +
      '</div>';
  }

  function renderVerdict(card) {
    if (verdictTitleEl) { verdictTitleEl.textContent = card.verdictTitle; verdictTitleEl.style.color = card.verdictColor; }
    if (verdictTextEl) verdictTextEl.textContent = card.verdictText;
  }

  function labelRow(txt) {
    return '<div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#A39784;">' + esc(txt) + '</div>';
  }

  function renderCards(card) {
    /* card 0 - "en IA": primary on X/Y, consistency, the main AI rival */
    var ia = card.ia;
    cardEls[0].innerHTML =
      labelRow(T('in AI', 'en IA')) +
      '<div style="display:flex;align-items:baseline;gap:10px;">' +
        '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(19px,1.9vw,28px);line-height:1;color:' + ia.bigColor + ';font-variant-numeric:tabular-nums;">' + esc(ia.big) + '</span>' +
        '<span style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#B2A694;">' + esc(ia.line) + '</span>' +
      '</div>' +
      (ia.rival ? '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#958772;">' + esc(ia.rival) + '</div>' : '');

    /* card 1 - "sur Google": your best/worst rank + who owns the page */
    var g = card.google;
    cardEls[1].innerHTML =
      labelRow(T('on Google', 'sur Google')) +
      '<div style="display:flex;align-items:baseline;gap:10px;">' +
        '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(19px,1.9vw,28px);line-height:1;color:' + g.bigColor + ';font-variant-numeric:tabular-nums;">' + esc(g.big) + '</span>' +
        '<span style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#B2A694;">' + esc(g.line) + '</span>' +
      '</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#958772;">' + esc(g.owners) + '</div>';

    /* card 2 - "aller plus loin": the ONE Deep Audit button on the whole
       screen (free tier only, see buildCards) plus the recurring offers
       (monitoring, settlement). A delivered deep result never repeats the
       Deep Audit sell, so the page never carries two competing primary
       buttons for the same product. */
    var dp = card.deep;
    var hasContent = !!dp.free || dp.delivered;
    var linksHtml = hasContent
      ? '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:2px;">' +
          (dp.delivered ? '' : '<button class="ndl-deep-cta" data-ev="deep_click" style="cursor:pointer;border:none;background:#C6A15B;color:#211A14;font-family:inherit;font-weight:600;font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 14px;">Deep Audit, 79 &euro;</button>') +
          '<a class="ndl-mon-link" href="/settlement#pricing" data-ev="monitor_click" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding-bottom:1px;">' + T('track over time', 'suivre dans le temps') + '</a>' +
          '<a class="ndl-mon-link" href="/settlement" data-ev="settlement_click" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding-bottom:1px;">' + T('performance settlement', 'règlement de performance') + '</a>' +
        '</div>'
      : '';
    cardEls[2].innerHTML =
      labelRow(T('go further', 'aller plus loin')) +
      (dp.free ? '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#958772;">' + esc(dp.free) + '</div>' : '') +
      (hasContent ? '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#C9BEAC;">' + esc(dp.adds) + '</div>' : '') +
      linksHtml +
      (dp.delivered ? '' : '<div class="ndl-deep-msg" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.4;color:#958772;display:none;"></div>');
    var cta = cardEls[2].querySelector('.ndl-deep-cta');
    if (cta) cta.addEventListener('click', startCheckout);
  }

  /* ============================ dock modes: idle / measuring / error ============================
     Before a real result exists (or after one fails), the dock used to be
     either an empty #362E24 slab (opacity:0 the whole time) or, briefly, a
     below-the-fold strip nobody scrolled to reach. Now it always carries
     real content: the three products at idle/while measuring, an honest,
     non-monetary recovery panel on error. Exactly ONE Deep Audit CTA can
     exist at a time across the whole page (idle dock XOR the settled result
     dock's card 2, via swapDockContent's mode switch - never both). */
  function idleFigureRow(big, bigColor, line) {
    return '<div style="display:flex;align-items:baseline;gap:10px;">' +
      '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(19px,1.9vw,28px);line-height:1;color:' + bigColor + ';font-variant-numeric:tabular-nums;">' + big + '</span>' +
      '<span style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#B2A694;">' + esc(line) + '</span>' +
    '</div>';
  }
  /* the idle/measuring dock: same three products the below-the-fold strip
     used to carry (Deep Audit / suivi dans le temps / règlement de
     performance), now living where a visitor actually sees them. Static,
     brand-agnostic copy: nothing here claims anything about the visitor's
     own measurement, because nothing has been measured yet. */
  function renderIdleCards() {
    cardEls[0].innerHTML =
      labelRow('deep audit') +
      idleFigureRow('79&euro;', '#E8DFD2', T('one time, 5 questions and 8 passes on one AI (versus 2 questions, 3 passes free).', 'une fois, 5 questions et 8 passages sur une IA (contre 2 questions, 3 passages en gratuit).')) +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:2px;">' +
        '<button class="ndl-deep-cta" data-ev="deep_click" style="cursor:pointer;border:none;background:#C6A15B;color:#211A14;font-family:inherit;font-weight:600;font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 14px;">' + T('Run a Deep Audit', 'Lancer un Deep Audit') + '</button>' +
      '</div>' +
      '<div class="ndl-deep-msg" style="display:none;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.4;color:#958772;"></div>';
    cardEls[1].innerHTML =
      labelRow(T('monitoring over time', 'suivi dans le temps')) +
      idleFigureRow(T('From 99', 'Dès 99') + '&euro;', '#E8DFD2', T('per month. The same bounded score, measured every week, one alert only when it clears the noise.', 'par mois. Le même score borné, mesuré chaque semaine, une alerte seulement quand ça sort du bruit.')) +
      '<a class="ndl-mon-link" href="/settlement#pricing" data-ev="monitor_click" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding-bottom:1px;">' + T('see the three plans', 'voir les trois offres') + '</a>';
    cardEls[2].innerHTML =
      labelRow(T('performance settlement', 'règlement de performance')) +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#C9BEAC;">' + T('Never a percentage. Nadelio referees contracts between brands and agencies, a gain counts only when it clears the 95 percent band.', 'Jamais un pourcentage. Nadelio arbitre les contrats entre marques et agences, un gain ne compte que hors de la bande à 95 pour cent.') + '</div>' +
      '<a class="ndl-mon-link" href="/settlement" data-ev="settlement_click" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding-bottom:1px;">' + T('how it works', 'comment ça marche') + '</a>';
    var cta = cardEls[0].querySelector('.ndl-deep-cta');
    if (cta) cta.addEventListener('click', startCheckout);
  }
  /* the error dock (a failed free measurement OR a Stripe payError): honest
     recovery information, deliberately NEVER a Deep Audit / payment pitch -
     selling 79 EUR at the exact moment something just failed would read as
     predatory, and on a payError the overlay above already carries its own
     Réessayer button, so this never duplicates it. */
  function renderErrorCards(v) {
    cardEls[0].innerHTML =
      labelRow('zero simulation') +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:#C9BEAC;">' + T('A measurement that fails never becomes a made up number. Nothing was measured this time.', 'Une mesure qui échoue ne devient jamais un chiffre inventé. Rien n\'a été mesuré cette fois.') + '</div>';
    var retryTxt = state.payError
      ? T('Your payment is safe. The detail and the Try again button are right above.', 'Votre paiement est en sécurité. Le détail et le bouton Réessayer sont juste au-dessus.')
      : (v.unknownMsg || T('Check the name, or paste the brand official website, then run it again.', 'Vérifiez le nom, ou collez le site officiel de la marque, puis relancez.'));
    cardEls[1].innerHTML =
      labelRow(T('to continue', 'pour continuer')) +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:#C9BEAC;">' + esc(retryTxt) + '</div>';
    cardEls[2].innerHTML =
      labelRow(T('how we measure', 'comment on mesure')) +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:#C9BEAC;">' + T('Sources, passes and method, unfiltered.', 'Sources, passages et méthode, sans filtre.') + '</div>' +
      '<button class="ndl-transp" id="ndl-dock-transp-btn" style="cursor:pointer;background:none;border:none;font-family:inherit;font-size:11px;color:#B2A694;border-bottom:1px solid #564D3C;padding:0 0 2px;align-self:flex-start;margin-top:2px;">' + T('transparency ›', 'transparence ›') + '</button>';
    var btn = cardEls[2].querySelector('#ndl-dock-transp-btn');
    if (btn) btn.addEventListener('click', openDrawer);
  }
  function populateDockCards(mode, v) {
    if (mode === 'result') renderCards(v.card);
    else if (mode === 'error') renderErrorCards(v);
    else renderIdleCards();
  }

  /* Content-swap choreography for the dock. The climactic idle/measuring ->
     result transition is the ONE that must read as a deliberate reveal (see
     the "verdict lands last" retiming in render()): cards are snapped to
     invisible with transitions disabled (imperceptible, same tick as the
     content swap), then released on the next frame with the ORIGINAL
     staggered cascade restored, so it plays exactly like the pre-existing
     first-ever reveal used to. Any other mode change (idle<->error, etc.) is
     secondary housekeeping and gets a soft, unstaggered crossfade. */
  var DOCK_STAGGER = [
    'opacity 0.48s cubic-bezier(0.2,0.8,0.2,1) 0ms, transform 0.48s cubic-bezier(0.2,0.8,0.2,1) 0ms',
    'opacity 0.48s cubic-bezier(0.2,0.8,0.2,1) 90ms, transform 0.48s cubic-bezier(0.2,0.8,0.2,1) 90ms',
    'opacity 0.48s cubic-bezier(0.2,0.8,0.2,1) 180ms, transform 0.48s cubic-bezier(0.2,0.8,0.2,1) 180ms'
  ];
  var DOCK_SOFT = 'opacity 0.3s cubic-bezier(0.2,0.8,0.2,1) 0ms, transform 0.3s cubic-bezier(0.2,0.8,0.2,1) 0ms';
  var lastDockMode = null;
  function swapDockContent(mode, v) {
    var i;
    for (i = 0; i < cardEls.length; i++) {
      cardEls[i].style.transition = 'none';
      cardEls[i].style.opacity = '0';
      cardEls[i].style.transform = 'translateY(10px)';
    }
    populateDockCards(mode, v);
    /* force the "opacity:0, transition:none" frame to commit before the next
       rAF restores a real transition and raises opacity - without this the
       browser can coalesce both writes into one frame and skip the fade
       entirely, exactly the "insight pops in" bug this mirrors (see render()). */
    void cardEls[0].offsetWidth;
    var staggered = mode === 'result';
    requestAnimationFrame(function () {
      for (i = 0; i < cardEls.length; i++) {
        cardEls[i].style.transition = staggered ? DOCK_STAGGER[i] : DOCK_SOFT;
        cardEls[i].style.opacity = '1';
        cardEls[i].style.transform = 'translateY(0)';
      }
    });
  }

  /* ============================ render() ============================ */
  function render() {
    var v = renderVals();

    /* controlled input (only touch it when the value actually differs) */
    if (inputEl && inputEl.value !== v.inputValue) inputEl.value = v.inputValue;

    /* Enforce "no new run while one is in flight" IN THE DOM, not just as a
       function guard (see runMeasure): a disabled button and a read-only
       input make it structurally impossible to fire a competing free run
       (and bump measureGen) while a paid Deep Audit is still running - the
       exact interaction that used to silently discard an already-billed
       79-euro dossier. */
    if (runBtn) {
      runBtn.disabled = !!v.measuring;
      runBtn.style.opacity = v.measuring ? '0.45' : '1';
      runBtn.style.cursor = v.measuring ? 'default' : 'pointer';
    }
    if (inputEl) inputEl.readOnly = !!v.measuring;

    /* idle Deep Audit CTA: dimmed (never fully disabled here - see the
       `if (state.measuring) return;` guard in startCheckout, which is the
       actual functional lock) while a measurement is in flight. */
    var deepCtaDim = document.querySelectorAll('.ndl-deep-cta');
    for (var dci = 0; dci < deepCtaDim.length; dci++) deepCtaDim[dci].style.opacity = v.measuring ? '0.45' : '1';

    /* "lecture en cours" overlay (fades out on settle) */
    if (overlayEl) overlayEl.style.opacity = v.measuringOverlayOp;

    /* verdict hero reveal - the CLIMAX. Retimed (0.28s delay/0.56s duration in
       the markup, see v2.html) to finish clearly after the dock cards, the
       field and the insight below - it must unmistakably land last, never
       just barely after them. aria-hidden mirrors visibility: the h2 inside
       is empty at idle/measuring, and an empty heading is noise for AT. */
    if (verdictEl) {
      verdictEl.style.opacity = v.verdictOp;
      verdictEl.style.transform = 'translateY(' + v.verdictTy + 'px)';
      if (v.haveResult) verdictEl.removeAttribute('aria-hidden');
      else verdictEl.setAttribute('aria-hidden', 'true');
    }
    /* the measured-brand chip next to "verdict": always shows who this result
       is for, never dimmed, so a screenshot is never ambiguous about whose
       numbers are on screen (the Yoyaku defect this whole feature fixes). */
    if (verdictBrandEl) verdictBrandEl.textContent = v.haveResult ? v.focusName : '';

    /* ---- live staleness (typed brand != measured brand) ----
       Runs on EVERY render (so every keystroke, via the input's own 'input'
       listener -> setState -> render), never gated behind a content
       signature: the whole point is that it must react before the visitor
       even finishes typing. Dims the verdict body, the insight, the field
       and the axis brackets - NOT the eyebrow chip above or the hint line
       itself, both of which must stay fully legible while the rest goes
       translucent. Nothing here touches opacity while !v.haveResult (idle /
       measuring): those elements are already at opacity 0 then via
       verdictOp/proofOp, and there is no result yet to mark stale. */
    var staleDim = v.stale ? 0.38 : 1;
    /* the cloud mirrors the same staleness dimming as the rest of the result -
       one property set on the shared PointsMaterial (opacity was 0.9 at
       creation, see initScene), never a per-particle or per-frame cost. */
    if (material) material.opacity = 0.9 * staleDim;
    if (verdictTitleEl) verdictTitleEl.style.opacity = staleDim;
    if (verdictTextEl) verdictTextEl.style.opacity = staleDim;
    /* share / free-export affordances dim with the rest of the verdict body
       while stale (per the task's hard requirement) - set every render, same
       as the axis brackets below, since the widget itself is only rebuilt on
       an actual content change (see the lastContentSig block further down). */
    if (shareEl) shareEl.style.opacity = staleDim;
    if (verdictStaleEl) {
      if (v.stale) { verdictStaleEl.style.display = 'block'; verdictStaleEl.textContent = v.staleMsg; }
      else { verdictStaleEl.style.display = 'none'; verdictStaleEl.textContent = ''; }
    }
    /* who + which market was measured (see renderIdentity): visible whenever
       a result is on screen, dims with the rest of the verdict body while
       stale, gone entirely at idle/measuring (nothing settled to name yet). */
    if (identityEl) {
      if (v.haveResult) { identityEl.style.display = 'flex'; identityEl.style.opacity = staleDim; }
      else { identityEl.style.display = 'none'; identityEl.innerHTML = ''; }
    }

    /* named competitive field fades to full on settle, further dimmed while stale */
    if (fieldEl) fieldEl.style.opacity = v.proofOp * staleDim;

    /* headline insight (shown only with a real result), revealed with the
       proof. display:none -> flex and opacity 0 -> 1 must never land in the
       same tick: a display:none element has no previous rendered frame to
       transition FROM, so the very first paint after un-hiding used to just
       show it already at opacity:1, no fade at all. Forcing a reflow while
       still at opacity:0 gives the browser a real "before" frame to animate
       away from once the next rAF raises it to v.proofOp. */
    if (insightEl) {
      var showInsight = v.haveResult && !!v.insight;
      if (showInsight) {
        if (insightEl.style.display !== 'flex') {
          insightEl.style.display = 'flex';
          insightEl.style.opacity = '0';
          void insightEl.offsetWidth;
          requestAnimationFrame(function () { insightEl.style.opacity = String(v.proofOp * staleDim); });
        } else {
          insightEl.style.opacity = v.proofOp * staleDim;
        }
      } else {
        insightEl.style.display = 'none';
        insightEl.style.opacity = 0;
      }
    }

    /* dynamic scale label (shows the zoom window once measured) */
    if (scaleLabelEl) scaleLabelEl.textContent = v.scaleLabel;

    /* dock cards: content + reveal choreography both live in swapDockContent,
       triggered only on an actual mode change (idle/measuring share 'idle',
       see renderVals) - never an empty slab, in any state. */
    if (v.mode !== lastDockMode) {
      swapDockContent(v.mode, v);
      lastDockMode = v.mode;
    }

    /* overlap / advantage band (persistent node -> its transition can fire) */
    if (regionEl) {
      var r = v.region;
      regionEl.style.left = r.leftPct + '%';
      regionEl.style.width = r.widthPct + '%';
      regionEl.style.background = r.fill;
      regionEl.style.borderLeft = '1px ' + r.borderStyle + ' ' + r.borderColor;
      regionEl.style.borderRight = '1px ' + r.borderStyle + ' ' + r.borderColor;
    }

    if (passCounterEl) { passCounterEl.textContent = v.passCounter; passCounterEl.style.color = v.passColor; }

    if (unknownEl) {
      if (v.hasUnknown) { unknownEl.style.display = ''; unknownEl.textContent = v.unknownMsg; }
      else unknownEl.style.display = 'none';
    }

    renderTicks(v);
    /* axis brackets: only rebuilt when their own signature changes (was
       unconditional on every render, including every keystroke while typing -
       see axisBrandsSig - and that unconditional rebuild is exactly what used
       to destroy the "pourquoi une fourchette" info-dot the instant it
       received keyboard focus). */
    var axSig = axisBrandsSig(v.axisBrands);
    if (axSig !== lastAxisBrandsSig) {
      renderAxisBrands(v.axisBrands);
      lastAxisBrandsSig = axSig;
    }
    /* axis brand brackets dim with the rest of the result while stale - set on
       every render (not gated by axSig) so it reacts on the same keystroke as
       everything else, and snaps instantly (these nodes have no opacity
       transition of their own, only `left`/`width` do). */
    for (var abi = 0; abi < axisBrandNodes.length; abi++) axisBrandNodes[abi].style.opacity = staleDim;

    /* quick-pick chips only reflect which example is focused -> rebuild on focus change */
    if (lastChipFocus !== state.focus) {
      renderBrands(v.brands);
      lastChipFocus = state.focus;
    }

    /* verdict text + field + insight text depend on the real result (or the
       loading/idle phase) -> rebuild only when that signature changes, so the
       ~ticking during loading never re-writes innerHTML needlessly. The dock
       cards themselves are handled above by swapDockContent (they need their
       own reveal choreography, not just a content refresh). */
    if (lastContentSig !== v.contentSig) {
      renderVerdict(v.card);
      renderField(v);
      if (insightTextEl) insightTextEl.textContent = v.insight;
      renderShareAffordance(v);
      renderIdentity(v.haveResult ? currentResult : null);
      lastContentSig = v.contentSig;
    }

    /* tooltip + drawer (mount/unmount only when their state changes) */
    renderTip();
    syncDrawer(v);
  }

  /* ============================ setState() ============================ */
  function setState(patch) {
    var prev = {};
    for (var k in state) prev[k] = state[k];
    for (var k2 in patch) state[k2] = patch[k2];
    render();
    componentDidUpdate(props, prev);
  }

  /* ============================ bootstrap ============================ */
  function init() {
    /* Localize the static chrome (or leave it, if the visitor is French - the
       markup is FR authored) before anything else runs, so there is no visible
       flash of the wrong language for an English visitor. Same detection rule
       as index.html: PAGE_FR from pageLang() at file load time. */
    applyChromeLang();
    /* computed here (not just in componentDidMount, which runs AFTER the
       first render() below) so the very first dock swap - the load-time
       idle-cards fade-in - already knows whether to respect reduced motion.
       In practice the global `@media (prefers-reduced-motion: reduce)`
       transition-duration:0.001ms override in nadelio.css neutralises any
       transition regardless, but this keeps the JS's own notion of `reduced`
       correct from the first frame instead of only after componentDidMount. */
    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    screenEl = document.querySelector('[data-nadelio-root]');
    mountEl = document.getElementById('ndl-mount');
    axisEl = document.getElementById('ndl-axis');
    axisAreaEl = document.getElementById('ndl-axisarea');
    inputEl = document.querySelector('.ndl-input');
    regionEl = document.getElementById('ndl-region');
    overlayEl = document.getElementById('ndl-overlay');
    verdictEl = document.getElementById('ndl-verdict');
    verdictTitleEl = document.getElementById('ndl-verdict-title');
    verdictTextEl = document.getElementById('ndl-verdict-text');
    verdictBrandEl = document.getElementById('ndl-verdict-brand');
    verdictStaleEl = document.getElementById('ndl-verdict-stale');
    insightEl = document.getElementById('ndl-insight');
    insightTextEl = document.getElementById('ndl-insight-text');
    fieldEl = document.getElementById('ndl-field');
    ticksEl = document.getElementById('ndl-ticks');
    scaleLabelEl = document.getElementById('ndl-scale-label');
    passCounterEl = document.getElementById('ndl-passcounter');
    unknownEl = document.getElementById('ndl-unknown');
    runBtn = document.querySelector('.ndl-run');
    brandsHost = runBtn.parentNode;
    transpBtn = document.getElementById('ndl-transp-btn');
    cardEls = Array.prototype.slice.call(document.querySelectorAll('.ndl-card'));
    subBannerEl = document.getElementById('ndl-subbanner');
    belowEl = document.getElementById('ndl-below');
    deepDocEl = document.getElementById('ndl-deepdoc');
    shareEl = document.getElementById('ndl-share');
    identityEl = document.getElementById('ndl-identity');
    idToggleBtn = document.getElementById('ndl-idtoggle');
    idPanelEl = document.getElementById('ndl-idpanel');
    officialUrlEl = document.getElementById('ndl-officialurl');
    marketSelectEl = document.getElementById('ndl-market');
    idUpdateBtn = document.getElementById('ndl-idupdate');
    if (overlayEl) defaultOverlayHTML = overlayEl.innerHTML;

    /* handlers on persistent nodes (was onChange / onKeyDown / onClick) */
    inputEl.addEventListener('input', function (ev) { setState({ inputValue: ev.target.value, unknownMsg: '' }); });
    inputEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') runMeasure(ev.target.value); });
    /* The input ships prefilled with "Qonto" (an example, not a placeholder)
       so autofocus alone used to leave a caret AFTER it - typing then gave
       "QontoNotion". Selecting it on the first genuine focus (before the
       visitor has done anything else) means the first keystroke replaces it
       cleanly, exactly like a search box. Stops doing this once the visitor
       has actually interacted (userInteracted), so refocusing the input
       later (post-reveal, tab-return, etc.) never nukes what they typed. */
    inputEl.addEventListener('focus', function () {
      if (!userInteracted) { try { inputEl.select(); } catch (e) {} }
    });
    runBtn.addEventListener('click', function () { runMeasure(state.inputValue || state.focus); });
    /* Funnel: the monitoring links, wherever they are rendered (dock card and
       deep dossier). Delegated because those nodes are rebuilt on every render.
       Only ALLOWLISTED names are mapped: deep_click is deliberately absent (it
       is fired inside startCheckout, after the identity and brand guards, so a
       raw click on a CTA that then refuses to proceed is not counted as intent
       to buy), and settlement_click has no allowlisted counterpart in app.py so
       it stays with the generic /api/track click logger. */
    var EV_MAP = { monitor_click: 'monitor_click', monitor_click_deep: 'monitor_click' };
    document.addEventListener('click', function (ev) {
      try {
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-ev]') : null;
        if (!el) return;
        var mapped = EV_MAP[el.getAttribute('data-ev')];
        if (mapped) track(mapped);
      } catch (e) {}
    }, true);
    if (transpBtn) transpBtn.addEventListener('click', openDrawer);
    if (idToggleBtn) idToggleBtn.addEventListener('click', function () { toggleIdPanel(); });
    if (idUpdateBtn) idUpdateBtn.addEventListener('click', onIdentityUpdate);

    /* first render populates every dynamic region before first paint */
    render();

    /* ref callbacks (source DOM order: mount, input, axis) then componentDidMount */
    mountRef(mountEl);
    inputRef(inputEl);
    axisRef(axisEl);
    componentDidMount();

    /* Stripe return (?paid / ?sub) or a plain ?brand= prefill, read once at
       boot. Runs last so every DOM ref and the 3D poll are already wired. */
    bootstrapParams();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
