'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { isValidSignal } = require('../src/server/signaling');
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
    const webrtcUrl = pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js')).href;
    const shareUrl = pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/screen-share.js')).href;
    const [webrtcMod, shareMod] = await Promise.all([import(webrtcUrl), import(shareUrl)]);
    return { ...webrtcMod, ...shareMod };
}

function createMeshFixture(createWebRtcMesh, options = {}) {
    const emitted = [];
    const socket = {
        id: options.myId || 'peer-a',
        emit(event, data) {
            emitted.push({ event, data });
        }
    };
    const state = {
        myId: socket.id,
        roomId: 'room-1',
        localStream: options.localStream || null,
        selectedVideoFps: 60,
        contentHintMode: 'motion'
    };
    const streamGrid = createMockElement('div', { id: 'streamGrid' });
    const dom = {
        streamGrid,
        btnStartShare: createMockElement('button', { id: 'btnStartShare' }),
        btnStopShare: createMockElement('button', { id: 'btnStopShare' }),
        btnQualityToggle: createMockElement('button', { id: 'btnQualityToggle' })
    };
    const doc = createMockDocument({
        streamGrid,
        btnStartShare: dom.btnStartShare,
        btnStopShare: dom.btnStopShare,
        btnQualityToggle: dom.btnQualityToggle
    });

    class FakePeerConnection {
        constructor() {
            return options.pcFactory ? options.pcFactory() : createMockPeerConnection();
        }
    }

    const mesh = createWebRtcMesh({
        state,
        dom,
        getSocket: () => socket,
        getQosMonitor: () => ({ configureSenderParams: () => {} }),
        getGrid: () => ({
            updateMemberCount: () => {},
            updateGridState: () => {},
            updateEchoWarningVisibility: () => {},
            updatePeerUserName: () => {},
            createStreamTile: () => createMockElement('div'),
            startTilePlayback: () => {}
        }),
        getScreenShare: () => ({ invalidateGeneration: () => {}, stopScreenShare: () => {} }),
        getRoomModal: () => null,
        getServerUrl: () => 'http://localhost:3000',
        rtcConfig: { iceServers: [] },
        refreshIceServers: async () => {},
        scheduleIceRefreshTimer: () => {},
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
        windowObj: { addEventListener: () => {}, removeEventListener: () => {} },
        storage: createMockStorage()
    });

    return { mesh, state, socket, emitted, dom, doc };
}

test('isValidSignal accepts request-keyframe and offer while rejecting invalid payloads', () => {
    assert.equal(isValidSignal({ type: 'request-keyframe' }), true);
    assert.equal(isValidSignal({ type: 'offer', sdp: 'v=0...' }), true);
    assert.equal(isValidSignal({ type: 'invalid-type' }), false);
    assert.equal(isValidSignal({ foo: 'bar' }), false);
});

test('addLocalTracksToPC reuses existing empty video transceiver/sender via replaceTrack without duplicate addTrack', async () => {
    const { createWebRtcMesh } = await loadModules();
    const vTrack = createMockTrack('video', 'v-live');
    const localStream = new MockMediaStream([vTrack]);

    const { mesh } = createMeshFixture(createWebRtcMesh, { localStream });

    const sender = createMockSender(null, { _kind: 'video' });
    const transceivers = [
        {
            sender,
            receiver: { track: { kind: 'video' } },
            direction: 'recvonly'
        }
    ];
    let addTrackCount = 0;
    const pc = createMockPeerConnection({ senders: [sender], transceivers });
    const origAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = (track, stream) => {
        addTrackCount += 1;
        return origAddTrack(track, stream);
    };

    mesh.addLocalTracksToPC(pc);

    assert.equal(addTrackCount, 0, 'Must reuse existing transceiver/sender instead of calling addTrack');
    assert.equal(sender.track, vTrack, 'replaceTrack must bind the local video track');
    assert.equal(sender.replaceHistory.length, 1);
    assert.equal(transceivers[0].direction, 'sendrecv', 'recvonly transceiver must transition to sendrecv');
});

