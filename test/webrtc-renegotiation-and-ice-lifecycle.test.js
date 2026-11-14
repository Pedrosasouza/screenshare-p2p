'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockTrack,
    createMockSender,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');

async function loadModules() {
    const [webrtcMod, shareMod, appMod, iceMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/screen-share.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/room-utils.js')).href),
        import(`${pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/ice-config.js')).href}?reneg=${Date.now()}`)
    ]);
    return { webrtcMod, shareMod, appMod, iceMod };
}

function createMeshEnv(createWebRtcMesh, overrides = {}) {
    const emitted = [];
    const socket = overrides.socket || {
        id: overrides.myId || 'me-1',
        emit(event, payload) {
            emitted.push({ event, payload });
        }
    };
    const state = {
        myId: socket.id,
        roomId: 'room-init',
        currentRoomPassword: '',
        currentUserName: 'Pedro',
        pendingRoomJoin: null,
        localStream: null,
        selectedVideoFps: 60,
        contentHintMode: 'motion',
        ...(overrides.state || {})
    };
    const streamGrid = createMockElement('div', { id: 'streamGrid' });
    const displayRoomId = createMockElement('span', { id: 'displayRoomId' });
    const dom = {
        streamGrid,
        displayRoomId,
        btnStartShare: createMockElement('button', { id: 'btnStartShare' }),
        btnStopShare: createMockElement('button', { id: 'btnStopShare' }),
        btnQualityToggle: createMockElement('button', { id: 'btnQualityToggle' }),
        ...(overrides.dom || {})
    };
    const doc = overrides.documentObj || createMockDocument({
        streamGrid,
        displayRoomId,
        btnStartShare: dom.btnStartShare,
        btnStopShare: dom.btnStopShare,
        btnQualityToggle: dom.btnQualityToggle
    });

    const createdPcs = [];
    class FakePeerConnection {
        constructor(cfg) {
            const pc = overrides.pcFactory ? overrides.pcFactory(cfg) : createMockPeerConnection();
            createdPcs.push(pc);
            return pc;
        }
    }

    const cleanupCalls = [];
    const gridStub = overrides.grid || {
        updateMemberCount: () => {},
        updateGridState: () => {},
        updateEchoWarningVisibility: () => {},
        updatePeerUserName: () => {},
        createStreamTile: (peerId) => createMockElement('div', { id: `tile-${peerId}`, className: 'stream-tile' }),
        startTilePlayback: () => {}
    };
    const screenShareStub = overrides.screenShare || {
        invalidateGeneration: () => {},
        stopScreenShare: (opts) => {
            cleanupCalls.push(opts || {});
            if (state.localStream) {
                state.localStream.getTracks().forEach((t) => t.stop());
                state.localStream = null;
            }
        }
    };

    const mesh = createWebRtcMesh({
        state,
        dom,
        getSocket: () => socket,
        getQosMonitor: () => ({
            configureSenderParams: () => {},
            updateSendersForActivePeers: () => {}
        }),
        getGrid: () => gridStub,
        getScreenShare: () => screenShareStub,
        getRoomModal: () => overrides.roomModal || {
            closeRoomModal: () => {},
            updateRoomModalCloseButton: () => {}
        },
        getServerUrl: () => (overrides.serverUrl !== undefined ? overrides.serverUrl : 'https://screenshare-p2p.onrender.com'),
        rtcConfig: overrides.rtcConfig || { iceServers: [] },
        refreshIceServers: overrides.refreshIceServers || (async () => {}),
        scheduleIceRefreshTimer: overrides.scheduleIceRefreshTimer || (() => {}),
        registerFullscreenChangeHandler: () => {},
        saveSessionRoomPassword: () => {},
        clearSessionRoomPassword: () => {},
        showToast: () => {},
        playPresenceChime: () => {},
        RTCPeerConnectionCtor: FakePeerConnection,
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: doc,
        windowObj: overrides.windowObj || {
            location: { protocol: 'http:', pathname: '/' },
            history: { pushState: () => {} },
            addEventListener: () => {}
        },
        storage: createMockStorage()
    });

    return { mesh, state, socket, emitted, dom, doc, createdPcs, cleanupCalls };
}

