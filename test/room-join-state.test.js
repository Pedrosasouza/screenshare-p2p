'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');

async function loadModules() {
    const [roomModalMod, webrtcMod, prefsMod, roomUtilsMod, appMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/room-modal.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/preferences.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/room-utils.js')).href),
        import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?rjs=${Date.now()}`)
    ]);
    return { ...roomModalMod, ...webrtcMod, ...prefsMod, ...roomUtilsMod, ...appMod };
}

function createRoomJoinHarness(mods) {
    const storage = createMockStorage();
    const emittedEvents = [];
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

    const socket = {
        id: 'sock-1',
        connected: true,
        emit(event, payload, cb) {
            emittedEvents.push({ event, payload, hasCb: typeof cb === 'function' });
        }
    };

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

test('T3: room-users confirmation runs cleanupRoomState, updates state, pushes URL, and closes modal', async () => {
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

test('T4: socket connect with pendingRoomJoin prioritizes pending room over previous room', async () => {
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

test('T5: Status checkers sanitize roomId and closeRoomModal cancels offline pendingRoomJoin', async () => {
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
