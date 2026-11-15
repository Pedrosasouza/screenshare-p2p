'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { loadClientModules, createMockSocket } = require('./helpers/client-env');

async function loadModules(tag = 'rjs') {
    return loadClientModules(
        ['room-modal', 'webrtc-mesh', 'preferences', 'room-utils', 'stats-modal', 'signaling-url', 'share-config-modal', 'app'],
        { cacheBustTag: tag }
    );
}

function createRoomJoinHarness(mods) {
    const storage = createMockStorage();
    const pushedUrls = [];
    const replacedUrls = [];
    let cleanupCalls = 0;

    const dom = {
        roomModal: createMockElement('div', { id: 'roomModal', hidden: false, style: { display: 'flex' } }),
        roomErrorBanner: createMockElement('div', { id: 'roomErrorBanner', hidden: true, style: { display: 'none' } }),
        btnCloseRoomModal: createMockElement('button', { id: 'btnCloseRoomModal', style: { display: 'none' } }),
        btnCancelRoomModal: createMockElement('button', { id: 'btnCancelRoomModal', style: { display: 'none' } }),
        roomChoiceCancelContainer: createMockElement('div', { id: 'roomChoiceCancelContainer', style: { display: 'none' } }),
        roomViewChoice: createMockElement('div', { id: 'roomViewChoice', style: { display: 'block' } }),
        roomViewCreate: createMockElement('div', { id: 'roomViewCreate', style: { display: 'none' } }),
        roomViewJoin: createMockElement('div', { id: 'roomViewJoin', style: { display: 'none' } }),
        inputCreateUserName: createMockElement('input', { id: 'inputCreateUserName' }),
        inputJoinUserName: createMockElement('input', { id: 'inputJoinUserName' }),
        inputCreateRoomId: createMockElement('input', { id: 'inputCreateRoomId' }),
        inputJoinRoomId: createMockElement('input', { id: 'inputJoinRoomId' }),
        inputCreateRoomPassword: createMockElement('input', { id: 'inputCreateRoomPassword' }),
        inputJoinRoomPassword: createMockElement('input', { id: 'inputJoinRoomPassword' }),
        createRoomStatusIndicator: createMockElement('div', { id: 'createRoomStatusIndicator' }),
        joinRoomStatusIndicator: createMockElement('div', { id: 'joinRoomStatusIndicator' }),
        joinPasswordHint: createMockElement('div', { id: 'joinPasswordHint' }),
        displayRoomId: createMockElement('span', { id: 'displayRoomId' }),
        memberCountText: createMockElement('span', { id: 'memberCountText' }),
        streamGrid: createMockElement('div', { id: 'streamGrid' })
    };
    const doc = createMockDocument(dom, { createElement: (tag) => createMockElement(tag) });
    const windowObj = {
        location: { protocol: 'http:', pathname: '/' },
        history: {
            pushState: (_s, _t, url) => pushedUrls.push(url),
            replaceState: (_s, _t, url) => replacedUrls.push(url)
        },
        addEventListener: () => {}
    };

    const socket = createMockSocket({ id: 'sock-1' });
    const emittedEvents = socket.emitted;

    const state = {
        myId: '',
        clientId: 'client-1',
        roomId: '',
        currentRoomPassword: '',
        currentUserName: 'Pedro',
        pendingRoomJoin: null,
        localStream: null
    };

    let mesh;
    let roomModalCtrl;

    mesh = mods.createWebRtcMesh({
        state,
        dom,
        getSocket: () => socket,
        getQosMonitor: () => ({ configureSenderParams: () => {}, updateSendersForActivePeers: () => {} }),
        getGrid: () => ({
            updateEchoWarningVisibility: () => {},
            updateMemberCount: () => {},
            updateGridState: () => {},
            updatePeerUserName: () => {},
            createStreamTile: () => createMockElement('div'),
            startTilePlayback: () => {}
        }),
        getScreenShare: () => ({
            invalidateGeneration: () => {},
            stopScreenShare: () => { cleanupCalls += 1; }
        }),
        getRoomModal: () => roomModalCtrl,
        getServerUrl: () => '',
        rtcConfig: { iceServers: [] },
        refreshIceServers: async () => {},
        scheduleIceRefreshTimer: () => {},
        registerFullscreenChangeHandler: () => {},
        saveSessionRoomPassword: () => {},
        clearSessionRoomPassword: () => {},
        showToast: () => {},
        playPresenceChime: () => {},
        RTCPeerConnectionCtor: function () { return createMockPeerConnection(); },
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: doc,
        windowObj,
        storage
    });

    const origCleanup = mesh.cleanupRoomState;
    mesh.cleanupRoomState = (opts) => {
        cleanupCalls += 1;
        return origCleanup(opts);
    };

    roomModalCtrl = mods.createRoomModalController({
        state,
        dom,
        getSocket: () => socket,
        onCleanupRoomState: mesh.cleanupRoomState,
        getMembership: () => mesh.membership,
        showToast: () => {},
        storage,
        windowObj
    });

    return {
        state,
        dom,
        socket,
        mesh,
        roomModalCtrl,
        storage,
        emittedEvents,
        pushedUrls,
        replacedUrls,
        STORAGE_KEY: mods.STORAGE_KEY,
        getCleanupCalls: () => cleanupCalls
    };
}

