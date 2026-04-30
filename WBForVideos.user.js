// ==UserScript==
// @name         Video WB Pro V2 (Kelvin + Tint + WB Picker) — Import/Export + Autoload
// @namespace    amir.video.wbpro
// @version      3.28
// @description  Powerful WB for HTML5 video: extended Kelvin (500–100,000 K), Tint, Strength, WB picker, per-video Save/Restore, JSON Import/Export, autoload on reopen. Shadow-DOM UI; starts hidden; draggable bubble hides if no video; hardened for YouTube/SPAs.
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @run-at       document-end
// @allFrames    true
// ==/UserScript==

(() => {
  'use strict';

  const IS_TOP = (() => { try { return window.top === window.self; } catch { return false; } })();
  const FRAME_ID = Math.random().toString(36).slice(2);
  const FRAME_STATUS_TTL_MS = 3000;
  const framePresence = new Map();
  const HAS_VALUE_LISTENER = typeof GM_addValueChangeListener === 'function';
  const COMPARE_STATUS_DEFAULT = 'Left half = changed, right half = original.';
  const COMPARE_SPLIT_POS = 50;
  const PICKER_ZOOM = 10;
  const PICKER_SAMPLE_SIZE = 9;
  const SNAPSHOT_TTL_MS = 60 * 24 * 60 * 60 * 1000;
  const SNAPSHOT_LIMIT = 200;
  const KEY_TOGGLE_GUARD_MS = 120;
  const AMIR_FOLLOW_URL = 'https://followamir.com/';
  const AMIR_DONATE_URL = 'https://www.paypal.com/donate/?hosted_button_id=2U2GXSKFJKJCA';

  // ---------- Config ----------
  const CONFIG = {
    storageKey: 'tm_vwb_pro_v30',
    default: {
      enabled: true,
      applyAll: true,
      kelvin: 6500,
      tint: 0,
      strength: 100,
      brightness: 100,
      contrast: 100,
      saturation: 100,
      sharpness: 0,
      compareEnabled: false,
      comparePos: 50,
      compareDefaultOffApplied: false,
      x: 24, y: 24,                 // panel position
      w: 300, h: 230,                // panel size
      visible: false,               // panel starts hidden
      bubbleX: 12, bubbleY: 12,     // bubble position
      snapshots: {},                // per-video saved settings, auto-expire after 60 days
      sitePresets: {},              // per-website saved settings
      defaultPreset: null,          // user default preset
      rev: 0,
      lastUserActionAt: 0
    },
    kelvinMin: 500,
    kelvinMax: 100000,
    watchdogMs: 1200,
    fullscreenLite: true,
    filterHealIntervalMs: 2500,
    filterReapplyCooldownMs: 350,
    fullscreenApplyDelayMs: 140,
    z: 2147483647,
    panelW: 300,
    panelH: 230,
    panelLinkGap: 12,
    rescanTries: 50,
    rescanIntervalMs: 200,
    exportSchema: 'video-wb-pro-snapshots-1'
  };

  // ---------- Safe storage ----------
  const store = {
    get(k, d) { try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { typeof GM_setValue === 'function' ? GM_setValue(k, v) : localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  function normalizeState(raw) {
    const next = { ...CONFIG.default, ...(raw || {}) };
    if (!next.snapshots) next.snapshots = {};
    if (!next.sitePresets) next.sitePresets = {};
    for (const [key, preset] of Object.entries(next.sitePresets)) {
      const normalized = normalizeSnapshot(preset);
      if (normalized) next.sitePresets[key] = normalized;
      else delete next.sitePresets[key];
    }
    next.defaultPreset = normalizePreset(next.defaultPreset);
    const revNum = Number(next.rev);
    next.rev = Number.isFinite(revNum) ? revNum : 0;
    const actionAt = Number(next.lastUserActionAt);
    next.lastUserActionAt = Number.isFinite(actionAt) ? actionAt : 0;
    next.enabled = !!next.enabled;
    next.applyAll = !!next.applyAll;
    next.visible = !!next.visible;
    next.compareEnabled = !!next.compareEnabled;
    next.compareDefaultOffApplied = !!next.compareDefaultOffApplied;
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    next.x = num(next.x, CONFIG.default.x);
    next.y = num(next.y, CONFIG.default.y);
    next.w = num(next.w, CONFIG.default.w);
    next.h = num(next.h, CONFIG.default.h);
    next.bubbleX = num(next.bubbleX, CONFIG.default.bubbleX);
    next.bubbleY = num(next.bubbleY, CONFIG.default.bubbleY);
    next.comparePos = clamp(num(next.comparePos, CONFIG.default.comparePos), 0, 100);
    return next;
  }

  function normalizePreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      kelvin: clamp(Math.round(num(raw.kelvin, CONFIG.default.kelvin)), CONFIG.kelvinMin, CONFIG.kelvinMax),
      tint: clamp(Math.round(num(raw.tint, CONFIG.default.tint)), -100, 100),
      strength: clamp(Math.round(num(raw.strength, CONFIG.default.strength)), 0, 100),
      brightness: clamp(Math.round(num(raw.brightness, CONFIG.default.brightness)), 10, 200),
      contrast: clamp(Math.round(num(raw.contrast, CONFIG.default.contrast)), 10, 250),
      saturation: clamp(Math.round(num(raw.saturation, CONFIG.default.saturation)), 0, 250),
      sharpness: clamp(Math.round(num(raw.sharpness, CONFIG.default.sharpness)), -50, 150)
    };
  }

  function effectStamp(s) {
    return [
      s.enabled ? '1' : '0',
      s.applyAll ? '1' : '0',
      s.compareEnabled ? '1' : '0',
      s.comparePos,
      s.kelvin,
      s.tint,
      s.strength,
      s.brightness,
      s.contrast,
      s.saturation,
      s.sharpness
    ].join('|');
  }

  // ---------- State ----------
  let state = normalizeState(store.get(CONFIG.storageKey, null));
  let needsCompareDefaultOffSave = false;
  if (IS_TOP && !state.compareDefaultOffApplied) {
    state.compareEnabled = false;
    state.compareDefaultOffApplied = true;
    needsCompareDefaultOffSave = true;
  }
  if (IS_TOP) {
    state.w = clamp(state.w || CONFIG.panelW, 260, Math.max(260, (innerWidth||1200) - 40));
    state.h = state.h ? clamp(state.h, 220, Math.max(220, (innerHeight||800) - 40)) : CONFIG.panelH;
  }
  let host, sr, panel, bubble, observer, matrixNode, matrixNodeLite, sharpNode, svgHost;
  let els = {}; // panel refs
  let lastPrimaryVideo = null;
  let lastKeyToggleAt = 0;
  const autoAppliedKeys = new Set();
  let lastSyncRev = state.rev || 0;
  let lastEffectStamp = effectStamp(state);
  let lastFramePingAt = 0;
  let lastFrameHasVideo = null;
  let fullscreenActive = false;
  let lastHealAt = 0;
  const lastFilterApplyAt = new WeakMap();
  let fullscreenApplyTimer = 0;
  let lastFullscreenChangeAt = 0;
  const compare = {
    active: false,
    video: null,
    wrap: null,
    clip: null,
    canvas: null,
    line: null,
    handle: null,
    changedLabel: null,
    originalLabel: null,
    ctx: null,
    raf: 0,
    lastDrawAt: 0,
    lastLayoutAt: 0,
    lastRect: null,
    dragging: false,
    dragPointerId: null,
    videoListeners: [],
    dragHandlers: null
  };
  const picker = {
    active: false,
    video: null,
    overlay: null,
    loupe: null,
    canvas: null,
    ctx: null,
    sourceCanvas: null,
    sourceCtx: null,
    status: null,
    lastSample: null,
    teardown: null
  };

  // ---------- Page-scope CSS (affects real <video>) ----------
  GM_addStyle(`
    video[data-vwb-active="1"],
    iframe[data-vwb-active="1"] { filter: var(--vwb-filter, url(#vwb-filter)) !important; }
    #vwb-svg { position: fixed; width: 0; height: 0; pointer-events: none; left: -9999px; top: -9999px; }
    #vwb-compare-wrap { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: ${CONFIG.z - 2}; pointer-events: none; }
    #vwb-compare-wrap[data-hidden="1"] { display: none !important; }
    #vwb-compare-clip { position: absolute; left: 0; top: 0; height: 100%; overflow: hidden; pointer-events: none; }
    #vwb-compare-canvas { width: 100%; height: 100%; display: block; }
    #vwb-compare-line {
      position: absolute; top: 0; height: 100%; width: 22px; transform: translateX(-50%);
      background: transparent; cursor: ew-resize; pointer-events: auto;
    }
    #vwb-compare-line::before {
      content: ""; position: absolute; left: 50%; top: 0; height: 100%; width: 2px; transform: translateX(-50%);
      background: rgba(255,255,255,0.85); box-shadow: 0 0 0 1px rgba(0,0,0,0.45);
    }
    #vwb-compare-handle {
      position: absolute; left: 50%; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px;
      border-radius: 50%; background: rgba(0,0,0,0.6); border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.45);
      pointer-events: auto; cursor: ew-resize;
    }
    .vwb-compare-label {
      position: absolute; top: 10px; z-index: 2; box-sizing: border-box;
      padding: 5px 10px; border-radius: 999px;
      background: rgba(0,0,0,0.68); color: #fff; border: 1px solid rgba(255,255,255,0.55);
      font: 700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: .02em; text-transform: uppercase; text-shadow: 0 1px 2px rgba(0,0,0,0.6);
      pointer-events: none;
    }
    #vwb-compare-label-changed { left: 12px; }
    #vwb-compare-label-original { right: 12px; }
    #vwb-picker-overlay {
      position: fixed; z-index: ${CONFIG.z - 1}; cursor: crosshair;
      background: rgba(0,0,0,0.01); pointer-events: auto;
      outline: 2px solid rgba(255,255,255,0.78); outline-offset: -2px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.45);
    }
    #vwb-picker-loupe {
      position: fixed; box-sizing: border-box; width: 148px; min-height: 180px; z-index: ${CONFIG.z};
      border-radius: 18px; padding: 10px; pointer-events: none;
      background: rgba(14,17,24,0.92); border: 1px solid rgba(255,255,255,0.28);
      box-shadow: 0 18px 55px rgba(0,0,0,0.48); color: #fff;
      font: 600 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #vwb-picker-canvas {
      width: 126px; height: 126px; display: block; border-radius: 14px;
      image-rendering: pixelated; background: #111; border: 1px solid rgba(255,255,255,0.22);
    }
    #vwb-picker-loupe::after {
      content: ""; position: absolute; left: 84px; top: 84px; width: 10px; height: 10px;
      transform: translate(-50%, -50%); border: 2px solid #fff; border-radius: 50%;
      box-shadow: 0 0 0 1px #000, 0 0 0 999px rgba(0,0,0,0.05);
    }
    #vwb-picker-status { margin-top: 8px; color: rgba(255,255,255,0.86); }
  `);

  // ---------- Helpers ----------
  const isYouTube = () => location.hostname.includes('youtube.com');
  const isYTWatchOrShorts = () => /^\/(watch|shorts|embed)\b/.test(location.pathname || '');
  function shouldForceBubbleVisible() {
    if (!IS_TOP) return false;
    return isYouTube() && isYTWatchOrShorts();
  }
  const STABLE_HOSTS = ['fulltaboo.tv'];
  const NORMAL_FULLSCREEN_FILTER_HOSTS = ['animepahe.pw'];
  const CHILD_VIDEO_ONLY_HOSTS = ['animepahe.pw'];
  const IFRAME_TARGET_SELECTORS = [
    '.video-player iframe',
    '.responsive-player iframe',
    'iframe[allowfullscreen]',
    'iframe[allow*="autoplay"]'
  ];
  const isStableHost = (host) => STABLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const isNormalFullscreenFilterHost = (host) => NORMAL_FULLSCREEN_FILTER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const isChildVideoOnlyHost = (host) => CHILD_VIDEO_ONLY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const referrerNormalFullscreenFilterHost = () => {
    try {
      if (!document.referrer) return false;
      const host = new URL(document.referrer).hostname || '';
      return isNormalFullscreenFilterHost(host);
    } catch {
      return false;
    }
  };
  const referrerStableHost = () => {
    try {
      if (!document.referrer) return false;
      const host = new URL(document.referrer).hostname || '';
      return isStableHost(host);
    } catch {
      return false;
    }
  };
  const STABLE_MODE = isStableHost(location.hostname) || referrerStableHost();
  const DELEGATE_TO_PARENT = !IS_TOP && referrerStableHost();
  const IFRAME_TARGET_MODE = IS_TOP && isStableHost(location.hostname);
  const NORMAL_FULLSCREEN_FILTER_MODE = isNormalFullscreenFilterHost(location.hostname) || referrerNormalFullscreenFilterHost();

  function allowIframeTargets() { return IS_TOP || IFRAME_TARGET_MODE; }
  const trustedTypesPolicy = (() => {
    try {
      if (!window.trustedTypes?.createPolicy) return null;
      return window.trustedTypes.createPolicy(`vwb-panel-${FRAME_ID}`, { createHTML: (html) => html });
    } catch {
      return null;
    }
  })();
  function setTrustedHTML(el, html) {
    if (!el) return;
    el.innerHTML = trustedTypesPolicy ? trustedTypesPolicy.createHTML(html) : html;
  }
  function getCspNonce() {
    try {
      const el = document.querySelector('style[nonce],script[nonce],link[nonce]');
      if (!el) return '';
      return el.getAttribute('nonce') || el.nonce || '';
    } catch {
      return '';
    }
  }

  function listIframeTargets(force = false) {
    if (!allowIframeTargets()) return [];
    const seen = new Set();
    const out = [];
    const add = (el) => {
      if (!el || el.tagName !== 'IFRAME' || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    for (const sel of IFRAME_TARGET_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach(add);
      } catch {}
    }
    if (force && out.length === 0) {
      Array.from(document.getElementsByTagName('iframe')).forEach(add);
    }
    return out;
  }

  function hasAnyVideoLocal() {
    if (document.querySelector('video')) return true;
    if (allowIframeTargets()) return listIframeTargets(false).length > 0;
    return false;
  }
  function shouldApplyFilters(userAction) {
    if (DELEGATE_TO_PARENT) return false;
    return !STABLE_MODE || !!userAction;
  }

  function shouldSkipIframeFilter() {
    return (IS_TOP && isChildVideoOnlyHost(location.hostname)) ||
      (IS_TOP && state.compareEnabled && allowIframeTargets());
  }

  function isFullscreenActive() {
    try {
      const doc = document;
      return !!(
        doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement ||
        doc.fullscreen ||
        doc.webkitIsFullScreen ||
        doc.mozFullScreen
      );
    } catch {
      return false;
    }
  }

  function getFullscreenElement(doc = document) {
    try {
      return doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement ||
        null;
    } catch {
      return null;
    }
  }

  function scheduleFullscreenApply() {
    if (!state.enabled) return;
    if (fullscreenApplyTimer) clearTimeout(fullscreenApplyTimer);
    fullscreenApplyTimer = setTimeout(() => {
      fullscreenApplyTimer = 0;
      applyToVideos(true, false);
    }, CONFIG.fullscreenApplyDelayMs);
  }

  function updateFullscreenState(force = false) {
    const next = isFullscreenActive();
    if (!force && next === fullscreenActive) return;
    fullscreenActive = next;
    lastFullscreenChangeAt = Date.now();
    if (IS_TOP) ensureHost();
    scheduleFullscreenApply();
  }

  function setupFullscreenListeners() {
    const handler = () => updateFullscreenState(false);
    document.addEventListener('fullscreenchange', handler, true);
    document.addEventListener('webkitfullscreenchange', handler, true);
    document.addEventListener('mozfullscreenchange', handler, true);
    document.addEventListener('MSFullscreenChange', handler, true);
  }

  function notifyTopFrame(hasVideo, force = false) {
    if (IS_TOP) return;
    const now = Date.now();
    if (!force && hasVideo === lastFrameHasVideo && now - lastFramePingAt < CONFIG.watchdogMs) return;
    lastFrameHasVideo = hasVideo;
    lastFramePingAt = now;
    try {
      window.top.postMessage({ source: 'vwb', type: 'frame-status', id: FRAME_ID, hasVideo: !!hasVideo, t: now }, '*');
    } catch {}
  }

  function setupFramePresenceListener() {
    if (!IS_TOP) return;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'vwb' || data.type !== 'frame-status' || !data.id) return;
      framePresence.set(data.id, { hasVideo: !!data.hasVideo, at: Date.now() });
      updateBubbleVisibility();
    });
  }

  function applyIncomingState(raw) {
    if (!raw || typeof raw !== 'object') return;
    const uiSnapshot = IS_TOP ? {
      x: state.x, y: state.y, w: state.w, h: state.h,
      bubbleX: state.bubbleX, bubbleY: state.bubbleY, visible: state.visible
    } : null;
    const prevUserActionAt = state.lastUserActionAt || 0;
    const next = normalizeState(raw);
    const nextRev = next.rev || 0;
    const nextEffect = effectStamp(next);
    if (nextRev === lastSyncRev && nextEffect === lastEffectStamp) return;

    const prevEnabled = state.enabled;
    const prevEffect = lastEffectStamp;
    const userAction = (next.lastUserActionAt || 0) > prevUserActionAt;
    state = next;
    if (IS_TOP && uiSnapshot) Object.assign(state, uiSnapshot);
    lastSyncRev = nextRev;
    lastEffectStamp = nextEffect;

    if (IS_TOP) {
      syncUIFromState();
      if (panel) panel.classList.toggle('hidden', !state.visible);
    }

    if (!state.enabled) {
      clearFilters();
      if (prevEnabled) stopObserver();
      updateRestoreState();
      updateBubbleVisibility();
      return;
    }

    if (!prevEnabled) startObserver();
    if (!prevEnabled || nextEffect !== prevEffect || userAction) {
      refreshMatrix();
      refreshSharpness();
      applyToVideos(true, userAction);
    }
    autoApplySnapshotIfPresent(userAction);
    updateRestoreState();
    updateBubbleVisibility();
  }

  function setupStateSync() {
    if (IS_TOP) return;
    if (HAS_VALUE_LISTENER) {
      GM_addValueChangeListener(CONFIG.storageKey, (_, __, val) => { applyIncomingState(val); });
    }
  }

  function syncFromStore() {
    if (IS_TOP) return;
    const raw = store.get(CONFIG.storageKey, null);
    if (!raw || typeof raw !== 'object') return;
    applyIncomingState(raw);
  }

  // ---------- Shadow host (isolated UI) ----------
  function ensureHost() {
    if (!IS_TOP) return;
    const parent = getFullscreenElement(document) || document.documentElement || document.body;
    if (host && host.isConnected && sr) {
      if (parent && host.parentNode !== parent) parent.appendChild(host);
      return;
    }
    host = document.getElementById('vwb-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'vwb-host';
      host.style.position = 'fixed';
      host.style.top = '0';
      host.style.left = '0';
      host.style.zIndex = String(CONFIG.z);
    }
    if (parent && host.parentNode !== parent) parent.appendChild(host);
    if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
    sr = host.shadowRoot;

    const css = `
      #vwb-panel {
        position: fixed; top: 24px; left: 24px; width: 300px; padding: 10px 10px 30px;
        font: 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
        color:#111; background: rgba(255,255,255,.98); border:1px solid rgba(0,0,0,.12);
        border-radius:12px; box-shadow:0 8px 22px rgba(0,0,0,.18);
        z-index: ${CONFIG.z}; -webkit-user-select:none; user-select:none;
        resize: both; overflow: auto; min-width: 260px; min-height: 220px;
      }
      #vwb-panel.hidden { display: none !important; }
      #vwb-header { cursor: move; font-weight: 600; margin-bottom: 8px; display:flex; align-items:center; justify-content:space-between }
      #vwb-title{ font-size:14px }
      #vwb-close{ border:none; background:transparent; font-size:16px; line-height:1; cursor:pointer; padding:2px 6px; color:#444 }
      #vwb-resizer { position:absolute; right:8px; bottom:6px; width:18px; height:18px; border:1px solid rgba(0,0,0,.2); border-radius:6px; display:grid; place-items:center; cursor:nwse-resize; background:#f3f3f3; color:#555; font-size:12px; }
      .vwb-row{ margin:8px 0 }
      .vwb-flex{ display:flex; gap:8px; align-items:center }
      .vwb-label{ display:flex; justify-content:space-between; margin-bottom:4px }
      .vwb-num{ width:86px; padding:4px 6px }
      .vwb-slider{ width:100% }
      .vwb-small{ font-size:12px; color:#666 }
      .vwb-btn{ padding:6px 10px; border-radius:8px; border:1px solid rgba(0,0,0,.15); background:#f7f7f7; cursor:pointer }
      #vwb-actions{ display:flex; gap:8px; margin-top:8px; flex-wrap:wrap }
      #vwb-toggles{ display:flex; gap:12px; align-items:center; margin-top:4px }
      #vwb-site-row{ margin:10px 0; padding:8px; border:1px solid rgba(0,0,0,.1); border-radius:10px; background:#fafafa; }
      #vwb-site-actions{ display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
      #vwb-site-input{ box-sizing:border-box; width:100%; padding:6px 8px; border:1px solid rgba(0,0,0,.18); border-radius:8px; font:inherit; }
      #vwb-bubble{
        position:fixed; width:32px; height:32px; border-radius:50%;
        background:#111; color:#fff; display:none; /* hidden until a video exists */
        align-items:center; justify-content:center;
        font: 12px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
        cursor:grab; z-index:${CONFIG.z}; box-shadow:0 4px 10px rgba(0,0,0,.25);
        user-select:none; left:0; top:0;
      }
      #vwb-bubble.dragging { cursor:grabbing; }
      #vwb-actions .vwb-btn:disabled { opacity:.5; cursor:not-allowed; }
      input[type="file"].vwb-file { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
      #vwb-compare-status.warn { color: #b45309; }
      #vwb-save-status { margin-top: 6px; color: #4b5563; }
      #vwb-save-status.warn { color: #b45309; }
      #vwb-amir-footer{
        display:flex; align-items:center; justify-content:space-between; gap:8px;
        margin-top:10px; padding-top:8px; border-top:1px solid rgba(0,0,0,.1);
        color:#5f6368; font-size:11px; line-height:1.25;
      }
      #vwb-amir-footer a{ color:#1a73e8; text-decoration:none; font-weight:600; }
      #vwb-amir-footer a:hover{ text-decoration:underline; }
      #vwb-amir-donate{
        flex:0 0 auto; padding:5px 9px; border-radius:8px; border:1px solid rgba(0,0,0,.2);
        background:#ffc439; color:#111 !important; font-weight:700; text-decoration:none !important;
        box-shadow:0 1px 2px rgba(0,0,0,.12);
      }
      #vwb-amir-donate:hover{ background:#ffb703; }
      #vwb-amir-donate:active{ transform:translateY(1px); }
    `;
    const nonce = getCspNonce();
    const existingStyle = sr.getElementById('vwb-style');
    const needsNonce = nonce && (!existingStyle || !existingStyle.getAttribute('nonce'));
    if (!existingStyle || needsNonce) {
      if (existingStyle) existingStyle.remove();
      const style = document.createElement('style');
      style.id = 'vwb-style';
      if (nonce) style.setAttribute('nonce', nonce);
      style.textContent = css;
      sr.appendChild(style);
    }
  }

  // ---------- SVG filter (page DOM) ----------
  function ensureSVG() {
    if (matrixNode && matrixNode.isConnected && matrixNodeLite && matrixNodeLite.isConnected && sharpNode && sharpNode.isConnected) return;
    const ns = 'http://www.w3.org/2000/svg';
    svgHost = document.getElementById('vwb-svg');
    if (!svgHost) {
      svgHost = document.createElementNS(ns, 'svg');
      svgHost.setAttribute('id','vwb-svg');
      svgHost.setAttribute('xmlns', ns);
      (document.documentElement || document.body).appendChild(svgHost);
    }
    const ensureFilter = (id) => {
      let filter = document.getElementById(id);
      if (!filter) {
        filter = document.createElementNS(ns, 'filter');
        filter.setAttribute('id', id);
        filter.setAttribute('color-interpolation-filters','sRGB');
        svgHost.appendChild(filter);
      }
      return filter;
    };
    const ensureMatrix = (filter) => {
      let fe = filter.querySelector('feColorMatrix');
      if (!fe) {
        fe = document.createElementNS(ns,'feColorMatrix');
        fe.setAttribute('type','matrix');
        fe.setAttribute('values','1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0');
        fe.setAttribute('result','wb');
        filter.appendChild(fe);
      }
      return fe;
    };
    const ensureSharp = (filter) => {
      let sharp = filter.querySelector('feConvolveMatrix');
      if (!sharp) {
        sharp = document.createElementNS(ns,'feConvolveMatrix');
        sharp.setAttribute('order','3');
        sharp.setAttribute('kernelMatrix','0 0 0 0 1 0 0 0 0');
        sharp.setAttribute('preserveAlpha','true');
        sharp.setAttribute('in','wb');
        sharp.setAttribute('result','sharp');
        filter.appendChild(sharp);
      }
      return sharp;
    };

    const mainFilter = ensureFilter('vwb-filter');
    matrixNode = ensureMatrix(mainFilter);
    sharpNode = ensureSharp(mainFilter);

    const liteFilter = ensureFilter('vwb-filter-lite');
    matrixNodeLite = ensureMatrix(liteFilter);
  }

  // ---------- Build UI (in Shadow) ----------
  function buildBubble() {
    if (!IS_TOP) return null;
    ensureHost();
    if (sr.getElementById('vwb-bubble')) { bubble = sr.getElementById('vwb-bubble'); return bubble; }
    bubble = document.createElement('div');
    bubble.id = 'vwb-bubble';
    bubble.textContent = 'WB';
    bubble.title = 'Show/Hide Video WB Panel (Alt+W)';
    bubble.style.left = `${state.bubbleX}px`;
    bubble.style.top  = `${state.bubbleY}px`;
    sr.appendChild(bubble);
    makeDraggableBubble(bubble);
    updateBubbleVisibility();
    return bubble;
  }

  function buildPanel() {
    if (!IS_TOP) return null;
    ensureHost();
    if (sr.getElementById('vwb-panel')) { panel = sr.getElementById('vwb-panel'); return panel; }

    panel = document.createElement('div');
    panel.id = 'vwb-panel';
    panel.style.left = `${state.x}px`;
    panel.style.top  = `${state.y}px`;
    panel.style.width = `${state.w || CONFIG.panelW}px`;
    if (state.h) panel.style.height = `${state.h}px`;
    if (!state.visible) panel.classList.add('hidden');

    setTrustedHTML(panel, `
      <div id="vwb-header">
        <div id="vwb-title">Video White Balance</div>
        <button id="vwb-close" title="Hide (Alt+W)">✕</button>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Kelvin</span><span><span id="vwb-kread">${state.kelvin}</span> K</span></div>
        <div class="vwb-flex">
          <input id="vwb-kelvin" class="vwb-slider" type="range" min="${CONFIG.kelvinMin}" max="${CONFIG.kelvinMax}" step="10" value="${state.kelvin}">
          <input id="vwb-kel-num" class="vwb-num" type="number" min="${CONFIG.kelvinMin}" max="${CONFIG.kelvinMax}" step="10" value="${state.kelvin}">
          <button id="vwb-kminus" class="vwb-btn" style="padding:4px 6px; min-width:42px;">−10</button>
          <button id="vwb-kplus" class="vwb-btn" style="padding:4px 6px; min-width:42px;">+10</button>
        </div>
        <div class="vwb-small">500–100,000 K. Lower = warmer (red), higher = cooler (blue). Use ±10 for fine nudges.</div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Tint</span><span id="vwb-tread">${state.tint}</span></div>
        <div class="vwb-flex">
          <input id="vwb-tint" class="vwb-slider" type="range" min="-100" max="100" step="1" value="${state.tint}">
          <input id="vwb-tint-num" class="vwb-num" type="number" min="-100" max="100" step="1" value="${state.tint}">
        </div>
        <div class="vwb-small">− = greener, + = magenta.</div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Strength</span><span id="vwb-sread">${state.strength}%</span></div>
        <div class="vwb-flex">
          <input id="vwb-strength" class="vwb-slider" type="range" min="0" max="100" step="1" value="${state.strength}">
          <input id="vwb-strength-num" class="vwb-num" type="number" min="0" max="100" step="1" value="${state.strength}">
        </div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Brightness</span><span id="vwb-bread">${state.brightness}%</span></div>
        <div class="vwb-flex">
          <input id="vwb-bright" class="vwb-slider" type="range" min="10" max="200" step="1" value="${state.brightness}">
          <input id="vwb-bright-num" class="vwb-num" type="number" min="10" max="200" step="1" value="${state.brightness}">
        </div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Contrast</span><span id="vwb-cread">${state.contrast}%</span></div>
        <div class="vwb-flex">
          <input id="vwb-contrast" class="vwb-slider" type="range" min="10" max="250" step="1" value="${state.contrast}">
          <input id="vwb-contrast-num" class="vwb-num" type="number" min="10" max="250" step="1" value="${state.contrast}">
        </div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Saturation</span><span id="vwb-satread">${state.saturation}%</span></div>
        <div class="vwb-flex">
          <input id="vwb-sat" class="vwb-slider" type="range" min="0" max="250" step="1" value="${state.saturation}">
          <input id="vwb-sat-num" class="vwb-num" type="number" min="0" max="250" step="1" value="${state.saturation}">
        </div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label"><span>Sharpness</span><span id="vwb-sharpread">${state.sharpness}%</span></div>
        <div class="vwb-flex">
          <input id="vwb-sharp" class="vwb-slider" type="range" min="-50" max="150" step="1" value="${state.sharpness}">
          <input id="vwb-sharp-num" class="vwb-num" type="number" min="-50" max="150" step="1" value="${state.sharpness}">
        </div>
        <div class="vwb-small">0 = neutral. Negative softens, positive sharpens.</div>
      </div>

      <div class="vwb-row">
        <div class="vwb-label">
          <label style="display:flex; align-items:center; gap:6px;">
            <input id="vwb-compare-enabled" type="checkbox" ${state.compareEnabled ? 'checked' : ''}>
            <span>Compare split</span>
          </label>
          <span id="vwb-compare-read">${state.comparePos}%</span>
        </div>
        <div class="vwb-flex">
          <input id="vwb-compare" class="vwb-slider" type="range" min="0" max="100" step="1" value="${state.comparePos}">
          <input id="vwb-compare-num" class="vwb-num" type="number" min="0" max="100" step="1" value="${state.comparePos}">
        </div>
      <div class="vwb-small" id="vwb-compare-status">${COMPARE_STATUS_DEFAULT}</div>
      </div>

      <div id="vwb-toggles">
        <label><input id="vwb-enabled" type="checkbox" ${state.enabled ? 'checked' : ''}> Enable</label>
        <label><input id="vwb-all" type="checkbox" ${state.applyAll ? 'checked' : ''}> All videos</label>
      </div>

      <div id="vwb-site-row">
        <div class="vwb-label"><span>Website preset</span><span id="vwb-site-read"></span></div>
        <input id="vwb-site-input" type="text" spellcheck="false" value="${escapeAttr(getDefaultSitePresetInput())}" placeholder="youtube.com">
        <div id="vwb-site-actions">
          <button id="vwb-site-save" class="vwb-btn" title="Save current settings for this website">Save Site</button>
          <button id="vwb-site-apply" class="vwb-btn" title="Apply the saved preset for this website">Apply Site</button>
          <button id="vwb-site-delete" class="vwb-btn" title="Delete the saved preset for this website">Delete Site</button>
        </div>
        <div class="vwb-small" id="vwb-site-status">No website preset yet.</div>
      </div>

      <div id="vwb-actions">
        <button id="vwb-wb" class="vwb-btn" title="Pick a neutral point (white/gray)">WB Picker</button>
        <button id="vwb-save" class="vwb-btn" title="Save current preset for this video">Save</button>
        <button id="vwb-default" class="vwb-btn" title="Save current preset as the default for all videos">Set Default</button>
        <button id="vwb-restore" class="vwb-btn" title="Restore saved preset for this video">Restore</button>
        <button id="vwb-export" class="vwb-btn" title="Export ALL video presets to JSON">Export</button>
        <button id="vwb-import" class="vwb-btn" title="Import presets JSON (merge)">Import</button>
        <input id="vwb-import-file" class="vwb-file" type="file" accept="application/json">
        <button id="vwb-center" class="vwb-btn" title="Move panel to the middle">Center</button>
        <button id="vwb-reset" class="vwb-btn">Reset</button>
        <button id="vwb-rescan" class="vwb-btn">Rescan</button>
      </div>

      <div class="vwb-small">Settings auto-save per video for 60 days. Compare split shows filtered vs original. Save -> Reset -> Restore also works. Import/Export moves presets across machines.</div>
      <div class="vwb-small" id="vwb-save-status">No video save yet. Changes auto-save for 60 days.</div>
      <div id="vwb-amir-footer">
        <span>Built by Amir. Follow Amir at <a href="${AMIR_FOLLOW_URL}" target="_blank" rel="noopener noreferrer">followamir.com</a>.</span>
        <a id="vwb-amir-donate" href="${AMIR_DONATE_URL}" target="_blank" rel="noopener noreferrer">Donate</a>
      </div>
      <div id="vwb-resizer" title="Resize panel">⤡</div>
    `);
    sr.appendChild(panel);

    els = {
      kSlider: panel.querySelector('#vwb-kelvin'),
      kInput:  panel.querySelector('#vwb-kel-num'),
      tSlider: panel.querySelector('#vwb-tint'),
      tInput:  panel.querySelector('#vwb-tint-num'),
      sSlider: panel.querySelector('#vwb-strength'),
      sInput:  panel.querySelector('#vwb-strength-num'),
      bSlider: panel.querySelector('#vwb-bright'),
      bInput:  panel.querySelector('#vwb-bright-num'),
      cSlider: panel.querySelector('#vwb-contrast'),
      cInput:  panel.querySelector('#vwb-contrast-num'),
      satSlider: panel.querySelector('#vwb-sat'),
      satInput:  panel.querySelector('#vwb-sat-num'),
      shSlider: panel.querySelector('#vwb-sharp'),
      shInput:  panel.querySelector('#vwb-sharp-num'),
      compareSlider: panel.querySelector('#vwb-compare'),
      compareInput:  panel.querySelector('#vwb-compare-num'),
      compareRead:   panel.querySelector('#vwb-compare-read'),
      compareEnabled: panel.querySelector('#vwb-compare-enabled'),
      compareStatus: panel.querySelector('#vwb-compare-status'),
      saveStatus: panel.querySelector('#vwb-save-status'),
      siteInput: panel.querySelector('#vwb-site-input'),
      siteRead: panel.querySelector('#vwb-site-read'),
      siteStatus: panel.querySelector('#vwb-site-status'),
      kRead:   panel.querySelector('#vwb-kread'),
      tRead:   panel.querySelector('#vwb-tread'),
      sRead:   panel.querySelector('#vwb-sread'),
      bRead:   panel.querySelector('#vwb-bread'),
      cRead:   panel.querySelector('#vwb-cread'),
      satRead: panel.querySelector('#vwb-satread'),
      shRead:  panel.querySelector('#vwb-sharpread'),
      enabled: panel.querySelector('#vwb-enabled'),
      all:     panel.querySelector('#vwb-all'),
      file:    panel.querySelector('#vwb-import-file'),
      resizer: panel.querySelector('#vwb-resizer')
    };

    panel.querySelector('#vwb-close').addEventListener('click', hidePanel);
    const nudgeKelvin = (d)=>{ state.kelvin = clamp(Math.round(state.kelvin + d), CONFIG.kelvinMin, CONFIG.kelvinMax); syncUIFromState(); saveUserAction(); refreshMatrix(); applyToVideos(false, true); };
    panel.querySelector('#vwb-kminus').addEventListener('click', ()=> nudgeKelvin(-10));
    panel.querySelector('#vwb-kplus').addEventListener('click', ()=> nudgeKelvin(10));
    pair(els.kSlider, els.kInput, v => { state.kelvin = clamp(Math.round(v), CONFIG.kelvinMin, CONFIG.kelvinMax); els.kRead.textContent = state.kelvin; saveUserAction(); refreshMatrix(); applyToVideos(false, true); });
    pair(els.tSlider, els.tInput, v => { state.tint   = clamp(Math.round(v), -100, 100); els.tRead.textContent = state.tint; saveUserAction(); refreshMatrix(); applyToVideos(false, true); });
    pair(els.sSlider, els.sInput, v => { state.strength = clamp(Math.round(v), 0, 100); els.sRead.textContent = `${state.strength}%`; saveUserAction(); refreshMatrix(); applyToVideos(false, true); });
    pair(els.bSlider, els.bInput, v => { state.brightness = clamp(Math.round(v), 10, 200); els.bRead.textContent = `${state.brightness}%`; saveUserAction(); applyToVideos(false, true); });
    pair(els.cSlider, els.cInput, v => { state.contrast = clamp(Math.round(v), 10, 250); els.cRead.textContent = `${state.contrast}%`; saveUserAction(); applyToVideos(false, true); });
    pair(els.satSlider, els.satInput, v => { state.saturation = clamp(Math.round(v), 0, 250); els.satRead.textContent = `${state.saturation}%`; saveUserAction(); applyToVideos(false, true); });
    pair(els.shSlider, els.shInput, v => { state.sharpness = clamp(Math.round(v), -50, 150); els.shRead.textContent = `${state.sharpness}%`; saveUserAction(); refreshSharpness(); applyToVideos(false, true); });
    pair(els.compareSlider, els.compareInput, v => {
      state.comparePos = normalizeComparePos(v, 0);
      els.compareRead.textContent = `${state.comparePos}%`;
      saveUserAction();
      applyToVideos(false, true);
    });
    els.compareEnabled.addEventListener('change', () => {
      state.compareEnabled = els.compareEnabled.checked;
      if (state.compareEnabled) state.comparePos = COMPARE_SPLIT_POS;
      syncCompareControl();
      saveUserAction();
      applyToVideos(true, true);
    });

    els.enabled.addEventListener('change', () => {
      state.enabled = els.enabled.checked;
      saveUserAction();
      if (state.enabled) {
        startObserver();
        applyToVideos(true, true);
        autoApplySnapshotIfPresent(true);
      } else {
        clearFilters();
        stopObserver();
      }
    });
    els.all.addEventListener('change',     () => { state.applyAll = els.all.checked; saveUserAction(); applyToVideos(false, true); });

    panel.querySelector('#vwb-reset').addEventListener('click', () => {
      state = { ...state, kelvin: CONFIG.default.kelvin, tint: CONFIG.default.tint, strength: CONFIG.default.strength, brightness: CONFIG.default.brightness, contrast: CONFIG.default.contrast, saturation: CONFIG.default.saturation, sharpness: CONFIG.default.sharpness };
      syncUIFromState(); saveUserAction(); refreshMatrix(); refreshSharpness(); applyToVideos(true, true);
    });

    panel.querySelector('#vwb-rescan').addEventListener('click', () => { saveUserAction(); applyToVideos(true, true); updateBubbleVisibility(); autoApplySnapshotIfPresent(true); });
    panel.querySelector('#vwb-wb').addEventListener('click', pickWB);
    panel.querySelector('#vwb-center').addEventListener('click', centerPanel);
    panel.querySelector('#vwb-save').addEventListener('click', onSaveSnapshot);
    panel.querySelector('#vwb-default').addEventListener('click', onSaveDefaultPreset);
    panel.querySelector('#vwb-restore').addEventListener('click', onRestoreSnapshot);
    panel.querySelector('#vwb-site-save').addEventListener('click', onSaveSitePreset);
    panel.querySelector('#vwb-site-apply').addEventListener('click', onApplySitePreset);
    panel.querySelector('#vwb-site-delete').addEventListener('click', onDeleteSitePreset);
    els.siteInput.addEventListener('input', updateSitePresetState);
    panel.querySelector('#vwb-export').addEventListener('click', exportSnapshots);
    panel.querySelector('#vwb-import').addEventListener('click', () => els.file.click());
    els.file.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) importSnapshotsFromFile(f);
      e.target.value = '';
    });

    if (els.resizer) {
      let resizing = false, startW=0, startH=0, sx=0, sy=0;
      els.resizer.addEventListener('pointerdown', (evt) => {
        resizing = true;
        const rect = panel.getBoundingClientRect();
        startW = rect.width; startH = rect.height; sx = evt.clientX; sy = evt.clientY;
        evt.preventDefault();
        document.addEventListener('pointermove', onResize, true);
        document.addEventListener('pointerup', endResize, true);
      });
      function onResize(evt){
        if(!resizing) return;
        const nextW = clamp(startW + (evt.clientX - sx), 260, Math.max(260, innerWidth - 40));
        const nextH = clamp(startH + (evt.clientY - sy), 220, Math.max(220, innerHeight - 40));
        panel.style.width = `${nextW}px`;
        panel.style.height = `${nextH}px`;
      }
      function endResize(){
        if(!resizing) return;
        resizing=false;
        const rect = panel.getBoundingClientRect();
        state.w = rect.width;
        state.h = rect.height;
        save();
        document.removeEventListener('pointermove', onResize, true);
        document.removeEventListener('pointerup', endResize, true);
      }
    }

    if (state.visible) clampPanelIntoViewport();
    updateRestoreState();
    return panel;
  }

  // ---------- Draggable bubble ----------
  function makeDraggableBubble(el) {
    clampBubbleIntoViewport();
    let dragging = false, moved = false, sx = 0, sy = 0, bx = 0, by = 0;
    const thresh = 3;

    const onDown = (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); bx = r.left; by = r.top;
      el.classList.add('dragging');
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && (Math.abs(dx) > thresh || Math.abs(dy) > thresh)) moved = true;
      const nx = clamp(bx + dx, 0, innerWidth  - el.offsetWidth);
      const ny = clamp(by + dy, 0, innerHeight - el.offsetHeight);
      el.style.left = `${Math.round(nx)}px`;
      el.style.top  = `${Math.round(ny)}px`;
      if (isPanelVisible()) linkPanelToBubble(true);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      if (moved) {
        state.bubbleX = Math.round(parseFloat(el.style.left)) || 12;
        state.bubbleY = Math.round(parseFloat(el.style.top))  || 12;
        linkPanelToBubble(isPanelVisible());
        save();
      } else {
        if (!isPanelVisible()) showPanel(); else hidePanel();
      }
    };

    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('resize', () => { clampBubbleIntoViewport(); });
  }

  function clampBubbleIntoViewport() {
    if (!bubble) return;
    const w = innerWidth || 1280, h = innerHeight || 720;
    const bw = bubble.offsetWidth || 32, bh = bubble.offsetHeight || 32;
    state.bubbleX = clamp(state.bubbleX, 0, Math.max(0, w - bw));
    state.bubbleY = clamp(state.bubbleY, 0, Math.max(0, h - bh));
    bubble.style.left = `${state.bubbleX}px`;
    bubble.style.top  = `${state.bubbleY}px`;
    linkPanelToBubble(isPanelVisible());
    save();
  }

  // ---------- Bubble visibility ----------
  function hasAnyVideo() {
    if (hasAnyVideoLocal()) return true;
    if (!IS_TOP) return false;
    const now = Date.now();
    let seen = false;
    for (const [id, entry] of framePresence.entries()) {
      if (!entry) continue;
      if (now - entry.at > FRAME_STATUS_TTL_MS) { framePresence.delete(id); continue; }
      if (entry.hasVideo) seen = true;
    }
    return seen;
  }
  function updateBubbleVisibility() { if (bubble) bubble.style.display = (hasAnyVideo() || shouldForceBubbleVisible()) ? 'flex' : 'none'; }

  function linkPanelToBubble(applyToPanel = true) {
    if (!IS_TOP || !bubble) return;
    const rect = bubble.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const panelW = Math.max(panel?.offsetWidth || 0, state.w || CONFIG.panelW);
    const panelH = Math.max(panel?.offsetHeight || 0, state.h || CONFIG.panelH);
    const gap = CONFIG.panelLinkGap;
    const vw = innerWidth || 1280;
    const vh = innerHeight || 720;

    let x = rect.right + gap;
    let y = rect.top;
    if (x + panelW > vw) x = rect.left - panelW - gap;
    if (x < 0) x = clamp(rect.left, 0, Math.max(0, vw - panelW));
    if (y + panelH > vh) y = Math.max(0, vh - panelH - gap);
    if (y < 0) y = 0;

    state.x = Math.round(x);
    state.y = Math.round(y);
    if (applyToPanel && panel) {
      panel.style.left = `${state.x}px`;
      panel.style.top = `${state.y}px`;
    }
  }

  // ---------- Per-video Save / Restore ----------
  function getVideoKey() {
    try {
      const u = new URL(location.href);
      if (u.hostname.includes('youtube.com')) {
        const v = u.searchParams.get('v');
        if (v) return 'yt:' + v;
        if (location.pathname.startsWith('/shorts/')) {
          const id = location.pathname.split('/shorts/')[1]?.split(/[/?#&]/)[0];
          if (id) return 'yt:' + id;
        }
      }
      return 'url:' + (u.origin + u.pathname + u.search);
    } catch {
      return 'url:' + location.href.split('#')[0];
    }
  }

  function getDefaultSitePresetInput() {
    return normalizeSitePresetKey(location.hostname) || location.hostname || '';
  }

  function normalizeSitePresetKey(raw) {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) return '';
    try {
      const parsed = text.includes('://') ? new URL(text) : new URL(`https://${text}`);
      return normalizeHost(parsed.hostname);
    } catch {
      return normalizeHost(text.split('/')[0].split('?')[0].split('#')[0]);
    }
  }

  function normalizeHost(host) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^\.+/, '')
      .replace(/\.+$/, '')
      .replace(/^www\./, '');
  }

  function getSitePresetKeyFromInput() {
    return normalizeSitePresetKey(els.siteInput?.value || location.hostname);
  }

  function getMatchingSitePreset() {
    const presets = state.sitePresets || {};
    let hostKey = normalizeHost(location.hostname);
    while (hostKey) {
      if (presets[hostKey]) return { key: hostKey, preset: presets[hostKey] };
      const parts = hostKey.split('.');
      if (parts.length <= 2) break;
      hostKey = parts.slice(1).join('.');
    }
    return null;
  }

  function escapeAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function snapshotFromState() {
    return {
      kelvin: state.kelvin,
      tint: state.tint,
      strength: state.strength,
      brightness: state.brightness,
      contrast: state.contrast,
      saturation: state.saturation,
      sharpness: state.sharpness,
      compareEnabled: !!state.compareEnabled,
      comparePos: normalizeComparePos(state.comparePos, CONFIG.default.comparePos),
      updatedAt: new Date().toISOString()
    };
  }

  function applySnapshotSettings(snap, userAction = false) {
    if (!snap) return false;
    state.kelvin = snap.kelvin;
    state.tint = snap.tint;
    state.strength = snap.strength;
    state.brightness = snap.brightness ?? CONFIG.default.brightness;
    state.contrast = snap.contrast ?? CONFIG.default.contrast;
    state.saturation = snap.saturation ?? CONFIG.default.saturation;
    state.sharpness = snap.sharpness ?? CONFIG.default.sharpness;
    state.compareEnabled = snap.compareEnabled ?? state.compareEnabled;
    state.comparePos = normalizeComparePos(snap.comparePos, state.comparePos ?? CONFIG.default.comparePos);
    syncUIFromState();
    refreshMatrix();
    refreshSharpness();
    applyToVideos(true, userAction);
    return true;
  }

  function normalizeSnapshot(snap) {
    if (!snap || typeof snap !== 'object' || !('kelvin' in snap) || !('tint' in snap) || !('strength' in snap)) return null;
    return {
      kelvin: clamp(Math.round(+snap.kelvin), CONFIG.kelvinMin, CONFIG.kelvinMax),
      tint: clamp(Math.round(+snap.tint), -100, 100),
      strength: clamp(Math.round(+snap.strength), 0, 100),
      brightness: clamp(Math.round(snap.brightness ?? CONFIG.default.brightness), 10, 200),
      contrast: clamp(Math.round(snap.contrast ?? CONFIG.default.contrast), 10, 250),
      saturation: clamp(Math.round(snap.saturation ?? CONFIG.default.saturation), 0, 250),
      sharpness: clamp(Math.round(snap.sharpness ?? CONFIG.default.sharpness), -50, 150),
      compareEnabled: typeof snap.compareEnabled === 'boolean' ? snap.compareEnabled : undefined,
      comparePos: Number.isFinite(Number(snap.comparePos)) ? normalizeComparePos(snap.comparePos, CONFIG.default.comparePos) : undefined,
      updatedAt: snap.updatedAt || new Date().toISOString()
    };
  }

  function saveCurrentVideoSnapshot({ flash = false } = {}) {
    if (!IS_TOP || !hasAnyVideo()) return false;
    const key = getVideoKey();
    if (!key) return false;
    if (!state.snapshots) state.snapshots = {};
    state.snapshots[key] = snapshotFromState();
    pruneSnapshots();
    updateRestoreState();
    if (flash) flashBubble('✓');
    return true;
  }

  function pruneSnapshots(limit=SNAPSHOT_LIMIT){
    const snaps = state.snapshots || {};
    const entries = Object.entries(snaps);
    const now = Date.now();
    let changed = false;
    for (const [key, snap] of entries) {
      const updatedAt = Date.parse(snap?.updatedAt || '');
      if (!Number.isFinite(updatedAt) || now - updatedAt > SNAPSHOT_TTL_MS) {
        delete snaps[key];
        changed = true;
      }
    }
    const freshEntries = Object.entries(snaps);
    if (freshEntries.length <= limit) return changed;
    freshEntries.sort((a,b)=> new Date(a[1].updatedAt||0) - new Date(b[1].updatedAt||0));
    while(freshEntries.length>limit){
      const [k] = freshEntries.shift();
      delete snaps[k];
      changed = true;
    }
    return changed;
  }

  function onSaveSnapshot() {
    saveCurrentVideoSnapshot({ flash: true });
    save();
    updateRestoreState();
  }

  function onSaveDefaultPreset() {
    state.defaultPreset = normalizePreset({
      kelvin: state.kelvin,
      tint: state.tint,
      strength: state.strength,
      brightness: state.brightness,
      contrast: state.contrast,
      saturation: state.saturation,
      sharpness: state.sharpness
    });
    save();
    flashBubble('D');
  }

  function onRestoreSnapshot() {
    const key = getVideoKey();
    const snap = state.snapshots && state.snapshots[key];
    if (!snap) { alert('No saved preset for this video yet. Click Save first.'); return; }
    applySnapshotSettings(snap, true);
    saveUserAction();
  }

  function onSaveSitePreset() {
    const key = getSitePresetKeyFromInput();
    if (!key) { alert('Add a website like youtube.com first.'); return; }
    if (!state.sitePresets) state.sitePresets = {};
    const snap = snapshotFromState();
    state.sitePresets[key] = snap;
    autoAppliedKeys.delete(getVideoKey());
    applySnapshotSettings(snap, true);
    markUserAction();
    save();
    updateSitePresetState();
    flashBubble('S');
  }

  function onApplySitePreset() {
    const key = getSitePresetKeyFromInput();
    const snap = state.sitePresets && state.sitePresets[key];
    if (!snap) { alert('No saved website preset for this website yet.'); return; }
    applySnapshotSettings(snap, true);
    markUserAction();
    save();
    updateSitePresetState();
  }

  function onDeleteSitePreset() {
    const key = getSitePresetKeyFromInput();
    if (!key || !state.sitePresets || !state.sitePresets[key]) return;
    delete state.sitePresets[key];
    save();
    updateSitePresetState();
    flashBubble('X');
  }

  function updateRestoreState() {
    if (!panel) return;
    const btn = panel.querySelector('#vwb-restore');
    if (!btn) return;
    const key = getVideoKey();
    const snap = state.snapshots && state.snapshots[key];
    btn.disabled = !snap;
    updateSaveStatus(snap);
    updateSitePresetState();
  }

  function updateSitePresetState() {
    if (!panel || !els.siteInput || !els.siteStatus) return;
    const key = getSitePresetKeyFromInput();
    const snap = key && state.sitePresets && state.sitePresets[key];
    if (els.siteRead) els.siteRead.textContent = key || '';
    const applyBtn = panel.querySelector('#vwb-site-apply');
    const deleteBtn = panel.querySelector('#vwb-site-delete');
    if (applyBtn) applyBtn.disabled = !snap;
    if (deleteBtn) deleteBtn.disabled = !snap;
    if (!key) {
      els.siteStatus.textContent = 'Add a website like youtube.com.';
      els.siteStatus.classList.add('warn');
      return;
    }
    if (!snap) {
      const matching = getMatchingSitePreset();
      els.siteStatus.textContent = matching
        ? `This page will use ${matching.key}. Save to ${key} to override it.`
        : `No website preset saved for ${key}.`;
      els.siteStatus.classList.remove('warn');
      return;
    }
    const updatedAt = Date.parse(snap.updatedAt || '');
    els.siteStatus.textContent = Number.isFinite(updatedAt)
      ? `Saved for ${key} on ${formatDateShort(new Date(updatedAt))}.`
      : `Saved for ${key}.`;
    els.siteStatus.classList.remove('warn');
  }

  function updateSaveStatus(snap) {
    if (!els.saveStatus) return;
    if (!snap) {
      els.saveStatus.textContent = 'No video save yet. Changes auto-save for 60 days.';
      els.saveStatus.classList.remove('warn');
      return;
    }
    const updatedAt = Date.parse(snap.updatedAt || '');
    if (!Number.isFinite(updatedAt)) {
      els.saveStatus.textContent = 'Saved for this video. Expiry date unknown.';
      els.saveStatus.classList.add('warn');
      return;
    }
    const expiresAt = new Date(updatedAt + SNAPSHOT_TTL_MS);
    const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    els.saveStatus.textContent = `Saved for this video until ${formatDateShort(expiresAt)} (${daysLeft} days left).`;
    els.saveStatus.classList.toggle('warn', daysLeft <= 7);
  }

  function formatDateShort(date) {
    try {
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function syncUIFromState() {
    if (!panel) return;
    els.kSlider.value = els.kInput.value = state.kelvin;
    els.tSlider.value = els.tInput.value = state.tint;
    els.sSlider.value = els.sInput.value = state.strength;
    els.bSlider.value = els.bInput.value = state.brightness;
    els.cSlider.value = els.cInput.value = state.contrast;
    els.satSlider.value = els.satInput.value = state.saturation;
    els.shSlider.value = els.shInput.value = state.sharpness;
    if (els.compareSlider) els.compareSlider.value = els.compareInput.value = state.comparePos;
    els.kRead.textContent = state.kelvin;
    els.tRead.textContent = state.tint;
    els.sRead.textContent = `${state.strength}%`;
    els.bRead.textContent = `${state.brightness}%`;
    els.cRead.textContent = `${state.contrast}%`;
    els.satRead.textContent = `${state.saturation}%`;
    els.shRead.textContent = `${state.sharpness}%`;
    if (els.compareRead) els.compareRead.textContent = `${state.comparePos}%`;
    if (els.compareEnabled) els.compareEnabled.checked = !!state.compareEnabled;
    if (state.compareEnabled) syncCompareControl();
    updateSitePresetState();
  }

  function normalizeComparePos(raw, fallback = 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : fallback;
  }

  // ---------- Import / Export (ALL snapshots) ----------
  function exportSnapshots() {
    if (pruneSnapshots()) save();
    const payload = {
      schema: CONFIG.exportSchema,
      exportedAt: new Date().toISOString(),
      snapshots: state.snapshots || {},
      sitePresets: state.sitePresets || {}
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const name = `video-wb-settings-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;

    // Try GM_download first; fallback to anchor download
    try {
      if (typeof GM_download === 'function') {
        const url = URL.createObjectURL(blob);
        GM_download({ url, name, saveAs: true, onerror: () => aFallback(), ontimeout: () => aFallback() });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        flashBubble('⬇');
        return;
      }
    } catch {}
    aFallback();

    function aFallback() {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      flashBubble('⬇');
    }
  }

  function importSnapshotsFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || typeof data.snapshots !== 'object') {
          alert('Invalid settings file.');
          return;
        }
        state.snapshots = state.snapshots || {};
        state.sitePresets = state.sitePresets || {};
        let count = 0;
        for (const [k, snap] of Object.entries(data.snapshots)) {
          const normalized = normalizeSnapshot(snap);
          if (normalized) {
            state.snapshots[k] = normalized;
            count++;
          }
        }
        if (data.sitePresets && typeof data.sitePresets === 'object') {
          for (const [k, snap] of Object.entries(data.sitePresets)) {
            const key = normalizeSitePresetKey(k);
            const normalized = normalizeSnapshot(snap);
            if (key && normalized) {
              state.sitePresets[key] = normalized;
              count++;
            }
          }
        }
        pruneSnapshots();
        saveUserAction();
        updateRestoreState();
        flashBubble('⬆');

        // If the current video now has a preset, apply it immediately
        const key = getVideoKey();
        if (state.snapshots[key]) {
          applySnapshotSettings(state.snapshots[key], true);
        }
        updateSitePresetState();
      } catch {
        alert('Could not read settings file.');
      }
    };
    reader.readAsText(file);
  }

  // ---------- Autoload on reopen ----------
  function autoApplySnapshotIfPresent(userAction = false) {
    if (!state.enabled) return;
    if (!shouldApplyFilters(userAction)) return;
    if (!hasAnyVideo()) return;
    const key = getVideoKey();
    if (autoAppliedKeys.has(key)) return;
    const siteMatch = getMatchingSitePreset();
    if (siteMatch?.preset) {
      applySnapshotSettings(siteMatch.preset, userAction);
      autoAppliedKeys.add(key);
      updateSitePresetState();
      return;
    }
    const snap = state.snapshots && state.snapshots[key];
    if (snap) {
      applySnapshotSettings(snap, userAction);
      autoAppliedKeys.add(key);
      return;
    }
    const def = state.defaultPreset || CONFIG.default;
    state.kelvin = def.kelvin; state.tint = def.tint; state.strength = def.strength;
    state.brightness = def.brightness ?? CONFIG.default.brightness;
    state.contrast = def.contrast ?? CONFIG.default.contrast;
    state.saturation = def.saturation ?? CONFIG.default.saturation;
    state.sharpness = def.sharpness ?? CONFIG.default.sharpness;
    state.compareEnabled = CONFIG.default.compareEnabled;
    state.comparePos = CONFIG.default.comparePos;
    syncUIFromState(); refreshMatrix(); refreshSharpness(); applyToVideos(true, userAction);
    autoAppliedKeys.add(key);
  }

  function flashBubble(icon='✓') {
    if (!bubble) return;
    const old = bubble.textContent;
    bubble.textContent = icon;
    setTimeout(() => { bubble.textContent = old; }, 600);
  }

  // ---------- Panel visibility ----------
  function isPanelVisible() { return !!(panel && panel.isConnected && !panel.classList.contains('hidden')); }
  function showPanel() {
    if (!IS_TOP) return;
    buildPanel();
    panel.classList.remove('hidden');
    state.visible = true;
    linkPanelToBubble(true);
    clampPanelIntoViewport();
    save();
  }
  function hidePanel() {
    if (!IS_TOP) return;
    if (!panel) buildPanel();
    panel.classList.add('hidden');
    state.visible = false;
    save();
  }
  function centerPanel() {
    if (!IS_TOP) return;
    buildPanel();
    const w = innerWidth || 1280, h = innerHeight || 720;
    const pw = panel.offsetWidth || state.w || CONFIG.panelW;
    const ph = panel.offsetHeight || state.h || CONFIG.panelH;
    state.x = Math.round((w - pw) / 2);
    state.y = Math.round((h - ph) / 3);
    state.w = pw; state.h = ph;
    panel.style.left = `${state.x}px`;
    panel.style.top  = `${state.y}px`;
    save();
  }
  function clampPanelIntoViewport() {
    if (!IS_TOP) return;
    buildPanel();
    const wasHidden = panel.classList.contains('hidden');
    if (wasHidden) panel.classList.remove('hidden');
    const w = innerWidth || 1280, h = innerHeight || 720;
    const pw = panel.offsetWidth || CONFIG.panelW;
    const ph = panel.offsetHeight || CONFIG.panelH;
    state.x = clamp(state.x, 0, Math.max(0, w - pw));
    state.y = clamp(state.y, 0, Math.max(0, h - ph));
    panel.style.left = `${state.x}px`;
    panel.style.top  = `${state.y}px`;
    if (wasHidden) panel.classList.add('hidden');
    save();
  }

  function pair(slider, input, on) {
    slider.addEventListener('input', () => { input.value = slider.value; on(+slider.value); });
    input.addEventListener('change', () => {
      const v = clamp(+input.value, +slider.min, +slider.max);
      input.value = slider.value = String(v);
      on(v);
    });
  }

  // ---------- Kelvin + Tint math (extended) ----------
  function refreshMatrix() {
    ensureSVG();
    if (!matrixNode && !matrixNodeLite) return;
    const [r,g,b] = gainsFrom(state.kelvin, state.tint, state.strength / 100);
    const R = clamp(r, 0.02, 10), G = clamp(g, 0.02, 10), B = clamp(b, 0.02, 10);
    const values = `${R} 0 0 0 0  0 ${G} 0 0 0  0 0 ${B} 0 0  0 0 0 1 0`;
    if (matrixNode) matrixNode.setAttribute('values', values);
    if (matrixNodeLite) matrixNodeLite.setAttribute('values', values);
  }
  function refreshSharpness(){
    ensureSVG();
    if (!sharpNode) return;
    const amt = clamp(state.sharpness, -50, 150) / 100; // -0.5..1.5
    const a = amt;
    const center = 1 + 4 * a;
    const edge = -a;
    const kernel = [
      0,      edge,   0,
      edge,   center, edge,
      0,      edge,   0
    ].join(' ');
    sharpNode.setAttribute('kernelMatrix', kernel);
  }

  function isVideoFullscreen(video) {
    if (!video) return false;
    try {
      if (video.webkitDisplayingFullscreen) return true;
    } catch {}
    const doc = video.ownerDocument || document;
    const fsEl =
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement;
    if (fsEl && (fsEl === video || (fsEl.contains && fsEl.contains(video)))) return true;
    try {
      if (video.matches && (video.matches(':fullscreen') || video.matches(':-webkit-full-screen'))) return true;
    } catch {}
    return false;
  }

  // Use a lighter filter in fullscreen to reduce GPU stalls.
  function filterIdForVideo(video) {
    if (NORMAL_FULLSCREEN_FILTER_MODE) return 'vwb-filter';
    return CONFIG.fullscreenLite && (fullscreenActive || isVideoFullscreen(video)) ? 'vwb-filter-lite' : 'vwb-filter';
  }

  function currentFilterString(filterId){
    const parts = [];
    const id = filterId || 'vwb-filter';
    parts.push(`url(#${id})`);
    parts.push(`brightness(${state.brightness}%)`);
    parts.push(`contrast(${state.contrast}%)`);
    parts.push(`saturate(${state.saturation}%)`);
    return parts.join(' ');
  }

  function pickCompareTarget(videos){
    const list = videos.filter(v => v && v.tagName === 'VIDEO');
    if (!list.length) return null;
    return pickPrimary(list);
  }

  function ensureCompareOverlayFor(video){
    if (!IS_TOP || !state.compareEnabled) {
      teardownCompareOverlay();
      return false;
    }
    if (!video || video.tagName !== 'VIDEO') {
      teardownCompareOverlay();
      return false;
    }
    if (compare.video !== video || !compare.wrap) {
      teardownCompareOverlay();
      createCompareOverlay(video);
    }
    compare.active = true;
    compare.video = video;
    syncCompareControl();
    updateCompareFilter();
    updateCompareLayout(true);
    updateCompareClip();
    startCompareLoop();
    return true;
  }

  function createCompareOverlay(video){
    if (!video) return;
    const wrap = document.createElement('div');
    wrap.id = 'vwb-compare-wrap';
    const clip = document.createElement('div');
    clip.id = 'vwb-compare-clip';
    const canvas = document.createElement('canvas');
    canvas.id = 'vwb-compare-canvas';
    clip.appendChild(canvas);
    const line = document.createElement('div');
    line.id = 'vwb-compare-line';
    const handle = document.createElement('div');
    handle.id = 'vwb-compare-handle';
    line.appendChild(handle);
    const changedLabel = document.createElement('div');
    changedLabel.id = 'vwb-compare-label-changed';
    changedLabel.className = 'vwb-compare-label';
    changedLabel.textContent = 'Changed';
    const originalLabel = document.createElement('div');
    originalLabel.id = 'vwb-compare-label-original';
    originalLabel.className = 'vwb-compare-label';
    originalLabel.textContent = 'Original';
    wrap.appendChild(clip);
    wrap.appendChild(line);
    wrap.appendChild(changedLabel);
    wrap.appendChild(originalLabel);

    compare.wrap = wrap;
    compare.clip = clip;
    compare.canvas = canvas;
    compare.line = line;
    compare.handle = handle;
    compare.changedLabel = changedLabel;
    compare.originalLabel = originalLabel;
    compare.ctx = null;
    compare.lastRect = null;
    compare.video = video;
    compare.active = true;
    compare.lastDrawAt = 0;
    compare.lastLayoutAt = 0;

    ensureCompareContainer();
    setupCompareDrag();
    bindCompareVideoEvents();
    drawCompareFrame();
  }

  function ensureCompareContainer(){
    if (!compare.wrap) return;
    const doc = compare.video?.ownerDocument || document;
    const parent = getFullscreenElement(doc) || doc.body || doc.documentElement;
    if (!parent) return;
    if (compare.wrap.parentNode !== parent) parent.appendChild(compare.wrap);
  }

  function bindCompareVideoEvents(){
    if (!compare.video) return;
    compare.videoListeners = [];
    const onFrame = () => { drawCompareFrame(); };
    const onLayout = () => { updateCompareLayout(true); drawCompareFrame(); };
    addCompareVideoListener('loadedmetadata', onLayout);
    addCompareVideoListener('loadeddata', onFrame);
    addCompareVideoListener('seeked', onFrame);
    addCompareVideoListener('play', onFrame);
    addCompareVideoListener('pause', onFrame);
  }

  function addCompareVideoListener(type, fn){
    if (!compare.video) return;
    compare.video.addEventListener(type, fn);
    compare.videoListeners.push([type, fn]);
  }

  function teardownCompareOverlay(){
    if (compare.raf) {
      cancelAnimationFrame(compare.raf);
      compare.raf = 0;
    }
    if (compare.dragHandlers) {
      window.removeEventListener('pointermove', compare.dragHandlers.move, true);
      window.removeEventListener('pointerup', compare.dragHandlers.up, true);
      compare.dragHandlers = null;
    }
    if (compare.video && compare.videoListeners.length) {
      for (const [type, fn] of compare.videoListeners) {
        try { compare.video.removeEventListener(type, fn); } catch {}
      }
    }
    compare.videoListeners = [];
    compare.dragging = false;
    compare.dragPointerId = null;
    compare.ctx = null;
    compare.lastRect = null;
    compare.active = false;
    compare.video = null;
    if (compare.wrap && compare.wrap.parentNode) {
      compare.wrap.parentNode.removeChild(compare.wrap);
    }
    compare.wrap = null;
    compare.clip = null;
    compare.canvas = null;
    compare.line = null;
    compare.handle = null;
    compare.changedLabel = null;
    compare.originalLabel = null;
  }

  function updateCompareLayout(force=false){
    if (!compare.wrap || !compare.video) return;
    if (!compare.video.isConnected) {
      teardownCompareOverlay();
      return;
    }
    ensureCompareContainer();
    const rect = compare.video.getBoundingClientRect();
    const vw = innerWidth || 0;
    const vh = innerHeight || 0;
    const visible = rect.width > 40 && rect.height > 40 &&
      rect.bottom > 0 && rect.right > 0 && rect.left < vw && rect.top < vh;
    compare.wrap.dataset.hidden = visible ? '' : '1';
    if (!visible) return;
    const prev = compare.lastRect;
    const changed = !prev ||
      Math.abs(prev.left - rect.left) > 0.5 ||
      Math.abs(prev.top - rect.top) > 0.5 ||
      Math.abs(prev.width - rect.width) > 0.5 ||
      Math.abs(prev.height - rect.height) > 0.5;
    if (force || changed) {
      compare.lastRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      compare.wrap.style.left = `${rect.left}px`;
      compare.wrap.style.top = `${rect.top}px`;
      compare.wrap.style.width = `${rect.width}px`;
      compare.wrap.style.height = `${rect.height}px`;
      syncCompareCanvasSize(rect);
      updateCompareClip();
    }
  }

  function syncCompareCanvasSize(rect){
    const canvas = compare.canvas;
    if (!canvas || !compare.video) return;
    const w = Math.max(1, Math.floor(compare.video.videoWidth || rect.width || 1));
    const h = Math.max(1, Math.floor(compare.video.videoHeight || rect.height || 1));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${Math.max(1, Math.round(rect.width || 1))}px`;
    canvas.style.height = `${Math.max(1, Math.round(rect.height || 1))}px`;
  }

  function updateCompareClip(){
    if (!compare.clip || !compare.line) return;
    const pos = normalizeComparePos(state.comparePos, COMPARE_SPLIT_POS);
    state.comparePos = pos;
    compare.clip.style.width = `${pos}%`;
    compare.line.style.left = `${pos}%`;
    syncCompareControl();
  }

  function setCompareStatus(msg, warn = false){
    if (!panel || !els.compareStatus) return;
    els.compareStatus.textContent = msg || COMPARE_STATUS_DEFAULT;
    els.compareStatus.classList.toggle('warn', !!warn);
  }

  function updateCompareStatusForTargets(videos, compareActive){
    if (!panel || !els.compareStatus) return;
    if (!state.compareEnabled) {
      setCompareStatus(COMPARE_STATUS_DEFAULT, false);
      return;
    }
    const hasVideo = videos.some(v => v.tagName === 'VIDEO');
    const hasIframe = videos.some(v => v.tagName === 'IFRAME');
    if (!hasVideo) {
      if (hasIframe) {
        if (allowIframeTargets()) {
          setCompareStatus('Compare runs inside the player frame on this site. If you do not see it, click Rescan.', false);
        } else {
          setCompareStatus('Compare needs a direct video element. This player uses an iframe.', true);
        }
      } else {
        setCompareStatus('Compare waits for a visible video.', false);
      }
      return;
    }
    if (!compareActive) {
      setCompareStatus('Compare split is ready. Try Rescan if it does not show.', false);
      return;
    }
    setCompareStatus(COMPARE_STATUS_DEFAULT, false);
  }

  function updateCompareFilter(){
    if (!compare.canvas || !compare.video) return;
    const filterId = filterIdForVideo(compare.video);
    const f = currentFilterString(filterId);
    const varValue = compare.canvas.style.getPropertyValue('--vwb-filter') || '';
    if (varValue !== f) compare.canvas.style.setProperty('--vwb-filter', f, 'important');
    compare.canvas.style.setProperty('filter', 'var(--vwb-filter)', 'important');
  }

  function drawCompareFrame(){
    if (!compare.canvas || !compare.video) return;
    if (compare.video.readyState < 2) return;
    const ctx = compare.ctx || (compare.ctx = compare.canvas.getContext('2d'));
    if (!ctx) return;
    const w = compare.canvas.width || 0;
    const h = compare.canvas.height || 0;
    if (!w || !h) return;
    try {
      ctx.drawImage(compare.video, 0, 0, w, h);
    } catch {}
  }

  function startCompareLoop(){
    if (compare.raf) return;
    const tick = (ts) => {
      if (!compare.active || !compare.video || !compare.wrap) { compare.raf = 0; return; }
      if (ts - compare.lastLayoutAt > 120) {
        updateCompareLayout(false);
        compare.lastLayoutAt = ts;
      }
      const playing = !compare.video.paused && !compare.video.ended && compare.video.readyState >= 2;
      const interval = playing ? 1000 / 30 : 600;
      if (ts - compare.lastDrawAt > interval) {
        drawCompareFrame();
        compare.lastDrawAt = ts;
      }
      compare.raf = requestAnimationFrame(tick);
    };
    compare.raf = requestAnimationFrame(tick);
  }

  function setComparePos(pos, saveNow=false){
    const next = normalizeComparePos(pos, 0);
    state.comparePos = next;
    syncCompareControl();
    updateCompareClip();
    if (saveNow) saveUserAction();
  }

  function syncCompareControl(){
    if (!panel || !els.compareSlider) return;
    const pos = normalizeComparePos(state.comparePos, COMPARE_SPLIT_POS);
    els.compareSlider.value = String(pos);
    els.compareInput.value = String(pos);
    if (els.compareRead) els.compareRead.textContent = `${pos}%`;
  }

  function setComparePosFromClientX(clientX, saveNow=false){
    if (!compare.video) return;
    const rect = compare.lastRect || compare.video.getBoundingClientRect();
    if (!rect || !(rect.width > 0)) return;
    const pos = ((clientX - rect.left) / rect.width) * 100;
    setComparePos(pos, saveNow);
  }

  function setupCompareDrag(){
    if (!compare.line) return;
    const onDown = (e) => {
      if (!compare.video) return;
      compare.dragging = true;
      compare.dragPointerId = e.pointerId;
      try { compare.line.setPointerCapture?.(e.pointerId); } catch {}
      updateCompareLayout(true);
      setComparePosFromClientX(e.clientX, false);
      const onMove = (evt) => {
        if (!compare.dragging) return;
        if (compare.dragPointerId !== null && evt.pointerId !== compare.dragPointerId) return;
        setComparePosFromClientX(evt.clientX, false);
      };
      const onUp = (evt) => {
        if (!compare.dragging) return;
        if (compare.dragPointerId !== null && evt.pointerId !== compare.dragPointerId) return;
        compare.dragging = false;
        compare.dragPointerId = null;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        compare.dragHandlers = null;
        saveUserAction();
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      compare.dragHandlers = { move: onMove, up: onUp };
      e.preventDefault();
    };
    compare.line.addEventListener('pointerdown', onDown);
  }

  function getActiveCompareVideo(videos) {
    if (!compare.active || !compare.video) return null;
    if (!compare.video.isConnected) return null;
    if (videos && !videos.includes(compare.video)) return null;
    return compare.video;
  }

  function gainsFrom(kelvin, tint, str) {
    const eff = clamp(kelvin, 1000, 40000);
    let [r,g,b] = kelvinToRGB(eff);
    [r,g,b] = extendedKelvinStretch(r,g,b, kelvin);
    let mean = (r+g+b)/3 || 1; r/=mean; g/=mean; b/=mean;
    const f = Math.log(2) * (tint/100);
    r *= Math.exp( 0.5*f);
    g *= Math.exp(-1.0*f);
    b *= Math.exp( 0.5*f);
    mean = (r+g+b)/3 || 1; r/=mean; g/=mean; b/=mean;
    r = 1 + (r-1)*str; g = 1 + (g-1)*str; b = 1 + (b-1)*str;
    return [r,g,b];
  }

  function extendedKelvinStretch(r,g,b, K){
    const exp = 0.85;
    if (K < 1000) {
      const t = 1000 / Math.max(500, K);
      r *= Math.pow(t,  exp);
      b *= Math.pow(t, -exp);
    } else if (K > 40000) {
      const t = Math.max(1, K / 40000);
      r *= Math.pow(t, -exp);
      b *= Math.pow(t,  exp);
    }
    return [r,g,b];
  }

  function kelvinToRGB(tempK) {
    const t = clamp(tempK, 1000, 40000) / 100;
    let r = (t <= 66) ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    let g = (t <= 66) ? (99.4708025861 * Math.log(t) - 161.1195681661)
                      : (288.1221695283 * Math.pow(t - 60, -0.0755148492));
    let b = (t >= 66) ? 255 : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
    return [clamp(r,0,255)/255, clamp(g,0,255)/255, clamp(b,0,255)/255];
  }

  // ---------- WB Picker ----------
  async function pickWB() {
    const picked = await pickWBWithZoom();
    if (picked) return;
    if (!('EyeDropper' in window)) { alert('WB picker could not sample this video. EyeDropper API is also not supported.'); return; }
    const restoreUI = hideUIForPick(true);
    try {
      const eye = new EyeDropper();
      const { sRGBHex } = await eye.open();
      const [R,G,B] = hexTo01(sRGBHex);
      applyWBFromRGB(R, G, B);
    } catch { /* canceled */ }
    finally { restoreUI(); }
  }

  function applyWBFromRGB(R, G, B) {
    const lum = 0.2126*R + 0.7152*G + 0.0722*B;
    if (lum < 0.03 || lum > 0.97) { alert('Pick a mid-tone neutral (not near black/white).'); return false; }

    const mean = (R+G+B)/3;
    let gR = mean/(R||1e-6), gG = mean/(G||1e-6), gB = mean/(B||1e-6);
    const gMean = (gR+gG+gB)/3 || 1; gR/=gMean; gG/=gMean; gB/=gMean;

    const targetRB = clamp(gR / gB, 0.05, 20);
    const bestK = solveKelvinByRB(targetRB, CONFIG.kelvinMin, CONFIG.kelvinMax);

    let base = kelvinToRGB(clamp(bestK,1000,40000));
    base = extendedKelvinStretch(base[0], base[1], base[2], bestK);
    const bm = (base[0]+base[1]+base[2])/3 || 1;
    const Rk = base[0]/bm, Gk = base[1]/bm, Bk = base[2]/bm;

    const S = gG / Math.sqrt(gR*gB);
    const Bf = Gk / Math.sqrt(Rk*Bk);
    const f = -(2/3) * Math.log((S||1e-6)/(Bf||1e-6));
    const tint = clamp(Math.round((f/Math.log(2))*100), -100, 100);

    state.kelvin = Math.round(bestK);
    state.tint = tint;
    syncUIFromState(); saveUserAction(); refreshMatrix(); applyToVideos(false, true);
    return true;
  }

  async function pickWBWithZoom() {
    if (!IS_TOP) return false;
    const videos = scanVideos(true).filter(v => v.tagName === 'VIDEO');
    const video = pickPrimary(videos);
    if (!video || !isTargetVisibleCandidate(video) || video.readyState < 2) return false;
    return await runVideoPicker(video);
  }

  function runVideoPicker(video) {
    stopPicker(false);
    return new Promise((resolve) => {
      const restoreUI = hideUIForPick(true);
      const overlay = document.createElement('div');
      overlay.id = 'vwb-picker-overlay';
      const loupe = document.createElement('div');
      loupe.id = 'vwb-picker-loupe';
      const canvas = document.createElement('canvas');
      canvas.id = 'vwb-picker-canvas';
      canvas.width = 150;
      canvas.height = 150;
      const status = document.createElement('div');
      status.id = 'vwb-picker-status';
      status.textContent = 'Move over video. Click neutral gray/white.';
      loupe.appendChild(canvas);
      loupe.appendChild(status);
      document.body.appendChild(overlay);
      document.body.appendChild(loupe);

      picker.active = true;
      picker.video = video;
      picker.overlay = overlay;
      picker.loupe = loupe;
      picker.canvas = canvas;
      picker.ctx = canvas.getContext('2d');
      picker.sourceCanvas = document.createElement('canvas');
      picker.sourceCtx = picker.sourceCanvas.getContext('2d', { willReadFrequently: true });
      picker.status = status;
      picker.lastSample = null;
      let picking = false;

      const syncOverlayRect = () => {
        const rect = video.getBoundingClientRect();
        overlay.style.left = `${Math.max(0, rect.left)}px`;
        overlay.style.top = `${Math.max(0, rect.top)}px`;
        overlay.style.width = `${Math.max(1, rect.width)}px`;
        overlay.style.height = `${Math.max(1, rect.height)}px`;
      };
      syncOverlayRect();

      const cleanup = (result) => {
        overlay.removeEventListener('pointermove', onMove, true);
        overlay.removeEventListener('pointerdown', onPick, true);
        window.removeEventListener('resize', syncOverlayRect, true);
        window.removeEventListener('scroll', syncOverlayRect, true);
        window.removeEventListener('keydown', onKey, true);
        stopPicker(false);
        restoreUI();
        resolve(result);
      };
      picker.teardown = () => cleanup(false);

      const onMove = (event) => {
        syncOverlayRect();
        const sample = sampleVideoPixel(video, event.clientX, event.clientY, true);
        positionPickerLoupe(loupe, event.clientX, event.clientY);
        picker.lastSample = sample?.ok ? sample : null;
        if (sample?.ok) {
          drawPickerLoupe(sample);
          status.textContent = `RGB ${sample.r}, ${sample.g}, ${sample.b}. Click to apply.`;
        } else {
          drawPickerFallback();
          status.textContent = sample?.reason || 'Move over target video.';
        }
      };
      const onPick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (picking) return;
        picking = true;
        syncOverlayRect();
        const sample = sampleVideoPixel(video, event.clientX, event.clientY, true);
        if (sample?.ok) {
          cleanup(applyWBFromRGB(sample.r / 255, sample.g / 255, sample.b / 255));
          return;
        }
        if ('EyeDropper' in window) {
          overlay.style.display = 'none';
          loupe.style.display = 'none';
          try {
            const eye = new EyeDropper();
            const { sRGBHex } = await eye.open();
            const [R,G,B] = hexTo01(sRGBHex);
            cleanup(applyWBFromRGB(R, G, B));
          } catch {
            cleanup(true);
          }
          return;
        }
        picking = false;
        cleanup(false);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(true);
        }
      };
      overlay.addEventListener('pointermove', onMove, true);
      overlay.addEventListener('pointerdown', onPick, true);
      window.addEventListener('resize', syncOverlayRect, true);
      window.addEventListener('scroll', syncOverlayRect, true);
      window.addEventListener('keydown', onKey, true);
    });
  }

  function stopPicker(resolveValue = false) {
    if (!picker.active && !picker.overlay && !picker.loupe) return resolveValue;
    const overlay = picker.overlay;
    const loupe = picker.loupe;
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
    if (loupe?.parentNode) loupe.parentNode.removeChild(loupe);
    picker.active = false;
    picker.video = null;
    picker.overlay = null;
    picker.loupe = null;
    picker.canvas = null;
    picker.ctx = null;
    picker.sourceCanvas = null;
    picker.sourceCtx = null;
    picker.status = null;
    picker.lastSample = null;
    picker.teardown = null;
    return resolveValue;
  }

  function positionPickerLoupe(loupe, x, y) {
    if (!loupe) return;
    const pad = 16;
    const box = loupe.getBoundingClientRect();
    const w = box.width || 148;
    const h = box.height || 180;
    let left = x + 22;
    let top = y + 22;
    if (left + w > innerWidth) left = x - w - 22;
    if (top + h > innerHeight) top = y - h - 22;
    loupe.style.left = `${clamp(left, pad, Math.max(pad, innerWidth - w - pad))}px`;
    loupe.style.top = `${clamp(top, pad, Math.max(pad, innerHeight - h - pad))}px`;
  }

  function sampleVideoPixel(video, clientX, clientY, includeCrop = false) {
    if (!video || video.readyState < 2 || !picker.sourceCanvas || !picker.sourceCtx) return { ok: false, reason: 'Video not ready.' };
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return { ok: false, reason: 'Move over target video.' };
    }
    const w = Math.max(1, Math.floor(video.videoWidth || rect.width || 1));
    const h = Math.max(1, Math.floor(video.videoHeight || rect.height || 1));
    const x = clamp(Math.floor(((clientX - rect.left) / rect.width) * w), 0, w - 1);
    const y = clamp(Math.floor(((clientY - rect.top) / rect.height) * h), 0, h - 1);
    try {
      if (picker.sourceCanvas.width !== w || picker.sourceCanvas.height !== h) {
        picker.sourceCanvas.width = w;
        picker.sourceCanvas.height = h;
      }
      picker.sourceCtx.drawImage(video, 0, 0, w, h);
      const data = picker.sourceCtx.getImageData(x, y, 1, 1).data;
      const sample = { ok: true, r: data[0], g: data[1], b: data[2], x, y, w, h };
      if (includeCrop) {
        const half = Math.floor(PICKER_SAMPLE_SIZE / 2);
        sample.cropX = clamp(x - half, 0, Math.max(0, w - PICKER_SAMPLE_SIZE));
        sample.cropY = clamp(y - half, 0, Math.max(0, h - PICKER_SAMPLE_SIZE));
        sample.cropSize = Math.min(PICKER_SAMPLE_SIZE, w, h);
      }
      return sample;
    } catch {
      return { ok: false, reason: 'Protected video blocks script pixel zoom. Click to use browser picker.' };
    }
  }

  function drawPickerLoupe(sample) {
    if (!picker.ctx || !picker.sourceCanvas || !sample?.ok) return;
    const ctx = picker.ctx;
    const size = picker.canvas.width;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    const crop = sample.cropSize || PICKER_SAMPLE_SIZE;
    ctx.drawImage(picker.sourceCanvas, sample.cropX || 0, sample.cropY || 0, crop, crop, 0, 0, size, size);
    const cell = size / crop;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    for (let i = 1; i < crop; i += 1) {
      const p = Math.round(i * cell) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    const center = Math.floor(crop / 2) * cell;
    ctx.strokeRect(center + 1, center + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));
  }

  function drawPickerFallback() {
    if (!picker.ctx || !picker.canvas) return;
    const ctx = picker.ctx;
    const size = picker.canvas.width;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    for (let i = 0; i <= size; i += 15) {
      ctx.beginPath(); ctx.moveTo(i + 0.5, 0); ctx.lineTo(i + 0.5, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i + 0.5); ctx.lineTo(size, i + 0.5); ctx.stroke();
    }
  }

  function hideUIForPick(hide) {
    const prev = { panel: panel?.style.visibility, bubble: bubble?.style.visibility };
    if (hide) { if (panel) panel.style.visibility = 'hidden'; if (bubble) bubble.style.visibility = 'hidden'; }
    return () => { if (panel) panel.style.visibility = prev.panel || ''; if (bubble) bubble.style.visibility = prev.bubble || ''; };
  }

  function hexTo01(hex){ const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return m?[parseInt(m[1],16)/255,parseInt(m[2],16)/255,parseInt(m[3],16)/255]:[1,1,1]; }

  function solveKelvinByRB(targetRB, lo, hi){
    let bestK=6500,bestErr=1e9, L=lo, H=hi;
    for(let i=0;i<28;i++){
      const mid=(L+H)/2;
      let [r,g,b]=kelvinToRGB(clamp(mid,1000,40000));
      [r,g,b]=extendedKelvinStretch(r,g,b, mid);
      const m=(r+g+b)/3||1; const rb=(r/m)/(b/m);
      const err=Math.abs(Math.log((rb||1e-6)/(targetRB||1e-6)));
      if(err<bestErr){bestErr=err;bestK=mid;}
      if(rb>targetRB) L=mid; else H=mid;
    }
    return bestK;
  }

  // ---------- Apply to videos ----------
  function applyToVideos(forceScan=false, userAction=false){
    if(!state.enabled) { teardownCompareOverlay(); return; }
    const allowFilter = shouldApplyFilters(userAction);
    const allowCompare = state.compareEnabled && (IS_TOP || DELEGATE_TO_PARENT || allowFilter);
    const skipIframe = shouldSkipIframeFilter();
    if (allowFilter || allowCompare) {
      ensureSVG();
      refreshMatrix();
      refreshSharpness();
    }
    const vids = scanVideos(forceScan);
    if (!IS_TOP) notifyTopFrame(vids.length > 0);
    if(!vids.length) { lastPrimaryVideo = null; teardownCompareOverlay(); updateBubbleVisibility(); return; }

    let compareTarget = null;
    let compareActive = false;
    if (state.compareEnabled && allowCompare) {
      compareTarget = pickCompareTarget(vids);
      compareActive = ensureCompareOverlayFor(compareTarget);
    } else {
      teardownCompareOverlay();
    }

    updateCompareStatusForTargets(vids, compareActive);

    if (skipIframe) {
      vids.filter(v => v.tagName === 'IFRAME').forEach(v => activate(v, false));
    }

    if (!allowFilter) { updateBubbleVisibility(); return; }

    const applyTargets = skipIframe ? vids.filter(v => v.tagName !== 'IFRAME') : vids;
    if(state.applyAll){ applyTargets.forEach(v=>activate(v, !compareActive || v !== compareTarget)); }
    else {
      const pick = compareActive ? compareTarget : pickPrimary(applyTargets);
      applyTargets.forEach(v=>activate(v, v===pick && (!compareActive || v !== compareTarget)));
    }
    updateBubbleVisibility();
  }

  function activate(v,on){
    if (!v || (v.tagName !== 'VIDEO' && v.tagName !== 'IFRAME')) return;
    if (!on) {
      v.removeAttribute('data-vwb-active');
      v.style.removeProperty('--vwb-filter');
      v.style.removeProperty('filter');
      return;
    }
    v.setAttribute('data-vwb-active','1');
    const filterId = filterIdForVideo(v);
    const f = currentFilterString(filterId);
    const varValue = v.style.getPropertyValue('--vwb-filter') || '';
    const filterValue = v.style.getPropertyValue('filter') || '';
    const needsUpdate = varValue !== f ||
      !filterValue ||
      (!filterValue.includes('var(--vwb-filter)') && !filterValue.includes('vwb-filter'));
    if (!needsUpdate) return;
    const now = Date.now();
    const lastAt = lastFilterApplyAt.get(v) || 0;
    if (varValue === f && now - lastAt < CONFIG.filterReapplyCooldownMs) return;
    lastFilterApplyAt.set(v, now);
    v.style.setProperty('--vwb-filter', f, 'important');
    v.style.setProperty('filter', 'var(--vwb-filter)', 'important');
  }
  function clearFilters(){
    teardownCompareOverlay();
    const vids = [
      ...Array.from(document.getElementsByTagName('video')),
      ...Array.from(document.getElementsByTagName('iframe'))
    ];
    vids.forEach(v => {
      const varValue = v.style.getPropertyValue('--vwb-filter') || '';
      const filterValue = v.style.getPropertyValue('filter') || '';
      const marked = v.getAttribute('data-vwb-active') === '1';
      const ours = varValue.includes('vwb-filter') || filterValue.includes('vwb-filter') || filterValue.includes('var(--vwb-filter)');
      if (!marked && !ours) return;
      v.removeAttribute('data-vwb-active');
      v.style.removeProperty('--vwb-filter');
      v.style.removeProperty('filter');
    });
  }

  function hasFilterApplied(v) {
    if (!v) return false;
    const filterId = filterIdForVideo(v);
    const expected = currentFilterString(filterId);
    const varValue = v.style.getPropertyValue('--vwb-filter') || '';
    const filterValue = v.style.getPropertyValue('filter') || '';
    if (varValue !== expected) return false;
    if (!filterValue || (!filterValue.includes('var(--vwb-filter)') && !filterValue.includes('vwb-filter'))) return false;
    return true;
  }

  function needsFilterHeal(videos) {
    if (!videos.length) return false;
    const skipIframe = shouldSkipIframeFilter();
    const pool = skipIframe ? videos.filter(v => v.tagName !== 'IFRAME') : videos;
    if (!pool.length) return false;
    const compareVideo = getActiveCompareVideo(pool);
    const active = pool.filter(v => v.getAttribute('data-vwb-active') === '1');
    if (state.applyAll) {
      const expected = pool.length - (compareVideo ? 1 : 0);
      if (active.length !== expected) return true;
    } else {
      const expected = compareVideo ? 0 : 1;
      if (active.length !== expected) return true;
    }
    for (const v of active) {
      if (!hasFilterApplied(v)) return true;
    }
    return false;
  }

  function healFilters() {
    if (!state.enabled) return;
    if (!shouldApplyFilters(false)) return;
    const now = Date.now();
    if (now - lastFullscreenChangeAt < CONFIG.fullscreenApplyDelayMs) return;
    if (now - lastHealAt < CONFIG.filterHealIntervalMs) return;
    lastHealAt = now;
    const vids = scanVideos(false);
    if (!vids.length) return;
    if (needsFilterHeal(vids)) applyToVideos(true, false);
  }

  function scanVideos(force=false){
    const set = new Set(), list = [];
    const add = (el) => {
      if (!el || set.has(el)) return;
      if (el.tagName !== 'VIDEO' && el.tagName !== 'IFRAME') return;
      set.add(el);
      list.push(el);
    };
    if (isYouTube()) {
      add(document.querySelector('video.html5-main-video'));
      add(document.querySelector('#movie_player video'));
      add(document.querySelector('ytd-player video'));
      add(document.querySelector('ytd-watch-flexy video'));
    }
    (force ? Array.from(document.getElementsByTagName('video'))
           : Array.from(document.querySelectorAll('video'))).forEach(add);
    listIframeTargets(force).forEach(add);
    return list.filter(isTargetConnectedCandidate);
  }

  function isTargetConnectedCandidate(v){
    return !!(v && v.isConnected && (v.tagName === 'VIDEO' || v.tagName === 'IFRAME'));
  }

  function isTargetVisibleCandidate(v){
    if (!v || !v.isConnected) return false;
    const r = v.getBoundingClientRect();
    if (!(r.width > 40 && r.height > 40)) return false;
    const vw = innerWidth || 0;
    const vh = innerHeight || 0;
    return r.bottom > 0 && r.right > 0 && r.left < vw && r.top < vh;
  }

  function pickPrimary(videos){
    let playing = null;
    let playingArea = 0;
    for (const v of videos) {
      if (!isTargetVisibleCandidate(v)) continue;
      if (v.tagName === 'VIDEO' && !v.paused && !v.ended && v.readyState > 2) {
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > playingArea) { playingArea = area; playing = v; }
      }
    }
    if (playing) { lastPrimaryVideo = playing; return playing; }

    if (lastPrimaryVideo && videos.includes(lastPrimaryVideo) && isTargetVisibleCandidate(lastPrimaryVideo)) {
      return lastPrimaryVideo;
    }

    const ytMain = videos.find(v => v.tagName === 'VIDEO' && v.classList.contains('html5-main-video') && isTargetVisibleCandidate(v));
    if (ytMain) { lastPrimaryVideo = ytMain; return ytMain; }
    let best = videos.find(isTargetVisibleCandidate) || videos[0], bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const visible = r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight;
      const a = r.width * r.height;
      if (visible && a > bestArea) { bestArea = a; best = v; }
    }
    lastPrimaryVideo = best;
    return best;
  }

  // ---------- Observers / SPA hooks ----------
  function startObserver(){
    if(observer || !document.body) return;
    observer = new MutationObserver(muts=>{
      let touched = false, uiTouched = false;
      for(const m of muts){
        if (m.type === 'attributes') {
          const target = m.target;
          if (target && (target.tagName === 'VIDEO' || target.tagName === 'IFRAME')) touched = true;
        }
        for(const n of m.addedNodes||[]){
          if(n.nodeType===1){
            if (n.tagName==='VIDEO' || (n.querySelector && n.querySelector('video'))) touched = true;
            if (n.id === 'vwb-host') uiTouched = true;
          }
        }
        for(const n of m.removedNodes||[]){
          if(n.nodeType===1){
            if (n.tagName==='VIDEO' || (n.querySelector && n.querySelector('video'))) touched = true;
            if (n.id === 'vwb-host') uiTouched = true;
          }
        }
      }
      if (uiTouched) { ensureHost(); buildBubble(); buildPanel(); }
      if (touched) { applyToVideos(false, false); updateBubbleVisibility(); updateRestoreState(); autoApplySnapshotIfPresent(false); }
    });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','src','poster','hidden']});
  }
  function stopObserver(){ if(observer){observer.disconnect(); observer=null;} }

  function hasAppliedVideoTarget() {
    if (!state.enabled || !shouldApplyFilters(false)) return hasAnyVideo();
    const videos = scanVideos(true);
    return videos.some(v => v.getAttribute('data-vwb-active') === '1' && hasFilterApplied(v));
  }

  function rescanBurst() {
    if (!shouldApplyFilters(false)) return;
    let tries = 0;
    const iv = setInterval(() => {
      applyToVideos(true, false);
      updateBubbleVisibility();
      autoApplySnapshotIfPresent(false);
      if (hasAppliedVideoTarget() || ++tries >= CONFIG.rescanTries) clearInterval(iv);
    }, CONFIG.rescanIntervalMs);
  }

  (function hookHistory(){
    const fire=()=>window.dispatchEvent(new Event('vwb-locationchange'));
    const _ps=history.pushState; history.pushState=function(){ const r=_ps.apply(this,arguments); fire(); return r; };
    const _rs=history.replaceState; history.replaceState=function(){ const r=_rs.apply(this,arguments); fire(); return r; };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('vwb-locationchange', ()=>{ setTimeout(()=>{ ensureHost(); buildBubble(); buildPanel(); ensureSVG(); refreshMatrix(); applyToVideos(true, false); updateRestoreState(); updateBubbleVisibility(); rescanBurst(); }, 50); });
  })();

  window.addEventListener('yt-navigate-finish', () => setTimeout(rearm, 50), true);
  window.addEventListener('yt-page-data-updated', () => setTimeout(rearm, 50), true);
  function rearm(){ ensureHost(); buildBubble(); buildPanel(); ensureSVG(); refreshMatrix(); applyToVideos(true, false); updateRestoreState(); updateBubbleVisibility(); rescanBurst(); }

  // ---------- Hotkeys & menu ----------
  function onKey(e){
    if (e.repeat) return;
    const K = (e.key || '').toUpperCase();
    const hit = (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && K === 'W') ||
      (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && K === 'W');
    if (!hit) return;
    const now = Date.now();
    if (now - lastKeyToggleAt < KEY_TOGGLE_GUARD_MS) return;
    lastKeyToggleAt = now;
    e.preventDefault();
    if (!isPanelVisible()) showPanel(); else hidePanel();
  }
  if (IS_TOP) {
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('keydown', onKey, true);
    try { GM_registerMenuCommand('Show/Hide Video WB Panel (Alt+W)', () => { if (!isPanelVisible()) showPanel(); else hidePanel(); }); } catch{}
  }

  // ---------- Dragging (panel) ----------
  function makeDraggable(box, handle, onDrop){
    let drag=false, sx=0, sy=0, bx=0, by=0;
    handle.addEventListener('mousedown', e=>{ drag=true; sx=e.clientX; sy=e.clientY; const r=box.getBoundingClientRect(); bx=r.left; by=r.top; e.preventDefault(); });
    window.addEventListener('mousemove', e=>{ if(!drag) return; const nx=clamp(bx+(e.clientX-sx),0,innerWidth-box.offsetWidth); const ny=clamp(by+(e.clientY-sy),0,innerHeight-box.offsetHeight); box.style.left=`${nx}px`; box.style.top=`${ny}px`; });
    window.addEventListener('mouseup', ()=>{ if(!drag) return; drag=false; const r=box.getBoundingClientRect(); onDrop(Math.round(r.left),Math.round(r.top)); });
    window.addEventListener('resize', ()=>{ clampPanelIntoViewport(); });
  }

  // ---------- Utils ----------
  function clamp(v,min,max){ return Math.min(max, Math.max(min, v)); }
  function markUserAction() { state.lastUserActionAt = Date.now(); }
  function saveUserAction() {
    markUserAction();
    saveCurrentVideoSnapshot();
    save();
  }
  function save(){
    if (!IS_TOP) return;
    state.rev = (state.rev || 0) + 1;
    lastSyncRev = state.rev;
    lastEffectStamp = effectStamp(state);
    store.set(CONFIG.storageKey, state);
  }

  // ---------- Watchdog ----------
  function startWatchdog(){
    setInterval(()=>{
      if(!document.getElementById('vwb-svg')) ensureSVG();
      updateFullscreenState(false);
      healFilters();
      syncFromStore();
      if (IS_TOP) {
        if(!host || !host.isConnected) { ensureHost(); buildBubble(); buildPanel(); }
        if (state.visible) clampPanelIntoViewport();
        clampBubbleIntoViewport();
        updateBubbleVisibility();
      } else {
        notifyTopFrame(hasAnyVideoLocal());
      }
    }, CONFIG.watchdogMs);
  }

  // ---------- Init ----------
  function init(){
    setupStateSync();
    setupFramePresenceListener();
    setupFullscreenListeners();
    const prunedExpiredSnapshots = IS_TOP ? pruneSnapshots() : false;
    if (IS_TOP && (needsCompareDefaultOffSave || prunedExpiredSnapshots)) save();
    if (IS_TOP) {
      ensureHost();
      buildBubble();
      buildPanel();
    }
    fullscreenActive = isFullscreenActive();
    ensureSVG();
    refreshMatrix();
    if(state.enabled){ startObserver(); applyToVideos(true, false); autoApplySnapshotIfPresent(false); }
    else { clearFilters(); }
    startWatchdog();
    updateRestoreState();
    updateBubbleVisibility();
    if (!IS_TOP) notifyTopFrame(hasAnyVideoLocal(), true);
    if (isYouTube() && isYTWatchOrShorts()) rescanBurst();
  }

  if(document.body) init();
  else {
    const iv = setInterval(()=>{ if(document.body){ clearInterval(iv); init(); } }, 50);
    setTimeout(()=>clearInterval(iv), 7000);
  }
})();
