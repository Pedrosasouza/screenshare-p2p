'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { ROOT_DIR, CLIENT_MODULES_DIR, loadClientModules } = require('./helpers/client-env');

async function importClientModule(relPath) {
    return import(pathToFileURL(path.join(CLIENT_MODULES_DIR, relPath)).href);
}

async function loadModules(tag = 'cui') {
    return loadClientModules(
        ['signaling-url', 'room-modal', 'preferences', 'qos-monitor', 'share-config-modal', 'app'],
        { cacheBustTag: tag }
    );
}

function createWindowAndStorage({
    locationHref = 'https://screenshare-p2p.onrender.com/',
    initialStorage = {},
    isDesktop = false
} = {}) {
    const urlObj = new URL(locationHref);
    const storageMap = new Map(Object.entries(initialStorage));
    const setItemCalls = [];
    const removeItemCalls = [];
    const replacedUrls = [];

    const windowObj = {
        location: {
            protocol: urlObj.protocol,
            origin: urlObj.origin,
            hostname: urlObj.hostname,
            pathname: urlObj.pathname,
            search: urlObj.search,
            hash: urlObj.hash
        },
        history: {
            state: null,
            replaceState(state, _title, url) {
                replacedUrls.push({ state, url });
                const next = new URL(url, urlObj.origin);
                windowObj.location.pathname = next.pathname;
                windowObj.location.search = next.search;
                windowObj.location.hash = next.hash;
            }
        }
    };

    if (isDesktop) {
        windowObj.__TAURI__ = {};
    }

    const storage = {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => {
            setItemCalls.push({ k, v: String(v) });
            storageMap.set(k, String(v));
        },
        removeItem: (k) => {
            removeItemCalls.push(k);
            storageMap.delete(k);
        }
    };

    return { windowObj, storage, storageMap, setItemCalls, removeItemCalls, replacedUrls };
}

async function withMockedGlobals(windowObj, storage, fn) {
    const prevWindow = global.window;
    const prevStorage = global.localStorage;
    global.window = windowObj;
    global.localStorage = storage;
    try {
        return await fn();
    } finally {
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
        if (prevStorage === undefined) delete global.localStorage;
        else global.localStorage = prevStorage;
    }
}

