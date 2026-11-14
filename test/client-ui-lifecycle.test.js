const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'public', 'app.js');
const { loadClientBundleSource } = require('./helpers/client-source');
const appCode = loadClientBundleSource();
function extractBlock(source, startRegex, description) {
    const startMatch = source.match(startRegex);
    assert(startMatch, `Could not find start of ${description}`);
    const startIdx = startMatch.index;
    const braceOpenIdx = source.indexOf('{', startIdx);
    assert(braceOpenIdx !== -1, `Could not find opening brace for ${description}`);
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;
    for (let i = braceOpenIdx; i < source.length; i++) {
        const ch = source[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (inSingle) {
            if (ch === "'") inSingle = false;
            continue;
        }
        if (inDouble) {
            if (ch === '"') inDouble = false;
            continue;
        }
        if (inTemplate) {
            if (ch === '`') inTemplate = false;
            continue;
        }
        if (ch === "'") { inSingle = true; continue; }
        if (ch === '"') { inDouble = true; continue; }
        if (ch === '`') { inTemplate = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(startIdx, i + 1);
            }
        }
    }
    throw new Error(`Unbalanced braces while extracting ${description}`);
}

function createMockClassList(el) {
    const set = new Set();
    return {
        add(...cls) { cls.forEach((c) => set.add(c)); },
        remove(...cls) { cls.forEach((c) => set.delete(c)); },
        contains(c) { return set.has(c); },
        toggle(c, force) {
            if (force === undefined) {
                if (set.has(c)) { set.delete(c); return false; }
                set.add(c); return true;
            }
            if (force) set.add(c); else set.delete(c);
            return !!force;
        },
        toArray() { return Array.from(set); }
    };
}

function matchesSingleSelector(el, sel) {
    if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return el.classList.contains(cls) || el.className.split(/\s+/).includes(cls);
    }
    const attrMatch = sel.match(/^([a-zA-Z0-9_-]+)\[type="([^"]+)"\]$/);
    if (attrMatch) {
        return el.tagName === attrMatch[1].toUpperCase() && el.type === attrMatch[2];
    }
    return el.tagName === sel.toUpperCase();
}

function matchesSelectorParts(el, parts) {
    if (!matchesSingleSelector(el, parts[parts.length - 1])) return false;
    let idx = parts.length - 2;
    let cur = el.parentNode;
    while (idx >= 0 && cur) {
        if (matchesSingleSelector(cur, parts[idx])) idx--;
        cur = cur.parentNode;
    }
    return idx < 0;
}

function createMockElement(tagName, options = {}) {
    const listeners = new Map();
    const attrs = new Map();
    const el = {
        tagName: tagName.toUpperCase(),
        id: '',
        className: '',
        innerHTML: '',
        textContent: '',
        title: '',
        type: '',
        min: '',
        max: '',
        step: '',
        value: '',
        muted: false,
        volume: 1,
        autoplay: false,
        playsInline: false,
        srcObject: null,
        dataset: {},
        style: {},
        children: [],
        parentNode: null,
        classList: null,
        playCalls: 0,
        playImpl: options.playImpl || null,
        setAttribute(k, v) {
            attrs.set(String(k), String(v));
            if (k === 'muted') this.muted = true;
        },
        removeAttribute(k) {
            attrs.delete(String(k));
            if (k === 'muted') this.muted = false;
        },
        hasAttribute(k) { return attrs.has(String(k)); },
        getAttribute(k) { return attrs.get(String(k)) ?? null; },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        remove() {
            if (this.parentNode) {
                this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
                this.parentNode = null;
            }
        },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = listeners.get(type);
            if (!arr) return;
            listeners.set(type, arr.filter((f) => f !== fn));
        },
        listenerCount(type) {
            return (listeners.get(type) || []).length;
        },
        dispatchEvent(evt) {
            const event = typeof evt === 'string' ? { type: evt } : { ...evt };
            let stopped = false;
            event.target = event.target || this;
            event.stopPropagation = () => { stopped = true; };
            event.preventDefault = () => {};
            const list = [...(listeners.get(event.type) || [])];
            for (const fn of list) fn.call(this, event);
            if (!stopped && this.parentNode) {
                this.parentNode.dispatchEvent(event);
            }
        },
        play() {
            this.playCalls++;
            if (this.playImpl) return this.playImpl(this);
            return Promise.resolve();
        },
        querySelector(selector) {
            const parts = selector.trim().split(/\s+/);
            const walk = (node) => {
                for (const child of node.children) {
                    if (matchesSelectorParts(child, parts)) return child;
                    const nested = walk(child);
                    if (nested) return nested;
                }
                return null;
            };
            return walk(this);
        }
    };
    el.classList = createMockClassList(el);
    return el;
}

