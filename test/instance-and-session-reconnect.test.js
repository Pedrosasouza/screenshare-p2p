'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');

async function loadModules() {
    const [statsMod, sigMod, appMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/stats-modal.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/signaling-url.js')).href),
        import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?inst=${Date.now()}`)
    ]);
    return { ...statsMod, ...sigMod, ...appMod };
}

test('T1: render.yaml pins 1 instance, /health check, npm start, and TRUST_PROXY=true', () => {
    const renderYamlPath = path.join(ROOT_DIR, 'render.yaml');
    assert.ok(fs.existsSync(renderYamlPath));
    const renderYaml = fs.readFileSync(renderYamlPath, 'utf8');
    assert.match(renderYaml, /numInstances:\s*1\b/);
    assert.match(renderYaml, /healthCheckPath:\s*\/health\b/);
    assert.match(renderYaml, /startCommand:\s*npm start\b/);
    assert.ok(/TRUST_PROXY/.test(renderYaml) && /["']?true["']?/.test(renderYaml));
});

test('T2: index.html includes #statsServerUrl and #btnResetServerUrl inside #statsModal', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
    const statsModalMatch = indexHtml.match(/id="statsModal"[\s\S]*$/);
    assert(statsModalMatch, '#statsModal not found in public/index.html');
    const statsSection = statsModalMatch[0];
    assert.ok(statsSection.includes('id="statsServerUrl"'));
    assert.ok(statsSection.includes('id="btnResetServerUrl"'));
    assert.match(statsSection, /id="btnResetServerUrl"[^>]*type="button"|type="button"[^>]*id="btnResetServerUrl"/);
});

test('T3: updateStatsDisplay displays SERVER_URL and resetSavedSignalingServerUrl clears localStorage override', async () => {
    const { createStatsModalController, SERVER_URL_STORAGE_KEY } = await loadModules();
    const storage = createMockStorage({ [SERVER_URL_STORAGE_KEY]: 'https://outro.onrender.com' });
    const toasts = [];
    let reloadCount = 0;

    const elServerUrl = createMockElement('span', { id: 'statsServerUrl' });
    const btnReset = createMockElement('button', { id: 'btnResetServerUrl', hidden: false });
    const doc = createMockDocument({
        statsServerUrl: elServerUrl,
        btnResetServerUrl: btnReset,
        statsConnectionState: createMockElement('span', { id: 'statsConnectionState' }),
        statsRtt: createMockElement('span', { id: 'statsRtt' }),
        statsPacketLoss: createMockElement('span', { id: 'statsPacketLoss' }),
        statsLocalStream: createMockElement('span', { id: 'statsLocalStream' }),
        statsContentHint: createMockElement('span', { id: 'statsContentHint' }),
        statsVideoTelemetry: createMockElement('span', { id: 'statsVideoTelemetry' }),
        statsCodecEncoder: createMockElement('span', { id: 'statsCodecEncoder' }),
        statsQualityLimitation: createMockElement('span', { id: 'statsQualityLimitation' }),
        statsIceRoute: createMockElement('span', { id: 'statsIceRoute' })
    });

    const statsCtrl = createStatsModalController({
        state: { localStream: null, selectedVideoFps: 60, selectedVideoResolution: '1080p', contentHintMode: 'motion' },
        dom: {},
        getPeers: () => new Map(),
        getServerUrl: () => 'https://outro.onrender.com',
        showToast: (msg, type) => toasts.push({ msg, type }),
        documentObj: doc,
        windowObj: { location: { reload: () => { reloadCount += 1; } } },
        storage
    });

    await statsCtrl.updateStatsDisplay();
    assert.ok(elServerUrl.textContent.includes('https://outro.onrender.com'));
    assert.ok(elServerUrl.textContent.includes('override'));
    assert.equal(btnReset.hidden, false);

    statsCtrl.resetSavedSignalingServerUrl();
    assert.equal(storage.getItem(SERVER_URL_STORAGE_KEY), null);
    assert.ok(toasts.length >= 1);
    assert.equal(reloadCount, 1);

    await statsCtrl.updateStatsDisplay();
    assert.equal(btnReset.hidden, true);
    statsCtrl.resetSavedSignalingServerUrl();
    assert.equal(reloadCount, 1);
});

test('T4: Cold start notice triggers after 3000ms and cancels cleanly on connect / connect_error', async () => {
    const { COLD_START_NOTICE_DELAY_MS, initApp } = await loadModules();
    assert.equal(COLD_START_NOTICE_DELAY_MS, 3000);

    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const origDocument = global.document;
    const timers = new Map();
    let nextId = 1;

    const toastContainer = createMockElement('div', { id: 'toastContainer' });
    const fakeDoc = createMockDocument({ toastContainer }, { createElement: (tag) => createMockElement(tag) });
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
    const socket = {
        id: 'sock-cold',
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
            ioFactory: () => socket,
            serverUrl: 'http://localhost:3000'
        });

        try {
            assert.equal(timers.size, 1, 'Cold start notice timer should schedule while disconnected');
            const [id1, entry1] = Array.from(timers.entries())[0];
            assert.equal(entry1.ms, 3000);
            timers.delete(id1);
            entry1.fn();
            assert.equal(toastContainer.children.length, 1);
            const toastText = toastContainer.children[0].children.map((c) => c.textContent || '').join(' ');
            assert.match(toastText, /acordando|servidor/i);
        } finally {
            app.teardownClientSession();
        }

        // Case 2: connect before 3s cancels coldStartTimer
        timers.clear();
        socket.connected = false;
        const app2 = initApp({
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
        try {
            assert.equal(timers.size, 1);
            socket.connected = true;
            socketHandlers.connect();
            assert.equal(timers.size, 0, 'connect must cancel coldStartTimer');
        } finally {
            app2.teardownClientSession();
        }

        // Case 3: connect_error before 3s cancels coldStartTimer
        timers.clear();
        socket.connected = false;
        const app3 = initApp({
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
        try {
            assert.equal(timers.size, 1);
            socketHandlers.connect_error(new Error('network'));
            assert.equal(timers.size, 0, 'connect_error must cancel coldStartTimer');
        } finally {
            app3.teardownClientSession();
        }
    } finally {
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
        global.document = origDocument;
    }
});

test('T5: sessionStorage preserves room password across F5 reload and clears on join-error / public room', async () => {
    const {
        SESSION_PASS_STORAGE_KEY,
        saveSessionRoomPassword,
        getSessionRoomPassword,
        initApp
    } = await loadModules();

    const localStorageObj = createMockStorage();
    const sessionStorageObj = createMockStorage();
    const origSessionStorage = global.sessionStorage;
    global.sessionStorage = sessionStorageObj;

    const socketHandlers = {};
    const emitted = [];
    const fakeSocket = {
        id: 's1',
        connected: true,
        on(ev, fn) { socketHandlers[ev] = fn; },
        emit(ev, payload) { emitted.push({ ev, payload }); },
        disconnect() {}
    };

    const win = {
        location: {
            protocol: 'https:',
            origin: 'https://screenshare-p2p.onrender.com',
            pathname: '/',
            search: '?room=sala-casal',
            hash: ''
        },
        history: { state: null, pushState() {}, replaceState() {} },
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false })
    };

    try {
        const app = initApp({
            windowObj: win,
            documentObj: createMockDocument({}, { createElement: (tag) => createMockElement(tag) }),
            navigatorObj: { clipboard: { writeText: async () => {} } },
            storage: localStorageObj,
            ioFactory: () => fakeSocket,
            serverUrl: 'https://screenshare-p2p.onrender.com'
        });

        try {
            // 1. Confirm joining password-protected room saves to sessionStorage only
            app.roomModalCtrl.joinRoom('sala-casal', 'segredo-123');
            await socketHandlers['room-users']({
                users: [],
                userNames: {},
                activeStreams: [],
                socketId: 's1',
                memberCount: 1,
                hasPassword: true
            });

            assert.notEqual(sessionStorageObj.getItem(SESSION_PASS_STORAGE_KEY), null);
            assert.equal(getSessionRoomPassword('sala-casal'), 'segredo-123');
            assert.equal(getSessionRoomPassword('outra-sala'), '');
            assert.equal(localStorageObj.getItem(SESSION_PASS_STORAGE_KEY), null);

            // 2. Simulate F5 (?room=sala-casal without #pass) -> restores password from sessionStorage
            emitted.length = 0;
            app.state.roomId = '';
            app.roomModalCtrl.applyInitialUrlAndRestore();
            const joinCalls1 = emitted.filter((e) => e.ev === 'join-room');
            assert.equal(joinCalls1.length, 1);
            assert.equal(joinCalls1[0].payload.roomId, 'sala-casal');
            assert.equal(joinCalls1[0].payload.password, 'segredo-123');

            // 3. Simulate F5 using localStorage only (empty query string) -> still restores session password
            emitted.length = 0;
            win.location.search = '';
            app.state.roomId = '';
            app.roomModalCtrl.applyInitialUrlAndRestore();
            const joinCalls2 = emitted.filter((e) => e.ev === 'join-room');
            assert.equal(joinCalls2.length, 1);
            assert.equal(joinCalls2[0].payload.roomId, 'sala-casal');
            assert.equal(joinCalls2[0].payload.password, 'segredo-123');

            // 4. join-error invalid_password clears sessionStorage
            app.roomModalCtrl.handleJoinError({ error: 'invalid_password', message: 'Senha incorreta' });
            assert.equal(getSessionRoomPassword('sala-casal'), '');

            // 5. Public room clears stale session password
            saveSessionRoomPassword('sala-casal', 'velha');
            app.roomModalCtrl.joinRoom('sala-casal', '');
            await socketHandlers['room-users']({
                users: [],
                userNames: {},
                activeStreams: [],
                socketId: 's1',
                memberCount: 1,
                hasPassword: false
            });
            assert.equal(getSessionRoomPassword('sala-casal'), '');
        } finally {
            app.teardownClientSession();
        }
    } finally {
        global.sessionStorage = origSessionStorage;
    }
});

test('T7: saveCustomSignalingServerUrl validates URLs and stats-modal saves/reloads via inputCustomServerUrl & btnSaveServerUrl', async () => {
    const {
        createStatsModalController,
        saveCustomSignalingServerUrl,
        SERVER_URL_STORAGE_KEY
    } = await loadModules();

    const webWin = {
        location: { protocol: 'https:', origin: 'https://app.example.com', hostname: 'app.example.com', reload: () => {} }
    };
    const webStorage = createMockStorage();

    // Non-desktop rejects external HTTPS/HTTP URLs
    const webExternal = saveCustomSignalingServerUrl('https://outro.example.com', { windowObj: webWin, storage: webStorage });
    assert.equal(webExternal.ok, false);
    assert.equal(webStorage.getItem(SERVER_URL_STORAGE_KEY), null);

    // Loopback HTTP is allowed even in web mode; credentials are rejected
    const badCreds = saveCustomSignalingServerUrl('https://user:pass@localhost:3000', { windowObj: webWin, storage: webStorage });
    assert.equal(badCreds.ok, false);
    const localOk = saveCustomSignalingServerUrl('http://localhost:3000/custom?a=1', { windowObj: webWin, storage: webStorage });
    assert.deepEqual(localOk, { ok: true, url: 'http://localhost:3000' });
    assert.equal(webStorage.getItem(SERVER_URL_STORAGE_KEY), 'http://localhost:3000');

    // Desktop allows custom HTTPS server via modal UI (#inputCustomServerUrl + #btnSaveServerUrl + Enter)
    let reloadCount = 0;
    const desktopWin = {
        __TAURI__: {},
        location: { protocol: 'tauri:', origin: 'tauri://localhost', reload: () => { reloadCount += 1; } }
    };
    const desktopStorage = createMockStorage({ [SERVER_URL_STORAGE_KEY]: 'https://initial.example.com' });
    const statsModal = createMockElement('div', { id: 'statsModal', hidden: true });
    statsModal.style.display = 'none';
    const inputCustomServerUrl = createMockElement('input', { id: 'inputCustomServerUrl', value: '' });
    const btnSaveServerUrl = createMockElement('button', { id: 'btnSaveServerUrl' });
    const doc = createMockDocument({
        statsModal,
        inputCustomServerUrl,
        btnSaveServerUrl
    });

    const toasts = [];
    const ctrl = createStatsModalController({
        state: { localStream: null, selectedVideoFps: 60, selectedVideoResolution: '1080p', contentHintMode: 'motion' },
        dom: { statsModal, inputCustomServerUrl, btnSaveServerUrl },
        getPeers: () => new Map(),
        getServerUrl: () => 'https://initial.example.com',
        showToast: (msg, type) => toasts.push({ msg, type }),
        documentObj: doc,
        windowObj: desktopWin,
        storage: desktopStorage
    });
    ctrl.bindEvents();

    try {
        ctrl.openStatsModal();
        assert.equal(inputCustomServerUrl.value, 'https://initial.example.com');

        // Invalid URL -> error toast, no reload, keeps saved override
        inputCustomServerUrl.value = 'ftp://invalid.example.com';
        btnSaveServerUrl.dispatchEvent({ type: 'click' });
        assert.equal(reloadCount, 0);
        assert.equal(desktopStorage.getItem(SERVER_URL_STORAGE_KEY), 'https://initial.example.com');
        assert.equal(toasts[toasts.length - 1].type, 'error');

        // Valid URL via Enter -> saves normalized origin, info toast, reloads
        inputCustomServerUrl.value = 'https://custom-host.example.com:8443/room';
        inputCustomServerUrl.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: () => {} });
        assert.equal(desktopStorage.getItem(SERVER_URL_STORAGE_KEY), 'https://custom-host.example.com:8443');
        assert.equal(toasts[toasts.length - 1].type, 'info');
        assert.equal(reloadCount, 1);
    } finally {
        ctrl.closeStatsModal();
    }
});
