'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { getCorsOrigin } = require('../src/server/security-headers');
const { startTestServer } = require('./helpers/test-server');
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
    const qosModUrl = pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/qos-monitor.js')).href;
    const qosUrl = pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/qos.js')).href;
    const [webrtcMod, qosMonMod, qosMod] = await Promise.all([
        import(webrtcUrl),
        import(qosModUrl),
        import(qosUrl)
    ]);
    return { ...webrtcMod, ...qosMonMod, ...qosMod };
}

test('addLocalTracksToPC adds new audio track without overwriting existing video sender', async () => {
    const { createWebRtcMesh } = await loadModules();
    const vTrack = createMockTrack('video', 'v1');
    const aTrack = createMockTrack('audio', 'a1');
    const localStream = new MockMediaStream([vTrack, aTrack]);
    const videoSender = createMockSender(createMockTrack('video', 'v-old'));

    let added = [];
    const pc = createMockPeerConnection({ senders: [videoSender] });
    const origAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = (track, stream) => {
        added.push(track);
        return origAddTrack(track, stream);
    };

    const mesh = createWebRtcMesh({
        state: { myId: 'peer-a', localStream },
        dom: { streamGrid: createMockElement('div') },
        getSocket: () => null,
        getQosMonitor: () => ({ configureSenderParams: () => {} }),
        getGrid: () => ({ updateGridState: () => {}, updateMemberCount: () => {}, updateEchoWarningVisibility: () => {} }),
        getScreenShare: () => ({ invalidateGeneration: () => {}, stopScreenShare: () => {} }),
        getRoomModal: () => null,
        getServerUrl: () => '',
        rtcConfig: { iceServers: [] },
        refreshIceServers: async () => {},
        scheduleIceRefreshTimer: () => {},
        registerFullscreenChangeHandler: () => {},
        saveSessionRoomPassword: () => {},
        clearSessionRoomPassword: () => {},
        showToast: () => {},
        playPresenceChime: () => {},
        RTCPeerConnectionCtor: function () { return pc; },
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: createMockDocument(),
        windowObj: { addEventListener: () => {} },
        storage: createMockStorage()
    });

    mesh.addLocalTracksToPC(pc);

    assert.equal(videoSender.track, vTrack, 'Video sender must be updated via replaceTrack');
    assert.equal(added.length, 1);
    assert.equal(added[0], aTrack, 'New audio track must be added separately');
});

test('toggleQualityMode toggles motion/detail, preserves 30fps cap, and updates contentHint', async () => {
    const { createQosMonitor } = await loadModules();
    const vTrack = createMockTrack('video', 'v-fps');
    const videoSender = createMockSender(vTrack, {
        params: { encodings: [{ maxBitrate: 4000000, maxFramerate: 30 }], degradationPreference: '' }
    });
    const pc = createMockPeerConnection({ senders: [videoSender] });
    const peers = new Map([['peer-b', { pc }]]);
    const state = {
        localStream: new MockMediaStream([vTrack]),
        selectedVideoFps: 30,
        contentHintMode: 'motion',
        roomId: 'room-1'
    };
    const qualityIcon = createMockElement('span', { id: 'qualityIcon' });
    const qualityLabel = createMockElement('span', { id: 'qualityLabel' });
    const btnQualityToggle = createMockElement('button', { id: 'btnQualityToggle' });

    const qm = createQosMonitor({
        state,
        dom: { qualityIcon, qualityLabel, btnQualityToggle },
        getPeers: () => peers,
        storage: createMockStorage()
    });

    qm.toggleQualityMode();
    assert.equal(state.contentHintMode, 'detail');
    assert.equal(vTrack.contentHint, 'detail');
    assert.equal(videoSender.getParameters().degradationPreference, 'maintain-resolution');
    assert.equal(videoSender.getParameters().encodings[0].maxFramerate, 30);

    qm.toggleQualityMode();
    assert.equal(state.contentHintMode, 'motion');
    assert.equal(vTrack.contentHint, 'motion');
    assert.equal(videoSender.getParameters().degradationPreference, 'maintain-framerate');
    assert.equal(videoSender.getParameters().encodings[0].maxFramerate, 30);
});

