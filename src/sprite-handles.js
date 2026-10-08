/**
 * sprite-handles.js — Expressions+
 *
 * Custom 4-corner drag & resize handles for #expression-plus-holder.
 * Replaces SillyTavern's dragElement + CSS `resize: both` for that element
 * only. VN/scenario holders still use the stock system.
 *
 * Fixes:
 *  1. All four corners active — even when half the sprite is behind chat UI.
 *  2. Click-through: handles never steal clicks from menus on top.
 *  3. Layout stored as % of viewport — survives windowed <-> fullscreen.
 *  4. Layout preserved across sprite changes (no drift / shrink per message).
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { currentCharacterAvatar } from './state.js';
import { getSettings } from './settings.js';

const HOLDER_ID = 'expression-plus-holder';
const MIN_W_PX = 60;
const MIN_H_PX = 60;

const BLOCKER_SELECTORS = [
    '#sheld', '#chat', '#chat_history', '.chat_scroll',
    '#send_form', '#form_sheld',
    '#left-nav-panel', '#right-nav-panel',
    '#top-bar', '#top-settings-holder',
    '.drawer-content', '.drawer-icon',
    '.popup', '.menu_button',
    '.mes', '.mes_block',
];

const CURSOR_CLASSES = [
    'sxp-cursor-grab', 'sxp-cursor-grabbing',
    'sxp-cursor-nwse', 'sxp-cursor-nesw',
];

const HANDLE_DEFS = [
    { which: 'tl', mode: 'drag',   title: 'Drag to reposition' },
    { which: 'tr', mode: 'drag',   title: 'Drag to reposition' },
    { which: 'bl', mode: 'resize', title: 'Drag to resize' },
    { which: 'br', mode: 'resize', title: 'Drag to resize' },
];

let initialized = false;
let holderEl = null;
let handleEls = [];
let gesture = null;
let hideTimer = null;
let resizeRaf = null;
let lastVW = window.innerWidth;
let lastVH = window.innerHeight;

// ---------------------------------------------------------------------------
// Clamp helpers
// ---------------------------------------------------------------------------

/** Height of SillyTavern's top bar, in pixels. */
function getTopMargin() {
    const val = getComputedStyle(document.documentElement).getPropertyValue('--topBarBlockSize');
    const px = parseFloat(val);
    return Number.isFinite(px) && px > 0 ? px : 55;
}

/**
 * Clamp a sprite rectangle so it stays fully inside the viewport and
 * below the top bar. Size is clamped first, then position.
 */
function clampRect(left, top, width, height) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const topMin = getTopMargin();

    // Size limits
    width  = Math.max(MIN_W_PX, Math.min(vw, width));
    height = Math.max(MIN_H_PX, Math.min(vh - topMin, height));

    // Position limits — keep the sprite fully on screen and below the top bar
    left = Math.max(0, Math.min(vw - width, left));
    top  = Math.max(topMin, Math.min(vh - height, top));

    return { left, top, width, height };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initSpriteHandles() {
    if (initialized) return;
    initialized = true;

    holderEl = document.getElementById(HOLDER_ID);
    if (!holderEl) {
        console.warn('[SXP-Handles] holder not found, retrying in 500ms');
        initialized = false;
        setTimeout(initSpriteHandles, 500);
        return;
    }

    // Take ownership before anyone else caches state.
    holderEl.dataset.sxpManaged = '1';
    holderEl.style.resize = 'none';

    // Inject corner handles.
    handleEls = HANDLE_DEFS.map(def => {
        const el = document.createElement('div');
        el.className = `sxp-handle sxp-handle-${def.which} sxp-handle-${def.mode}`;
        el.dataset.which = def.which;
        el.dataset.mode = def.mode;
        el.title = def.title;
        holderEl.appendChild(el);
        return el;
    });

    // Document-level listeners in CAPTURE phase so we intercept before any
    // other handler on the page (including SillyTavern's legacy drag code
    // if it ever gets attached elsewhere).
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('mouseleave', onMouseLeave, true);

    // Reapply on chat change (per-character layouts).
    import('../../../../../script.js').then(mod => {
        const { eventSource, event_types } = mod;
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(applyStoredLayout, 200);
        });
    }).catch(() => {});

    setTimeout(applyStoredLayout, 300);
    console.log('[SXP-Handles] initialized');

    // Track viewport size here, where initSpriteHandles owns the variables.
    lastVW = window.innerWidth;
    lastVH = window.innerHeight;

    // Listen to every possible viewport-change event.
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', onWindowResize);
    document.addEventListener('fullscreenchange', onWindowResize);
    document.addEventListener('webkitfullscreenchange', onWindowResize);

    // Polling fallback: catches changes that don't fire any event.
    setInterval(() => {
        if (!holderEl || holderEl.style.display === 'none') return;
        if (gesture) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (vw !== lastVW || vh !== lastVH) {
            console.log('[SXP-Handles] viewport changed (poll)', lastVW + 'x' + lastVH, '->', vw + 'x' + vh);
            onWindowResize();
        }
    }, 300);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function getLayoutMap() {
    const settings = getSettings();
    if (!settings.spriteLayoutPercent) settings.spriteLayoutPercent = {};
    return settings.spriteLayoutPercent;
}

