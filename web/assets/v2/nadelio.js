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
   Palette: brass #C6A15B, sage #93A06E, terracotta #B07452 / #7C5240.
   density and breath were editor sliders; in production they are constants = 1.
   three.js is provided by window.THREE (self-hosted vendor script).
   ============================================================================ */
(function () {
  'use strict';

  /* ---------- constants (copied verbatim from the source) ---------- */
  var ZLO = 0, ZHI = 100;
  var BRASS = '#C6A15B', SAGE = '#93A06E', SIENNA = '#B07452', INK = '#D8CDBB';
  var SUPPORT_EMAIL = 'adam.chabbi94@gmail.com';

  /* Example quick-picks: REAL brands. The chips no longer replay demo data,
     they run a real audit through the backend, exactly like a typed brand. */
  var EXAMPLES = ['Qonto', 'Pennylane', 'Alan'];

  var TIP_TEXT = {
    scale: 'L\'échelle réelle va de 0 à 100. On zoome sur la zone utile pour rendre l\'écart lisible : l\'écart parait donc plus grand qu\'il ne l\'est sur 100. Les chiffres et les proportions restent exacts, l\'axe indique toujours sa fenêtre de zoom.',
    range: 'Le vrai score se trouve dans cette fourchette 95 fois sur 100. Plus elle est étroite, plus la mesure est sûre.',
    presence: 'Dans combien de vos questions la marque ressort. Absente d\'une question, elle est invisible pour tous ceux qui la posent.'
  };

  /* The single REAL result the whole view renders from. null = idle / measuring
     (nothing measured yet). buildResult(d) fills it from the /api/analyze body. */
  var currentResult = null;

  /* Empty card content used at idle / during measuring (the dock cards are held
     at opacity 0 then, so this is never actually read by a human). */
  var BLANK_CARD = {
    verdictTitle: '', verdictColor: '#93A06E', verdictText: '',
    ia: { big: '', bigColor: '#6E6250', line: '', rival: '' },
    google: { big: '', bigColor: '#6E6250', line: '', owners: '' },
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
    tip: { open: false }, drawerOpen: false,
    /* payError: a Stripe return (?paid) failed to verify or to run. Forces the
       "lecture en cours" overlay to stay up (like measuring) but with its own
       message + retry, and keeps the passcounter honest ("paiement", not
       "mesure en cours"). Cleared the moment a normal measurement starts. */
    payError: false
  };

  /* ---------- DOM refs (persistent nodes, never re-created) ---------- */
  var screenEl, mountEl, axisEl, axisAreaEl, inputEl, regionEl, overlayEl,
      verdictEl, verdictTitleEl, verdictTextEl,
      insightEl, insightTextEl, fieldEl, ticksEl, scaleLabelEl,
      passCounterEl, unknownEl, runBtn, brandsHost, transpBtn, cardEls = [],
      subBannerEl, belowEl, deepDocEl;
  /* the overlay's original "le nuage converge / lecture en cours" markup,
     captured once at init so the Stripe-return paid flow (which borrows this
     same node) can hand it back exactly as it found it. */
  var defaultOverlayHTML = '';

  /* ---------- three.js state ---------- */
  var renderer, scene, camera, group, sprite, material, points,
      targets, dirs, meta, ro, rafId, pollIv, measureStart, reduced;

  /* ---------- lifecycle / focus / reveal / log state ---------- */
  var revealT, logIv, focusArmed, focusOutHandler, userInteracted,
      visHandler, interactHandler, keyHandler,
      tipOverH, tipOutH, tipFocusInH, tipFocusOutH, tipClickH, hoverTipEl = null;

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
  /* Only ever emit http(s) links built from backend-supplied strings (SERP /
     evidence sources are third-party content Nadelio did not author) - never a
     javascript: or data: URL. Returns '' (renders no link) for anything else. */
  function safeHttpUrl(u) {
    var s = String(u || '').trim();
    return (/^https?:\/\//i).test(s) ? s : '';
  }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5); }

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
      tipEl.setAttribute('style', 'position:fixed;z-index:60;left:' + (tip.x || 0) + 'px;top:' + (tip.top || 0) + 'px;transform:' + (tip.transform || 'none') + ';width:264px;background:#1C170F;border:1px solid #3A3128;padding:13px 15px;box-shadow:0 10px 34px rgba(0,0,0,0.55);animation:tipIn 0.14s ease;pointer-events:none;');
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
    setState({ drawerOpen: true });
    setTimeout(function () { if (drawerCloseBtn) drawerCloseBtn.focus(); }, 40);
  }
  function closeDrawer() { setState({ drawerOpen: false }); }

  function buildDrawer(v) {
    drawerScrim = document.createElement('div');
    drawerScrim.setAttribute('style', 'position:fixed;inset:0;z-index:70;background:rgba(8,6,4,0.6);animation:scrimIn 0.2s ease;');
    drawerScrim.addEventListener('click', closeDrawer);

    drawerDialog = document.createElement('div');
    drawerDialog.setAttribute('role', 'dialog');
    drawerDialog.setAttribute('aria-modal', 'true');
    drawerDialog.setAttribute('aria-label', 'Le détail de la mesure');
    drawerDialog.setAttribute('style', 'position:fixed;top:0;right:0;bottom:0;z-index:71;width:min(620px,95vw);background:#14100C;border-left:1px solid #2A241C;display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,0.5);animation:drawerIn 0.28s cubic-bezier(0.2,0.8,0.2,1);');

    var fn = esc(v.focusName || 'la marque');
    var provider = esc(v.providerLabel || 'l\'IA');
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
      srcChips += '<span style="font-size:11px;color:#C9BEAC;border:1px solid #2A241C;padding:5px 9px;">' + esc(srcNames[i]) + '</span>';
    }

    /* column header = the brands, focus first and in brass */
    var headerCells = matrix.length ? matrix[0].cells : [];
    var K = headerCells.length;
    var gridCols = 'minmax(150px,1.4fr) repeat(' + Math.max(1, K) + ',minmax(104px,1fr))';
    var minW = 150 + Math.max(1, K) * 108;
    var hCols = '';
    for (var j = 0; j < headerCells.length; j++) {
      var hn = headerCells[j];
      hCols += '<div title="' + esc(hn.name) + '" style="font-size:10px;font-weight:' + (hn.isFocus ? '600' : '400') + ';color:' + (hn.isFocus ? BRASS : '#9A8D78') + ';text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(hn.name) + '</div>';
    }

    /* one cell = a brand's standing on a question: AI chip (primary=strong,
       mentioned=soft, absent=sienna outline) + cited/runs + Google rank. */
    function matrixCell(cell) {
      var aiTxt, aiBg, aiFg, aiBorder = 'transparent';
      if (cell.aiRank == null) {
        aiTxt = 'absent'; aiBg = 'transparent'; aiFg = '#7C5240'; aiBorder = 'rgba(176,116,82,0.55)';
      } else if (cell.aiKind === 'primary') {
        aiTxt = 'principal n' + cell.aiRank; aiBg = 'rgba(147,160,110,0.7)'; aiFg = '#141009';
      } else {
        aiTxt = 'cité n' + cell.aiRank; aiBg = 'rgba(147,160,110,0.28)'; aiFg = '#D8CDBB';
      }
      var citeTxt = (cell.aiRank != null && cell.runs) ? (cell.cited + '/' + cell.runs) : '';
      var gTxt = cell.serpRank != null ? ('Google n' + cell.serpRank) : 'Google absent';
      var focusEdge = cell.isFocus ? 'border-top:2px solid ' + BRASS + ';' : 'border-top:2px solid transparent;';
      return '<div style="display:flex;flex-direction:column;gap:3px;padding:5px;background:#171310;' + focusEdge + 'box-sizing:border-box;">' +
        '<div style="font-size:9.5px;line-height:1.2;text-align:center;padding:3px 4px;background:' + aiBg + ';border:1px solid ' + aiBorder + ';box-sizing:border-box;color:' + aiFg + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(aiTxt) + '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:4px;font-size:8.5px;color:#8A7D68;font-variant-numeric:tabular-nums;">' +
          '<span>' + (citeTxt ? ('cité ' + citeTxt) : '&nbsp;') + '</span><span>' + esc(gTxt) + '</span>' +
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
      rowsHtml = '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#8A7D68;">Lancez d\'abord une mesure pour voir le détail, question par question.</div>';
    }

    /* "Qui tient Google" : the hosts that own the page, per question, making the
       aggregator ownership explicit. */
    var ownerHtml = '';
    for (var qi = 0; qi < serpByQ.length; qi++) {
      var sq = serpByQ[qi];
      var hostsHtml = '';
      if (sq.hosts.length) {
        for (var hi = 0; hi < sq.hosts.length; hi++) {
          hostsHtml += '<span style="font-size:10.5px;color:#C9BEAC;border:1px solid #2A241C;padding:3px 7px;font-variant-numeric:tabular-nums;">' + esc(shortHost(sq.hosts[hi].host)) + ' <span style="color:#8A7D68;">n' + sq.hosts[hi].rank + '</span></span>';
        }
      } else {
        hostsHtml = '<span style="font-size:10.5px;color:#8A7D68;">page non relevée</span>';
      }
      ownerHtml += '<div style="display:flex;flex-direction:column;gap:5px;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;color:#A99C88;">« ' + esc(sq.q) + ' »</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:5px;">' + hostsHtml + '</div>' +
      '</div>';
    }
    if (!serpByQ.length) ownerHtml = '<div style="font-size:11.5px;color:#8A7D68;">Aucune donnée de page Google.</div>';

    drawerDialog.innerHTML =
      '<div style="flex:none;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);border-bottom:1px solid #2A241C;">' +
        '<div style="display:flex;flex-direction:column;gap:5px;">' +
          '<div style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(17px,1.7vw,23px);letter-spacing:-0.01em;">Le détail, sans filtre</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#A99C88;max-width:46ch;">Vos questions posées à Google et à ' + provider + ', et où chaque marque ressort. Rien n\'est agrégé avant que vous le voyiez.</div>' +
        '</div>' +
        '<button class="ndl-drawer-close" aria-label="fermer le détail" style="flex:none;cursor:pointer;background:none;border:1px solid #3A3128;color:#A99C88;font-family:inherit;font-size:15px;line-height:1;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">✕</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto;overflow-x:hidden;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);display:flex;flex-direction:column;gap:22px;">' +
        '<div style="display:flex;flex-direction:column;gap:9px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">les sources interrogées</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + srcChips + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">chaque marque, question par question</div>' +
            '<div style="font-size:10px;color:#8A7D68;font-variant-numeric:tabular-nums;">' + runN + ' mesures IA par question</div>' +
          '</div>' +
          '<div style="overflow-x:auto;overflow-y:hidden;">' +
            '<div style="min-width:' + minW + 'px;display:flex;flex-direction:column;gap:4px;">' +
              '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:3px;align-items:end;">' +
                '<div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#55483A;">question</div>' +
                hCols +
              '</div>' +
              rowsHtml +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:16px;padding-top:2px;">' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.7);"></span>réponse principale</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.28);"></span>cité plus bas</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:transparent;border:1px solid rgba(176,116,82,0.6);box-sizing:border-box;"></span>absent</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">qui tient la page Google</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#8A7D68;">Souvent, la page Google n\'est pas tenue par les marques mais par des comparateurs et des agrégateurs. Voici les domaines en tête, question par question.</div>' +
          ownerHtml +
        '</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#8A7D68;border-top:1px solid #2A241C;padding-top:14px;">Mesuré : ' + matrix.length + ' question' + (matrix.length > 1 ? 's' : '') + ', 1 IA (' + provider + '), ' + runN + ' passage' + (runN > 1 ? 's' : '') + ' par question, ' + matrix.length + ' lecture' + (matrix.length > 1 ? 's' : '') + ' de Google. Chaque case montre le rang réel de la marque, sans agrégation cachée. Le Deep Audit élargit cette même lecture à 5 questions et 8 passages par question, toujours sur ' + provider + '.</div>' +
      '</div>';

    screenEl.appendChild(drawerScrim);
    screenEl.appendChild(drawerDialog);
    drawerCloseBtn = drawerDialog.querySelector('.ndl-drawer-close');
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeDrawer);
  }
  function teardownDrawer() {
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
    slowNoteEl.setAttribute('style', 'font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#6E6250;margin-top:2px;');
    slowNoteEl.textContent = 'L\'instrument se réveille. La première mesure après une période calme peut prendre jusqu\'à une minute.';
    overlayEl.appendChild(slowNoteEl);
  }
  function clearSlowNote() {
    clearTimeout(slowNoteT); slowNoteT = null;
    if (slowNoteEl && slowNoteEl.parentNode) slowNoteEl.parentNode.removeChild(slowNoteEl);
    slowNoteEl = null;
  }

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
    ro = new ResizeObserver(function () { resize(); });
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
    var rows = rowsIn.slice().sort(function (a, b) { return b.s - a.s; });
    var l = rows[0], s2 = rows[1];
    var hasOverlap = false, oLo = 0, oHi = 0;
    if (rows.length >= 2) { oLo = Math.max(l.s - l.m, s2.s - s2.m); oHi = Math.min(l.s + l.m, s2.s + s2.m); hasOverlap = oLo < oHi; }
    var brass = [0.86, 0.68, 0.37], hot = [0.78, 0.44, 0.29];
    var pts = [];
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
    });
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
    if (points) { group.remove(points); points.geometry.dispose(); }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    points = new THREE.Points(geo, material);
    group.add(points);
    if (reduced) renderResolved();
  }

  function renderResolved() {
    if (!renderer || !points) return;
    var pos = points.geometry.attributes.position;
    pos.array.set(targets); pos.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function startLoop() {
    if (rafId || !renderer || reduced) return;
    var tick = function () { rafId = requestAnimationFrame(tick); frame(); };
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
    var pos = points.geometry.attributes.position.array;
    var n = pos.length / 3;
    for (var i = 0; i < n; i++) {
      var res = meta[i * 6], burst = meta[i * 6 + 1], ph = meta[i * 6 + 2], fq = meta[i * 6 + 3], stag = meta[i * 6 + 4], calm = meta[i * 6 + 5];
      var p = (e - 0.15 - stag) / 1.35;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      var k = Math.pow(1 - p, 3);
      var breathe = (0.7 + 0.3 * Math.sin(t * fq + ph)) * (measuring ? 1 : calm) * breath;
      var amp = res * breathe + burst * k;
      pos[i * 3] = targets[i * 3] + dirs[i * 3] * amp;
      pos[i * 3 + 1] = targets[i * 3 + 1] + dirs[i * 3 + 1] * amp;
      pos[i * 3 + 2] = targets[i * 3 + 2] + dirs[i * 3 + 2] * amp;
    }
    points.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
  }

  /* ============================ paid push (Deep Audit checkout) ============================ */
  /* Ported from index.html startCheckout: same endpoint, headers and body. The
     subject is the measured brand (state.focus / the real result), the market is
     the audit's own market label. Transparent, non-manipulative: everything free
     is already shown; this only goes deeper. */
  function deepMsg(text, isError) {
    var el = cardEls[2] ? cardEls[2].querySelector('.ndl-deep-msg') : null;
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
    el.style.color = isError ? '#B07452' : '#8A7D68';
  }
  function deepCtaLock(locked) {
    var el = cardEls[2] ? cardEls[2].querySelector('.ndl-deep-cta') : null;
    if (el) el.style.pointerEvents = locked ? 'none' : '';
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
    var urlHtml = url ? (' (<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="color:#A99C88;border-bottom:1px solid #4A4234;">' + esc(shortHost(url)) + '</a>)') : '';
    return '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;padding:11px 13px;border:1px solid #3A3128;background:#171310;">' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#D8CDBB;">Avant de payer, confirmez : nous avons identifié <b style="color:#E8DFD2;">' + name + '</b>' + urlHtml + '.</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="ndl-identity-yes" style="cursor:pointer;border:none;background:#C6A15B;color:#14100C;font-family:inherit;font-weight:600;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;padding:8px 12px;">Oui, lancer le paiement</button>' +
        '<button class="ndl-identity-no" style="cursor:pointer;border:1px solid #4A4234;background:none;color:#A99C88;font-family:inherit;font-size:10.5px;padding:8px 12px;">Ce n\'est pas ma marque</button>' +
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
      deepMsg('Corrigez le nom ou l\'URL de la marque puis relancez une mesure.', true);
      if (inputEl) inputEl.focus();
    });
  }
  function startCheckout() {
    var brand = (currentResult && currentResult.focusName) || state.focus || (state.inputValue || '').trim();
    if (!brand) { if (inputEl) inputEl.focus(); deepMsg('Lancez d\'abord un audit, le Deep Audit a besoin d\'une marque.', true); return; }
    /* Never let a low-confidence identification reach checkout unconfirmed:
       the 79-euro dossier must never be sold on possibly the wrong company. */
    if (currentResult && currentResult.confidence === 'low' && !identityConfirmed) {
      showIdentityConfirm();
      return;
    }
    var market = (currentResult && currentResult.market) || '';
    deepCtaLock(true);
    deepMsg('Ouverture du paiement sécurisé...', false);
    fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: brand, hint: '', market: market }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, body: d }; }); })
      .then(function (r) {
        var d = r.body || {};
        if (!r.ok || !d.url) {
          deepMsg(d.error === 'payments not configured'
            ? 'Le Deep Audit par paiement n\'est pas encore disponible. Revenez bientôt.'
            : 'Impossible d\'ouvrir le paiement pour le moment. Réessayez dans un instant.', true);
          deepCtaLock(false);
          return;
        }
        window.location = d.url;
      })
      .catch(function () {
        deepMsg('Impossible de joindre le serveur. Réessayez dans un instant.', true);
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

  function renderDeepDocHTML(R) {
    var geo = R.geo || {};
    var score = R.geoScore != null ? R.geoScore : (geo.point != null ? Math.round(geo.point) : null);
    var scoreColor = score != null ? scoreColorFor(score) : '#6E6250';
    var hw = geo.half_width;
    var verdictTag = geo.verdict ? (VERDICT_WORD_FR[geo.verdict] || '') : '';

    var scoreBlock = score != null
      ? '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">score de visibilité IA</div>' +
          '<div style="display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;">' +
            '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(38px,4.6vw,58px);line-height:1;color:' + scoreColor + ';font-variant-numeric:tabular-nums;">' + score + '</span>' +
            (hw != null ? '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:14px;color:#6E6250;font-variant-numeric:tabular-nums;">&plusmn;' + hw + '</span>' : '') +
            '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:12px;color:#8A7D68;">/ 100</span>' +
          '</div>' +
          (verdictTag ? '<div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#8A7D68;">' + esc(verdictTag) + '</div>' : '') +
        '</div>'
      : '';

    var priceBlock =
      '<div style="display:flex;flex-direction:column;gap:6px;padding-top:16px;border-top:1px solid #2A241C;">' +
        '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">continuer la mesure</div>' +
        '<a class="ndl-mon-link" href="/settlement#pricing" data-ev="monitor_click_deep" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#C9BEAC;border-bottom:1px solid #4A4234;align-self:flex-start;">Suivre cette marque, dès 99&euro;/mois</a>' +
        '<a class="ndl-mon-link" href="/settlement" data-ev="settlement_click_deep" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#A99C88;border-bottom:1px solid #4A4234;align-self:flex-start;">Réglement de performance</a>' +
      '</div>';

    var identityHtml = '';
    if (R.evidence && R.evidence.length) {
      var items = R.evidence.slice(0, 6).map(function (e) {
        var bits = [];
        if (e.site_name) bits.push('<b style="color:#E8DFD2;font-weight:600;">' + esc(e.site_name) + '</b>');
        if (e.title) bits.push(esc(e.title));
        if (e.description) bits.push('<span style="color:#8A7D68;">' + esc(e.description) + '</span>');
        var src = safeHttpUrl(e.source || e.link || '');
        var srcHtml = src ? ' <a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer" style="color:#A99C88;border-bottom:1px solid #4A4234;">source</a>' : '';
        return bits.length ? '<li style="margin-bottom:8px;line-height:1.55;">' + bits.join(', ') + srcHtml + '</li>' : '';
      }).join('');
      if (items) {
        identityHtml =
          '<div style="display:flex;flex-direction:column;gap:10px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">preuve sourcée</div>' +
            '<ul style="margin:0;padding-left:18px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;color:#C9BEAC;">' + items + '</ul>' +
          '</div>';
      }
    }

    var reportHtml = '';
    if (R.report) {
      var rep = R.report;
      var bsItems = (rep.blind_spots || []).map(function (b) {
        var by = (b.dominated_by || []).map(function (x) { return esc(x); }).join(', ');
        return '<li style="margin-bottom:8px;line-height:1.5;"><b style="color:#E8DFD2;font-weight:600;">' + esc(b.query) + '</b>' + (by ? ', dominé par ' + by : '') + '</li>';
      }).join('');
      var actItems = (rep.actions || []).map(function (a) {
        return '<li style="margin-bottom:9px;line-height:1.55;">' + esc(a) + '</li>';
      }).join('');
      reportHtml =
        '<div style="display:flex;flex-direction:column;gap:18px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">rapport de remédiation</div>' +
            '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:8.5px;letter-spacing:0.08em;text-transform:uppercase;color:#8A7D68;border:1px solid #2A241C;padding:2px 6px;">généré par IA</span>' +
          '</div>' +
          (rep.verdict ? '<div style="border-left:2px solid #C6A15B;padding:2px 0 2px 14px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#D8CDBB;">' + esc(rep.verdict) + '</div>' : '') +
          (bsItems ? '<div><div style="font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#6E6250;margin-bottom:8px;">angles morts nommés</div><ul style="margin:0;padding-left:18px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;color:#C9BEAC;">' + bsItems + '</ul></div>' : '') +
          (actItems ? '<div><div style="font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#6E6250;margin-bottom:8px;">plan d\'action</div><ol style="margin:0;padding-left:20px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;color:#C9BEAC;">' + actItems + '</ol></div>' : '') +
        '</div>';
    }

    /* Escaped exactly ONCE, at output (line below): esc()'ing these fragments
       here too double-escaped any "&" in a provider/market label ("&amp;" ->
       "&amp;amp;") in the paid dossier. */
    var footNote = 'Mesuré : ' + R.nQueries + ' question' + (R.nQueries > 1 ? 's' : '') + ', 1 IA (' + R.providerLabel + '), ' + R.n + ' passage' + (R.n > 1 ? 's' : '') + ' par question' + (R.market ? ', marché ' + R.market : '') + '.';

    return (
      '<div style="max-width:960px;margin:0 auto;padding:clamp(32px,6vh,64px) clamp(16px,3vw,40px) clamp(48px,8vh,88px);display:flex;flex-direction:column;gap:28px;border-top:1px solid #2A241C;">' +
        '<div style="display:flex;flex-direction:column;gap:6px;">' +
          '<div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#C6A15B;">deep audit, le dossier</div>' +
          '<h2 style="margin:0;font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-weight:400;font-size:clamp(22px,2.6vw,34px);line-height:1.05;letter-spacing:-0.01em;color:#E8DFD2;">' + esc(R.focusName) + '</h2>' +
        '</div>' +
        '<div class="ndl-deepgrid">' +
          '<div style="display:flex;flex-direction:column;gap:28px;min-width:0;">' + identityHtml + (identityHtml && reportHtml ? '<div style="border-top:1px solid #2A241C;"></div>' : '') + reportHtml + '</div>' +
          '<div style="display:flex;flex-direction:column;gap:0;">' + scoreBlock + priceBlock + '</div>' +
        '</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#6E6250;border-top:1px solid #2A241C;padding-top:14px;">' + esc(footNote) + '</div>' +
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
    if (deepDocEl) deepDocEl.innerHTML = renderDeepDocHTML(R);
    belowEl.style.display = 'block';
  }

  /* ============================ Stripe return (paid / sub) ============================ */
  /* Ported from index.html (resumeDeepAudit / resumeVerifyRetry / payError /
     runDeepAnalysis / resumeSubscription), recast in the v2 language: the
     Stripe return borrows the SAME #ndl-overlay node the normal "lecture en
     cours" loading state uses (state.measuring / state.payError both flip its
     opacity via renderVals()), so a paying customer always lands on the exact
     same instrument, mid read, never a blank or a dead page. */
  function payStepsHTML(lines) {
    var html = '<div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#6E6250;">paiement</div>';
    html += '<div style="display:flex;flex-direction:column;gap:5px;margin-top:2px;">';
    lines.forEach(function (l) {
      var color = l.state === 'done' ? SAGE : (l.state === 'active' ? '#E8DFD2' : '#6E6250');
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
    setState({ measuring: false, settled: false, payError: true });
    if (!overlayEl) return;
    overlayEl.innerHTML =
      '<div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#6E6250;">paiement</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#D8CDBB;max-width:52ch;">' + esc(msg) + '</div>' +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:8px;flex-wrap:wrap;">' +
        (retryFn ? '<button class="ndl-pay-retry" style="cursor:pointer;border:none;background:#E8DFD2;color:#14100C;font-family:inherit;font-weight:600;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 14px;">Réessayer</button>' : '') +
        '<a href="mailto:' + SUPPORT_EMAIL + '" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#A99C88;border-bottom:1px solid #4A4234;">Contacter le support</a>' +
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
    if (scene) buildClusters(loadingRows(), !reduced, '');
    if (reduced) renderResolved();
    showPayStep([
      { text: 'Paiement confirmé', state: 'done' },
      { text: 'Audit en cours (30 à 60s)', state: 'active' },
      { text: 'Dossier prêt', state: 'pending' }
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
          .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, body: d }; }); });
      })
      .then(function (ana) {
        if (ana == null || gen !== measureGen) return;
        var d = ana.body || {};
        if (!ana.ok || d.error || !d.ranking || !d.geo || d.geo.point == null) {
          showPayError('Le paiement est confirmé mais l\'audit n\'a pas abouti. Réessayez ou contactez le support, votre paiement est en sécurité.', function () { runDeepMeasure(brand, sessionId, market); });
          return;
        }
        /* Same guard on the paid path: the backend falls back to its demo
           fixture on a live failure. A customer who just paid must never be
           handed another brand's sample as their dossier. */
        if (d.mode !== 'live') {
          showPayError('Le paiement est confirmé mais la mesure n\'a pas abouti. Réessayez ou contactez le support, votre paiement est en sécurité.', function () { runDeepMeasure(brand, sessionId, market); });
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
          showPayError('Le paiement est confirmé mais l\'audit approfondi n\'a pas pu être débloqué automatiquement. Contactez le support avec votre reçu Stripe, nous le lançons pour vous, votre paiement est en sécurité.', null);
          return;
        }
        currentResult = buildResult(d);
        currentResult.officialUrl = officialUrl;
        measureStart = performance.now();
        if (scene) buildClusters(currentResult.rows, !reduced, currentResult.focusName);
        if (reduced) renderResolved();
        resetOverlayContent();
        var wait = reduced ? 0 : Math.max(0, MIN_LOAD_MS - (performance.now() - loadStart));
        clearTimeout(revealT);
        revealT = setTimeout(function () { reveal(gen); }, wait);
      })
      .catch(function () {
        showPayError('Impossible de joindre l\'instrument. Votre paiement est en sécurité, réessayez ou contactez le support.', function () { runDeepMeasure(brand, sessionId, market); });
      });
  }

  function showConsumedMessage() {
    /* Terminal state - this session has nothing left to resume. */
    clearPendingDeep();
    setState({ measuring: false, settled: false, payError: true });
    if (!overlayEl) return;
    overlayEl.innerHTML =
      '<div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#6E6250;">paiement</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#D8CDBB;max-width:52ch;">Ce Deep Audit a déjà été utilisé. Chaque paiement débloque un dossier unique. Lancez un nouveau Deep Audit pour en obtenir un autre, ou contactez le support si ceci est une erreur.</div>' +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:8px;">' +
        '<a href="mailto:' + SUPPORT_EMAIL + '" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#A99C88;border-bottom:1px solid #4A4234;">Contacter le support</a>' +
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
    showPayStep([{ text: 'Confirmation du paiement', state: 'active' }]);
    fetch('/api/verify-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, body: d }; }); })
      .then(function (r) {
        var d = r.body || {};
        if (!d.ok) {
          showPayError('Nous n\'avons pas pu confirmer ce paiement. Si vous avez été débité, réessayez ou contactez le support avec votre reçu Stripe.', function () { resumeDeepAudit(sessionId, brandParam); });
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
        showPayError('Impossible de confirmer le paiement pour le moment. Si vous avez été débité, réessayez ou contactez le support avec votre reçu.', function () { resumeDeepAudit(sessionId, brandParam); });
      });
  }

  /* Entry point for a ?sub={CHECKOUT_SESSION_ID} monitoring return. Purely a
     confirmation toast, it never touches the measurement state machine or the
     hero: the visitor can still type a brand and run a free audit underneath. */
  function showSubBanner(brand, tier, failed) {
    if (!subBannerEl) return;
    var html;
    if (failed) {
      html = '<div style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">suivi</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#D8CDBB;margin-top:4px;">Nous n\'avons pas pu confirmer cet abonnement. Si vous venez de payer, patientez un instant et actualisez, ou contactez le support.</div>';
    } else {
      var b = esc(brand || 'votre marque');
      var t = tier ? esc(tier) : '';
      html = '<div style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#93A06E;">suivi actif</div>' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#D8CDBB;margin-top:4px;">Le suivi est actif pour <b style="color:#E8DFD2;">' + b + '</b>' + (t ? ' (plan ' + t + ')' : '') + '. La première mesure bornée tourne cette semaine, vous serez alerté dès que le score devient volatil.</div>';
    }
    html += '<button class="ndl-subbanner-close" aria-label="fermer" style="position:absolute;top:8px;right:8px;cursor:pointer;background:none;border:none;color:#6E6250;font-family:inherit;font-size:13px;line-height:1;padding:4px;">&times;</button>';
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
       already delivered (and billed) it. DOM-enforced too, see render(). */
    if (state.measuring) return;
    var name = (rawName || '').trim();
    if (!name) { setState({ unknownMsg: 'Tapez le nom d\'une marque.' }); return; }
    resetOverlayContent();
    var gen = ++measureGen;
    currentResult = null;
    identityConfirmed = false;
    setState({ focus: name, inputValue: name, measuring: true, settled: false, payError: false, unknownMsg: '', passCount: 0 });
    renderBelowFold();
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
    fetch('/api/infer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: name }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, status: res.status, body: d }; }); })
      .then(function (inf) {
        if (gen !== measureGen) return null;
        var d = inf.body || {};
        officialUrl = d.official_url || '';
        var usable = inf.ok && !d.error && d.competitors && d.competitors.length && d.queries && d.queries.length;
        if (!usable) {
          failMeasure(gen, inf.status === 429
            ? 'Trop de requêtes, patientez un instant.'
            : 'Marque introuvable. Vérifiez l\'orthographe ou collez votre site.');
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
        }).then(function (res) { return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b }; }); });
      })
      .then(function (ana) {
        if (ana == null || gen !== measureGen) return;
        var d = ana.body || {};
        if (!ana.ok || d.error || !d.ranking || !d.geo || d.geo.point == null) {
          failMeasure(gen, (ana.status === 429 || d.error === 'quota_ip' || d.error === 'quota_global')
            ? 'Limite du jour atteinte (3 audits gratuits par jour). Revenez demain ou passez au suivi Pro.'
            : 'La mesure n\'a pas pu aboutir. Réessayez dans un instant.');
          return;
        }
        /* When the live pipeline fails (a SERP or model hiccup), the backend
           still answers 200 with its DEMO fixture (mode "demo"), which is a
           different brand entirely. Never present that as this visitor's
           measurement: a tool whose whole promise is honesty cannot show
           someone else's numbers under your brand name. */
        if (d.mode !== 'live') {
          failMeasure(gen, 'La mesure n\'a pas pu aboutir pour ' + name + '. Réessayez dans un instant.');
          return;
        }
        currentResult = buildResult(d);
        currentResult.officialUrl = officialUrl;
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
        failMeasure(gen, 'Impossible de joindre l\'instrument. Rien n\'a été mesuré.');
      });
  }

  function failMeasure(gen, msg) {
    if (gen !== measureGen) return;
    clearSlowNote();
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
    return {
      present: true, rank: Math.round(best.rank),
      kind: best.kind === 'primary' ? 'primary' : 'mentioned',
      consistency: cons, runs: runs, cited: runs ? Math.round(cons / 100 * runs) : 0,
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
    if (!ai || !ai.present) return 'absent de l\'IA';
    return (ai.kind === 'primary' ? 'principal' : 'mentionné') + ' n' + ai.rank + ', cité ' + ai.cited + '/' + ai.runs;
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
            cited: (cons != null && runs) ? Math.round(cons / 100 * runs) : null,
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
        var rr = c.runs || 0, cc = c.consistency != null ? c.consistency : 0;
        var cited = rr ? Math.round(cc / 100 * rr) : 0;
        if (focusPrimaryCited === null || cited < focusPrimaryCited) focusPrimaryCited = cited;
      }
    });
    var focusAi = aiSummary(focusEntry, queries);
    var focusSerp = serpRange(focusEntry, queries);
    var runs = focusAi.runs || n || 0;
    var aiLeader = fieldRows.length ? fieldRows[0] : null;

    var ctx = {
      focusName: focusName, geo: geo, rival: rival, Q: Q, runs: runs,
      providerLabel: d.ai_provider_label || 'l\'IA',
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
      providerLabel: d.ai_provider_label || 'l\'IA',
      market: d.market || '',
      notice: d.notice || '',
      tier: tier, evidence: evidence, report: report, geoScore: geoScore, planche: planche,
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
      var citedTxt = (c.focusPrimaryCited && c.runs) ? (c.focusPrimaryCited + ' fois sur ' + c.runs) : ('sur ' + c.runs + ' mesures');
      /* "primary" (kind==='primary') is a coverage majority across runs, not a
         rank-1 guarantee (a brand named primary in 2 of 3 runs while ranked
         2nd on average still has kind==='primary'). Never assert "n1" here. */
      var s = 'En IA, ' + c.focusName + ' est la réponse mise en avant sur ' + c.focusPrimaryN + ' de vos ' + Y + ' question' + plural + ', ' + citedTxt + '.';
      if (c.ownersPhrase) s += ' Sur Google, ce sont les comparateurs (' + c.ownersPhrase + ') qui tiennent la page. Vous gagnez la réponse IA, pas encore le référencement.';
      else if (c.focusSerp.best != null) s += ' Sur Google, votre meilleure position est le rang ' + c.focusSerp.best + '. L\'avantage IA est réel, tenez-le dans le temps.';
      else s += ' L\'avantage IA est réel, tenez-le dans le temps.';
      return s;
    }
    if (c.focusPresentN >= 1) {
      var lead = (c.aiLeader && !c.aiLeader.isFocus) ? c.aiLeader.name : '';
      var yr = c.focusAi.present ? c.focusAi.rank : null;
      var s2 = 'En IA, ' + c.focusName + ' est cité mais jamais en tête' + (yr != null ? (' (au mieux n' + yr + ')') : '') + '.';
      if (lead) s2 += ' C\'est ' + lead + ' qui est la réponse mise en avant.';
      if (c.ownersPhrase) s2 += ' Et sur Google, la page reste tenue par les comparateurs (' + c.ownersPhrase + ').';
      s2 += ' La place de premier choix est à prendre.';
      return s2;
    }
    var lead2 = (c.aiLeader && c.aiLeader.ai.present && !c.aiLeader.isFocus) ? c.aiLeader.name : '';
    var s3 = 'En IA, ' + c.focusName + ' n\'apparaît pas sur vos ' + Y + ' question' + plural + '.';
    if (lead2) s3 += ' C\'est ' + lead2 + ' qui prend la réponse.';
    if (c.ownersPhrase) s3 += ' Sur Google, ce sont les comparateurs (' + c.ownersPhrase + ') qui tiennent la page.';
    s3 += ' Vous êtes invisible pour qui pose ces questions à une IA.';
    return s3;
  }

  /* The verdict: bounded head-to-head. Confident and quantified, never planting
     doubt, never restating the visible numbers. Mirrors index.html boundedCompare. */
  function computeVerdict(focusName, geo, rival) {
    if (!geo || geo.point == null) return { title: '', color: INK, text: '', kind: 'none' };
    if (!rival) {
      var p = geo.point, t, txt;
      if (geo.verdict === 'SINGLE_RUN') { t = 'Première mesure.'; txt = focusName + ' obtient ' + p + ' sur 100 sur cette première lecture.'; }
      else if (geo.verdict === 'STABLE') { t = 'Position tenue.'; txt = focusName + ' obtient ' + p + ' sur 100, un niveau qui tient à chaque mesure.'; }
      else { t = 'Position mesurée.'; txt = focusName + ' obtient ' + p + ' sur 100, une visibilité réelle dans les réponses IA.'; }
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
        title: 'Trop tôt pour comparer.', color: INK, kind: 'unbounded',
        text: focusName + ' et ' + rival.brand + ' ne sont mesurés qu\'une fois chacun sur cette lecture. On ne départage jamais deux marques sur une seule mesure.'
      };
    }
    var gLow = geo.low, gHigh = geo.high, rLow = rival.low, rHigh = rival.high;
    var diff = geo.point - rival.point;
    if (gLow > rHigh) {
      var d1 = Math.max(1, Math.round(diff));
      return {
        title: 'Avance réelle.', color: SAGE, kind: 'ahead',
        text: focusName + ' devance ' + rival.brand + ' de ' + d1 + ' point' + (d1 > 1 ? 's' : '') + ', une avance nette qui tient à chaque mesure.'
      };
    }
    if (gHigh < rLow) {
      var d2 = Math.max(1, Math.round(-diff));
      return {
        title: rival.brand + ' devant, écart réel.', color: SIENNA, kind: 'behind',
        text: rival.brand + ' domine ' + focusName + ' de ' + d2 + ' point' + (d2 > 1 ? 's' : '') + ', un écart large et régulier. Le retard est réel, il faudra le combler.'
      };
    }
    var d3 = Math.abs(Math.round(diff));
    var gap = d3 === 0 ? 'sont à égalité' : ('se tiennent à ' + d3 + ' point' + (d3 > 1 ? 's' : ''));
    return {
      title: 'Trop proche pour trancher.', color: INK, kind: 'overlap',
      text: focusName + ' et ' + rival.brand + ' ' + gap + ', trop proche pour les départager. On préfère le dire que d\'inventer un gagnant.'
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
      var citedTxt = (c.focusPrimaryCited && c.runs) ? (', ' + c.focusPrimaryCited + ' fois sur ' + c.runs) : '';
      iaLine = 'Réponse mise en avant sur ' + c.focusPrimaryN + ' de vos ' + Y + ' question' + (Y > 1 ? 's' : '') + citedTxt + '.';
    } else if (c.focusAi.present) {
      iaBig = 'n' + c.focusAi.rank; iaColor = '#B07452';
      iaLine = 'Cité au mieux au rang ' + c.focusAi.rank + ', jamais en tête, sur ' + c.runs + ' passages.';
    } else {
      iaBig = 'absent'; iaColor = '#B07452';
      iaLine = 'Aucune citation dans les réponses ' + provider + ' sur vos ' + Y + ' questions.';
    }
    var iaRival = '';
    var rl = null;
    for (var i = 0; i < c.fieldRows.length; i++) { if (!c.fieldRows[i].isFocus && c.fieldRows[i].ai.present) { rl = c.fieldRows[i]; break; } }
    if (rl) iaRival = 'Principal rival IA : ' + rl.name + ' (' + aiLabel(rl.ai) + ').';

    /* card 1 - "sur Google" : your best/worst rank + who owns the page */
    var gBig, gColor, gLine;
    if (c.focusSerp.best != null) {
      gBig = 'n' + c.focusSerp.best; gColor = '#C6A15B';
      gLine = (c.focusSerp.worst != null && c.focusSerp.worst !== c.focusSerp.best)
        ? ('Vous figurez entre le rang ' + c.focusSerp.best + ' et le rang ' + c.focusSerp.worst + '.')
        : ('Vous figurez au rang ' + c.focusSerp.best + '.');
    } else {
      gBig = 'absent'; gColor = '#B07452';
      gLine = 'Vous n\'apparaissez pas dans la page Google sur ces questions.';
    }
    var gOwners;
    if (c.owners.length) {
      gOwners = 'La page est tenue par ' + c.owners.slice(0, 3).map(function (o) {
        return shortHost(o.host) + ' (rang ' + o.best_rank + ')';
      }).join(', ') + '.';
    } else {
      gOwners = 'Aucun domaine dominant identifié sur la page.';
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
        adds: 'Dossier sourcé livré ci-dessous : preuve, angles morts nommés et plan d\'action.'
      };
    } else {
      var free = 'Gratuit : ' + Y + ' question' + (Y > 1 ? 's' : '') + ', 1 IA (' + provider + '), ' + c.runs + ' passage' + (c.runs > 1 ? 's' : '') + ' par question.';
      /* Ground truth (app.py): a Deep Audit measures 5 questions (vs 2 free)
         and 8 passages per question on the SAME assistant (vs c.runs, 3 by
         default) - a tighter confidence interval, never a second assistant.
         "plusieurs IA recoupées" / "triple mesure" both over-claimed this;
         the free card above already says c.runs, so state the real deep
         number (8) against it and name the assistant explicitly so nobody
         reads this as a cross-model check. */
      var adds;
      if (c.planche && c.planche.query) {
        var holderTxt = c.planche.holder ? (', où ' + c.planche.holder + ' tient la réponse aujourd\'hui') : '';
        adds = 'Le Deep Audit élargit à 5 questions et 8 passages par question sur ' + provider + ' (contre ' + c.runs + ' aujourd\'hui), un intervalle plus étroit, et nomme vos angles morts, par exemple « ' + c.planche.query + ' »' + holderTxt + '.';
      } else {
        adds = 'Le Deep Audit élargit à 5 questions et 8 passages par question sur ' + provider + ' (contre ' + c.runs + ' aujourd\'hui), un intervalle plus étroit, et remet un plan d\'action sourcé.';
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
        var bracketColor = isFocus ? BRASS : cState === 'behind' ? '#7C5240' : '#8A7D68';
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
          nameColor: isFocus ? '#E8DFD2' : cState === 'behind' ? '#6E6250' : '#9A8D78',
          scoreColor: isFocus ? BRASS : cState === 'behind' ? '#6E6250' : '#A99C88',
          subColor: cState === 'behind' ? '#55483A' : '#8A7D68',
          scoreDisplay: r.s,
          /* A real 95% interval only when the backend actually bounded it.
             Never fabricate "entre X et Y" (nor its "why a range" tooltip,
             see axisBrandHTML) on a SINGLE_RUN read the backend explicitly
             refused to bound - that would sell a confidence claim that was
             never computed. */
          rangeText: bounded ? ('entre ' + Math.max(0, r.s - r.m) + ' et ' + Math.min(100, r.s + r.m)) : 'mesure unique, non bornée',
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
          : regionBox(Math.max(l.s - l.m, s2.s - s2.m), Math.min(l.s + l.m, s2.s + s2.m), 'rgba(176,116,82,0.14)', 'rgba(176,116,82,0.7)', 'solid');
      }
    }

    /* ---- example quick-pick chips (each runs a REAL audit) ---- */
    var brands = EXAMPLES.map(function (name) {
      return {
        key: name, name: name,
        run: function () { runMeasure(name); },
        border: name === st.focus ? '#8A7D68' : '#3A3128',
        color: name === st.focus ? '#E8DFD2' : '#8A7D68'
      };
    });

    /* ---- named competitive field (replaces the anonymous share bar) ---- */
    var fieldRows = [], focusName = st.focus;
    if (haveResult) {
      focusName = R.focusName;
      fieldRows = R.fieldRows.map(function (f) {
        var g = f.serpRank != null ? ('Google rang ' + f.serpRank) : 'absent de Google';
        return {
          name: f.name, isFocus: f.isFocus,
          nameColor: f.isFocus ? BRASS : '#C9BEAC',
          ai: aiLabel(f.ai),
          aiColor: !f.ai.present ? '#7C5240' : f.ai.kind === 'primary' ? '#93A06E' : '#A99C88',
          google: g,
          googleColor: f.serpRank != null ? '#8A7D68' : '#7C5240',
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
    /* dynamic scale label: shows the zoom window once a result is present */
    var scaleLabel = haveResult ? ('zoom ' + ZLO + ' à ' + ZHI + ' sur 100') : 'échelle 0 à 100';

    /* ---- pass counter: real total once settled, indeterminate while measuring ----
       R.n is the number of AI responses actually read (one API call per run,
       each covering every question) - R.passTotal (n x nQueries) counts
       question-coverage, not responses, and was mislabelled "réponses lues"
       (doubling the true count for a 2-question audit). A cached result is
       surfaced honestly here too: it is not this visitor's own fresh
       measurement (see buildResult / app.py _cache). */
    var passCounter;
    if (st.settled && haveResult) {
      passCounter = R.n + ' réponse' + (R.n > 1 ? 's' : '') + ' IA lues sur ' + R.nQueries + ' question' + (R.nQueries > 1 ? 's' : '') + (R.cached ? ', mesure en cache' : '');
    }
    else if (st.payError) passCounter = 'paiement';
    else if (st.measuring) passCounter = 'mesure en cours';
    else passCounter = 'en attente';

    var revealed = st.settled && haveResult;
    var contentSig = revealed ? ('R|' + R.sig) : ((st.measuring ? 'M|' : 'I|') + st.focus);

    return {
      measuring: st.measuring, settled: st.settled, haveResult: haveResult, contentSig: contentSig,
      measuringOverlayOp: (st.measuring || st.payError) ? 1 : 0,
      verdictOp: revealed ? 1 : 0,
      verdictTy: st.settled ? 0 : 14,
      proofOp: revealed ? 1 : 0,
      revealOp: revealed ? 1 : 0,
      revealTy: st.settled ? 0 : 14,
      passColor: st.measuring ? '#C6A15B' : '#8A7D68',
      inputValue: st.inputValue,
      hasUnknown: !!st.unknownMsg, unknownMsg: st.unknownMsg,
      brands: brands, axisBrands: axisBrands, region: region, card: card,
      zlo: ZLO, zhi: ZHI, scaleLabel: scaleLabel,
      fieldRows: fieldRows, insight: insight,
      passCounter: passCounter, focusName: focusName,
      matrix: haveResult ? R.matrix : [], owners: haveResult ? R.owners : [], serpByQ: haveResult ? R.serpByQ : [],
      market: haveResult ? R.market : '',
      providerLabel: haveResult ? R.providerLabel : 'l\'IA',
      runN: haveResult ? R.n : 0, nQueries: haveResult ? R.nQueries : 0
    };
  }

  /* ============================ DOM generation (was the <x-dc> markup) ============================ */
  function axisBrandHTML(ab) {
    var s = '';
    s += '<div style="position:absolute;left:' + ab.loPct + '%;width:' + ab.wPct + '%;top:calc(50% - 6px);height:12px;border-left:2px solid ' + ab.bracketColor + ';border-right:2px solid ' + ab.bracketColor + ';box-sizing:border-box;transition:left 0.6s cubic-bezier(0.2,0.8,0.2,1),width 0.6s cubic-bezier(0.2,0.8,0.2,1);">';
    s += '<div style="position:absolute;left:0;right:0;top:5px;height:1px;background:' + ab.bracketColor + ';opacity:0.5;"></div>';
    s += '</div>';
    s += '<div style="position:absolute;left:' + ab.midPct + '%;top:' + ab.leaderTop + ';width:1px;height:' + ab.leaderH + 'px;background:#3A3128;transition:left 0.6s cubic-bezier(0.2,0.8,0.2,1);"></div>';
    s += '<div style="position:absolute;left:' + ab.midPct + '%;' + ab.labelPos + ';transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:1px;white-space:nowrap;transition:left 0.6s cubic-bezier(0.2,0.8,0.2,1);">';
    s += '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10.5px;letter-spacing:0.06em;color:' + ab.nameColor + ';">' + esc(ab.name) + '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-weight:500;color:' + ab.scoreColor + ';font-variant-numeric:tabular-nums;">' + esc(ab.scoreDisplay) + '</span></span>';
    if (ab.showRange) {
      /* Bounded: a real 95% interval was computed, the tooltip explaining it
         is honest to show. */
      s += '<span style="display:inline-flex;align-items:center;gap:5px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:10.5px;color:' + ab.subColor + ';">' + esc(ab.rangeText);
      if (ab.focus) {
        s += '<button data-tip="range" class="ndl-tip-dot" aria-label="pourquoi une fourchette" style="cursor:help;background:none;border:1px solid #55483A;border-radius:50%;width:13px;height:13px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;font-size:8px;line-height:1;color:#8A7D68;">i</button>';
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
      html += '<div style="position:absolute;left:' + pos + '%;top:calc(50% - 2px);width:1px;height:5px;background:#2A241C;"></div>';
    }
    /* major ticks + round labels */
    for (val = Math.ceil(zlo / step) * step; val <= zhi + 0.001; val += step) {
      pos = ((val - zlo) / span * 100).toFixed(2);
      html += '<div style="position:absolute;left:' + pos + '%;top:calc(50% - 4px);width:1px;height:9px;background:#2E2820;"></div>';
      html += '<div style="position:absolute;left:' + pos + '%;top:calc(50% + 11px);transform:translateX(-50%);font-size:9px;color:#55483A;font-variant-numeric:tabular-nums;">' + val + '</div>';
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
      '<div style="display:grid;grid-template-columns:' + rowCols + ';gap:10px;align-items:baseline;font-size:8.5px;letter-spacing:0.14em;text-transform:uppercase;color:#55483A;">' +
        '<span>marque</span><span>en IA</span><span>sur Google</span><span style="text-align:right;">part de voix</span>' +
      '</div>';
    var rows = '';
    for (var i = 0; i < v.fieldRows.length; i++) {
      var f = v.fieldRows[i];
      rows +=
        '<div style="display:grid;grid-template-columns:' + rowCols + ';gap:10px;align-items:center;">' +
          '<span style="font-size:11.5px;font-weight:' + (f.isFocus ? '600' : '400') + ';color:' + f.nameColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(f.name) + '</span>' +
          '<span style="font-size:10px;color:' + f.aiColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(f.ai) + '</span>' +
          '<span style="font-size:10px;color:' + f.googleColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(f.google) + '</span>' +
          '<span style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">' +
            '<span style="position:relative;width:52px;height:5px;background:#221C15;"><span style="position:absolute;left:0;top:0;bottom:0;width:' + f.shareW + '%;background:' + f.shareColor + ';"></span></span>' +
            '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:10px;color:' + (f.isFocus ? BRASS : '#8A7D68') + ';font-variant-numeric:tabular-nums;min-width:26px;text-align:right;">' + esc(f.shareLabel) + '</span>' +
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
    return '<div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">' + esc(txt) + '</div>';
  }

  function renderCards(card) {
    /* card 0 - "en IA": primary on X/Y, consistency, the main AI rival */
    var ia = card.ia;
    cardEls[0].innerHTML =
      labelRow('en IA') +
      '<div style="display:flex;align-items:baseline;gap:10px;">' +
        '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(19px,1.9vw,28px);line-height:1;color:' + ia.bigColor + ';font-variant-numeric:tabular-nums;">' + esc(ia.big) + '</span>' +
        '<span style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#A99C88;">' + esc(ia.line) + '</span>' +
      '</div>' +
      (ia.rival ? '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#8A7D68;">' + esc(ia.rival) + '</div>' : '');

    /* card 1 - "sur Google": your best/worst rank + who owns the page */
    var g = card.google;
    cardEls[1].innerHTML =
      labelRow('sur Google') +
      '<div style="display:flex;align-items:baseline;gap:10px;">' +
        '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(19px,1.9vw,28px);line-height:1;color:' + g.bigColor + ';font-variant-numeric:tabular-nums;">' + esc(g.big) + '</span>' +
        '<span style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#A99C88;">' + esc(g.line) + '</span>' +
      '</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#8A7D68;">' + esc(g.owners) + '</div>';

    /* card 2 - "aller plus loin": the ONE Deep Audit button on the whole
       screen (free tier only, see buildCards) plus the recurring offers
       (monitoring, settlement). A delivered deep result never repeats the
       Deep Audit sell, so the page never carries two competing primary
       buttons for the same product. */
    var dp = card.deep;
    var hasContent = !!dp.free || dp.delivered;
    var linksHtml = hasContent
      ? '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:2px;">' +
          (dp.delivered ? '' : '<button class="ndl-deep-cta" data-ev="deep_click" style="cursor:pointer;border:none;background:#C6A15B;color:#14100C;font-family:inherit;font-weight:600;font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 14px;">Deep Audit, 79 &euro;</button>') +
          '<a class="ndl-mon-link" href="/settlement#pricing" data-ev="monitor_click" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#A99C88;border-bottom:1px solid #4A4234;padding-bottom:1px;">suivre dans le temps</a>' +
          '<a class="ndl-mon-link" href="/settlement" data-ev="settlement_click" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;color:#A99C88;border-bottom:1px solid #4A4234;padding-bottom:1px;">règlement de performance</a>' +
        '</div>'
      : '';
    cardEls[2].innerHTML =
      labelRow('aller plus loin') +
      (dp.free ? '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#8A7D68;">' + esc(dp.free) + '</div>' : '') +
      (hasContent ? '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.45;color:#C9BEAC;">' + esc(dp.adds) + '</div>' : '') +
      linksHtml +
      (dp.delivered ? '' : '<div class="ndl-deep-msg" style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.4;color:#8A7D68;display:none;"></div>');
    var cta = cardEls[2].querySelector('.ndl-deep-cta');
    if (cta) cta.addEventListener('click', startCheckout);
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

    /* "lecture en cours" overlay (fades out on settle) */
    if (overlayEl) overlayEl.style.opacity = v.measuringOverlayOp;

    /* verdict hero reveal - the climax (opacity + translateY, own 0.14s delay) */
    if (verdictEl) {
      verdictEl.style.opacity = v.verdictOp;
      verdictEl.style.transform = 'translateY(' + v.verdictTy + 'px)';
    }

    /* named competitive field fades to full on settle */
    if (fieldEl) fieldEl.style.opacity = v.proofOp;

    /* headline insight (shown only with a real result), revealed with the proof */
    if (insightEl) {
      if (v.haveResult && v.insight) { insightEl.style.display = 'flex'; insightEl.style.opacity = v.proofOp; }
      else { insightEl.style.display = 'none'; insightEl.style.opacity = 0; }
    }

    /* dynamic scale label (shows the zoom window once measured) */
    if (scaleLabelEl) scaleLabelEl.textContent = v.scaleLabel;

    /* dock cards reveal (opacity + translateY on the persistent outer nodes) */
    for (var i = 0; i < cardEls.length; i++) {
      cardEls[i].style.opacity = v.revealOp;
      cardEls[i].style.transform = 'translateY(' + v.revealTy + 'px)';
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
    renderAxisBrands(v.axisBrands);

    /* quick-pick chips only reflect which example is focused -> rebuild on focus change */
    if (lastChipFocus !== state.focus) {
      renderBrands(v.brands);
      lastChipFocus = state.focus;
    }

    /* verdict + cards + field + insight depend on the real result (or the
       loading/idle phase) -> rebuild only when that signature changes, so the
       ~ticking during loading never re-writes innerHTML needlessly. */
    if (lastContentSig !== v.contentSig) {
      renderCards(v.card);
      renderVerdict(v.card);
      renderField(v);
      if (insightTextEl) insightTextEl.textContent = v.insight;
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
    if (overlayEl) defaultOverlayHTML = overlayEl.innerHTML;

    /* handlers on persistent nodes (was onChange / onKeyDown / onClick) */
    inputEl.addEventListener('input', function (ev) { setState({ inputValue: ev.target.value, unknownMsg: '' }); });
    inputEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') runMeasure(ev.target.value); });
    runBtn.addEventListener('click', function () { runMeasure(state.inputValue || state.focus); });
    if (transpBtn) transpBtn.addEventListener('click', openDrawer);

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
