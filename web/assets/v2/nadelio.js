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
  var ZLO = 50, ZHI = 90;
  var BRASS = '#C6A15B', SAGE = '#93A06E', SIENNA = '#B07452', INK = '#D8CDBB';

  var MARKETS = {
    Qonto: { rows: [{ n: 'Qonto', s: 80, m: 1 }, { n: 'Shine', s: 76, m: 1 }, { n: 'Revolut Pro', s: 72, m: 2 }] },
    Pennylane: { rows: [{ n: 'Sage', s: 71, m: 1 }, { n: 'Pennylane', s: 60, m: 1 }, { n: 'Indy', s: 57, m: 2 }] },
    Alan: { rows: [{ n: 'Alan', s: 74, m: 2 }, { n: 'Malakoff Humanis', s: 73, m: 2 }, { n: 'Generali', s: 68, m: 3 }] }
  };
  var MODELS = ['GPT-4o', 'GPT-4.1', 'o3', 'Claude Opus', 'Claude Sonnet', 'Gemini Pro', 'Gemini Flash', 'Mistral Large', 'Llama 4', 'DeepSeek', 'Grok 3', 'Perplexity'];
  var MODELS_SHORT = ['4o', '4.1', 'o3', 'Opus', 'Sonn', 'GemP', 'GemF', 'Mist', 'Lla4', 'Deep', 'Grok', 'Plx'];
  var TIP_TEXT = {
    scale: 'L\'échelle va de 0 à 100. La vue du dessus agrandit la tranche 50 à 90 pour lire les écarts, sans jamais les grossir.',
    range: 'Le vrai score se trouve dans cette fourchette 95 fois sur 100. Plus elle est étroite, plus la mesure est sûre.',
    presence: 'Combien des 12 IA citent la marque au moins une fois. Absent d\'une IA, c\'est être invisible pour tous ceux qui l\'utilisent.'
  };
  var SHARE = {
    Qonto: [{ n: 'Qonto', v: 41 }, { n: 'Shine', v: 33 }, { n: 'Revolut Pro', v: 26 }],
    Pennylane: [{ n: 'Sage', v: 46 }, { n: 'Pennylane', v: 28 }, { n: 'Indy', v: 26 }],
    Alan: [{ n: 'Alan', v: 37 }, { n: 'Malakoff Humanis', v: 35 }, { n: 'Generali', v: 28 }]
  };
  var TRANSP = {
    Qonto: {
      questions: ['quelle banque pour un freelance ?', 'meilleur compte pro sans frais ?', 'néobanque pour auto-entrepreneur ?', 'banque pro 100% en ligne ?', 'compte professionnel pour SASU ?'],
      weights: [1.2, 0.14, 0.9, 1.1, 1.0]
    },
    Pennylane: {
      questions: ['logiciel de comptabilité pour PME ?', 'compta en ligne pour expert-comptable ?', 'alternative à Sage ?', 'logiciel de facturation pour TPE ?', 'meilleur outil de compta en 2026 ?'],
      weights: [0.2, 0.85, 0.14, 1.0, 0.7]
    },
    Alan: {
      questions: ['quelle mutuelle pour une petite entreprise ?', 'assurance santé pour une famille ?', 'complémentaire santé senior ?', 'mutuelle pas chère pour indépendant ?', 'meilleure assurance santé en 2026 ?'],
      weights: [1.15, 0.85, 0.12, 1.0, 0.95]
    }
  };
  var CARDS = {
    Qonto: {
      verdictTitle: 'Avance réelle.', verdictColor: '#93A06E',
      verdictText: 'Qonto devance Shine de 4 points, une avance nette qui tient à chaque mesure.',
      questions: [
        { q: 'quelle banque pour un freelance ?', status: 'cité en premier', tone: 'up' },
        { q: 'meilleur compte pro sans frais ?', status: 'absent, Revolut Pro répond', tone: 'down' },
        { q: 'néobanque pour auto-entrepreneur ?', status: 'cité, derrière Shine', tone: 'mid' }
      ],
      hits: [37, 35, 33, 36, 34, 32, 30, 28, 24, 26, 29, 38],
      presenceBig: '12 / 12', presenceColor: '#93A06E',
      presenceText: 'Citée par toutes les IA du panel, de GPT-4o à Perplexity.',
      action: 'Verrouiller « meilleur compte pro sans frais », la seule question où vous disparaissez. Revolut Pro y prend la réponse.'
    },
    Pennylane: {
      verdictTitle: 'Sage devant, écart réel.', verdictColor: '#B07452',
      verdictText: 'Sage domine Pennylane de 11 points, un écart large et régulier. Le retard est réel, il faudra le combler.',
      questions: [
        { q: 'logiciel de comptabilité pour PME ?', status: 'absent, Sage répond', tone: 'down' },
        { q: 'compta en ligne pour expert-comptable ?', status: 'cité, derrière Sage', tone: 'mid' },
        { q: 'alternative à Sage ?', status: 'absent, Indy répond', tone: 'down' }
      ],
      hits: [28, 26, 23, 25, 24, 21, 18, 15, 0, 0, 0, 20],
      presenceBig: '9 / 12', presenceColor: '#B07452',
      presenceText: 'Invisible dans Llama 4, DeepSeek et Grok 3.',
      action: 'Exister d\'abord dans les 3 IA où vous êtes invisible : c\'est là que les 11 points se perdent.'
    },
    Alan: {
      verdictTitle: 'Trop proche pour trancher.', verdictColor: '#D8CDBB',
      verdictText: 'Alan et Malakoff Humanis se tiennent à 1 point, trop proche pour les départager. On préfère le dire que d\'inventer un gagnant.',
      questions: [
        { q: 'quelle mutuelle pour une petite entreprise ?', status: 'cité en premier', tone: 'up' },
        { q: 'assurance santé pour une famille ?', status: 'cité, derrière Generali', tone: 'mid' },
        { q: 'complémentaire santé senior ?', status: 'absent, Malakoff Humanis répond', tone: 'down' }
      ],
      hits: [33, 31, 28, 32, 30, 29, 27, 24, 21, 0, 22, 30],
      presenceBig: '11 / 12', presenceColor: '#93A06E',
      presenceText: 'Invisible dans DeepSeek uniquement.',
      action: 'L\'écart avec Malakoff se joue à quelques citations. Gagner « complémentaire santé senior » suffit à faire pencher la mesure.'
    }
  };

  /* density and breath were editor sliders -> constants = 1 in production */
  var props = { density: 1, breath: 1 };

  var state = {
    focus: 'Qonto', measuring: true, settled: false,
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
  var axisBrandNodes = [], brandBtnNodes = [], lastFocusRendered = null;

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
    scheduleReveal();
    startLog();
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
      if (scene) buildClusters(state.focus, false);
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

    var fn = esc(v.focusName);

    /* models chips */
    var mChips = '';
    for (var i = 0; i < v.transpModels.length; i++) {
      mChips += '<span style="font-size:11px;color:#C9BEAC;border:1px solid #2A241C;padding:5px 9px;">' + esc(v.transpModels[i].name) + '</span>';
    }
    /* grid header (model shorts) */
    var hCols = '';
    for (var j = 0; j < v.transpModels.length; j++) {
      hCols += '<div title="' + esc(v.transpModels[j].name) + '" style="font-size:9px;color:#8A7D68;text-align:center;white-space:nowrap;overflow:hidden;">' + esc(v.transpModels[j].short) + '</div>';
    }
    /* grid rows */
    var rowsHtml = '';
    for (var ri = 0; ri < v.transpRows.length; ri++) {
      var row = v.transpRows[ri];
      var cells = '';
      for (var ci = 0; ci < row.cells.length; ci++) {
        var c = row.cells[ci];
        cells += '<div title="' + esc(c.title) + '" style="height:26px;display:flex;align-items:center;justify-content:center;font-size:10px;font-variant-numeric:tabular-nums;background:' + c.bg + ';border:1px solid ' + c.border + ';box-sizing:border-box;color:' + c.textColor + ';">' + esc(c.label) + '</div>';
      }
      rowsHtml += '<div style="display:grid;grid-template-columns:minmax(160px,1.7fr) repeat(12,minmax(28px,1fr));gap:3px;align-items:stretch;">' +
        '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;color:#D8CDBB;display:flex;align-items:center;padding-right:8px;line-height:1.3;">« ' + esc(row.q) + ' »</div>' +
        cells + '</div>';
    }

    drawerDialog.innerHTML =
      '<div style="flex:none;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);border-bottom:1px solid #2A241C;">' +
        '<div style="display:flex;flex-direction:column;gap:5px;">' +
          '<div style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(17px,1.7vw,23px);letter-spacing:-0.01em;">Le détail, sans filtre</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#A99C88;max-width:46ch;">Voici les questions posées à chaque IA pour mesurer ' + fn + ', et qui a été cité. Rien n\'est agrégé avant que vous le voyiez.</div>' +
        '</div>' +
        '<button class="ndl-drawer-close" aria-label="fermer le détail" style="flex:none;cursor:pointer;background:none;border:1px solid #3A3128;color:#A99C88;font-family:inherit;font-size:15px;line-height:1;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">✕</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto;overflow-x:hidden;padding:clamp(16px,2.4vh,26px) clamp(18px,2.4vw,30px);display:flex;flex-direction:column;gap:22px;">' +
        '<div style="display:flex;flex-direction:column;gap:9px;">' +
          '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">les 12 IA interrogées</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + mChips + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">' +
            '<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;">résultat par question et par IA</div>' +
            '<div style="font-size:10px;color:#8A7D68;font-variant-numeric:tabular-nums;">8 passes chacune, 480 au total</div>' +
          '</div>' +
          '<div style="overflow-x:auto;overflow-y:hidden;">' +
            '<div style="min-width:560px;display:flex;flex-direction:column;gap:4px;">' +
              '<div style="display:grid;grid-template-columns:minmax(160px,1.7fr) repeat(12,minmax(28px,1fr));gap:3px;align-items:end;">' +
                '<div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#55483A;">question</div>' +
                hCols +
              '</div>' +
              rowsHtml +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:16px;padding-top:2px;">' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.7);"></span>cité souvent</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:rgba(147,160,110,0.28);"></span>cité rarement</div>' +
            '<div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#A99C88;"><span style="width:14px;height:10px;background:transparent;border:1px solid rgba(176,116,82,0.6);box-sizing:border-box;"></span>jamais cité</div>' +
          '</div>' +
          '<div style="font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#8A7D68;">Le chiffre d\'une case, c\'est le nombre de fois où ' + fn + ' a été cité sur 8 essais, pour cette question dans cette IA.</div>' +
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

  /* ============================ reveal / pass counter ============================ */
  function scheduleReveal() {
    clearTimeout(revealT);
    revealT = setTimeout(function () {
      clearInterval(logIv);
      setState({ measuring: false, settled: true, passCount: 480 });
      setTimeout(function () {
        if (inputEl && !state.drawerOpen && (document.activeElement === document.body || document.activeElement === null)) inputEl.focus({ preventScroll: true });
      }, 80);
    }, reduced ? 250 : 1750);
  }

  /* the pass counter ticks up to 480 while the cloud converges (no log lines in v5) */
  function startLog() {
    clearInterval(logIv);
    if (reduced) { setState({ passCount: 480 }); return; }
    var pass = 0;
    logIv = setInterval(function () {
      pass = Math.min(480, pass + 18 + Math.floor(Math.random() * 14));
      setState({ passCount: pass });
    }, 82);
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
    buildClusters(state.focus, true);
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
    if (points) buildClusters(state.focus, false);
    if (reduced) renderResolved();
  }

  function clusterState(rows, i) {
    var l = rows[0], s2 = rows[1], r = rows[i];
    var proven = (l.s - l.m) > (s2.s + s2.m);
    if (i === 0) return proven ? 'proven' : 'contested';
    if (i === 1 && !proven) return 'contested';
    if ((l.s - l.m) > (r.s + r.m)) return 'behind';
    return 'contested';
  }

  function buildClusters(marketKey, scattered) {
    var THREE = window.THREE;
    if (!THREE || !axisEl || !mountEl || !camera) return;
    var density = props.density != null ? props.density : 1;
    var mrect = mountEl.getBoundingClientRect();
    var arect = axisEl.getBoundingClientRect();
    if (arect.width < 10) return;
    var axL = arect.left - mrect.left, axW = arect.width, axY = arect.top - mrect.top;
    var zspan = ZHI - ZLO;
    var rows = MARKETS[marketKey].rows.slice().sort(function (a, b) { return b.s - a.s; });
    var l = rows[0], s2 = rows[1];
    var oLo = Math.max(l.s - l.m, s2.s - s2.m), oHi = Math.min(l.s + l.m, s2.s + s2.m);
    var hasOverlap = oLo < oHi;
    var brass = [0.86, 0.68, 0.37], hot = [0.78, 0.44, 0.29];
    var pts = [];
    rows.forEach(function (r, i) {
      var st = clusterState(rows, i);
      var cxPx = axL + (r.s - ZLO) / zspan * axW;
      var w0 = pxToWorld(cxPx, axY);
      var x = w0[0], y = w0[1], wpp = w0[2];
      var R = Math.max(r.m / zspan * axW * wpp, 0.12);
      var isFocus = r.n === marketKey;
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
  function matchBrand(name) {
    var q = (name || '').trim().toLowerCase();
    return Object.keys(MARKETS).find(function (key) { return key.toLowerCase() === q; }) || null;
  }
  function runMeasure(name) {
    var key = matchBrand(name);
    if (!key) { setState({ unknownMsg: 'Cette démo mesure trois marques : Qonto, Pennylane et Alan.' }); return; }
    setState({ focus: key, inputValue: key, measuring: true, settled: false, unknownMsg: '', passCount: 0 });
    measureStart = performance.now();
    if (scene) buildClusters(key, !reduced);
    if (reduced) renderResolved();
    scheduleReveal();
    startLog();
  }

  /* ============================ renderVals() ============================ */
  function renderVals() {
    var st = state;
    var market = MARKETS[st.focus];
    var cardData = CARDS[st.focus];
    var sorted = market.rows.slice().sort(function (a, b) { return b.s - a.s; });
    var zspan = ZHI - ZLO;
    var belowIdx = 0;
    var axisBrands = sorted.map(function (r, i) {
      var isFocus = r.n === st.focus;
      var cState = clusterState(sorted, i);
      var level = 0;
      if (!isFocus) { belowIdx += 1; level = belowIdx; }
      var bracketColor = isFocus ? BRASS : cState === 'behind' ? '#7C5240' : '#8A7D68';
      return {
        key: r.n, name: r.n,
        focus: isFocus, notFocus: !isFocus,
        loPct: ((r.s - r.m - ZLO) / zspan * 100).toFixed(2),
        wPct: ((2 * r.m) / zspan * 100).toFixed(2),
        midPct: ((r.s - ZLO) / zspan * 100).toFixed(2),
        bracketColor: bracketColor,
        nameColor: isFocus ? '#E8DFD2' : cState === 'behind' ? '#6E6250' : '#9A8D78',
        scoreColor: isFocus ? BRASS : cState === 'behind' ? '#6E6250' : '#A99C88',
        subColor: cState === 'behind' ? '#55483A' : '#8A7D68',
        scoreDisplay: r.s,
        rangeText: 'entre ' + (r.s - r.m) + ' et ' + (r.s + r.m),
        showRange: isFocus,
        leaderTop: isFocus ? 'calc(50% - 22px)' : 'calc(50% + 6px)',
        leaderH: isFocus ? 16 : level === 1 ? 12 : 30,
        labelPos: isFocus ? 'bottom:calc(50% + 24px)' : level === 1 ? 'top:calc(50% + 20px)' : 'top:calc(50% + 40px)'
      };
    });
    var l = sorted[0], s2 = sorted[1];
    var proven = (l.s - l.m) > (s2.s + s2.m);
    var region;
    if (proven) {
      var a = s2.s + s2.m, b = l.s - l.m;
      region = {
        leftPct: ((a - ZLO) / zspan * 100).toFixed(2),
        widthPct: ((b - a) / zspan * 100).toFixed(2),
        fill: 'rgba(147,160,110,0.08)', borderColor: 'rgba(147,160,110,0.6)', borderStyle: 'dashed'
      };
    } else {
      var a2 = Math.max(l.s - l.m, s2.s - s2.m), b2 = Math.min(l.s + l.m, s2.s + s2.m);
      region = {
        leftPct: ((a2 - ZLO) / zspan * 100).toFixed(2),
        widthPct: ((b2 - a2) / zspan * 100).toFixed(2),
        fill: 'rgba(176,116,82,0.14)', borderColor: 'rgba(176,116,82,0.7)', borderStyle: 'solid'
      };
    }
    var brands = Object.keys(MARKETS).map(function (key) {
      return {
        key: key, name: key,
        run: function () { runMeasure(key); },
        border: key === st.focus ? '#8A7D68' : '#3A3128',
        color: key === st.focus ? '#E8DFD2' : '#8A7D68'
      };
    });
    var ticks = MODELS.map(function (name, i) {
      var h = cardData.hits[i];
      return {
        key: name, name: name,
        bg: h === 0 ? 'transparent' : h >= 24 ? 'rgba(147,160,110,0.85)' : 'rgba(147,160,110,0.32)',
        border: h === 0 ? 'rgba(176,116,82,0.6)' : 'transparent'
      };
    });
    var toneColor = function (t) { return t === 'up' ? SAGE : t === 'down' ? SIENNA : '#A99C88'; };
    var card = {};
    for (var kk in cardData) card[kk] = cardData[kk];
    card.ticks = ticks;
    card.questions = cardData.questions.map(function (q, i) {
      return { key: 'q' + i, q: q.q, status: q.status, statusColor: toneColor(q.tone), dot: toneColor(q.tone) };
    });
    var shareData = SHARE[st.focus];
    var focusShareEntry = shareData.find(function (x) { return x.n === st.focus; }) || shareData[0];
    var focusShare = focusShareEntry.v;
    var shareSegs = shareData.map(function (x, i) {
      return {
        key: x.n, pct: x.v,
        color: x.n === st.focus ? BRASS : 'rgba(216,205,187,' + (0.30 - i * 0.06).toFixed(2) + ')',
        title: x.n + ' : ' + x.v + '% des citations du panel'
      };
    });
    var passCounter = st.measuring ? st.passCount + ' / 480 réponses' : '480 réponses comptées';
    var transpModels = MODELS.map(function (m, i) { return { key: m, name: m, short: MODELS_SHORT[i] }; });
    var tq = TRANSP[st.focus];
    var transpRows = tq.questions.map(function (q, qi) {
      return {
        key: 'trq' + qi, q: q,
        cells: MODELS.map(function (mn, mi) {
          var c = Math.max(0, Math.min(8, Math.round(8 * (cardData.hits[mi] / 40) * tq.weights[qi])));
          return {
            key: mn, count: c, label: c === 0 ? '·' : '' + c,
            bg: c === 0 ? 'transparent' : c >= 4 ? 'rgba(147,160,110,0.7)' : 'rgba(147,160,110,0.28)',
            border: c === 0 ? 'rgba(176,116,82,0.55)' : 'transparent',
            textColor: c === 0 ? '#7C5240' : c >= 4 ? '#141009' : '#D8CDBB',
            title: mn + ' : cité ' + c + ' fois sur 8'
          };
        })
      };
    });
    return {
      measuring: st.measuring, settled: st.settled,
      measuringOverlayOp: st.measuring ? 1 : 0,
      verdictOp: st.settled ? 1 : 0,
      verdictTy: st.settled ? 0 : 14,
      proofOp: st.measuring ? 0.5 : 1,
      revealOp: st.settled ? 1 : 0,
      revealTy: st.settled ? 0 : 14,
      passColor: st.measuring ? '#C6A15B' : '#8A7D68',
      inputValue: st.inputValue,
      hasUnknown: !!st.unknownMsg, unknownMsg: st.unknownMsg,
      brands: brands, axisBrands: axisBrands, region: region, card: card,
      shareSegs: shareSegs, focusShare: focusShare, passCounter: passCounter,
      focusName: st.focus, transpModels: transpModels, transpRows: transpRows
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
    if (sharePctEl) sharePctEl.textContent = v.focusShare + '%';
    if (shareNameEl) shareNameEl.textContent = 'des citations du panel vont à ' + v.focusName;
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

    /* card 1 - "présence dans les 12 IA" (label is a tooltip trigger) */
    var th = '';
    for (var j = 0; j < card.ticks.length; j++) {
      var t = card.ticks[j];
      th += '<div title="' + esc(t.name) + '" style="width:11px;height:7px;background:' + t.bg + ';border:1px solid ' + t.border + ';box-sizing:border-box;"></div>';
    }
    cardEls[1].innerHTML =
      '<button data-tip="presence" class="ndl-tip-text" aria-label="présence dans les 12 IA, en savoir plus" style="align-self:flex-start;display:inline-flex;align-items:center;gap:6px;cursor:help;background:none;border:none;padding:0;font-family:inherit;font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#6E6250;border-bottom:1px dotted #3A3128;">présence dans les 12 IA<span style="display:inline-flex;width:12px;height:12px;border:1px solid #3A3128;border-radius:50%;align-items:center;justify-content:center;font-size:8px;line-height:1;">i</span></button>' +
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

    /* brands + card + verdict + share content only depend on focus -> rebuild on focus change */
    if (lastFocusRendered !== state.focus) {
      renderBrands(v.brands);
      renderCards(v.card);
      renderVerdict(v.card);
      renderShare(v);
      lastFocusRendered = state.focus;
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