test('T1: Initial failed join keeps roomId empty, omits STORAGE_KEY, and blocks closeRoomModal', async () => {
    const mods = await loadModules();
    const h = createRoomJoinHarness(mods);

    h.roomModalCtrl.joinRoom('sala-secreta', 'senha-errada');
    assert.equal(h.emittedEvents.length, 1);
    assert.equal(h.emittedEvents[0].event, 'join-room');
    assert.equal(h.emittedEvents[0].payload.roomId, 'sala-secreta');

    assert.equal(h.state.roomId, '');
    assert.equal(h.storage.getItem(h.STORAGE_KEY), null);
    assert.equal(h.pushedUrls.length, 0);

    h.roomModalCtrl.handleJoinError({ error: 'invalid_password', message: 'Senha incorreta' });

    assert.equal(h.state.roomId, '');
    assert.equal(h.state.pendingRoomJoin, null);
    assert.equal(h.storage.getItem(h.STORAGE_KEY), null);
    assert.equal(h.dom.btnCloseRoomModal.style.display, 'none');
    assert.equal(h.dom.inputJoinRoomId.value, 'sala-secreta');

    h.roomModalCtrl.closeRoomModal();
    assert.equal(h.dom.roomModal.hidden, false);
    assert.equal(h.dom.roomModal.style.display, 'flex');
});

test('T2: Failed room switch preserves active room-a, STORAGE_KEY, and active peers across error types', async () => {
    const mods = await loadModules();
    const h = createRoomJoinHarness(mods);

    h.roomModalCtrl.joinRoom('sala-a', 'pass-a');
    await h.mesh.handleRoomUsers({
        users: ['peer-a1'],
        userNames: { 'peer-a1': 'Alice' },
        activeStreams: [],
        socketId: 'sock-1',
        memberCount: 2,
        hasPassword: true
    });
    h.state.localStream = new MockMediaStream([]);
    assert.equal(h.state.roomId, 'sala-a');
    assert.equal(h.storage.getItem(h.STORAGE_KEY), 'sala-a');
    assert.equal(h.mesh.peers.has('peer-a1'), true);

    for (const errPayload of [
        { error: 'invalid_password', message: 'Senha incorreta', pass: 'errada' },
        { error: 'rate_limited', message: 'Bloqueado', pass: 'errada-2' },
        { error: 'invalid_room', message: 'Sala inválida', pass: '' }
    ]) {
        h.roomModalCtrl.joinRoom('sala-b', errPayload.pass);
        assert.equal(h.getCleanupCalls(), 0);
        h.roomModalCtrl.handleJoinError(errPayload);
        assert.equal(h.state.roomId, 'sala-a');
        assert.equal(h.state.currentRoomPassword, 'pass-a');
        assert.equal(h.storage.getItem(h.STORAGE_KEY), 'sala-a');
        assert.equal(h.mesh.peers.has('peer-a1'), true);
        assert.equal(h.getCleanupCalls(), 0);
    }
});

