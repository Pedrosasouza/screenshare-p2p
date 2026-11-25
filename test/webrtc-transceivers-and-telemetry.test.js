'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
const { ROOT_DIR, loadClientModules } = require('./helpers/client-env');

async function loadModules() {
    return loadClientModules(['webrtc-mesh', 'screen-share', 'qos-monitor', 'qos']);
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
        getQosMonitor: () => ({ configureSenderParams: () => {}, updateSendersForActivePeers: () => {} }),
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

describe('Transceivers WebRTC, Keyframes, Telemetria & Limpeza de Peers', () => {
    it('isValidSignal accepts request-keyframe and offer while rejecting invalid payloads', () => {
        assert.equal(isValidSignal({ type: 'request-keyframe' }), true);
        assert.equal(isValidSignal({ type: 'offer', sdp: 'v=0...' }), true);
        assert.equal(isValidSignal({ type: 'invalid-type' }), false);
        assert.equal(isValidSignal({ foo: 'bar' }), false);
    });

    it('addLocalTracksToPC reuses existing empty video transceiver/sender via replaceTrack without duplicate addTrack', async () => {
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

    it('addLocalTracksToPC adds new audio track without overwriting existing video sender', async () => {
        const { createWebRtcMesh } = await loadModules();
        const vTrack = createMockTrack('video', 'v1');
        const aTrack = createMockTrack('audio', 'a1');
        const localStream = new MockMediaStream([vTrack, aTrack]);
        const videoSender = createMockSender(createMockTrack('video', 'v-old'));
        const added = [];
        const pc = createMockPeerConnection({ senders: [videoSender] });
        const origAddTrack = pc.addTrack.bind(pc);
        pc.addTrack = (track, stream) => {
            added.push(track);
            return origAddTrack(track, stream);
        };

        const { mesh } = createMeshFixture(createWebRtcMesh, {
            localStream,
            pcFactory: () => pc
        });

        mesh.addLocalTracksToPC(pc);

        assert.equal(videoSender.track, vTrack, 'Video sender must be updated via replaceTrack');
        assert.equal(added.length, 1);
        assert.equal(added[0], aTrack, 'New audio track must be added separately');
    });

    it('stopScreenShare clears tracks with replaceTrack(null) instead of removeTrack', async () => {
        const { createWebRtcMesh, createScreenShareController } = await loadModules();

        const vTrack = createMockTrack('video', 'v1');
        const localStream = new MockMediaStream([vTrack]);
        const { state, socket, emitted, dom, doc } = createMeshFixture(createWebRtcMesh, { localStream });

        const sender = createMockSender(vTrack);
        const transceiver = { sender, receiver: { track: { kind: 'video' } }, direction: 'sendrecv' };
        const pc = createMockPeerConnection({ senders: [sender], transceivers: [transceiver] });
        pc.removeTrack = () => {
            throw new Error('Must not call removeTrack');
        };
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

    it('handleSignal request-keyframe forces IDR via videoSender.replaceTrack(videoTrack)', async () => {
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

    it('ontrack video monitors 0-width frames and emits request-keyframe on black screen', async () => {
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

    it('applyPeerViewerQuality configures balanced mode, scales down per viewer, and respects broadcaster 30fps cap', async () => {
        const { createQosMonitor } = await loadModules();
        const vTrack = createMockTrack('video', 'v-fps');
        const videoSender = createMockSender(vTrack, {
            params: { encodings: [{ maxBitrate: 4000000, maxFramerate: 30 }], degradationPreference: '' }
        });
        const pc = createMockPeerConnection({ senders: [videoSender] });
        const peerObj = { pc, viewerQualityPreset: '720p60' };
        const peers = new Map([['peer-b', peerObj]]);
        const state = {
            localStream: new MockMediaStream([vTrack]),
            activeStreamMaxQuality: { resolution: '1080p', fps: 30 },
            selectedVideoResolution: '1080p',
            selectedVideoFps: 30,
            roomId: 'room-1'
        };

        const qm = createQosMonitor({
            state,
            dom: {},
            getPeers: () => peers,
            storage: createMockStorage()
        });

        qm.applyPeerViewerQuality('peer-b', peerObj);
        assert.equal(videoSender.getParameters().degradationPreference, 'balanced');
        assert.equal(videoSender.getParameters().encodings[0].scaleResolutionDownBy, 1.5);
        assert.equal(videoSender.getParameters().encodings[0].maxFramerate, 30, 'Must clamp 720p60 request to broadcaster 30fps ceiling');

        peerObj.viewerQualityPreset = 'auto';
        qm.applyPeerViewerQuality('peer-b', peerObj);
        assert.equal(videoSender.getParameters().degradationPreference, 'balanced');
        assert.equal(videoSender.getParameters().encodings[0].scaleResolutionDownBy, 1);
        assert.equal(videoSender.getParameters().encodings[0].maxFramerate, 30);
    });

    it('removePeerConnection and clearPeerTimers cancel active keyframe & ICE restart timers', async () => {
        const { clearPeerTimers, createWebRtcMesh } = await loadModules();

        let closedCount = 0;
        const pc = createMockPeerConnection();
        const origClose = pc.close.bind(pc);
        pc.close = () => {
            closedCount += 1;
            origClose();
        };

        const { mesh } = createMeshFixture(createWebRtcMesh, { pcFactory: () => pc });

        const intervalHandle = setInterval(() => {}, 10000);
        const timeoutHandle = setTimeout(() => {}, 10000);
        mesh.peers.set('peer-b', {
            pc,
            stream: new MockMediaStream(),
            _keyframeCheckInterval: intervalHandle,
            _iceRestartTimeout: timeoutHandle
        });

        const peerRef = mesh.peers.get('peer-b');
        mesh.removePeerConnection('peer-b');

        assert.equal(mesh.peers.has('peer-b'), false);
        assert.equal(closedCount, 1);
        assert.equal(peerRef._keyframeCheckInterval, null);
        assert.equal(peerRef._iceRestartTimeout, null);

        clearPeerTimers(peerRef);
        assert.equal(peerRef._keyframeCheckInterval, null);
        assert.equal(peerRef._iceRestartTimeout, null);
    });

    it('setPeerConnectionStatus renders status text safely via textContent without XSS interpolation', async () => {
        const { createWebRtcMesh } = await loadModules();

        const tileEl = createMockElement('div');
        let appendedWarning = null;
        const origQuerySelector = tileEl.querySelector.bind(tileEl);
        tileEl.querySelector = (sel) => {
            if (sel === '.peer-connection-warning') return appendedWarning;
            return origQuerySelector(sel);
        };
        const origAppendChild = tileEl.appendChild.bind(tileEl);
        tileEl.appendChild = (child) => {
            if (child.className === 'peer-connection-warning') appendedWarning = child;
            return origAppendChild(child);
        };

        const { mesh } = createMeshFixture(createWebRtcMesh);
        mesh.peers.set('peer-b', { pc: createMockPeerConnection(), tileEl });
        const xssPayload = '<img src=x onerror=alert(1)>';
        mesh.setPeerConnectionStatus('peer-b', 'failed', xssPayload);

        assert.ok(appendedWarning, 'Should append .peer-connection-warning element');
        const warnTextSpan = appendedWarning.children.find((c) => c.tagName === 'SPAN');
        assert.ok(warnTextSpan, 'Should create <span> for status text');
        assert.equal(warnTextSpan.textContent, xssPayload);
        assert.equal(warnTextSpan.innerHTML, '');
    });

    it('Telemetry HUD DOM elements, collectPeerTelemetry priority, and QoS 60fps recovery', async () => {
        const { collectPeerTelemetry, createQosMonitor } = await loadModules();
        const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
        for (const id of ['statsVideoTelemetry', 'statsCodecEncoder', 'statsQualityLimitation', 'statsIceRoute']) {
            assert.ok(indexHtml.includes(`id="${id}"`), `public/index.html missing #${id}`);
        }

        const statsMap = new Map([
            ['cand-pair-idle', { id: 'cand-pair-idle', type: 'candidate-pair', state: 'succeeded', nominated: false, localCandidateId: 'loc-idle', remoteCandidateId: 'rem-idle' }],
            ['cand-pair-active', { id: 'cand-pair-active', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'loc-active', remoteCandidateId: 'rem-active', currentRoundTripTime: 0.04 }],
            ['loc-idle', { id: 'loc-idle', type: 'local-candidate', candidateType: 'host' }],
            ['rem-idle', { id: 'rem-idle', type: 'remote-candidate', candidateType: 'host' }],
            ['loc-active', { id: 'loc-active', type: 'local-candidate', candidateType: 'srflx' }],
            ['rem-active', { id: 'rem-active', type: 'remote-candidate', candidateType: 'relay' }],
            ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
            ['out-vid', {
                id: 'out-vid',
                type: 'outbound-rtp',
                kind: 'video',
                timestamp: 2000,
                bytesSent: 250000,
                codecId: 'codec-h264',
                encoderImplementation: 'OpenH264',
                framesPerSecond: 60,
                qualityLimitationReason: 'none',
                frameWidth: 1920,
                frameHeight: 1080
            }]
        ]);

        const prevStats = { timestamp: 1000, outboundBytes: 0, inboundBytes: 0 };
        const videoSender = createMockSender(createMockTrack('video', 'v-qos'), {
            params: { encodings: [{ maxBitrate: 4000000, maxFramerate: 30 }], degradationPreference: 'maintain-framerate' }
        });
        const pc = createMockPeerConnection({
            senders: [videoSender],
            getStatsImpl: async () => statsMap
        });

        const telemetry = await collectPeerTelemetry(statsMap, prevStats);

        assert.equal(telemetry.iceRoute, 'srflx → relay', 'Nominated candidate-pair must take precedence');
        assert.equal(telemetry.outbound.codec, 'H264');
        assert.equal(telemetry.outbound.encoder, 'OpenH264');
        assert.equal(telemetry.outbound.kbps, 2000);

        const peerObj = { pc };
        const peers = new Map([['peer-b', peerObj]]);
        const state = {
            localStream: new MockMediaStream([videoSender.track]),
            selectedVideoFps: 60,
            contentHintMode: 'motion'
        };
        const qm = createQosMonitor({ state, dom: {}, getPeers: () => peers, storage: createMockStorage() });

        statsMap.get('cand-pair-active').availableOutgoingBitrate = 6000000;
        await qm.evaluatePeerQoS('peer-b', peerObj, 1);

        assert.equal(videoSender.getParameters().encodings[0].maxFramerate, 60, 'evaluatePeerQoS must restore 60fps when bandwidth recovers');
        assert.ok(videoSender.appliedParams.length >= 1);
    });

    it('webrtc-mesh implements setPeerConnectionStatus, telemetria, warning badge e visibilitychange', async () => {
        const { createWebRtcMesh } = await loadModules();

        const doc = createMockDocument();
        const streamGrid = createMockElement('div', { id: 'streamGrid' });
        const tile = createMockElement('div', { id: 'stream-peer-1' });
        const overlay = createMockElement('div', { className: 'stream-overlay-info' });
        tile.appendChild(overlay);
        streamGrid.appendChild(tile);
        doc.body.appendChild(streamGrid);

        class MockPC {
            constructor() {
                const pc = createMockPeerConnection();
                pc.iceConnectionState = 'failed';
                pc.connectionState = 'failed';
                pc.getStats = async () => new Map([
                    ['pair-1', { type: 'candidate-pair', state: 'failed', nominated: true, localCandidateId: 'lc', remoteCandidateId: 'rc' }],
                    ['lc', { type: 'local-candidate', candidateType: 'host' }],
                    ['rc', { type: 'remote-candidate', candidateType: 'srflx' }]
                ]);
                return pc;
            }
        }

        const mesh = createWebRtcMesh({
            state: {
                currentUserName: 'Host',
                isSharing: true,
                localStream: null,
                activeShareGeneration: 0,
                currentRoomId: 'sala-opt'
            },
            dom: { streamGrid },
            getSocket: () => ({ id: 'self', emit: () => {} }),
            getQosMonitor: () => ({ configureSenderParams: () => {}, updateSendersForActivePeers: () => {} }),
            getGrid: () => ({
                updateMemberCount: () => {},
                updateGridState: () => {},
                updateEchoWarningVisibility: () => {},
                updatePeerUserName: () => {},
                createStreamTile: () => {},
                startTilePlayback: () => {}
            }),
            getScreenShare: () => ({ invalidateGeneration: () => {}, stopScreenShare: () => {} }),
            getRoomModal: () => ({}),
            getServerUrl: () => 'http://127.0.0.1:0',
            rtcConfig: { iceServers: [] },
            refreshIceServers: async () => {},
            scheduleIceRefreshTimer: () => {},
            registerFullscreenChangeHandler: () => {},
            saveSessionRoomPassword: () => {},
            clearSessionRoomPassword: () => {},
            showToast: () => {},
            playPresenceChime: () => {},
            RTCPeerConnectionCtor: MockPC,
            documentObj: doc,
            windowObj: { addEventListener: () => {} }
        });

        try {
            const pc = new MockPC();
            const transceiver = {
                sender: { track: { kind: 'video' } },
                receiver: { track: { kind: 'video', enabled: true } }
            };
            pc.getTransceivers = () => [transceiver];
            const remoteTrack = createMockTrack('video', 'remote-v1');
            const remoteStream = new MockMediaStream([remoteTrack]);
            mesh.peers.set('peer-1', { pc, stream: remoteStream, tileEl: tile, userName: 'Peer 1' });

            mesh.setPeerConnectionStatus('peer-1', 'failed', 'Sem rota P2P');
            const badge = tile.querySelector('.peer-connection-warning');
            assert.ok(badge, 'Badge .peer-connection-warning deve ser criado em falha P2P');
            const badgeText = badge.querySelector('span');
            assert.ok(badgeText, 'Badge deve conter span de mensagem');
            assert.strictEqual(badgeText.textContent, 'Sem rota P2P');

            await mesh.logPeerConnectionTelemetry('peer-1', pc);

            mesh.bindLifecycleListeners();
            doc.hidden = true;
            doc.dispatchEvent({ type: 'visibilitychange' });
            assert.strictEqual(remoteTrack.enabled, false, 'Deve pausar trilha de vídeo em segundo plano');

            doc.hidden = false;
            doc.dispatchEvent({ type: 'visibilitychange' });
            assert.strictEqual(remoteTrack.enabled, true, 'Deve reativar trilha de vídeo ao retornar ao foco');
        } finally {
            mesh.cleanupRoomState({ keepPassword: true });
        }
    });
});