function saveLayout() {
    if (!holderEl || !currentCharacterAvatar) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = holderEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    getLayoutMap()[currentCharacterAvatar] = {
        left:   rect.left / vw,
        top:    rect.top / vh,
        width:  rect.width / vw,
        height: rect.height / vh,
        // Preserve box shape across viewport aspect-ratio changes
        aspect: rect.width / rect.height,
    };
    saveSettingsDebounced();
}

function applyStoredLayout() {
    if (!holderEl) return;
    const layout = currentCharacterAvatar
        ? getLayoutMap()[currentCharacterAvatar]
        : null;

    console.log('[SXP-Handles] applyStoredLayout', {
        avatar: currentCharacterAvatar,
        hasLayout: !!layout,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        layout,
    });

    if (!layout) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const topMin = getTopMargin();
    const availH = vh - topMin;

    // Preferred model: height scales with viewport height, width derived
    // from aspect. This is uniform across aspect-ratio changes.
    let height;
    let width;
    if (layout.aspect && layout.aspect > 0) {
        height = layout.height * vh;
        width  = height * layout.aspect;
    } else {
        // Legacy data with no aspect — fall back to independent fractions.
        width  = layout.width * vw;
        height = layout.height * vh;
    }

    // Uniformly scale DOWN only if it doesn't fit. Never scale UP beyond
    // the stored size — that respects the user's intent.
    let scale = 1;
    if (width > vw)   scale = Math.min(scale, vw / width);
    if (height > availH) scale = Math.min(scale, availH / height);
    width  *= scale;
    height *= scale;

    // Minimums (after scaling, not before)
    width  = Math.max(MIN_W_PX, width);
    height = Math.max(MIN_H_PX, height);

    // Position: percentages of viewport, then clamp
    let left = layout.left * vw;
    let top  = layout.top  * vh;
    left = Math.max(0, Math.min(vw - width, left));
    top  = Math.max(topMin, Math.min(vh - height, top));

    console.log('[SXP-Handles] computed rect', {
        left: Math.round(left), top: Math.round(top),
        width: Math.round(width), height: Math.round(height),
        scale: scale.toFixed(3),
    });

    holderEl.style.position = 'absolute';
    holderEl.style.left     = left   + 'px';
    holderEl.style.top      = top    + 'px';
    holderEl.style.width    = width  + 'px';
    holderEl.style.height   = height + 'px';
    holderEl.style.right    = 'auto';
    holderEl.style.bottom   = 'auto';
    holderEl.style.minWidth  = '0';
    holderEl.style.minHeight = '0';
    holderEl.style.maxWidth  = 'none';
    holderEl.style.maxHeight = 'none';
    holderEl.dataset.sxpManaged = '1';
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

function isBlocker(el) {
    if (!el || el.nodeType !== 1) return false;
    for (const sel of BLOCKER_SELECTORS) {
        try {
            if (el.matches(sel)) return true;
            if (el.closest && el.closest(sel)) return true;
        } catch {}
    }
    return false;
}

function isSpriteTopmost(x, y) {
    if (!holderEl || holderEl.style.display === 'none') return false;
    const stack = document.elementsFromPoint(x, y);
    if (!stack || stack.length === 0) return false;

    const idx = stack.findIndex(el => el === holderEl || holderEl.contains(el));
    if (idx === -1) return false;
    if (idx === 0) return true;

    for (let i = 0; i < idx; i++) {
        const el = stack[i];
        if (!el || el.nodeType !== 1) continue;
        if (el === holderEl || holderEl.contains(el)) continue;

        const st = getComputedStyle(el);
        if (st.pointerEvents === 'none') continue;
        if (isBlocker(el)) return false;

        if (el.matches?.('button, a, input, textarea, select, [role="button"], [role="menuitem"]')) {
            return false;
        }

        const bg = st.backgroundColor || '';
        const m = bg.match(/^rgba?\(([^)]+)\)$/);
        if (m) {
            const p = m[1].split(',').map(s => parseFloat(s.trim()));
            const a = p.length === 4 ? p[3] : 1;
            if (a > 0.15) return false;
        } else if (bg && bg !== 'transparent') {
            return false;
        }

        const bgi = st.backgroundImage;
        if (bgi && bgi !== 'none') return false;
    }
    return true;
}