test('T3 (room-join): room-users confirmation runs cleanupRoomState, updates state, pushes URL, and closes modal', async () => {
    const mods = await loadModules();
    const h = createRoomJoinHarness(mods);

    h.roomModalCtrl.joinRoom('sala-a', 'pass-a');
    await h.mesh.handleRoomUsers({
        users: ['peer-a1'],
        userNames: {},
        activeStreams: [],
        socketId: 'sock-1',
        memberCount: 2,
        hasPassword: true
    });
    assert.equal(h.getCleanupCalls(), 0);
    h.state.localStream = new MockMediaStream([]);

    h.roomModalCtrl.openRoomModal('join');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.dom.roomModal.hidden, false);

    h.roomModalCtrl.joinRoom('sala-b', 'segredo');
    assert.equal(h.getCleanupCalls(), 0);

    await h.mesh.handleRoomUsers({
        users: ['peer-b1'],
        userNames: { 'peer-b1': 'Bob' },
        activeStreams: [],
        socketId: 'sock-1',
        memberCount: 2,
        hasPassword: true
    });

    assert.equal(h.getCleanupCalls(), 1);
    assert.equal(h.state.roomId, 'sala-b');
    assert.equal(h.state.currentRoomPassword, 'segredo');
    assert.equal(h.storage.getItem(h.STORAGE_KEY), 'sala-b');
    assert.equal(h.dom.displayRoomId.textContent, 'sala-b');
    assert.equal(h.mesh.peers.has('peer-a1'), false);
    assert.equal(h.mesh.peers.has('peer-b1'), true);
    assert.equal(h.dom.roomModal.hidden, true);
    assert.ok(h.pushedUrls.some((u) => u.includes('?room=sala-b')));
});

