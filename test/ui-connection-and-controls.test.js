'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'public/style.css'), 'utf8');

test('Socket connection lifecycle toasts, connect_error de-duplication, and offline joinRoom queuing', async () => {
    const appMod = await import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?uiconn=${Date.now()}`);
    const toastContainer = createMockElement('div', { id: 'toastContainer' });
    const fakeDoc = createMockDocument({ toastContainer }, { createElement: (tag) => createMockElement(tag) });
    const socketHandlers = {};
    const emitted = [];
    const socket = {
        id: 'sock-test-1',
        connected: false,
        on(ev, fn) { socketHandlers[ev] = fn; },
        emit(ev, payload) { emitted.push({ event: ev, payload }); },
        disconnect() {}
    };

    const app = appMod.initApp({
        windowObj: {
            location: { protocol: 'http:', origin: 'http://localhost:3000', pathname: '/', search: '', hash: '' },
            addEventListener() {},
            removeEventListener() {},
            matchMedia: () => ({ matches: false })
        },
        documentObj: fakeDoc,
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => socket,
        serverUrl: 'http://localhost:3000'
    });

    const origDocument = global.document;
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const toastTimers = new Set();
    global.document = fakeDoc;
    global.setTimeout = (fn, ms, ...args) => {
        if (ms >= 300) {
            const id = { cancelled: false, fn: () => fn(...args) };
            toastTimers.add(id);
            return id;
        }
        return origSetTimeout(fn, ms, ...args);
    };
    global.clearTimeout = (id) => {
        if (id && typeof id === 'object') {
            id.cancelled = true;
            toastTimers.delete(id);
            return;
        }
        return origClearTimeout(id);
    };

    try {
        // Offline joinRoom queues pendingRoomJoin without emitting
        app.roomModalCtrl.joinRoom('minha-sala', '1234', 'Pedro');
        assert.ok(app.state.pendingRoomJoin && app.state.pendingRoomJoin.roomId === 'minha-sala');
        assert.equal(emitted.filter((e) => e.event === 'join-room').length, 0);

        socketHandlers.connect_error(new Error('timeout'));
        socketHandlers.connect_error(new Error('timeout 2'));
        const errorToasts = toastContainer.children.filter((t) => t.className.includes('toast-error'));
        assert.equal(errorToasts.length, 1, 'connect_error must not spam toasts');

        socket.connected = true;
        socketHandlers.connect();
        assert.equal(emitted.filter((e) => e.event === 'join-room').length, 1, 'Pending room must emit on connect');
        assert.ok(toastContainer.children[toastContainer.children.length - 1].className.includes('toast-success'));

        const countBeforeClientDisconnect = toastContainer.children.length;
        socketHandlers.disconnect('io client disconnect');
        assert.equal(toastContainer.children.length, countBeforeClientDisconnect, 'Intentional disconnect must not warn');

        socketHandlers.disconnect('transport close');
        assert.ok(toastContainer.children[toastContainer.children.length - 1].className.includes('toast-warning'));

        socketHandlers.connect_error(new Error('retry'));
        socketHandlers.connect();
        assert.ok(toastContainer.children[toastContainer.children.length - 1].className.includes('toast-success'));
    } finally {
        app.teardownClientSession();
        toastTimers.clear();
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
        global.document = origDocument;
    }
});

test('Volume slider remembers non-zero volume on mute/unmute, falls back to 1, and slider click does not trigger tap-to-unmute', async () => {
    const [{ createStreamGridController }, { enterPseudoFullscreen, showTapToUnmuteBadge }] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/stream-grid.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/tile-dom.js')).href)
    ]);

    const doc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    const grid = createStreamGridController({
        state: {},
        dom: {},
        documentObj: doc,
        navigatorObj: { userAgent: 'Mozilla/5.0' }
    });

    const tile = grid.createStreamTile('peer-1', { id: 's-1' }, 'Alice', false);
    const video = tile.querySelector('video');
    const overlay = tile.querySelector('.tile-controls-overlay');
    const muteBtn = overlay.children.find((c) => c.tagName === 'BUTTON');
    const slider = overlay.children.find((c) => c.tagName === 'INPUT');

    assert.equal(video.muted, false);
    assert.equal(slider.value, '1');
    assert.ok(muteBtn.innerHTML.includes('fa-volume-high'));

    // Slider to 0.35 -> mute -> unmute restores 0.35
    slider.value = '0.35';
    slider.dispatchEvent({ type: 'input', target: slider });
    assert.equal(video.volume, 0.35);

    muteBtn.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, true);
    assert.equal(slider.value, '0');

    muteBtn.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, false);
    assert.equal(video.volume, 0.35);
    assert.equal(slider.value, '0.35');

    // Fresh tile dragged to 0 -> unmute falls back to 1
    const freshTile = grid.createStreamTile('peer-fresh', { id: 's-fresh' }, 'Bob', false);
    const freshVideo = freshTile.querySelector('video');
    const freshOverlay = freshTile.querySelector('.tile-controls-overlay');
    const freshMuteBtn = freshOverlay.children.find((c) => c.tagName === 'BUTTON');
    const freshSlider = freshOverlay.children.find((c) => c.tagName === 'INPUT');

    freshSlider.value = '0';
    freshSlider.dispatchEvent({ type: 'input', target: freshSlider });
    assert.equal(freshVideo.muted, true);

    freshMuteBtn.dispatchEvent({ type: 'click' });
    assert.equal(freshVideo.muted, false);
    assert.equal(freshVideo.volume, 1);
    assert.equal(freshSlider.value, '1');

    // enterPseudoFullscreen aria-label
    enterPseudoFullscreen(tile, doc);
    const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
    assert.equal(exitBtn.getAttribute('aria-label'), 'Sair da Tela Cheia');

    // Slider click inside tap-to-unmute tile must NOT bubble up to unmute video
    const tapTile = grid.createStreamTile('peer-slider', { id: 's-slider' }, 'Carol', false);
    const tapVideo = tapTile.querySelector('video');
    const tapSlider = tapTile.querySelector('.tile-controls-overlay').children.find((c) => c.tagName === 'INPUT');
    tapVideo.muted = true;
    tapVideo.volume = 0;
    tapSlider.value = '0';
    showTapToUnmuteBadge(tapTile, tapVideo, doc);
    assert.ok(tapTile.querySelector('.tap-unmute-badge'));

    tapSlider.dispatchEvent({ type: 'click' });
    assert.equal(tapVideo.muted, true);
    assert.equal(tapVideo.volume, 0);
});

test('style.css keeps consistent dark overlay contrast on .tile-controls-overlay .btn-icon', () => {
    const baseMatch = styleCss.match(/\.tile-controls-overlay\s+\.btn-icon\s*\{[\s\S]*?\}/);
    const hoverMatch = styleCss.match(/\.tile-controls-overlay\s+\.btn-icon:hover\s*\{[\s\S]*?\}/);
    assert(baseMatch, 'Missing .tile-controls-overlay .btn-icon rule');
    assert(hoverMatch, 'Missing .tile-controls-overlay .btn-icon:hover rule');
    assert(
        baseMatch[0].includes('rgba(255, 255, 255, 0.1)') &&
        baseMatch[0].includes('color: #f8fafc') &&
        !baseMatch[0].includes('--btn-secondary-bg')
    );
    assert(hoverMatch[0].includes('rgba(255, 255, 255, 0.2)') && hoverMatch[0].includes('color: #ffffff'));
});

test('Tile PiP & Spotlight: per-tile PiP switching, spotlight toggle/transfer/auto-clear, and Escape clears spotlight', async () => {
    const { createStreamGridController } = await import(
        pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/stream-grid.js')).href
    );
    const { initApp } = await import(
        `${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?spotlight=${Date.now()}`
    );

    const streamGrid = createMockElement('div', { id: 'streamGrid', className: 'stream-grid' });
    const emptyGridPlaceholder = createMockElement('div', { id: 'emptyGridPlaceholder' });
    const activeStreamsText = createMockElement('span', { id: 'activeStreamsText' });
    const doc = createMockDocument({ streamGrid, emptyGridPlaceholder, activeStreamsText }, {
        createElement: (tag) => createMockElement(tag)
    });
    doc.pictureInPictureEnabled = true;
    doc.pictureInPictureElement = null;
    let exitCount = 0;
    doc.exitPictureInPicture = async () => {
        exitCount += 1;
        doc.pictureInPictureElement = null;
    };

    const grid = createStreamGridController({
        state: { localStream: null, roomId: 'sala-spot', currentRoomPassword: '' },
        dom: { streamGrid, emptyGridPlaceholder, activeStreamsText },
        documentObj: doc,
        navigatorObj: { userAgent: 'Mozilla/5.0' }
    });

    const tileA = grid.createStreamTile('peer-a', { id: 's-a' }, 'Alice', false);
    const tileB = grid.createStreamTile('peer-b', { id: 's-b' }, 'Bob', false);
    streamGrid.appendChild(tileA);
    streamGrid.appendChild(tileB);

    const videoA = tileA.querySelector('video');
    const videoB = tileB.querySelector('video');
    videoA.requestPictureInPicture = async () => { doc.pictureInPictureElement = videoA; };
    videoB.requestPictureInPicture = async () => { doc.pictureInPictureElement = videoB; };

    const pipBtnA = tileA.querySelector('.btn-tile-pip');
    const pipBtnB = tileB.querySelector('.btn-tile-pip');
    assert.ok(pipBtnA && pipBtnB);

    pipBtnA.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(doc.pictureInPictureElement, videoA);

    pipBtnB.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(doc.pictureInPictureElement, videoB);

    pipBtnB.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(exitCount, 1);
    assert.equal(doc.pictureInPictureElement, null);

    // Spotlight toggle, transfer to another tile, and auto-clear on removal
    const spotBtnA = tileA.querySelector('.btn-tile-spotlight');
    const spotBtnB = tileB.querySelector('.btn-tile-spotlight');
    assert.equal(spotBtnA.getAttribute('aria-pressed'), 'false');

    spotBtnA.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    assert.equal(streamGrid.classList.contains('is-spotlight-mode'), true);
    assert.equal(streamGrid.dataset.spotlightPeerId, 'peer-a');
    assert.equal(tileA.classList.contains('is-spotlight'), true);
    assert.equal(spotBtnA.getAttribute('aria-pressed'), 'true');

    spotBtnB.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    assert.equal(streamGrid.dataset.spotlightPeerId, 'peer-b');
    assert.equal(tileA.classList.contains('is-spotlight'), false);
    assert.equal(spotBtnA.getAttribute('aria-pressed'), 'false');
    assert.equal(tileB.classList.contains('is-spotlight'), true);
    assert.equal(spotBtnB.getAttribute('aria-pressed'), 'true');

    // Removing spotlighted tile causes updateGridState() to clear spotlight mode
    tileB.remove();
    grid.updateGridState();
    assert.equal(streamGrid.classList.contains('is-spotlight-mode'), false);
    assert.equal(streamGrid.dataset.spotlightPeerId, undefined);

    // Escape in app.js clears spotlight when no modal is open
    const windowListeners = new Map();
    const appStreamGrid = createMockElement('div', { id: 'streamGrid', className: 'stream-grid' });
    const appDoc = createMockDocument({ streamGrid: appStreamGrid }, {
        createElement: (tag) => createMockElement(tag)
    });
    const fakeWin = {
        location: { origin: 'https://example.com', protocol: 'https:', hostname: 'example.com', pathname: '/', search: '' },
        history: { replaceState: () => {} },
        addEventListener: (ev, fn) => {
            if (!windowListeners.has(ev)) windowListeners.set(ev, new Set());
            windowListeners.get(ev).add(fn);
        },
        removeEventListener: (ev, fn) => {
            windowListeners.get(ev)?.delete(fn);
        }
    };
    const app = initApp({
        windowObj: fakeWin,
        documentObj: appDoc,
        navigatorObj: { userAgent: 'Mozilla/5.0' },
        storage: createMockStorage(),
        ioFactory: () => ({ connected: false, on: () => {}, emit: () => {}, disconnect: () => {} }),
        serverUrl: 'https://example.com'
    });
    try {
        const t1 = app.grid.createStreamTile('peer-1', { id: 's-1' }, 'Carol', false);
        appStreamGrid.appendChild(t1);
        app.grid.toggleTileSpotlight(t1);
        assert.equal(app.grid.isSpotlightActive(), true);
        for (const fn of windowListeners.get('keydown') || []) {
            fn({ key: 'Escape' });
        }
        assert.equal(app.grid.isSpotlightActive(), false);
    } finally {
        app.teardownClientSession();
    }
});