test('T1: handleStreamState stopped preserves remote track and started recreates tile from getReceivers()', async () => {
    const { webrtcMod } = await loadModules();
    const { mesh } = createMeshEnv(webrtcMod.createWebRtcMesh);

    const remoteVideoTrack = createMockTrack('video', 'remote-v1');
    const pc = createMockPeerConnection({
        connectionState: 'connected',
        receivers: [{ track: remoteVideoTrack }]
    });
    mesh.peers.set('peer-a', {
        userName: 'Alice',
        pc,
        stream: new MockMediaStream([remoteVideoTrack]),
        tileEl: createMockElement('div', { className: 'stream-tile' })
    });

    mesh.handleStreamState({ senderId: 'peer-a', state: 'stopped' });
    assert.equal(remoteVideoTrack.stopped, false, 'removeStreamTile must never stop remote track');
    assert.equal(mesh.peers.get('peer-a').tileEl, null, 'Tile must be cleared on stopped');

    mesh.handleStreamState({ senderId: 'peer-a', state: 'started' });
    assert.notEqual(mesh.peers.get('peer-a').tileEl, null, 'stream-state:started must recreate tile via getReceivers()');
    assert.equal(mesh.peers.get('peer-a').stream.getVideoTracks().length, 1);
});

test('T2: addLocalTracksToPC promotes recvonly transceiver to sendrecv without duplicate addTrack', async () => {
    const { webrtcMod } = await loadModules();
    const localVideo = createMockTrack('video', 'local-v1');
    const { mesh } = createMeshEnv(webrtcMod.createWebRtcMesh, {
        state: { localStream: new MockMediaStream([localVideo]) }
    });

    const sender = createMockSender(null);
    const recvonlyTransceiver = {
        direction: 'recvonly',
        currentDirection: 'recvonly',
        receiver: { track: { id: 'remote-v1', kind: 'video' } },
        sender
    };
    const pc = createMockPeerConnection({
        senders: [sender],
        transceivers: [recvonlyTransceiver]
    });
    pc.addTrack = () => {
        throw new Error('Should reuse existing transceiver instead of calling addTrack');
    };

    mesh.addLocalTracksToPC(pc);
    assert.equal(sender.track, localVideo);
    assert.equal(recvonlyTransceiver.direction, 'sendrecv');
});

test('T3: sendOffer queues pendingOffer when makingOffer is active and dispatches once stable', async () => {
    const { webrtcMod } = await loadModules();
    let resolveGate;
    const gate = new Promise((r) => { resolveGate = r; });
    let offerCount = 0;

    const pc = createMockPeerConnection({ connectionState: 'connected' });
    pc.createOffer = async () => {
        offerCount += 1;
        if (offerCount === 1) await gate;
        return { type: 'offer', sdp: `v=0\r\noffer-${offerCount}` };
    };

    const { mesh, emitted } = createMeshEnv(webrtcMod.createWebRtcMesh);
    const peerObj = {
        pc,
        stream: new MockMediaStream(),
        makingOffer: false,
        pendingOffer: false,
        iceCandidateQueue: [],
        _signalChain: Promise.resolve()
    };
    mesh.peers.set('p1', peerObj);

    const firstRun = mesh.sendOffer('p1');
    await new Promise((r) => setTimeout(r, 5));
    await mesh.sendOffer('p1');
    assert.equal(peerObj.pendingOffer, true, 'Concurrent sendOffer must queue pendingOffer');

    resolveGate();
    await firstRun;
    await new Promise((r) => setTimeout(r, 15));

    const sentOffers = emitted.filter((e) => e.event === 'signal');
    assert.equal(sentOffers.length, 2, 'Queued pendingOffer must dispatch after first offer completes');
    assert.equal(peerObj.pendingOffer, false);
});