test('T4 (room-join): socket connect with pendingRoomJoin prioritizes pending room over previous room', async () => {
    const mods = await loadModules();
    const socketHandlers = {};
    const emitted = [];
    const fakeSocket = {
        id: 'sock-reconn',
        connected: false,
        on(ev, fn) { socketHandlers[ev] = fn; },
        emit(ev, payload) { emitted.push({ event: ev, payload }); },
        disconnect() {}
    };
    const fakeDoc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    const app = mods.initApp({
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
        app.state.roomId = 'sala-antiga';
        app.state.currentRoomPassword = 'pass-antiga';
        app.roomModalCtrl.joinRoom('sala-nova', 'pass-nova', 'Carlos');
        assert.equal(emitted.filter((e) => e.event === 'join-room').length, 0);
        assert.equal(app.state.roomId, 'sala-antiga');

        fakeSocket.connected = true;
        socketHandlers.connect();

        const joins = emitted.filter((e) => e.event === 'join-room');
        assert.equal(joins.length, 1);
        assert.equal(joins[0].payload.roomId, 'sala-nova');
        assert.equal(joins[0].payload.password, 'pass-nova');
        assert.equal(joins[0].payload.userName, 'Carlos');
    } finally {
        app.teardownClientSession();
    }
});

test('T5 (room-join): Status checkers sanitize roomId and closeRoomModal cancels offline pendingRoomJoin', async () => {
    const mods = await loadModules();
    const h = createRoomJoinHarness(mods);
    h.state.roomId = 'sala-atual';
    h.state.pendingRoomJoin = { roomId: 'sala-cancelada', password: '', userName: 'Pedro', inFlight: false };

    h.roomModalCtrl.checkCreateRoomStatus('  Sala Teste!!  ');
    h.roomModalCtrl.checkJoinRoomStatus('  Sala Outro  ');

    assert.equal(h.emittedEvents.length, 2);
    assert.equal(h.emittedEvents[0].payload.roomId, mods.sanitizeRoomId('  Sala Teste!!  '));
    assert.equal(h.emittedEvents[1].payload.roomId, mods.sanitizeRoomId('  Sala Outro  '));

    h.roomModalCtrl.closeRoomModal();
    assert.equal(h.state.pendingRoomJoin, null);
});

test('T6: closeRoomModal preserves in-flight join-room and reconciles on room-users', async () => {
    const mods = await loadModules();
    const h = createRoomJoinHarness(mods);
    h.state.roomId = 'sala-a';
    h.state.localStream = new MockMediaStream([]);

    h.roomModalCtrl.joinRoom('sala-b', 'senha-b', 'Pedro');
    assert.equal(h.emittedEvents.length, 1);

    h.roomModalCtrl.closeRoomModal();
    assert.notEqual(h.state.pendingRoomJoin, null, 'In-flight join-room must not be cleared when closing modal');

    await h.mesh.handleRoomUsers({
        users: ['peer-b'],
        userNames: { 'peer-b': 'Ana' },
        activeStreams: [],
        socketId: 'sock-1',
        memberCount: 2,
        hasPassword: true
    });

    assert.equal(h.getCleanupCalls(), 1);
    assert.equal(h.state.roomId, 'sala-b');
    assert.equal(h.dom.displayRoomId.textContent, 'sala-b');
});

test('T7 (room-join): Reconnect handleJoinError clears displayRoomId & STORAGE_KEY, and stale check-room responses are ignored', async () => {
    const mods = await loadModules();
    const h = createRoomJoinHarness(mods);

    // Parte 1: erro de reconexão quando membership não está confirmado limpa UI e storage
    h.state.roomId = 'sala-expirada';
    h.state.currentRoomPassword = 'segredo';
    h.dom.displayRoomId.textContent = 'sala-expirada';
    h.storage.setItem(h.STORAGE_KEY, 'sala-expirada');
    h.mesh.membership.isRoomMembershipConfirmed = false;

    h.roomModalCtrl.handleJoinError({ error: 'invalid_password', message: 'Senha alterada' });
    assert.equal(h.state.roomId, '');
    assert.equal(h.dom.displayRoomId.textContent, '------');
    assert.equal(h.storage.getItem(h.STORAGE_KEY), null);

    // Parte 2: resposta stale de check-room é ignorada quando input mudou
    const callbacks = [];
    h.socket.emit = (ev, payload, cb) => {
        if (ev === 'check-room' && typeof cb === 'function') {
            callbacks.push({ roomId: payload.roomId, cb });
        }
    };
    h.dom.inputJoinRoomId.value = 'sala-velha';
    h.roomModalCtrl.checkJoinRoomStatus('sala-velha');
    h.dom.inputJoinRoomId.value = 'sala-nova';
    h.roomModalCtrl.checkJoinRoomStatus('sala-nova');

    callbacks[0].cb({ exists: true, memberCount: 5, hasPassword: true });
    assert.equal(h.dom.joinRoomStatusIndicator.innerHTML, '', 'Resposta antiga não pode sobrescrever input novo');

    callbacks[1].cb({ exists: false, memberCount: 0, hasPassword: false });
    assert.match(h.dom.joinRoomStatusIndicator.innerHTML, /Sala vazia/);
});

test('T3 (instance): updateStatsDisplay displays SERVER_URL and resetSavedSignalingServerUrl clears localStorage override', async () => {
    const { createStatsModalController, SERVER_URL_STORAGE_KEY } = await loadModules('inst');
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

test('T4 (instance): Cold start notice triggers after 3000ms and cancels cleanly on connect / connect_error', async () => {
    const { COLD_START_NOTICE_DELAY_MS, initApp } = await loadModules('inst');
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
            fetchImpl: async () => ({ ok: false, status: 503 }),
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
            fetchImpl: async () => ({ ok: false, status: 503 }),
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
            fetchImpl: async () => ({ ok: false, status: 503 }),
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

test('T5 (instance): sessionStorage preserves room password across F5 reload and clears on join-error / public room', async () => {
    const {
        SESSION_PASS_STORAGE_KEY,
        saveSessionRoomPassword,
        getSessionRoomPassword,
        initApp
    } = await loadModules('inst');

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
            fetchImpl: async () => ({ ok: false, status: 503 }),
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

test('T7 (instance): saveCustomSignalingServerUrl validates URLs and stats-modal saves/reloads via inputCustomServerUrl & btnSaveServerUrl', async () => {
    const {
        createStatsModalController,
        saveCustomSignalingServerUrl,
        SERVER_URL_STORAGE_KEY
    } = await loadModules('inst');

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

test('shareConfigModal closes on backdrop click (e.target === shareConfigModal) and stays open on inner click', async () => {
    const { createShareConfigModalController } = await loadModules('escape');
    const shareConfigModal = createMockElement('div', { id: 'shareConfigModal' });
    const innerCard = createMockElement('div', { className: 'modal-card' });
    shareConfigModal.appendChild(innerCard);

    const doc = createMockDocument({ shareConfigModal });
    const ctrl = createShareConfigModalController({
        state: { selectedVideoResolution: '1080p', selectedVideoFps: 60 },
        dom: { shareConfigModal },
        isDesktopApp: () => false,
        documentObj: doc,
        storage: createMockStorage()
    });
    ctrl.bindEvents();

    ctrl.openShareConfigModal();
    assert.equal(ctrl.isShareConfigModalOpen(), true);

    // Click inside modal content must NOT close
    shareConfigModal.dispatchEvent({ type: 'click', target: innerCard });
    assert.equal(ctrl.isShareConfigModalOpen(), true, 'Clicking inside modal card must keep modal open');

    // Click directly on backdrop closes modal
    shareConfigModal.dispatchEvent({ type: 'click', target: shareConfigModal });
    assert.equal(ctrl.isShareConfigModalOpen(), false, 'Backdrop click must close shareConfigModal');
});

test('Escape key closes open shareConfigModal via initApp keydown handler', async () => {
    const { initApp } = await loadModules('escape');
    const winListeners = {};
    const shareConfigModal = createMockElement('div', { id: 'shareConfigModal' });
    const statsModal = createMockElement('div', { id: 'statsModal', style: { display: 'none' }, hidden: true });
    const roomModal = createMockElement('div', { id: 'roomModal', style: { display: 'none' }, hidden: true });
    const fakeDoc = createMockDocument({ shareConfigModal, statsModal, roomModal }, {
        createElement: (tag) => createMockElement(tag)
    });

    const app = initApp({
        windowObj: {
            location: { protocol: 'http:', origin: 'http://localhost:3000', pathname: '/', search: '', hash: '' },
            addEventListener(ev, fn) { winListeners[ev] = fn; },
            removeEventListener() {},
            matchMedia: () => ({ matches: false })
        },
        documentObj: fakeDoc,
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => createMockSocket({ id: 's1', connected: false }),
        fetchImpl: async () => ({ ok: false, status: 503 }),
        serverUrl: 'http://localhost:3000'
    });

    try {
        app.shareConfigCtrl.openShareConfigModal();
        assert.equal(app.shareConfigCtrl.isShareConfigModalOpen(), true);

        assert.equal(typeof winListeners.keydown, 'function', 'initApp must register Escape keydown listener');
        winListeners.keydown({ key: 'Escape' });

        assert.equal(app.shareConfigCtrl.isShareConfigModalOpen(), false, 'Escape key must close open shareConfigModal');
    } finally {
        app.teardownClientSession();
    }
});
