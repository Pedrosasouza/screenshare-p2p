'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { startTestServer } = require('./helpers/test-server');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'public/style.css'), 'utf8');

async function loadClientModules() {
    const [sigMod, prefsMod, qosMonMod, shareModalMod, tileDomMod, appMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/signaling-url.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/preferences.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/qos-monitor.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/share-config-modal.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/tile-dom.js')).href),
        import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?ihs=${Date.now()}`)
    ]);
    return { ...sigMod, ...prefsMod, ...qosMonMod, ...shareModalMod, ...tileDomMod, ...appMod };
}

test('T1 (Item A): Invite link places #pass= in URL fragment, strips from history, and preserves other hash params', async () => {
    const { buildInviteUrl, initApp } = await loadClientModules();
    const link = buildInviteUrl({
        roomId: 'casal-1',
        password: 's@nha#1 2',
        isDesktop: false,
        serverUrl: 'https://screenshare-p2p.onrender.com',
        origin: 'https://screenshare-p2p.onrender.com',
        pathname: '/app/'
    });

    const parsed = new URL(link);
    assert.equal(parsed.searchParams.get('room'), 'casal-1');
    assert.equal(parsed.searchParams.get('pass'), null, 'Password must NEVER appear in query string');
    assert.equal(parsed.hash, '#pass=s%40nha%231%202');

    const replaced = [];
    const emitted = [];
    const win = {
        location: {
            protocol: 'https:',
            origin: 'https://screenshare-p2p.onrender.com',
            pathname: '/',
            search: '?room=casal-1',
            hash: '#outro=1&pass=segredo-hash'
        },
        history: {
            state: { existing: true },
            replaceState(_state, _title, url) {
                replaced.push(url);
                const u = new URL(url, 'https://screenshare-p2p.onrender.com');
                win.location.search = u.search;
                win.location.hash = u.hash;
            },
            pushState() {}
        },
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false })
    };

    const fakeSocket = {
        id: 's1',
        connected: true,
        on() {},
        emit(ev, payload) { emitted.push({ ev, payload }); },
        disconnect() {}
    };

    const app = initApp({
        windowObj: win,
        documentObj: createMockDocument({}, { createElement: (tag) => createMockElement(tag) }),
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => fakeSocket,
        serverUrl: 'https://screenshare-p2p.onrender.com'
    });

    try {
        emitted.length = 0;
        app.roomModalCtrl.applyInitialUrlAndRestore();

        const joins = emitted.filter((e) => e.ev === 'join-room');
        assert.equal(joins.length, 1);
        assert.equal(joins[0].payload.roomId, 'casal-1');
        assert.equal(joins[0].payload.password, 'segredo-hash');
        assert.equal(replaced.length, 1);
        assert(!win.location.hash.includes('segredo-hash'), 'Hash #pass= must be removed from address bar');
        assert(win.location.hash.includes('outro=1'), 'Other hash parameters must be preserved');
    } finally {
        app.teardownClientSession();
    }
});

test('T2 (Item B): Signaling status pill transitions across waking, connected, reconnecting, and offline', async () => {
    assert.ok(indexHtml.includes('id="connectionStatusPill"'));
    assert.ok(indexHtml.includes('id="connectionStatusText"'));
    assert.match(styleCss, /\.connection-status-pill/);

    const { initApp, COLD_START_NOTICE_DELAY_MS } = await loadClientModules();
    const pill = createMockElement('div', { id: 'connectionStatusPill', className: 'info-pill connection-status-pill' });
    const textEl = createMockElement('span', { id: 'connectionStatusText' });
    const fakeDoc = createMockDocument({ connectionStatusPill: pill, connectionStatusText: textEl });

    const origDocument = global.document;
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const timers = new Map();
    let nextId = 1;
    global.document = fakeDoc;
    global.setTimeout = (fn, ms) => {
        if (ms === COLD_START_NOTICE_DELAY_MS) {
            const id = nextId++;
            timers.set(id, { fn, ms });
            return id;
        }
        return origSetTimeout(fn, ms);
    };
    global.clearTimeout = (id) => {
        if (timers.has(id)) {
            timers.delete(id);
            return;
        }
        return origClearTimeout(id);
    };

    const socketHandlers = {};
    const fakeSocket = {
        id: 's1',
        connected: false,
        on(ev, fn) { socketHandlers[ev] = fn; },
        emit() {},
        disconnect() {}
    };

    try {
        const app = initApp({
            windowObj: {
                location: { protocol: 'http:', origin: 'http://localhost:3000', pathname: '/', search: '', hash: '' },
                addEventListener() {},
                removeEventListener() {},
                matchMedia: () => ({ matches: false })
            },
            documentObj: fakeDoc,
            navigatorObj: { clipboard: { writeText: async () => {} } },
            storage: createMockStorage(),
            ioFactory: () => fakeSocket,
            serverUrl: 'http://localhost:3000'
        });

        try {
            const [tid, entry] = Array.from(timers.entries())[0];
            timers.delete(tid);
            entry.fn();
            assert.equal(pill.dataset.status, 'waking');
            assert.match(textEl.textContent, /acordando/i);

            fakeSocket.connected = true;
            socketHandlers.connect();
            assert.equal(pill.dataset.status, 'connected');
            assert.match(textEl.textContent, /conectado/i);

            fakeSocket.connected = false;
            socketHandlers.disconnect('transport close');
            assert.equal(pill.dataset.status, 'reconnecting');
            assert.match(textEl.textContent, /reconectando/i);

            socketHandlers.connect_error(new Error('offline'));
            assert.equal(pill.dataset.status, 'offline');
            assert.match(textEl.textContent, /offline/i);
        } finally {
            app.teardownClientSession();
        }
    } finally {
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
        global.document = origDocument;
    }
});

test('T3 (Item C): AUDIO_SOURCE_KEY and CONTENT_HINT_KEY persist in localStorage and restore in UI & Share modal', async () => {
    const {
        AUDIO_SOURCE_KEY,
        CONTENT_HINT_KEY,
        loadSavedClientPreferences,
        createQosMonitor,
        createShareConfigModalController
    } = await loadClientModules();

    const storage = createMockStorage({
        [AUDIO_SOURCE_KEY]: 'app',
        [CONTENT_HINT_KEY]: 'detail'
    });
    const qualityModeLabel = createMockElement('span', { id: 'qualityModeLabel' });
    const btnQualityToggle = createMockElement('button', { id: 'btnQualityToggle' });
    const radios = {
        exclude_discord: createMockElement('input', { value: 'exclude_discord', checked: true }),
        app: createMockElement('input', { value: 'app', checked: false }),
        system: createMockElement('input', { value: 'system', checked: false }),
        none: createMockElement('input', { value: 'none', checked: false })
    };
    const radioList = Object.values(radios);
    const appSelectorContainer = createMockElement('div', { style: { display: 'none' } });
    const shareConfigModal = createMockElement('div', { style: { display: 'none' }, hidden: true });
    const doc = createMockDocument({ qualityModeLabel, btnQualityToggle, appSelectorContainer, shareConfigModal });
    doc.querySelector = (sel) => (sel === 'input[name="audioSourceType"]:checked' ? radioList.find((r) => r.checked) || null : null);
    doc.querySelectorAll = (sel) => (sel === 'input[name="audioSourceType"]' ? radioList : []);

    const state = {
        contentHintMode: 'motion',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        selectedAudioSource: null,
        localStream: null
    };
    const qm = createQosMonitor({
        state,
        dom: { qualityModeLabel, btnQualityToggle },
        getPeers: () => new Map(),
        storage
    });

    loadSavedClientPreferences({
        state,
        storage,
        onApplied: () => qm.applyQualityModeUI()
    });
    assert.equal(state.contentHintMode, 'detail');
    assert.equal(qualityModeLabel.textContent, 'Nítido');

    qm.toggleQualityMode();
    assert.equal(state.contentHintMode, 'motion');
    assert.equal(storage.getItem(CONTENT_HINT_KEY), 'motion');

    const shareModalCtrl = createShareConfigModalController({
        state,
        dom: {
            audioSourceExcludeDiscord: radios.exclude_discord,
            audioSourceApp: radios.app,
            audioSourceSystem: radios.system,
            audioSourceNone: radios.none,
            appSelectorContainer,
            shareConfigModal
        },
        isDesktopApp: () => true,
        documentObj: doc,
        storage
    });
    shareModalCtrl.openShareConfigModal();
    assert.equal(radios.app.checked, true);
    assert.equal(appSelectorContainer.style.display, 'flex');
});

test('T4 (Item E): disposeTileElement unifies cleanup without stale inline systemCard border', async () => {
    const shareModalSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/js/modules/share-config-modal.js'), 'utf8');
    assert.equal(/systemCard\.style\.border\s*=/.test(shareModalSrc), false);

    const { disposeTileElement } = await loadClientModules();
    let unmuteCleaned = 0;
    let removedCount = 0;
    let exitFsCalls = 0;

    const videoEl = createMockElement('video');
    videoEl.srcObject = { id: 'stream-1' };
    const tileEl = {
        _cleanupTapUnmute: () => { unmuteCleaned += 1; },
        querySelector: (sel) => (sel === 'video' ? videoEl : null),
        remove: () => { removedCount += 1; }
    };
    const fakeDoc = {
        fullscreenElement: tileEl,
        exitFullscreen: () => {
            exitFsCalls += 1;
            return Promise.resolve();
        }
    };

    disposeTileElement(tileEl, fakeDoc);
    assert.equal(unmuteCleaned, 1);
    assert.equal(videoEl.srcObject, null);
    assert.equal(exitFsCalls, 1);
    assert.equal(removedCount, 1);
});

test('T5 (Item D): Server sets CSP and security headers on /, /health, and /ice-servers', async () => {
    const ts = await startTestServer();
    try {
        for (const route of ['/', '/health', '/ice-servers']) {
            const res = await fetch(`${ts.baseUrl}${route}`);
            assert.equal(res.status, 200);
            const csp = res.headers.get('content-security-policy');
            assert(csp, `Content-Security-Policy header must exist on ${route}`);
            assert(csp.includes("default-src 'self'"));
            assert(csp.includes("object-src 'none'"));
            assert(csp.includes("frame-ancestors 'none'"));
            assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
            assert.equal(res.headers.get('x-frame-options'), 'DENY');
        }
    } finally {
        await ts.close();
    }
});