test('stopScreenShare clears tracks with replaceTrack(null) instead of removeTrack', async () => {
    const { createWebRtcMesh, createScreenShareController } = await loadModules();
    const screenShareSource = fs.readFileSync(path.join(ROOT_DIR, 'public/js/modules/screen-share.js'), 'utf8');
    assert.equal(screenShareSource.includes('removeTrack(sender)'), false, 'screen-share must not call removeTrack(sender)');

    const vTrack = createMockTrack('video', 'v1');
    const localStream = new MockMediaStream([vTrack]);
    const { state, socket, emitted, dom, doc } = createMeshFixture(createWebRtcMesh, { localStream });

    const sender = createMockSender(vTrack);
    const transceiver = { sender, receiver: { track: { kind: 'video' } }, direction: 'sendrecv' };
    const pc = createMockPeerConnection({ senders: [sender], transceivers: [transceiver] });
    const peers = new Map([['peer-b', { pc }]]);
    const offersSent = [];

    const controller = createScreenShareController({
        state,
        dom,
        getSocket: () => socket,
        getPeers: () => peers,
        getWebRtc: () => ({
            sendOffer: async (peerId) => {
                offersSent.push(peerId);
            }
        }),
        getGrid: () => ({ updateGridState: () => {} }),
        getQosMonitor: () => ({ stopQualityMonitor: () => {} }),
        startExcludeDiscordCapture: async () => {},
        startAppAudioCapture: async () => {},
        stopAppAudioCapture: () => {},
        showToast: () => {},
        documentObj: doc,
        navigatorObj: {},
        MediaStreamCtor: MockMediaStream
    });

    await controller.stopScreenShare();

    assert.equal(sender.track, null, 'sender track should be cleared via replaceTrack(null)');
    assert.deepEqual(sender.replaceHistory, [null]);
    assert.equal(transceiver.direction, 'recvonly');
    assert.deepEqual(offersSent, ['peer-b']);
    assert.ok(emitted.some((e) => e.event === 'stream-state' && e.data.state === 'stopped'));
});

test('handleSignal request-keyframe forces IDR via videoSender.replaceTrack(videoTrack)', async () => {
    const { createWebRtcMesh } = await loadModules();
    const vTrack = createMockTrack('video', 'v-idr');
    const localStream = new MockMediaStream([vTrack]);
    const sender = createMockSender(vTrack);
    const pc = createMockPeerConnection({ senders: [sender] });

    const { mesh } = createMeshFixture(createWebRtcMesh, {
        localStream,
        pcFactory: () => pc
    });

    mesh.peers.set('peer-b', {
        pc,
        stream: new MockMediaStream(),
        iceCandidateQueue: [],
        isRemoteDescriptionSet: true,
        _signalChain: Promise.resolve()
    });

    mesh.handleSignal({
        senderId: 'peer-b',
        signal: { type: 'request-keyframe' }
    });
    await mesh.peers.get('peer-b')._signalChain;

    assert.equal(sender.replaceHistory.length, 1, 'request-keyframe must invoke replaceTrack on video sender');
    assert.equal(sender.replaceHistory[0], vTrack);
});

test('ontrack video monitors 0-width frames and emits request-keyframe on black screen', async () => {
    const { createWebRtcMesh } = await loadModules();
    const { mesh, emitted } = createMeshFixture(createWebRtcMesh);

    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    let scheduledTick = null;
    let cleared = false;
    global.setInterval = (fn) => {
        scheduledTick = fn;
        return 777;
    };
    global.clearInterval = (id) => {
        if (id === 777) cleared = true;
    };

    try {
        const pc = mesh.getOrCreatePeerConnection('peer-b');
        const peerObj = mesh.peers.get('peer-b');
        const mockVideo = createMockElement('video');
        mockVideo.videoWidth = 0;
        const mockTile = createMockElement('div');
        mockTile.querySelector = (sel) => (sel === 'video' ? mockVideo : null);
        peerObj.tileEl = mockTile;

        pc.ontrack({ track: createMockTrack('video', 'remote-v') });
        assert.equal(typeof scheduledTick, 'function', 'Video ontrack should start keyframe watchdog interval');

        scheduledTick();
        assert.ok(
            emitted.some((e) => e.event === 'signal' && e.data.targetId === 'peer-b' && e.data.signal.type === 'request-keyframe'),
            'Should emit request-keyframe when remote videoWidth === 0'
        );

        mockVideo.videoWidth = 1280;
        scheduledTick();
        assert.equal(cleared, true, 'Watchdog should clear once videoWidth > 0');
    } finally {
        global.setInterval = origSetInterval;
        global.clearInterval = origClearInterval;
        mesh.removePeerConnection('peer-b');
    }
});