test('removePeerConnection and clearPeerTimers cancel active keyframe & ICE restart timers', async () => {
    const { clearPeerTimers, createWebRtcMesh } = await loadModules();

    let closedCount = 0;
    const pc = createMockPeerConnection();
    const origClose = pc.close.bind(pc);
    pc.close = () => {
        closedCount += 1;
        origClose();
    };

    const mesh = createWebRtcMesh({
        state: { myId: 'peer-a' },
        dom: { streamGrid: createMockElement('div') },
        getSocket: () => null,
        getQosMonitor: () => null,
        getGrid: () => ({ updateGridState: () => {} }),
        getScreenShare: () => ({ invalidateGeneration: () => {}, stopScreenShare: () => {} }),
        getRoomModal: () => null,
        getServerUrl: () => '',
        rtcConfig: { iceServers: [] },
        refreshIceServers: async () => {},
        scheduleIceRefreshTimer: () => {},
        registerFullscreenChangeHandler: () => {},
        saveSessionRoomPassword: () => {},
        clearSessionRoomPassword: () => {},
        showToast: () => {},
        playPresenceChime: () => {},
        RTCPeerConnectionCtor: function () { return pc; },
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: createMockDocument(),
        windowObj: { addEventListener: () => {} },
        storage: createMockStorage()
    });

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

    // Direct idempotency check for clearPeerTimers
    clearPeerTimers(peerRef);
    assert.equal(peerRef._keyframeCheckInterval, null);
    assert.equal(peerRef._iceRestartTimeout, null);
});

test('setPeerConnectionStatus renders status text safely via textContent without XSS interpolation', async () => {
    const { createWebRtcMesh } = await loadModules();
    const webrtcSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js'), 'utf8');
    assert.equal(webrtcSrc.includes('${message}'), false, 'Dynamic status messages must never be interpolated into innerHTML');

    const doc = createMockDocument();
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

    const mesh = createWebRtcMesh({
        state: { myId: 'peer-a' },
        dom: {},
        getSocket: () => null,
        getQosMonitor: () => null,
        getGrid: () => null,
        getScreenShare: () => null,
        getRoomModal: () => null,
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
        windowObj: { addEventListener: () => {} },
        storage: createMockStorage()
    });

    mesh.peers.set('peer-b', { pc: createMockPeerConnection(), tileEl });
    const xssPayload = '<img src=x onerror=alert(1)>';
    mesh.setPeerConnectionStatus('peer-b', 'failed', xssPayload);

    assert.ok(appendedWarning, 'Should append .peer-connection-warning element');
    const warnTextSpan = appendedWarning.children.find((c) => c.tagName === 'SPAN');
    assert.ok(warnTextSpan, 'Should create <span> for status text');
    assert.equal(warnTextSpan.textContent, xssPayload);
    assert.equal(warnTextSpan.innerHTML, '');
});

test('Server security: getCorsOrigin restricts ALLOWED_ORIGINS and /health responds 200', async () => {
    const openCors = getCorsOrigin({});
    assert.equal(openCors, '*');

    const restrictedCors = getCorsOrigin({ ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com' });
    assert.equal(typeof restrictedCors, 'function');

    await new Promise((resolve, reject) => {
        restrictedCors('https://app.example.com', (err, allowed) => {
            if (err) return reject(err);
            assert.equal(allowed, true);
            restrictedCors('https://evil.example.com', (err2, allowed2) => {
                assert.ok(err2 instanceof Error);
                assert.equal(allowed2, undefined);
                resolve();
            });
        });
    });

    const ts = await startTestServer();
    try {
        const res = await fetch(`${ts.baseUrl}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'ok');
    } finally {
        await ts.close();
    }
});

test('Privacy doc lists STUN/TURN endpoints and Tauri config disables devtools', () => {
    const privacyDoc = fs.readFileSync(path.join(ROOT_DIR, 'PRIVACY.md'), 'utf8');
    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'src-tauri/tauri.conf.json'), 'utf8'));

    assert.ok(privacyDoc.includes('openrelay.metered.ca'), 'PRIVACY.md must document Metered OpenRelay TURN');
    assert.ok(privacyDoc.includes('stun.l.google.com:19302'), 'PRIVACY.md must document Google STUN');
    assert.equal(tauriConf.app.windows[0].devtools, false, 'Production Tauri config must disable devtools');
});

test('Telemetry HUD DOM elements, collectPeerTelemetry priority, and QoS 60fps recovery', async () => {
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

    const prevStats = {
        timestamp: 1000,
        outboundBytes: 0,
        inboundBytes: 0
    };
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

    // QoS recovery back to 60 FPS under good network conditions
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