function createHarness(overrides = {}) {
    const toasts = [];
    const clipboardWrites = [];
    const createdVideos = [];
    let nextTimerId = 1;
    const scheduledTimeouts = new Map();
    const scheduledIntervals = new Map();

    const btnCopyLink = createMockElement('button');
    btnCopyLink.innerHTML = '<span>Copiar Link</span>';

    const statsModal = createMockElement('div');
    statsModal.classList.add('hidden');
    const statsGrid = createMockElement('div');

    const sandbox = {
        console,
        Promise,
        Math,
        Date,
        Set,
        Map,
        ICON_VOLUME: '<svg>vol</svg>',
        ICON_MUTE: '<svg>mute</svg>',
        localStream: null,
        peers: overrides.peers || new Map(),
        roomId: overrides.roomId !== undefined ? overrides.roomId : 'sala-123',
        currentRoomPassword: overrides.currentRoomPassword !== undefined ? overrides.currentRoomPassword : '',
        contentHintMode: 'motion',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        statsModal,
        statsGrid,
        btnCopyLink,
        showToast: (msg, type) => toasts.push({ msg, type }),
        evaluatePeerQoS: overrides.evaluatePeerQoS || (async () => {}),
        document: {
            getElementById() { return null; },
            createElement(tag) {
                const el = createMockElement(tag, {
                    playImpl: tag.toLowerCase() === 'video' ? overrides.videoPlayImpl : null
                });
                if (tag.toLowerCase() === 'video') createdVideos.push(el);
                return el;
            }
        },
        navigator: {
            userAgent: overrides.userAgent || 'Mozilla/5.0',
            clipboard: {
                writeText: async (txt) => { clipboardWrites.push(txt); }
            }
        },
        window: {
            location: {
                origin: 'https://stream.example.com',
                pathname: '/'
            }
        },
        setTimeout: (fn, ms) => {
            const id = nextTimerId++;
            scheduledTimeouts.set(id, { id, fn, ms, cleared: false });
            return id;
        },
        clearTimeout: (id) => {
            if (scheduledTimeouts.has(id)) {
                scheduledTimeouts.get(id).cleared = true;
                scheduledTimeouts.delete(id);
            }
        },
        setInterval: (fn, ms) => {
            const id = nextTimerId++;
            scheduledIntervals.set(id, { id, fn, ms });
            return id;
        },
        clearInterval: (id) => {
            scheduledIntervals.delete(id);
        }
    };

    const qualityVarsMatch = appCode.match(/let qualityMonitorInterval[\s\S]*?isQualityMonitorRunning\s*=\s*false;/);
    assert(qualityVarsMatch, 'Could not find quality monitor state variables');
    const startQualityMonitorCode = extractBlock(appCode, /function startQualityMonitor\s*\(/, 'startQualityMonitor');
    const stopQualityMonitorCode = extractBlock(appCode, /function stopQualityMonitor\s*\(/, 'stopQualityMonitor');

    const statsBlock = appCode.match(/let statsUpdateInterval[\s\S]*?function closeStatsModal[\s\S]*?\n\}/);
    assert(statsBlock, 'Could not find stats modal block');

    const startTilePlaybackCode = extractBlock(appCode, /function startTilePlayback\s*\(/, 'startTilePlayback');
    const createStreamTileCode = extractBlock(appCode, /function createStreamTile\s*\(/, 'createStreamTile');
    const showTapCode = extractBlock(appCode, /function showTapToUnmuteBadge\s*\(/, 'showTapToUnmuteBadge');
    const copyLinkMatch = appCode.match(/\/\/ Copy Invite Link\r?\nconst defaultCopyLinkHtml[\s\S]*?\n\}/);
    assert(copyLinkMatch, 'Could not find Copy Invite Link block');

    const combined = [
        qualityVarsMatch[0],
        startQualityMonitorCode,
        stopQualityMonitorCode,
        statsBlock[0],
        startTilePlaybackCode,
        createStreamTileCode,
        showTapCode,
        copyLinkMatch[0]
    ].join('\n\n');

    vm.runInNewContext(combined, sandbox, { filename: 'public/app.js' });

    return {
        sandbox,
        toasts,
        clipboardWrites,
        createdVideos,
        btnCopyLink,
        statsModal,
        statsGrid,
        scheduledTimeouts,
        scheduledIntervals,
        flushTimeouts() {
            const entries = Array.from(scheduledTimeouts.values());
            for (const entry of entries) {
                scheduledTimeouts.delete(entry.id);
                entry.fn();
            }
        }
    };
}

async function runTests() {
    // T1: showTapToUnmuteBadge removes listener from both badge and tile, syncs controls, and cleans up on manual unmute
    {
        const h = createHarness();
        const tile = h.sandbox.createStreamTile('tile-1', { id: 'stream-1' }, 'Peer 1', false);
        const video = tile.querySelector('video');
        video.muted = true;
        video.volume = 0;
        video.setAttribute('muted', '');

        h.sandbox.showTapToUnmuteBadge(tile, video);
        const badge = tile.querySelector('.tap-unmute-badge');
        assert(badge, 'T1: badge should be appended to tile');
        assert.strictEqual(tile.listenerCount('click'), 1, 'T1: tile should have 1 unmute click listener');

        // Clicking badge unmutes, syncs slider & icon, restores volume, and removes tile listener too
        badge.dispatchEvent({ type: 'click' });
        assert.strictEqual(video.muted, false, 'T1: video.muted should be false after clicking badge');
        assert.strictEqual(video.hasAttribute('muted'), false, 'T1: muted attribute should be removed');
        assert.strictEqual(video.volume, 1, 'T1: zero volume should be restored to 1');
        assert.strictEqual(tile.listenerCount('click'), 0, 'T1: tile click listener must be removed after badge click');
        assert.strictEqual(tile.querySelector('.tap-unmute-badge'), null, 'T1: badge must be removed');

        const slider = tile.querySelector('.tile-controls-overlay input[type="range"]');
        const muteBtn = tile.querySelector('.tile-controls-overlay .btn-icon');
        assert.strictEqual(String(slider.value), '1', 'T1: slider should reflect unmuted volume');
        assert.strictEqual(muteBtn.innerHTML, '<i class="fa-solid fa-volume-high"></i>', 'T1: mute button icon should reflect unmuted state');

        // Re-muting via muteBtn and clicking tile must NOT re-unmute (no leaked { once: true } listener)
        muteBtn.dispatchEvent({ type: 'click' });
        assert.strictEqual(video.muted, true, 'T1: muteBtn click should mute video again');
        tile.dispatchEvent({ type: 'click' });
        assert.strictEqual(video.muted, true, 'T1: clicking tile after badge unmute must not unmute again');

        // Also verify unmuting via muteBtn/slider cleans up an active tap-to-unmute badge & listener
        h.sandbox.showTapToUnmuteBadge(tile, video);
        assert(tile.querySelector('.tap-unmute-badge'), 'T1: second badge created');
        assert.strictEqual(tile.listenerCount('click'), 1, 'T1: tile listener attached');
        muteBtn.dispatchEvent({ type: 'click' });
        assert.strictEqual(video.muted, false, 'T1: muteBtn toggles back to unmuted');
        assert.strictEqual(tile.querySelector('.tap-unmute-badge'), null, 'T1: muteBtn unmute removes tap badge');
        assert.strictEqual(tile.listenerCount('click'), 0, 'T1: muteBtn unmute removes tile click listener');
    }

    // T2: createStreamTile defers video.play() until startTilePlayback after DOM append, with autoplay fallback
    {
        let attempt = 0;
        const h = createHarness({
            videoPlayImpl: () => {
                attempt++;
                if (attempt === 1) return Promise.reject(new Error('NotAllowedError'));
                return Promise.resolve();
            }
        });
        const tile = h.sandbox.createStreamTile('tile-2', { id: 'stream-2' }, 'Peer 2', false);
        const video = tile.querySelector('video');
        assert.strictEqual(video.playCalls, 0, 'T2: createStreamTile must NOT call video.play() on detached DOM');

        // Defensive no-op on lightweight mock objects without querySelector
        h.sandbox.startTilePlayback({ id: 'mock-tile' });

        h.sandbox.startTilePlayback(tile, video);
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(video.playCalls, 2, 'T2: startTilePlayback should retry muted play() after rejection');
        assert.strictEqual(video.muted, true, 'T2: fallback should mute video');
        assert.strictEqual(video.hasAttribute('muted'), true, 'T2: fallback should set muted attribute');
        assert(tile.querySelector('.tap-unmute-badge'), 'T2: fallback should show tap-to-unmute badge');
    }

    // T3: btnCopyLink guards empty roomId and debounces rapid clicks preserving defaultCopyLinkHtml
    {
        const hEmpty = createHarness({ roomId: null });
        hEmpty.btnCopyLink.dispatchEvent({ type: 'click' });
        assert.strictEqual(hEmpty.clipboardWrites.length, 0, 'T3: must not copy when roomId is missing');
        assert.strictEqual(hEmpty.toasts.length, 1, 'T3: must warn when roomId is missing');
        assert.strictEqual(hEmpty.toasts[0].type, 'warning', 'T3: toast type should be warning');

        const h = createHarness({ roomId: 'room-xyz', currentRoomPassword: 'secret' });
        const originalHtml = h.btnCopyLink.innerHTML;
        h.btnCopyLink.dispatchEvent({ type: 'click' });
        await Promise.resolve();
        assert(h.btnCopyLink.innerHTML.includes('Link Copiado!'), 'T3: first click updates label');
        assert.strictEqual(h.scheduledTimeouts.size, 1, 'T3: first timer scheduled');

        // Second rapid click while label is already 'Link Copiado!' must cancel previous timer and still restore originalHtml
        h.btnCopyLink.dispatchEvent({ type: 'click' });
        await Promise.resolve();
        assert.strictEqual(h.clipboardWrites.length, 2, 'T3: both clicks copy invite URL');
        assert.strictEqual(h.scheduledTimeouts.size, 1, 'T3: only 1 active reset timer after rapid click');

        h.flushTimeouts();
        assert.strictEqual(h.btnCopyLink.innerHTML, originalHtml, 'T3: timer must restore original button HTML, not Link Copiado!');
    }

    // T4: Anti-reentrancy guards on startQualityMonitor / stopQualityMonitor and openStatsModal / closeStatsModal
    {
        let resolveQoS;
        let qosCallCount = 0;
        let resolveStats;
        let statsCallCount = 0;

        const h = createHarness({
            evaluatePeerQoS: () => {
                qosCallCount++;
                return new Promise((r) => { resolveQoS = r; });
            },
            peers: new Map([
                ['peer-1', {
                    userName: 'Alice',
                    pc: {
                        connectionState: 'connected',
                        getStats: () => {
                            statsCallCount++;
                            return new Promise((r) => {
                                resolveStats = () => r(new Map([
                                    ['cand-pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.02 }],
                                    ['in-v', { type: 'inbound-rtp', kind: 'video', frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, packetsLost: 0, bytesReceived: 1024 }]
                                ]));
                            });
                        }
                    }
                }]
            ])
        });

        h.sandbox.startQualityMonitor();
        assert.strictEqual(h.scheduledIntervals.size, 1, 'T4: quality monitor interval registered');
        const qEntry = Array.from(h.scheduledIntervals.values())[0];

        const p1 = qEntry.fn();
        const p2 = qEntry.fn(); // should be skipped while p1 is pending
        assert.strictEqual(qosCallCount, 1, 'T4: concurrent quality monitor tick must be skipped');
        resolveQoS();
        await p1;
        await p2;

        const p3 = qEntry.fn();
        assert.strictEqual(qosCallCount, 2, 'T4: quality monitor runs again after previous promise settles');
        resolveQoS();
        await p3;
        h.sandbox.stopQualityMonitor();
        assert.strictEqual(h.scheduledIntervals.size, 0, 'T4: stopQualityMonitor clears interval');

        h.sandbox.openStatsModal();
        assert.strictEqual(statsCallCount, 1, 'T4: openStatsModal runs initial updateStatsDisplay');
        // Overlap another updateStatsDisplay while getStats() is still pending
        const overlapPromise = h.sandbox.updateStatsDisplay();
        assert.strictEqual(statsCallCount, 1, 'T4: overlapping updateStatsDisplay must not call getStats()');
        await overlapPromise;

        // Close modal while stats request is still in-flight, then resolve stale stats
        h.sandbox.closeStatsModal();
        assert.strictEqual(h.scheduledIntervals.size, 0, 'T4: closeStatsModal clears statsUpdateInterval');
        resolveStats();
        await new Promise((r) => setTimeout(r, 10));

        // Re-open modal: generation incremented and guard reset cleanly
        h.sandbox.openStatsModal();
        assert.strictEqual(statsCallCount, 2, 'T4: reopening stats modal runs fresh getStats()');
        resolveStats();
        await new Promise((r) => setTimeout(r, 10));
        h.sandbox.closeStatsModal();
    }

    console.log('ALL CLIENT UI LIFECYCLE TESTS PASSED (T1-T4)');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