test('T4: handleSignal ignores candidates when ignoreOffer=true and blocks zombie signals after user-left', async () => {
    const { webrtcMod } = await loadModules();
    const { mesh } = createMeshEnv(webrtcMod.createWebRtcMesh, {
        myId: 'z-impolite' // 'z-impolite' > 'a-peer' => isPolite = false
    });
    mesh.activeRoomPeers.add('a-peer');
    mesh.membership.hasRoomMembershipSnapshot = true;

    const pcA = mesh.getOrCreatePeerConnection('a-peer');
    pcA.signalingState = 'have-local-offer';
    const peerObjA = mesh.peers.get('a-peer');
    assert.equal(peerObjA.isPolite, false);

    mesh.handleSignal({ senderId: 'a-peer', signal: { type: 'offer', sdp: 'v=0\r\nignored' } });
    await peerObjA._signalChain;
    assert.equal(peerObjA.ignoreOffer, true);

    mesh.handleSignal({ senderId: 'a-peer', signal: { candidate: { candidate: 'cand-from-ignored-offer', sdpMid: '0' } } });
    await peerObjA._signalChain;
    assert.equal(peerObjA.iceCandidateQueue.length, 0);
    assert.equal(pcA.addedCandidates.length, 0);

    mesh.handleUserLeft({ socketId: 'a-peer', memberCount: 1 });
    assert.equal(mesh.peers.has('a-peer'), false);

    mesh.handleSignal({ senderId: 'a-peer', signal: { candidate: { candidate: 'zombie-cand', sdpMid: '0' } } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(mesh.peers.has('a-peer'), false, 'Delayed signal after user-left must not recreate zombie PeerConnection');
});

test('T5: app.js passes { peers } to refreshIceServers and viewer without localStream triggers ICE restart on failure', async () => {
    const { webrtcMod } = await loadModules();
    const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/app.js'), 'utf8');
    assert.match(appSrc, /refreshIceServers\s*\(\s*serverUrl\s*,\s*\{\s*peers:\s*webrtc\.peers\s*\}\s*\)/);

    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    let triggerRestart = null;
    global.setTimeout = (fn) => {
        triggerRestart = fn;
        return 1234;
    };
    global.clearTimeout = () => {};

    try {
        const pc = createMockPeerConnection();
        const { mesh, emitted } = createMeshEnv(webrtcMod.createWebRtcMesh, {
            myId: 'viewer-1',
            state: { localStream: null },
            pcFactory: () => pc
        });
        mesh.getOrCreatePeerConnection('broadcaster-1');
        pc.iceConnectionState = 'failed';
        pc.oniceconnectionstatechange();

        assert.equal(typeof triggerRestart, 'function');
        triggerRestart();
        await new Promise((r) => origSetTimeout(r, 15));

        assert.equal(pc.iceRestarts, 1, 'Viewer must trigger restartIce() on ICE failure');
        assert.ok(
            emitted.some((e) => e.event === 'signal' && e.payload.targetId === 'broadcaster-1' && e.payload.signal.type === 'offer'),
            'Viewer must send offer on ICE restart'
        );
    } finally {
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
    }
});

test('T6: Room switch performs silent cleanup without leaking stream-state, and pagehide triggers teardown', async () => {
    const { webrtcMod } = await loadModules();
    const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/app.js'), 'utf8');
    assert.ok(appSrc.includes("windowObj.addEventListener('pagehide'"), 'app.js must bind pagehide teardown');

    const localTrack = createMockTrack('video', 'local-old');
    const oldPc = createMockPeerConnection();
    let oldClosed = false;
    oldPc.close = () => { oldClosed = true; };

    const { mesh, emitted, cleanupCalls } = createMeshEnv(webrtcMod.createWebRtcMesh, {
        myId: 'me',
        state: {
            roomId: 'sala-antiga',
            localStream: new MockMediaStream([localTrack]),
            pendingRoomJoin: { roomId: 'sala-nova', password: '', userName: 'Pedro' }
        }
    });
    mesh.peers.set('old-peer', { pc: oldPc, stream: null, tileEl: null });
    mesh.remoteActiveStreams.add('old-peer');

    await mesh.handleRoomUsers({
        users: [],
        userNames: {},
        activeStreams: [],
        socketId: 'me',
        memberCount: 1,
        hasPassword: false
    });

    assert.equal(localTrack.stopped, true, 'Previous localStream must stop when switching rooms');
    assert.equal(oldClosed, true, 'Previous peer connection must close when switching rooms');
    assert.ok(cleanupCalls.some((c) => c.silent === true), 'Room switch must call stopScreenShare({ silent: true })');
    assert.equal(emitted.filter((e) => e.event === 'stream-state').length, 0, 'Room switch must not leak stream-state to new room');
});

test('T7: stopScreenShare awaits all replaceTrack(null) promises before sendOffer and skips closed peers', async () => {
    const { shareMod } = await loadModules();
    let resolve1, resolve2;
    const p1 = new Promise((r) => { resolve1 = r; });
    const p2 = new Promise((r) => { resolve2 = r; });

    const s1 = createMockSender(createMockTrack('video', 'v1'));
    s1.replaceTrack = (t) => { s1.track = t; return p1; };
    const s2 = createMockSender(createMockTrack('audio', 'a1'));
    s2.replaceTrack = (t) => { s2.track = t; return p2; };
    const sClosed = createMockSender(createMockTrack('video', 'vc'));

    const pcOpen = createMockPeerConnection({
        connectionState: 'connected',
        senders: [s1, s2],
        transceivers: [
            { sender: s1, direction: 'sendrecv' },
            { sender: s2, direction: 'sendonly' }
        ]
    });
    const pcClosed = createMockPeerConnection({
        connectionState: 'closed',
        signalingState: 'closed',
        senders: [sClosed],
        transceivers: [{ sender: sClosed, direction: 'sendonly' }]
    });

    const peers = new Map([
        ['peer-open', { pc: pcOpen }],
        ['peer-closed', { pc: pcClosed }]
    ]);
    const sentOffers = [];
    const controller = shareMod.createScreenShareController({
        state: { roomId: 'room-1', localStream: new MockMediaStream([createMockTrack('video', 'v-loc')]) },
        dom: {
            btnStartShare: createMockElement('button'),
            btnStopShare: createMockElement('button'),
            btnQualityToggle: createMockElement('button')
        },
        getSocket: () => ({ emit: () => {} }),
        getPeers: () => peers,
        getWebRtc: () => ({ sendOffer: (id) => { sentOffers.push(id); } }),
        getGrid: () => ({ updateGridState: () => {} }),
        getQosMonitor: () => ({ stopQualityMonitor: () => {} }),
        startExcludeDiscordCapture: async () => {},
        startAppAudioCapture: async () => {},
        stopAppAudioCapture: () => {},
        showToast: () => {},
        documentObj: createMockDocument(),
        navigatorObj: {},
        MediaStreamCtor: MockMediaStream
    });

    const stopPromise = controller.stopScreenShare();
    assert.equal(sentOffers.length, 0, 'sendOffer must wait for replaceTrack(null)');

    resolve1();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sentOffers.length, 0, 'sendOffer must wait for all replaceTrack(null) promises');

    resolve2();
    await stopPromise;
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(sentOffers, ['peer-open']);
    assert.equal(s1.track, null);
    assert.equal(s2.track, null);
});

test('T8: socket connect awaits refreshIceServers before scheduleIceRefreshTimer uses server TTL', async () => {
    const appMod = await import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?t8=${Date.now()}`);
    let resolveFetch;
    const fetchGate = new Promise((r) => { resolveFetch = r; });

    const origFetch = global.fetch;
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const scheduledDelays = [];

    global.fetch = async () => {
        await fetchGate;
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    provider: 'cloudflare',
                    ttlSeconds: 14400,
                    iceServers: [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'p' }]
                };
            }
        };
    };
    global.setTimeout = (fn, ms, ...args) => {
        if (ms > 10000) {
            scheduledDelays.push(ms);
            return 9000 + scheduledDelays.length;
        }
        return origSetTimeout(fn, ms, ...args);
    };
    global.clearTimeout = (id) => {
        if (id >= 9000) return;
        return origClearTimeout(id);
    };

    const socketHandlers = {};
    const fakeSocket = {
        id: 'sock-1',
        on(ev, fn) { socketHandlers[ev] = fn; },
        emit() {},
        disconnect() {}
    };
    const doc = createMockDocument({}, { createElement: () => createMockElement('div') });
    const app = appMod.initApp({
        windowObj: {
            location: { protocol: 'http:', origin: 'https://screenshare-p2p.onrender.com', pathname: '/', search: '', hash: '' },
            addEventListener: () => {},
            removeEventListener: () => {},
            matchMedia: () => ({ matches: false })
        },
        documentObj: doc,
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => fakeSocket,
        serverUrl: 'https://screenshare-p2p.onrender.com'
    });

    try {
        socketHandlers.connect();
        assert.equal(scheduledDelays.length, 0, 'Must not schedule ICE refresh timer before refreshIceServers resolves');

        resolveFetch();
        await new Promise((r) => origSetTimeout(r, 25));

        assert.equal(scheduledDelays.length, 1, 'Should schedule ICE timer after refreshIceServers settles');
        assert.ok(scheduledDelays[0] > 10_000_000, `Expected ~3h55m timer for ttl=14400s, got ${scheduledDelays[0]}`);
    } finally {
        app.teardownClientSession();
        global.fetch = origFetch;
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
    }
});

test('T9: handleDesktopCaptureStopped stops WASAPI audio track, preserves video, and renegotiates peers', async () => {
    const { shareMod } = await loadModules();
    const desktopAudioSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/js/modules/desktop-audio.js'), 'utf8');
    assert.ok(desktopAudioSrc.includes('_isDesktopWasapiTrack'));

    const videoTrack = createMockTrack('video', 'v1');
    const audioTrack = createMockTrack('audio', 'a1', { _isDesktopWasapiTrack: true });

    let resolveAudioReplace;
    const audioReplacePromise = new Promise((r) => { resolveAudioReplace = r; });
    const videoSender = createMockSender(videoTrack);
    videoSender.replaceTrack = () => { throw new Error('Must not clear video sender'); };
    const audioSender = createMockSender(audioTrack);
    audioSender.replaceTrack = (t) => { audioSender.track = t; return audioReplacePromise; };
    const videoTransceiver = { direction: 'sendrecv', sender: videoSender };
    const audioTransceiver = { direction: 'sendrecv', sender: audioSender };

    const pc = createMockPeerConnection({
        connectionState: 'connected',
        senders: [videoSender, audioSender],
        transceivers: [videoTransceiver, audioTransceiver]
    });
    const peers = new Map([['peer-1', { pc }]]);
    const localStream = new MockMediaStream([videoTrack, audioTrack]);
    const sentOffers = [];
    const toasts = [];

    const controller = shareMod.createScreenShareController({
        state: { roomId: 'room-1', localStream },
        dom: {},
        getSocket: () => ({ emit: () => {} }),
        getPeers: () => peers,
        getWebRtc: () => ({ sendOffer: (id) => { sentOffers.push(id); } }),
        getGrid: () => null,
        getQosMonitor: () => null,
        startExcludeDiscordCapture: async () => {},
        startAppAudioCapture: async () => {},
        stopAppAudioCapture: () => {},
        showToast: (msg, type) => toasts.push({ msg, type }),
        documentObj: createMockDocument(),
        navigatorObj: {},
        MediaStreamCtor: MockMediaStream
    });

    const done = controller.handleDesktopCaptureStopped({ pid: 4321, reason: 'process_exited' });
    assert.equal(toasts.length, 1);
    assert.equal(audioTrack.stopped, true);
    assert.equal(videoTrack.stopped, false);
    assert.equal(localStream.getAudioTracks().length, 0);
    assert.equal(localStream.getVideoTracks().length, 1);
    assert.equal(audioTransceiver.direction, 'recvonly');
    assert.equal(sentOffers.length, 0, 'sendOffer must await replaceTrack(null) completion');

    resolveAudioReplace();
    await done;
    assert.deepEqual(sentOffers, ['peer-1']);
    assert.equal(audioSender.track, null);
});

test('T10: handleRoomUsers applies snapshot before await refreshIceServers and preserves concurrent events', async () => {
    const { webrtcMod } = await loadModules();
    let resolveIceGate;
    const iceGate = new Promise((r) => { resolveIceGate = r; });

    const { mesh } = createMeshEnv(webrtcMod.createWebRtcMesh, {
        myId: 'sock-old',
        state: {
            roomId: 'sala-antiga',
            pendingRoomJoin: { roomId: 'sala-nova', password: '', userName: 'Pedro' }
        },
        refreshIceServers: async () => { await iceGate; }
    });

    mesh.peers.set('old-peer', { pc: createMockPeerConnection(), stream: new MockMediaStream(), tileEl: null });
    mesh.activeRoomPeers.add('old-peer');
    mesh.remoteActiveStreams.add('old-peer');
    mesh.membership.hasRoomMembershipSnapshot = true;
    mesh.membership.lastJoinedSocketId = 'sock-old';

    const roomUsersPromise = mesh.handleRoomUsers({
        users: ['peer-b', 'sock-old'],
        userNames: { 'peer-b': 'Bob' },
        activeStreams: ['peer-b'],
        socketId: 'sock-old',
        memberCount: 2,
        hasPassword: false
    });

    mesh.handleSignal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'v=0\r\noffer-from-b' } });
    mesh.handleUserJoined({ socketId: 'peer-c', userName: 'Carol', memberCount: 3 });
    mesh.handleStreamState({ senderId: 'peer-c', state: 'started' });
    mesh.handleUserLeft({ socketId: 'peer-b', memberCount: 2 });

    resolveIceGate();
    await roomUsersPromise;

    assert.equal(mesh.peers.has('old-peer'), false, 'old-peer must be removed');
    assert.equal(mesh.peers.has('peer-b'), false, 'peer-b that left during await must not be resurrected');
    assert.equal(mesh.peers.has('peer-c'), true, 'peer-c that joined during await must be retained');
    assert.equal(mesh.activeRoomPeers.has('peer-c'), true);
    assert.equal(mesh.remoteActiveStreams.has('peer-c'), true);
    assert.equal(mesh.remoteActiveStreams.has('peer-b'), false);
});

test('T11: Reconnect with new socketId closes stale PCs, recalculates isPolite, sends new offer, and re-emits stream-state', async () => {
    const { webrtcMod } = await loadModules();
    const oldPc = createMockPeerConnection();
    const localVideo = createMockTrack('video', 'v1');

    const { mesh, emitted } = createMeshEnv(webrtcMod.createWebRtcMesh, {
        myId: 'a-new-id', // 'a-new-id' < 'm-peer' => true
        serverUrl: '', // skip ICE refresh delay
        state: {
            roomId: 'sala-1',
            localStream: new MockMediaStream([localVideo])
        }
    });
    mesh.membership.lastJoinedSocketId = 'z-old-id'; // previously 'z-old-id' < 'm-peer' => false
    mesh.peers.set('m-peer', { pc: oldPc, stream: new MockMediaStream(), tileEl: null, isPolite: false });

    await mesh.handleRoomUsers({
        users: ['m-peer', 'a-new-id'],
        userNames: { 'm-peer': 'Maria' },
        activeStreams: [],
        socketId: 'a-new-id',
        memberCount: 2,
        hasPassword: false
    });
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(oldPc.closed, true, 'Stale PeerConnection from previous socket must be closed');
    const currentPeer = mesh.peers.get('m-peer');
    assert.ok(currentPeer && currentPeer.pc !== oldPc);
    assert.equal(currentPeer.isPolite, true);
    assert.ok(emitted.some((e) => e.event === 'signal' && e.payload.targetId === 'm-peer' && e.payload.signal.type === 'offer'));
    assert.ok(emitted.some((e) => e.event === 'stream-state' && e.payload.roomId === 'sala-1' && e.payload.state === 'started'));
});

test('T12: updateBackgroundTracksOptimization keeps Picture-in-Picture track active while pausing hidden background tracks', async () => {
    const { webrtcMod } = await loadModules();
    const pipTrack = createMockTrack('video', 'v-pip');
    const bgTrack = createMockTrack('video', 'v-bg');
    const pipVideoEl = createMockElement('video', { id: 'vid-pip' });
    const bgVideoEl = createMockElement('video', { id: 'vid-bg' });

    const pipTileEl = createMockElement('div');
    pipTileEl.dataset.peerId = 'peer-pip';
    pipTileEl.contains = (el) => el === pipVideoEl;
    pipTileEl.querySelector = (sel) => (sel === 'video' ? pipVideoEl : null);

    const bgTileEl = createMockElement('div');
    bgTileEl.dataset.peerId = 'peer-bg';
    bgTileEl.contains = (el) => el === bgVideoEl;
    bgTileEl.querySelector = (sel) => (sel === 'video' ? bgVideoEl : null);

    const doc = createMockDocument();
    doc.hidden = true;
    doc.fullscreenElement = null;
    doc.pictureInPictureElement = pipVideoEl;

    const { mesh } = createMeshEnv(webrtcMod.createWebRtcMesh, { documentObj: doc });
    mesh.peers.set('peer-pip', { pc: createMockPeerConnection(), tileEl: pipTileEl, stream: new MockMediaStream([pipTrack]) });
    mesh.peers.set('peer-bg', { pc: createMockPeerConnection(), tileEl: bgTileEl, stream: new MockMediaStream([bgTrack]) });

    mesh.updateBackgroundTracksOptimization();
    assert.equal(pipTrack.enabled, true, 'PiP track must stay enabled when document is hidden');
    assert.equal(bgTrack.enabled, false, 'Non-PiP background tracks must pause when hidden');
});

test('T13: handleRoomUsers avoids duplicate offer for concurrent user-joined and applies setConfiguration before setRemoteDescription', async () => {
    const { webrtcMod } = await loadModules();
    let resolveIce;
    const iceGate = new Promise((r) => { resolveIce = r; });
    const opLog = [];
    const rtcConfigObj = { iceServers: [{ urls: 'stun:fallback' }] };

    const { mesh, emitted } = createMeshEnv(webrtcMod.createWebRtcMesh, {
        myId: 'me-13',
        rtcConfig: rtcConfigObj,
        state: {
            roomId: 'sala-t13',
            localStream: new MockMediaStream([createMockTrack('video', 'v1')])
        },
        refreshIceServers: async () => {
            await iceGate;
            rtcConfigObj.iceServers = [{ urls: 'turns:cf.turn:443' }];
        },
        pcFactory: () => {
            const pc = createMockPeerConnection();
            pc.setConfiguration = (cfg) => {
                opLog.push({ op: 'setConfiguration', urls: cfg && cfg.iceServers ? cfg.iceServers[0].urls : null });
            };
            pc.setRemoteDescription = async (desc) => {
                opLog.push({ op: 'setRemoteDescription', type: desc && desc.type });
                pc.remoteDescription = desc;
            };
            return pc;
        }
    });

    const roomUsersPromise = mesh.handleRoomUsers({
        users: ['peer-a'],
        userNames: { 'peer-a': 'Alice' },
        activeStreams: ['peer-a'],
        socketId: 'me-13',
        memberCount: 2,
        hasPassword: false
    });

    mesh.handleSignal({ senderId: 'peer-a', signal: { type: 'offer', sdp: 'v=0\r\n' } });
    mesh.handleUserJoined({ socketId: 'peer-d', userName: 'Daniel', memberCount: 3 });

    await new Promise((r) => setTimeout(r, 15));
    assert.equal(
        emitted.filter((e) => e.event === 'signal' && e.payload.targetId === 'peer-d' && e.payload.signal.type === 'offer').length,
        1,
        'Concurrent user-joined must send 1 offer immediately'
    );

    resolveIce();
    await roomUsersPromise;
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
        emitted.filter((e) => e.event === 'signal' && e.payload.targetId === 'peer-d' && e.payload.signal.type === 'offer').length,
        1,
        'peer-d must NOT receive a duplicate offer once handleRoomUsers resumes'
    );

    const idxSetCfg = opLog.findIndex((o) => o.op === 'setConfiguration' && o.urls === 'turns:cf.turn:443');
    const idxSetRemote = opLog.findIndex((o) => o.op === 'setRemoteDescription');
    assert.ok(idxSetCfg !== -1 && idxSetRemote !== -1);
    assert.ok(idxSetCfg < idxSetRemote, 'setConfiguration with updated TURN must run before setRemoteDescription');
});