function findHandleAt(x, y) {
    for (const h of handleEls) {
        if (h.style.display === 'none') continue;
        const r = h.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return h;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function clearCursor() {
    document.body.classList.remove(...CURSOR_CLASSES);
}

function setCursorForHandle(handle) {
    clearCursor();
    if (!handle) return;
    if (handle.dataset.mode === 'drag') {
        document.body.classList.add('sxp-cursor-grab');
    } else if (handle.dataset.which === 'br') {
        document.body.classList.add('sxp-cursor-nwse');
    } else if (handle.dataset.which === 'bl') {
        document.body.classList.add('sxp-cursor-nesw');
    }
}

// ---------------------------------------------------------------------------
// Handle visibility
// ---------------------------------------------------------------------------

function showHandles() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    for (const h of handleEls) h.style.display = 'flex';
}

function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        if (gesture) return;
        for (const h of handleEls) h.style.display = 'none';
    }, 600);
}

// ---------------------------------------------------------------------------
// Gesture handling
// ---------------------------------------------------------------------------

function onPointerDown(e) {
    if (e.button !== 0 || gesture) return;
    if (!holderEl || holderEl.style.display === 'none') return;

    // Cheap bounding-box reject before doing any hit-testing.
    const rect = holderEl.getBoundingClientRect();
    if (e.clientX < rect.left - 30 || e.clientX > rect.right  + 30 ||
        e.clientY < rect.top  - 30 || e.clientY > rect.bottom + 30) {
        return;
    }

    const handle = findHandleAt(e.clientX, e.clientY);
    if (handle) {
        if (!isSpriteTopmost(e.clientX, e.clientY)) return;
        beginGesture(e, handle.dataset.mode, handle.dataset.which, rect);
        return;
    }

    // Click anywhere on the exposed sprite → whole-element drag.
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) return;
    if (!isSpriteTopmost(e.clientX, e.clientY)) return;
    beginGesture(e, 'drag', null, rect);
}

function beginGesture(e, mode, which, rect) {
    gesture = {
        mode, which,
        startX: e.clientX,
        startY: e.clientY,
        startRect: {
            left: rect.left, top: rect.top,
            width: rect.width, height: rect.height,
        },
        pointerId: e.pointerId,
    };
    holderEl.style.willChange = 'left, top, width, height';
    clearCursor();
    document.body.classList.add(mode === 'drag' ? 'sxp-cursor-grabbing' : 'sxp-cursor-nwse');
    showHandles();
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
}

function onPointerMove(e) {
    if (!gesture) { handleHover(e); return; }
    if (e.pointerId !== gesture.pointerId) return;
    e.preventDefault();

    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;
    const sr = gesture.startRect;

    let left = sr.left, top = sr.top, width = sr.width, height = sr.height;

    if (gesture.mode === 'drag') {
        left = sr.left + dx;
        top  = sr.top  + dy;
    } else {
        switch (gesture.which) {
            case 'br':
                width  = sr.width  + dx;
                height = sr.height + dy;
                break;
            case 'bl':
                width  = sr.width  - dx;
                left   = sr.left   + dx;
                height = sr.height + dy;
                break;
            case 'tr':
                width  = sr.width  + dx;
                height = sr.height - dy;
                top    = sr.top    + dy;
                break;
            case 'tl':
                width  = sr.width  - dx;
                left   = sr.left   + dx;
                height = sr.height - dy;
                top    = sr.top    + dy;
                break;
        }
    }

    const clamped = clampRect(left, top, width, height);

    holderEl.style.left   = clamped.left   + 'px';
    holderEl.style.top    = clamped.top    + 'px';
    holderEl.style.width  = clamped.width  + 'px';
    holderEl.style.height = clamped.height + 'px';
}

function onPointerUp(e) {
    if (!gesture) return;
    if (e.pointerId !== gesture.pointerId) return;

    gesture = null;
    holderEl.style.willChange = '';
    clearCursor();
    saveLayout();
}

function onMouseLeave() {
    scheduleHide();
    clearCursor();
}

function handleHover(e) {
    if (!holderEl || holderEl.style.display === 'none') {
        clearCursor();
        return;
    }
    const rect = holderEl.getBoundingClientRect();
    const inside =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top  && e.clientY <= rect.bottom;

    if (inside && isSpriteTopmost(e.clientX, e.clientY)) {
        showHandles();
        setCursorForHandle(findHandleAt(e.clientX, e.clientY));
    } else {
        scheduleHide();
        clearCursor();
    }
}

function onWindowResize() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        if (gesture) return;

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        console.log('[SXP-Handles] onWindowResize', { vw, vh, prev: lastVW + 'x' + lastVH });

        lastVW = vw;
        lastVH = vh;

        applyStoredLayout();
    });
}