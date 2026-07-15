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

  /* Example quick-picks: REAL brands. The chips no longer replay demo data,
     they run a real audit through the backend, exactly like a typed brand. */
  var EXAMPLES = ['Qonto', 'Pennylane', 'Alan'];

  var TIP_TEXT = {
    scale: 'L\'échelle va de 0 à 100. On lit la position réelle de chaque marque et l\'écart entre elles, jamais grossi.',
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
    questions: [], ticks: [], presenceBig: '', presenceColor: '#6E6250', presenceText: '', action: ''
  };

  /* density and breath were editor sliders -> constants = 1 in production */
  var props = { density: 1, breath: 1 };

  /* Boot IDLE (not measuring, not settled): the page never auto-runs an audit,
     because every real audit costs money. The user triggers it (run button,
     Enter, or an example chip). focus/inputValue seed the input with an example. */
  var state = {
    focus: 'Qonto', measuring: false, settled: false,
    unknownMsg: '', inputValue: 'Qonto', passCount: 0,
    tip: { open: false }, drawerOpen: false
  };

  /* ---------- DOM refs (persistent nodes, never re-created) ---------- */
  var screenEl, mountEl, axisEl, axisAreaEl, inputEl, regionEl, overlayEl,
      verdictEl, verdictTitleEl, verdictTextEl,
      shareEl, shareSegsEl, sharePctEl, shareNameEl,
      passCounterEl, unknownEl, runBtn, brandsHost, transpBtn, cardEls = [];

  /* ---------- three.js state ---------- */
  var renderer, scene, camera, group, sprite, material, points,
      targets, dirs, meta, ro, rafId, pollIv, measureStart, reduced;

  /* ---------- lifecycle / focus / reveal / log state ---------- */
  var revealT, logIv, focusArmed, focusOutHandler, userInteracted,
      visHandler, interactHandler, keyHandler,
      tipOverH, tipOutH, tipFocusInH, tipFocusOutH, tipClickH, hoverTipEl = null;

  /* ---------- tracked dynamic node lists (for surgical re-render) ---------- */
  var axisBrandNodes = [], brandBtnNodes = [], lastChipFocus = null, lastContentSig = null;

  /* ---------- real-audit control (async flow) ---------- */
  var measureGen = 0;                 /* guards against overlapping runs */
  var slowNoteEl = null, slowNoteT = null;   /* "instrument waking" note (>8s) */
  var MIN_LOAD_MS = 1200;             /* minimum loading display so the animation reads */

  /* ---------- tooltip / drawer nodes ---------- */
  var tipEl = null, lastTipSig = '';
  var drawerScrim = null, drawerDialog = null, drawerCloseBtn = null, lastDrawerOpen = false;

  /* ============================ helpers ============================ */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5); }

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
    var perQ = v.transpQ || [];
    var runN = v.runN || 0;

    /* REAL granularity is PER-QUESTION: for each question we show where the brand
       ranks in Google (SERP) and in the one AI assistant actually queried. There
       is NO 12-AI matrix - the backend measures one assistant, N runs. */
    var srcNames = ['Google (SERP)', v.providerLabel || 'IA'];
    var srcChips = '';
    for (var i = 0; i < srcNames.length; i++) {
      srcChips += '<span style="font-size:11px;color:#C9BEAC;border:1px solid #2A241C;padding:5px 9px;">' + esc(srcNames[i]) + '</span>';
    }
    /* grid header: two territories, Google + the assistant */
    var colNames = ['Google', v.providerLabel || 'IA'];
    var hCols = '';
    for (var j = 0; j < colNames.length; j++) {
      hCols += '<div title="' + esc(colNames[j]) + '" style="font-size:9px;color:#8A7D68;text-align:center;white-space:nowrap;overflow:hidden;">' + esc(colNames[j]) + '</div>';
    }
    /* one cell = the brand's position for that question in that territory, or a
       dot when absent. Same visual language as the demo (green = cited, sienna
       border = absent), only the meaning is now honest (rank, not a fabricated
       per-AI hit count). */
    function detailCell(rank) {
      var absent = (rank == null);
      var rr = absent ? 0 : Math.round(rank);
      var strong = !absent && rr <= 3;
      var bg = absent ? 'transparent' : strong ? 'rgba(147,160,110,0.7)' : 'rgba(147,160,110,0.28)';
      var border = absent ? 'rgba(176,116,82,0.55)' : 'transparent';
      var textColor = absent ? '#7C5240' : strong ? '#141009' : '#D8CDBB';
      var label = absent ? '·' : String(rr);
      var title = absent ? 'absent' : 'rang ' + rr;
      return '<div title="' + title + '" style="height:26px;display:flex;align-items:center;justify-content:center;font-size:10px;font-variant-numeric:tabular-nums;background:' + bg + ';border:1px solid ' + border + ';box-sizing:border-box;color:' + textColor + ';">' + label + '</div>';
    }
    var rowsHtml = '';
    for (var ri = 0; ri < perQ.length; ri++) {
      var p = perQ[ri];
      rowsHtml += '<div style="display:grid;grid-template-columns:minmax(160px,1.7fr) repeat(2,minmax(70px,1fr));gap:3px;align-items:stretch;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;color:#D8CDBB;display:flex;align-items:center;padding-right:8px;line-height:1.3;">« ' + esc(p.q) + ' »</div>' +
        detailCell(p.serpRank) + detailCell(p.aiRank) + '</div>';
    }
    if (!perQ.length) {
      rowsHtml = '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;color:#8A7D68;">Lancez d\'abord une mesure pour voir le détail, question par question.</div>';
    }

    drawerDialog.innerHTML =
      '<div style="flex:none;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);border-bottom:1px solid #2A241C;">' +
        '<div style="display:flex;flex-direction:column;gap:5px;">' +
          '<div style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(17px,1.7vw,23px);letter-spacing:-0.01em;">Le détail, sans filtre</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#A99C88;max-width:46ch;">Voici vos questions posées à Google et à ' + provider + ' pour mesurer ' + fn + ', et où la marque ressort. Rien n\'est agrégé avant que vous le voyiez.</div>' +
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
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">résultat par question</div>' +
            '<div style="font-size:10px;color:#8A7D68;font-variant-numeric:tabular-nums;">' + runN + ' mesures IA par question</div>' +
          '</div>' +
          '<div style="overflow-x:auto;overflow-y:hidden;">' +
            '<div style="min-width:340px;display:flex;flex-direction:column;gap:4px;">' +
              '<div style="display:grid;grid-template-columns:minmax(160px,1.7fr) repeat(2,minmax(70px,1fr));gap:3px;align-items:end;">' +
                '<div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#55483A;">question</div>' +
                hCols +
              '</div>' +
              rowsHtml +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:16px;padding-top:2px;">' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.7);"></span>cité en tête</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.28);"></span>cité plus bas</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:transparent;border:1px solid rgba(176,116,82,0.6);box-sizing:border-box;"></span>absent</div>' +
          '</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#8A7D68;">Le chiffre d\'une case, c\'est la position de ' + fn + ' pour cette question. Un point signifie absent. On lit Google une fois et on interroge ' + provider + ' ' + runN + ' fois par question, puis le score est borné sur ces mesures.</div>' +
        '</div>' +
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
    setState({
      measuring: false, settled: true,
      passCount: currentResult ? currentResult.passTotal : 0,
      unknownMsg: (currentResult && currentResult.notice) ? currentResult.notice : ''
    });
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
     have a result, else a neutral converging cloud (no labels, no fake scores). */
  function loadingRows() { return [{ n: '', s: 70, m: 8 }]; }
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
    var proven = (l.s - l.m) > (s2.s + s2.m);
    if (i === 0) return proven ? 'proven' : 'contested';
    if (i === 1 && !proven) return 'contested';
    if ((l.s - l.m) > (r.s + r.m)) return 'behind';
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

  /* ============================ measurement control ============================ */
  /* Real two-step flow, same-origin: /api/infer identifies the brand + proposes
     the queries, then /api/analyze runs the bounded audit. The loading animation
     starts optimistically at once; the reveal fires on DATA ARRIVAL. */
  function runMeasure(rawName) {
    var name = (rawName || '').trim();
    if (!name) { setState({ unknownMsg: 'Tapez le nom d\'une marque.' }); return; }
    var gen = ++measureGen;
    currentResult = null;
    setState({ focus: name, inputValue: name, measuring: true, settled: false, unknownMsg: '', passCount: 0 });
    measureStart = performance.now();
    if (scene) buildClusters(loadingRows(), !reduced, '');
    if (reduced) renderResolved();
    clearSlowNote();
    slowNoteT = setTimeout(function () { if (gen === measureGen && state.measuring) showSlowNote(); }, 8000);
    runReal(name, gen);
  }

  function runReal(name, gen) {
    var loadStart = performance.now();
    fetch('/api/infer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: name }) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, status: res.status, body: d }; }); })
      .then(function (inf) {
        if (gen !== measureGen) return null;
        var d = inf.body || {};
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
        currentResult = buildResult(d);
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
    setState({ measuring: false, settled: false, unknownMsg: msg, passCount: 0 });
    if (scene) buildClusters(loadingRows(), false, '');
    if (reduced) renderResolved();
  }

  /* ============================ adapter: d -> view model ============================ */
  /* Turns the /api/analyze body into the single object renderVals() reads. The
     bounded head-to-head (focus vs top rival) is the honest core; we never invent
     scores for brands the backend did not bound. */
  function buildResult(d) {
    var focusName = d.brand || '';
    var geo = d.geo || null;
    var rival = (d.geo_rival && d.geo_rival.point != null) ? d.geo_rival : null;
    var queries = d.queries || [];
    var Q = queries.length;
    var n = (geo && geo.n) ? geo.n : 0;

    /* rows: focus + (optional) rival, from their bounded scores only */
    var rows = [];
    if (geo && geo.point != null) {
      rows.push({ n: focusName, s: geo.point, m: (geo.half_width != null ? geo.half_width : 1) });
      if (rival) rows.push({ n: rival.brand, s: rival.point, m: (rival.half_width != null ? rival.half_width : 1) });
    }

    var ranking = d.ranking || [];
    var lc = String(focusName).toLowerCase();
    var focusEntry = ranking.find(function (r) { return String(r.brand).toLowerCase() === lc; }) || null;

    /* share of voice: the focus entry's name MUST equal d.brand */
    var share = ranking.map(function (r) { return { n: r.brand, v: Math.max(0, Number(r.share_of_voice) || 0) }; });

    /* per-question detail (drawer + cards) from the focus entry's real cells */
    var perQ = queries.map(function (q) {
      var serp = focusEntry && focusEntry.cells ? focusEntry.cells[q] : null;
      var ai = focusEntry && focusEntry.ai_cells ? focusEntry.ai_cells[q] : null;
      return {
        q: q,
        serpRank: (serp && serp.rank != null) ? serp.rank : null,
        aiRank: (ai && ai.rank != null) ? ai.rank : null,
        aiKind: ai ? ai.kind : null
      };
    });
    var presentCount = perQ.filter(function (p) { return p.aiRank != null; }).length;

    return {
      sig: focusName + '|' + (geo ? geo.point : '') + '|' + (rival ? rival.point : '') + '|' + n + '|' + Q,
      focusName: focusName, geo: geo, rival: rival,
      rows: rows, share: share, perQ: perQ,
      nQueries: Q, presentCount: presentCount, n: n,
      passTotal: n * Q,                        /* n runs x Q queries, one assistant */
      providerLabel: d.ai_provider_label || 'l\'IA',
      notice: d.notice || '',
      cards: buildCards(focusName, geo, rival, ranking, d.serp_landscape, perQ, presentCount, Q, d.ai_provider_label || 'l\'IA')
    };
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
    var gLow = geo.half_width != null ? geo.low : geo.point;
    var gHigh = geo.half_width != null ? geo.high : geo.point;
    var rLow = rival.half_width != null ? rival.low : rival.point;
    var rHigh = rival.half_width != null ? rival.high : rival.point;
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

  /* Which brand (or SERP host) takes a question the focus brand misses. */
  function whoTakes(q, ranking, focusName, landscape) {
    var lc = String(focusName).toLowerCase(), best = null;
    (ranking || []).forEach(function (r) {
      if (String(r.brand).toLowerCase() === lc) return;
      var c = r.ai_cells && r.ai_cells[q];
      if (c && c.rank != null && (best === null || c.rank < best.rank)) best = { name: r.brand, rank: c.rank };
    });
    if (best) return best.name;
    var lq = landscape && landscape.queries && landscape.queries[q];
    if (lq && lq.length && lq[0].host) return lq[0].host;
    return '';
  }

  function buildCards(focusName, geo, rival, ranking, landscape, perQ, presentCount, Q, providerLabel) {
    var verdict = computeVerdict(focusName, geo, rival);
    var toneColor = function (t) { return t === 'up' ? SAGE : t === 'down' ? SIENNA : '#A99C88'; };

    /* card 0 - real questions with a present/absent status */
    var q3 = perQ.slice(0, 3).map(function (p) {
      var tone, status;
      if (p.aiRank != null && (p.aiKind === 'primary' || Math.round(p.aiRank) === 1)) { tone = 'up'; status = 'cité en premier'; }
      else if (p.aiRank != null) { tone = 'mid'; status = 'cité, rang ' + Math.round(p.aiRank) + ' dans l\'IA'; }
      else if (p.serpRank != null) { tone = 'mid'; status = 'présent sur Google, rang ' + p.serpRank; }
      else { tone = 'down'; status = 'absent des réponses'; }
      return { q: p.q, status: status, statusColor: toneColor(tone), dot: toneColor(tone) };
    });

    /* card 1 - presence X / N across the real questions (AI coverage) */
    var ratio = Q ? presentCount / Q : 0;
    var presColor = ratio >= 0.67 ? '#93A06E' : '#B07452';
    var ticks = perQ.map(function (p) {
      var present = p.aiRank != null;
      var strong = present && Math.round(p.aiRank) <= 3;
      return {
        bg: !present ? 'transparent' : strong ? 'rgba(147,160,110,0.85)' : 'rgba(147,160,110,0.32)',
        border: present ? 'transparent' : 'rgba(176,116,82,0.6)'
      };
    });
    var absentQ = perQ.filter(function (p) { return p.aiRank == null; }).map(function (p) { return p.q; });
    var presenceText;
    if (Q === 0) presenceText = '';
    else if (presentCount === Q) presenceText = 'Présent dans toutes vos questions, mesuré sur ' + providerLabel + '.';
    else if (presentCount === 0) presenceText = 'Absent des réponses IA sur vos ' + Q + ' questions.';
    else presenceText = 'Absent sur : ' + absentQ.slice(0, 2).map(function (x) { return '« ' + x + ' »'; }).join(', ') + '.';

    /* card 2 - one honest next step */
    var action;
    var firstAbsent = perQ.filter(function (p) { return p.aiRank == null; })[0];
    if (firstAbsent) {
      var who = whoTakes(firstAbsent.q, ranking, focusName, landscape);
      action = 'Gagner « ' + firstAbsent.q + ' », la question où vous n\'apparaissez pas encore' + (who ? (', ' + who + ' y prend la réponse') : '') + '.';
    } else if (rival && verdict.kind === 'overlap') {
      action = 'L\'écart avec ' + rival.brand + ' se joue à quelques citations. Gagner une question de plus suffit à le trancher.';
    } else if (rival && verdict.kind === 'behind') {
      action = 'Combler le retard sur ' + rival.brand + ' : viser les questions où il passe devant.';
    } else if (rival) {
      action = 'Tenir l\'avance sur ' + rival.brand + ' en surveillant la mesure dans le temps.';
    } else {
      action = 'Surveiller la mesure dans le temps pour voir la position bouger.';
    }

    return {
      verdictTitle: verdict.title, verdictColor: verdict.color, verdictText: verdict.text,
      questions: q3, ticks: ticks,
      presenceBig: presentCount + ' / ' + Q, presenceColor: presColor, presenceText: presenceText,
      action: action
    };
  }

  /* ============================ renderVals() ============================ */
  /* Single source of truth. Reads currentResult (the real audit) when present,
     else returns a blank/idle view (no fake brackets, no fake numbers). */
  function renderVals() {
    var st = state;
    var R = currentResult;
    var haveResult = !!(R && R.rows && R.rows.length);
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
        /* clamp to the visible 0..100 so an out-of-window real score never
           renders a negative-width or off-axis bracket; the axis spans 0..100. */
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
          rangeText: 'entre ' + Math.max(0, r.s - r.m) + ' et ' + Math.min(100, r.s + r.m),
          showRange: isFocus,
          leaderTop: isFocus ? 'calc(50% - 22px)' : 'calc(50% + 6px)',
          leaderH: isFocus ? 16 : level === 1 ? 12 : 30,
          labelPos: isFocus ? 'bottom:calc(50% + 24px)' : level === 1 ? 'top:calc(50% + 20px)' : 'top:calc(50% + 40px)'
        };
      });
      if (sorted.length >= 2) {
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

    /* ---- share of voice (focus entry name === d.brand) ---- */
    var shareSegs = [], focusShare = 0, focusName = st.focus;
    if (haveResult) {
      focusName = R.focusName;
      var fe = R.share.find(function (x) { return x.n === R.focusName; }) || R.share[0];
      focusShare = fe ? fe.v : 0;
      shareSegs = R.share.map(function (x, i) {
        return {
          key: x.n, pct: x.v,
          color: x.n === R.focusName ? BRASS : 'rgba(216,205,187,' + Math.max(0.06, 0.30 - i * 0.06).toFixed(2) + ')',
          title: x.n + ' : ' + Math.round(x.v) + '% des citations du panel'
        };
      });
    }

    var card = haveResult ? R.cards : BLANK_CARD;

    /* ---- pass counter: real total once settled, indeterminate while measuring ---- */
    var passCounter;
    if (st.settled && haveResult) passCounter = R.passTotal + ' réponses lues';
    else if (st.measuring) passCounter = 'mesure en cours';
    else passCounter = 'en attente';

    var revealed = st.settled && haveResult;
    var contentSig = revealed ? ('R|' + R.sig) : ((st.measuring ? 'M|' : 'I|') + st.focus);

    return {
      measuring: st.measuring, settled: st.settled, haveResult: haveResult, contentSig: contentSig,
      measuringOverlayOp: st.measuring ? 1 : 0,
      verdictOp: revealed ? 1 : 0,
      verdictTy: st.settled ? 0 : 14,
      proofOp: revealed ? 1 : 0,
      revealOp: revealed ? 1 : 0,
      revealTy: st.settled ? 0 : 14,
      passColor: st.measuring ? '#C6A15B' : '#8A7D68',
      inputValue: st.inputValue,
      hasUnknown: !!st.unknownMsg, unknownMsg: st.unknownMsg,
      brands: brands, axisBrands: axisBrands, region: region, card: card,
      shareSegs: shareSegs, focusShare: focusShare, passCounter: passCounter, focusName: focusName,
      transpQ: haveResult ? R.perQ : [], providerLabel: haveResult ? R.providerLabel : 'l\'IA',
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
      s += '<span style="display:inline-flex;align-items:center;gap:5px;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:10.5px;color:' + ab.subColor + ';">' + esc(ab.rangeText);
      if (ab.focus) {
        s += '<button data-tip="range" class="ndl-tip-dot" aria-label="pourquoi une fourchette" style="cursor:help;background:none;border:1px solid #55483A;border-radius:50%;width:13px;height:13px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;font-size:8px;line-height:1;color:#8A7D68;">i</button>';
      }
      s += '</span>';
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

  function renderShare(v) {
    var html = '';
    for (var i = 0; i < v.shareSegs.length; i++) {
      var sg = v.shareSegs[i];
      html += '<div title="' + esc(sg.title) + '" style="width:' + sg.pct + '%;background:' + sg.color + ';transition:width 0.6s cubic-bezier(0.2,0.8,0.2,1),background 0.4s;"></div>';
    }
    if (shareSegsEl) shareSegsEl.innerHTML = html;
    if (sharePctEl) sharePctEl.textContent = (v.haveResult ? Math.round(v.focusShare) : 0) + '%';
    if (shareNameEl) shareNameEl.textContent = v.haveResult ? ('des citations du panel vont à ' + v.focusName) : '';
  }

  function renderVerdict(card) {
    if (verdictTitleEl) { verdictTitleEl.textContent = card.verdictTitle; verdictTitleEl.style.color = card.verdictColor; }
    if (verdictTextEl) verdictTextEl.textContent = card.verdictText;
  }

  function renderCards(card) {
    /* card 0 - "ce que les gens demandent" (questions, tone-colored dot) */
    var qh = '';
    for (var i = 0; i < card.questions.length; i++) {
      var q = card.questions[i];
      qh += '<div style="display:flex;flex-direction:column;gap:0;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;color:#E8DFD2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">« ' + esc(q.q) + ' »</div>' +
        '<div style="display:flex;align-items:center;gap:6px;font-size:9.5px;color:' + q.statusColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="width:5px;height:5px;flex:none;background:' + q.dot + ';"></span>' + esc(q.status) + '</div>' +
        '</div>';
    }
    cardEls[0].innerHTML =
      '<div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">ce que les gens demandent</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' + qh + '</div>';

    /* card 1 - "présence dans vos questions" (label is a tooltip trigger) */
    var th = '';
    for (var j = 0; j < card.ticks.length; j++) {
      var t = card.ticks[j];
      th += '<div style="width:11px;height:7px;background:' + t.bg + ';border:1px solid ' + t.border + ';box-sizing:border-box;"></div>';
    }
    cardEls[1].innerHTML =
      '<button data-tip="presence" class="ndl-tip-text" aria-label="présence dans vos questions, en savoir plus" style="align-self:flex-start;display:inline-flex;align-items:center;gap:6px;cursor:help;background:none;border:none;padding:0;font-family:inherit;font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;border-bottom:1px dotted #3A3128;">présence dans vos questions<span style="display:inline-flex;width:12px;height:12px;border:1px solid #3A3128;border-radius:50%;align-items:center;justify-content:center;font-size:8px;line-height:1;">i</span></button>' +
      '<div style="display:flex;align-items:baseline;gap:9px;">' +
        '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(20px,2vw,30px);line-height:1;color:' + card.presenceColor + ';font-variant-numeric:tabular-nums;">' + esc(card.presenceBig) + '</span>' +
        '<div style="display:flex;gap:3px;">' + th + '</div>' +
      '</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#A99C88;">' + esc(card.presenceText) + '</div>';

    /* card 2 - "à faire en premier" (action) */
    cardEls[2].innerHTML =
      '<div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">à faire en premier</div>' +
      '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#E8DFD2;">' + esc(card.action) + '</div>';
  }

  /* ============================ render() ============================ */
  function render() {
    var v = renderVals();

    /* controlled input (only touch it when the value actually differs) */
    if (inputEl && inputEl.value !== v.inputValue) inputEl.value = v.inputValue;

    /* "lecture en cours" overlay (fades out on settle) */
    if (overlayEl) overlayEl.style.opacity = v.measuringOverlayOp;

    /* verdict hero reveal - the climax (opacity + translateY, own 0.14s delay) */
    if (verdictEl) {
      verdictEl.style.opacity = v.verdictOp;
      verdictEl.style.transform = 'translateY(' + v.verdictTy + 'px)';
    }

    /* share-of-voice block fades to full on settle */
    if (shareEl) shareEl.style.opacity = v.proofOp;

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

    renderAxisBrands(v.axisBrands);

    /* quick-pick chips only reflect which example is focused -> rebuild on focus change */
    if (lastChipFocus !== state.focus) {
      renderBrands(v.brands);
      lastChipFocus = state.focus;
    }

    /* verdict + cards + share depend on the real result (or the loading/idle
       phase) -> rebuild only when that signature changes, so the ~ticking during
       loading never re-writes innerHTML needlessly. */
    if (lastContentSig !== v.contentSig) {
      renderCards(v.card);
      renderVerdict(v.card);
      renderShare(v);
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
    shareEl = document.getElementById('ndl-share');
    shareSegsEl = document.getElementById('ndl-share-segs');
    sharePctEl = document.getElementById('ndl-share-pct');
    shareNameEl = document.getElementById('ndl-share-name');
    passCounterEl = document.getElementById('ndl-passcounter');
    unknownEl = document.getElementById('ndl-unknown');
    runBtn = document.querySelector('.ndl-run');
    brandsHost = runBtn.parentNode;
    transpBtn = document.getElementById('ndl-transp-btn');
    cardEls = Array.prototype.slice.call(document.querySelectorAll('.ndl-card'));

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