describe('buildInviteUrl, pure module imports & initApp #btnCopyLink integration', () => {
    it('returns serverUrl/?room=... in Tauri desktop mode instead of tauri.localhost', async () => {
        const { buildInviteUrl } = await importClientModule('signaling-url.js');
        assert.equal(typeof buildInviteUrl, 'function');

        const url = buildInviteUrl({
            roomId: 'sala-casal',
            password: 'seg redo',
            isDesktop: true,
            serverUrl: 'https://screenshare-p2p.onrender.com',
            origin: 'http://tauri.localhost',
            pathname: '/'
        });
        assert.equal(url, 'https://screenshare-p2p.onrender.com/?room=sala-casal#pass=seg%20redo');

        const urlTauriProto = buildInviteUrl({
            roomId: 'sala-2',
            password: '',
            isDesktop: false,
            serverUrl: 'https://custom.example.com/',
            origin: 'tauri://localhost',
            pathname: '/index.html'
        });
        assert.equal(urlTauriProto, 'https://custom.example.com/?room=sala-2');
    });

    it('preserves web origin and pathname in browser mode', async () => {
        const { buildInviteUrl } = await importClientModule('signaling-url.js');

        const url = buildInviteUrl({
            roomId: 'casal-1',
            password: '123',
            isDesktop: false,
            serverUrl: 'https://screenshare-p2p.onrender.com',
            origin: 'https://screenshare-p2p.onrender.com',
            pathname: '/'
        });
        assert.equal(url, 'https://screenshare-p2p.onrender.com/?room=casal-1#pass=123');

        const subpathUrl = buildInviteUrl({
            roomId: 'team',
            password: '',
            isDesktop: false,
            serverUrl: 'https://example.org',
            origin: 'https://example.org',
            pathname: '/app/'
        });
        assert.equal(subpathUrl, 'https://example.org/app/?room=team');

        const customWebServerUrl = buildInviteUrl({
            roomId: 'team-custom',
            password: 'pw',
            isDesktop: false,
            serverUrl: 'https://meu-servidor.example.org/',
            origin: 'https://screenshare-p2p.onrender.com',
            pathname: '/'
        });
        assert.equal(customWebServerUrl, 'https://meu-servidor.example.org/?room=team-custom#pass=pw');
    });

    it('imports all client modules cleanly in Node without undeclared globals', async () => {
        const modules = fs.readdirSync(CLIENT_MODULES_DIR)
            .filter((name) => name.endsWith('.js'))
            .sort();
        const loaded = {};
        for (const name of modules) {
            loaded[name] = await importClientModule(name);
            assert.equal(typeof loaded[name], 'object');
        }

        assert.equal(loaded['qos.js'].getMaxBitrateForPeerCount(), 6_000_000);
        assert.equal(loaded['qos.js'].getMaxBitrateForPeerCount(2, '720p', 30), 810_000);

        let fsNotified = 0;
        loaded['tile-dom.js'].registerFullscreenChangeHandler(() => { fsNotified++; });
        const mockTile = {
            classList: {
                set: new Set(),
                contains(c) { return this.set.has(c); },
                add(c) { this.set.add(c); },
                remove(c) { this.set.delete(c); }
            },
            querySelector() { return {}; }
        };
        loaded['tile-dom.js'].enterPseudoFullscreen(mockTile);
        assert.equal(fsNotified, 1);
        loaded['tile-dom.js'].registerFullscreenChangeHandler(null);
    });

    it('wires #btnCopyLink through initApp() in Web and Tauri Desktop modes and tears down cleanly', async () => {
        const appUrl = pathToFileURL(path.join(ROOT_DIR, 'public', 'app.js')).href;
        const { initApp } = await import(`${appUrl}?smoke=${Date.now()}`);

        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        const copyResetTimers = new Set();
        global.setTimeout = (fn, ms) => {
            if (ms === 2500) {
                const handle = { fn };
                copyResetTimers.add(handle);
                return handle;
            }
            return origSetTimeout(fn, ms);
        };
        global.clearTimeout = (id) => {
            if (copyResetTimers.has(id)) {
                copyResetTimers.delete(id);
                return;
            }
            return origClearTimeout(id);
        };

        try {
            // Desktop mode (#btnCopyLink inside http://tauri.localhost uses serverUrl)
            const desktopClipboard = [];
            const btnCopyDesktop = createMockElement('button', {
                id: 'btnCopyLink',
                innerHTML: '<i class="fa-solid fa-link"></i> <span class="btn-text">Copiar Link</span>'
            });
            const appDesktop = initApp({
                windowObj: {
                    __TAURI_INTERNALS__: {},
                    location: { protocol: 'http:', origin: 'http://tauri.localhost', pathname: '/', search: '', hash: '' },
                    addEventListener() {},
                    removeEventListener() {},
                    matchMedia: () => ({ matches: false })
                },
                documentObj: createMockDocument({ btnCopyLink: btnCopyDesktop }),
                navigatorObj: { clipboard: { writeText: async (txt) => { desktopClipboard.push(txt); } } },
                storage: createMockStorage(),
                ioFactory: () => ({ id: 'd1', connected: false, on() {}, emit() {}, disconnect() {} }),
                fetchImpl: async () => ({ ok: false, status: 503 }),
                serverUrl: 'https://screenshare-p2p.onrender.com'
            });

            try {
                appDesktop.state.roomId = 'desktop-room';
                appDesktop.state.currentRoomPassword = 'abc';
                btnCopyDesktop.click();
                await Promise.resolve();
                assert.equal(desktopClipboard[0], 'https://screenshare-p2p.onrender.com/?room=desktop-room#pass=abc');
            } finally {
                appDesktop.teardownClientSession();
            }

            // Web mode (#btnCopyLink preserves web origin + pathname)
            const webClipboard = [];
            const btnCopyWeb = createMockElement('button', {
                id: 'btnCopyLink',
                innerHTML: '<i class="fa-solid fa-link"></i> <span class="btn-text">Copiar Link</span>'
            });
            const appWeb = initApp({
                windowObj: {
                    location: { protocol: 'https:', origin: 'https://web.example.com', pathname: '/stream/', search: '', hash: '' },
                    addEventListener() {},
                    removeEventListener() {},
                    matchMedia: () => ({ matches: false })
                },
                documentObj: createMockDocument({ btnCopyLink: btnCopyWeb }),
                navigatorObj: { clipboard: { writeText: async (txt) => { webClipboard.push(txt); } } },
                storage: createMockStorage(),
                ioFactory: () => ({ id: 'w1', connected: false, on() {}, emit() {}, disconnect() {} }),
                fetchImpl: async () => ({ ok: false, status: 503 }),
                serverUrl: 'https://web.example.com'
            });

            try {
                appWeb.state.roomId = 'web-room';
                appWeb.state.currentRoomPassword = '';
                btnCopyWeb.click();
                await Promise.resolve();
                assert.equal(webClipboard[0], 'https://web.example.com/stream/?room=web-room');
            } finally {
                appWeb.teardownClientSession();
            }
        } finally {
            copyResetTimers.clear();
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
        }
    });
});

describe('Segurança de URL de sinalização & ?pass=', () => {
    it('T1: Web rejeita ?server=https://evil.com, retorna origin e não grava em localStorage', async () => {
        const signalingUrl = await loadModules();
        const env = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?room=abc&server=https://evil.com'
        });

        await withMockedGlobals(env.windowObj, env.storage, () => {
            const resolved = signalingUrl.resolveSignalingServerUrl();
            assert.strictEqual(resolved, 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(env.setItemCalls.length, 0, 'Não deve gravar ?server= em localStorage');
            assert.strictEqual(env.storageMap.has('streamgrid_server_url'), false);
        });
    });

    it('T2: Web rejeita http://evil.com, credenciais embutidas e esquemas inválidos', async () => {
        const signalingUrl = await loadModules();

        const envHttp = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?server=http://evil.com'
        });
        await withMockedGlobals(envHttp.windowObj, envHttp.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envHttp.setItemCalls.length, 0);
        });

        const envCreds = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?server=https://user:pass@screenshare-p2p.onrender.com'
        });
        await withMockedGlobals(envCreds.windowObj, envCreds.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envCreds.setItemCalls.length, 0);
        });

        const envSameOriginPath = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?server=https://screenshare-p2p.onrender.com/custom?x=1'
        });
        await withMockedGlobals(envSameOriginPath.windowObj, envSameOriginPath.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envSameOriginPath.setItemCalls.length, 0);
        });
    });

    it('T3: Web aceita loopback local sem persistir em localStorage', async () => {
        const signalingUrl = await loadModules();

        for (const loopbackUrl of [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://[::1]:3000'
        ]) {
            const env = createWindowAndStorage({
                locationHref: `https://screenshare-p2p.onrender.com/?server=${encodeURIComponent(loopbackUrl)}`
            });
            await withMockedGlobals(env.windowObj, env.storage, () => {
                const resolved = signalingUrl.resolveSignalingServerUrl();
                assert.strictEqual(resolved, loopbackUrl, `Deveria aceitar loopback ${loopbackUrl}`);
                assert.strictEqual(env.setItemCalls.length, 0, 'Loopback via ?server= não deve persistir em localStorage');
            });
        }
    });

    it('T4: Desktop aceita https remoto na sessão e valida/limpa localStorage', async () => {
        const signalingUrl = await loadModules();

        // 4a. ?server=https://meu-servidor.example.com aceito sem gravar em localStorage
        const envParam = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/?server=https://meu-servidor.example.com/path/',
            isDesktop: true
        });
        await withMockedGlobals(envParam.windowObj, envParam.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
            assert.strictEqual(envParam.setItemCalls.length, 0, 'Query ?server= no Desktop não deve auto-persistir');
        });

        // 4b. Valor válido em localStorage é aceito e normalizado
        const envValidStorage = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'https://meu-servidor.example.com/sub/' },
            isDesktop: true
        });
        await withMockedGlobals(envValidStorage.windowObj, envValidStorage.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
            assert.strictEqual(envValidStorage.removeItemCalls.length, 0);
        });

        // 4c. Valor inválido http://remoto-inseguro.com é descartado e removido do localStorage
        const envHttpStorage = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'http://remoto-inseguro.com' },
            isDesktop: true
        });
        await withMockedGlobals(envHttpStorage.windowObj, envHttpStorage.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envHttpStorage.removeItemCalls.includes('streamgrid_server_url'), true);
            assert.strictEqual(envHttpStorage.storageMap.has('streamgrid_server_url'), false);
        });

        // 4d. Valor com credenciais embutidas também é removido do localStorage
        const envCredStorage = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'https://user:secret@meu-servidor.example.com' },
            isDesktop: true
        });
        await withMockedGlobals(envCredStorage.windowObj, envCredStorage.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envCredStorage.removeItemCalls.includes('streamgrid_server_url'), true);
            assert.strictEqual(envCredStorage.storageMap.has('streamgrid_server_url'), false);
        });

        // 4e. Web aceita override HTTPS salvo explicitamente em localStorage, mas continua bloqueando http:// remoto
        const envWebSavedHttps = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/',
            initialStorage: { streamgrid_server_url: 'https://meu-servidor.example.com/custom/' },
            isDesktop: false
        });
        await withMockedGlobals(envWebSavedHttps.windowObj, envWebSavedHttps.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
            assert.strictEqual(envWebSavedHttps.removeItemCalls.length, 0);
        });

        const envWebSavedHttp = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/',
            initialStorage: { streamgrid_server_url: 'http://meu-servidor-inseguro.example.com' },
            isDesktop: false
        });
        await withMockedGlobals(envWebSavedHttp.windowObj, envWebSavedHttp.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envWebSavedHttp.removeItemCalls.includes('streamgrid_server_url'), true);
        });
    });

    it('T5: applyInitialUrlAndRestore remove ?pass= via replaceState mantendo ?room=', async () => {
        const roomModalMod = await loadModules();

        function createControllerForHref(locationHref) {
            const env = createWindowAndStorage({ locationHref });
            const dom = {
                inputCreateRoomPassword: { value: '' },
                inputJoinRoomPassword: { value: '' },
                inputJoinRoomId: { value: '' }
            };
            const state = {
                currentRoomId: null,
                currentUserName: ''
            };
            const ctrl = roomModalMod.createRoomModalController({
                state,
                dom,
                getSocket: () => ({ connected: true, emit: () => {} }),
                onCleanupRoomState: () => {},
                getMembership: () => ({}),
                showToast: () => {},
                getSessionRoomPassword: () => '',
                clearSessionRoomPassword: () => {},
                onThemeInit: () => {},
                onLoadPreferences: () => {},
                storage: env.storage,
                windowObj: env.windowObj
            });
            return { env, dom, ctrl };
        }

        const withRoom = createControllerForHref('https://screenshare-p2p.onrender.com/?room=sala-casal&pass=segredo123');
        withRoom.ctrl.applyInitialUrlAndRestore();
        assert.strictEqual(withRoom.env.replacedUrls.length, 1, 'Deve chamar history.replaceState uma vez para limpar pass');
        assert.strictEqual(withRoom.env.replacedUrls[0].url, '/?room=sala-casal');
        assert.strictEqual(withRoom.env.windowObj.location.search, '?room=sala-casal');
        assert.strictEqual(withRoom.dom.inputJoinRoomPassword.value, 'segredo123');

        const onlyPass = createControllerForHref('https://screenshare-p2p.onrender.com/?pass=segredo123');
        onlyPass.ctrl.applyInitialUrlAndRestore();
        assert.strictEqual(onlyPass.env.replacedUrls.length, 1);
        assert.strictEqual(onlyPass.env.replacedUrls[0].url, '/');
        assert.strictEqual(onlyPass.env.windowObj.location.search, '');
    });
});

test('T1 (Item A): Invite link places #pass= in URL fragment, strips from history, and preserves other hash params', async () => {
    const { buildInviteUrl, initApp } = await loadModules('ihs');
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
        fetchImpl: async () => ({ ok: false, status: 503 }),
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
    const { initApp, COLD_START_NOTICE_DELAY_MS } = await loadModules('ihs');
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
            fetchImpl: async () => ({ ok: false, status: 503 }),
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
    } = await loadModules('ihs');

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
