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
    const [shareMod, webrtcMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/screen-share.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js')).href)
    ]);
    return { ...shareMod, ...webrtcMod };
}

function createScreenShareEnv(mods, overrides = {}) {
    const events = [];
    const emitted = [];
    const offersSent = [];
    const appendedTiles = [];

    const state = {
        myId: 'self-1',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        contentHintMode: 'motion',
        currentUserName: 'Tester',
        roomId: 'sala-teste',
        localStream: null
    };
    const peers = overrides.peers || new Map();

    const streamGrid = createMockElement('div', { id: 'streamGrid' });
    streamGrid.appendChild = (el) => {
        appendedTiles.push(el);
        return el;
    };
    const dom = {
        streamGrid,
        btnStartShare: createMockElement('button', { id: 'btnStartShare', hidden: false }),
        btnStopShare: createMockElement('button', { id: 'btnStopShare', hidden: true }),
        btnQualityToggle: createMockElement('button', { id: 'btnQualityToggle', hidden: true })
    };
    const doc = createMockDocument(dom);
    const socket = overrides.socket || {
        emit(ev, payload) {
            emitted.push({ ev, payload });
        }
    };

    const navigatorObj = overrides.navigatorObj || {
        connection: null,
        mediaDevices: {
            getDisplayMedia: async () => new MockMediaStream([]),
            enumerateDevices: async () => [],
            getUserMedia: async () => new MockMediaStream([])
        }
    };

    const mesh = mods.createWebRtcMesh({
        state,
        dom,
        getSocket: () => socket,
        getQosMonitor: () => ({ configureSenderParams: () => {} }),
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
        RTCPeerConnectionCtor: function () { return createMockPeerConnection(); },
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: doc,
        windowObj: { addEventListener() {} },
        storage: createMockStorage()
    });

    const controller = mods.createScreenShareController({
        state,
        dom,
        getSocket: () => socket,
        getPeers: () => peers,
        getWebRtc: () => ({
            addLocalTracksToPC: () => {},
            sendOffer: overrides.sendOffer || ((pid) => offersSent.push(pid))
        }),
        getGrid: () => ({
            createStreamTile: overrides.createStreamTile || (() => createMockElement('div', { id: 'localStreamTile' })),
            startTilePlayback: () => {},
            updateGridState: () => {}
        }),
        getQosMonitor: () => ({
            startQualityMonitor: () => {},
            stopQualityMonitor: () => {},
            applyQualityModeUI: () => {}
        }),
        startExcludeDiscordCapture: overrides.startExcludeDiscordCapture || (async () => null),
        startAppAudioCapture: overrides.startAppAudioCapture || (async () => null),
        stopAppAudioCapture: () => events.push({ type: 'stopAppAudioCapture' }),
        showToast: (msg, toastType) => events.push({ type: 'toast', msg, toastType }),
        documentObj: doc,
        navigatorObj,
        MediaStreamCtor: MockMediaStream
    });

    return { controller, mesh, state, peers, navigatorObj, events, emitted, offersSent, appendedTiles };
}

test('T1: startScreenShare calls stopScreenShare and stops old tracks before new capture', async () => {
    const mods = await loadModules();
    const callOrder = [];
    const oldTrack = createMockTrack('video', 'old-v');
    const origOldStop = oldTrack.stop.bind(oldTrack);
    oldTrack.stop = () => {
        origOldStop();
        callOrder.push('oldTrack.stop');
    };
    const newVideoTrack = createMockTrack('video', 'new-v');

    const env = createScreenShareEnv(mods, {
        socket: {
            emit(ev, payload) {
                if (ev === 'stream-state' && payload && payload.state === 'stopped') {
                    callOrder.push('stream-state:stopped');
                }
            }
        }
    });
    env.state.localStream = new MockMediaStream([oldTrack]);

    env.navigatorObj.mediaDevices.getDisplayMedia = async () => {
        callOrder.push('getDisplayMedia');
        return new MockMediaStream([newVideoTrack]);
    };

    await env.controller.startScreenShare('none');

    const captureIdx = callOrder.indexOf('getDisplayMedia');
    assert.notEqual(captureIdx, -1, 'getDisplayMedia must be called');
    assert.ok(callOrder.includes('oldTrack.stop'), 'oldTrack must be stopped before new capture');
    assert.ok(callOrder.includes('stream-state:stopped'), 'stopScreenShare must emit stream-state:stopped before new capture');
    assert.ok(callOrder.indexOf('oldTrack.stop') < captureIdx);
    assert.ok(callOrder.indexOf('stream-state:stopped') < captureIdx);
    assert.equal(oldTrack.stopped, true);
    assert.equal(env.state.localStream.getVideoTracks()[0], newVideoTrack);
});

test('T2: Errors after getDisplayMedia roll back tracks, WASAPI capture, cable tracks, and localStream', async () => {
    const mods = await loadModules();

    // 2a: empty videoTracks in exclude_discord mode
    const leakedScreenAudio = createMockTrack('audio', 'scr-a');
    const wasapiAudioTrack = createMockTrack('audio', 'wasapi-a');
    const envA = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: async () => wasapiAudioTrack
    });
    envA.navigatorObj.mediaDevices.getDisplayMedia = async () => new MockMediaStream([leakedScreenAudio]);

    await envA.controller.startScreenShare('exclude_discord');
    assert.equal(leakedScreenAudio.stopped, true);
    assert.equal(wasapiAudioTrack.stopped, true);
    assert.ok(envA.events.some((e) => e.type === 'stopAppAudioCapture'));
    assert.equal(envA.state.localStream, null);

    // 2b: createStreamTile failure in app mode
    const videoTrackB = createMockTrack('video', 'v-b');
    const appAudioTrackB = createMockTrack('audio', 'app-a');
    const envB = createScreenShareEnv(mods, {
        startAppAudioCapture: async () => appAudioTrackB,
        createStreamTile: () => { throw new Error('DOM tile failure'); }
    });
    envB.navigatorObj.mediaDevices.getDisplayMedia = async () => new MockMediaStream([videoTrackB]);

    await envB.controller.startScreenShare('app', 1234);
    assert.equal(videoTrackB.stopped, true);
    assert.equal(appAudioTrackB.stopped, true);
    assert.ok(envB.events.some((e) => e.type === 'stopAppAudioCapture'));
    assert.equal(envB.state.localStream, null);

    // 2c: system mode with extra cableStream tracks + tile error
    const videoTrackC = createMockTrack('video', 'v-c');
    const cableTrack1 = createMockTrack('audio', 'cab-1');
    const cableTrackExtra = createMockTrack('audio', 'cab-2');
    const envC = createScreenShareEnv(mods, {
        createStreamTile: () => { throw new Error('Tile fail on cable'); }
    });
    envC.navigatorObj.mediaDevices.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: 'cable-id-1', label: 'CABLE Output (VB-Audio Virtual Cable)' }
    ];
    envC.navigatorObj.mediaDevices.getDisplayMedia = async () => new MockMediaStream([videoTrackC]);
    envC.navigatorObj.mediaDevices.getUserMedia = async () => new MockMediaStream([cableTrack1, cableTrackExtra]);

    await envC.controller.startScreenShare('system');
    assert.equal(cableTrackExtra.stopped, true);
    assert.equal(cableTrack1.stopped, true);
    assert.equal(videoTrackC.stopped, true);
    assert.equal(envC.state.localStream, null);
});

test('T3: Rejected/undefined replaceTrack never triggers unhandledRejection across addLocalTracksToPC, stopScreenShare, and handleUserJoined', async () => {
    const mods = await loadModules();
    let unhandledError = null;
    const onUnhandled = (reason) => { unhandledError = reason; };
    process.on('unhandledRejection', onUnhandled);

    try {
        const videoTrack = createMockTrack('video', 'v-1');
        const audioTrack = createMockTrack('audio', 'a-1');
        let replaceCalls = 0;

        const rejectingVideoSender = createMockSender(null, { _kind: 'video' });
        rejectingVideoSender.replaceTrack = () => {
            replaceCalls += 1;
            return Promise.reject(new Error('InvalidStateError: sender stopped'));
        };
        const syncAudioSender = createMockSender(null, { _kind: 'audio' });
        syncAudioSender.replaceTrack = () => {
            replaceCalls += 1;
            return undefined;
        };

        const mockPC = createMockPeerConnection({ senders: [rejectingVideoSender, syncAudioSender] });
        const env = createScreenShareEnv(mods, { peers: new Map([['peer-1', { pc: mockPC }]]) });
        env.state.localStream = new MockMediaStream([videoTrack, audioTrack]);

        env.mesh.addLocalTracksToPC(mockPC);
        assert.equal(replaceCalls, 2);

        await env.controller.stopScreenShare();
        assert.equal(replaceCalls, 4);

        const webrtcSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js'), 'utf8');
        assert.ok(webrtcSrc.includes('Promise.resolve(vSender.replaceTrack('));

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(unhandledError, null);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('T4: system mode avoids spurious mic permission prompt and warns when VB-Cable capture fails', async () => {
    const mods = await loadModules();

    // 4a: permission prompt + empty labels -> does NOT call getUserMedia({ audio: true })
    let micPromptCalled = false;
    let displayMediaAudioOpt = null;
    const envA = createScreenShareEnv(mods);
    envA.navigatorObj.permissions = { query: async () => ({ state: 'prompt' }) };
    envA.navigatorObj.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'dev-1', label: '' }];
    envA.navigatorObj.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints && constraints.audio === true) micPromptCalled = true;
        return new MockMediaStream([]);
    };
    envA.navigatorObj.mediaDevices.getDisplayMedia = async (opts) => {
        displayMediaAudioOpt = opts && opts.audio;
        return new MockMediaStream([createMockTrack('video', 'v-sys')]);
    };

    await envA.controller.startScreenShare('system');
    assert.equal(micPromptCalled, false);
    assert.ok(displayMediaAudioOpt && typeof displayMediaAudioOpt === 'object');

    // 4b: VB-Cable fails -> emits actionable warning toast
    const envB = createScreenShareEnv(mods);
    envB.navigatorObj.permissions = { query: async () => ({ state: 'granted' }) };
    envB.navigatorObj.mediaDevices.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: 'cable-1', label: 'CABLE Output (VB-Audio Virtual Cable)' }
    ];
    envB.navigatorObj.mediaDevices.getDisplayMedia = async () => new MockMediaStream([createMockTrack('video', 'v-cable')]);
    envB.navigatorObj.mediaDevices.getUserMedia = async () => {
        throw new Error('NotReadableError: Device in use');
    };

    await envB.controller.startScreenShare('system');
    assert.ok(envB.events.some((e) => e.type === 'toast' && e.toastType === 'warning'));
});

test('T5: In-flight cancellation via stopScreenShare stops late tracks and avoids publishing stream', async () => {
    const mods = await loadModules();
    let resolveDisplay;
    let markEntered;
    const enteredPrompt = new Promise((r) => { markEntered = r; });

    const lateVideoTrack = createMockTrack('video', 'late-v');
    const lateAudioTrack = createMockTrack('audio', 'late-a');

    const env = createScreenShareEnv(mods, {
        peers: new Map([['peer-1', { pc: createMockPeerConnection() }]])
    });
    env.navigatorObj.mediaDevices.getDisplayMedia = () => {
        markEntered();
        return new Promise((resolve) => { resolveDisplay = resolve; });
    };

    const sharePromise = env.controller.startScreenShare('none');
    await enteredPrompt;

    await env.controller.stopScreenShare({ silent: true });

    resolveDisplay(new MockMediaStream([lateVideoTrack, lateAudioTrack]));
    await sharePromise;

    assert.equal(env.state.localStream, null);
    assert.equal(lateVideoTrack.stopped, true);
    assert.equal(lateAudioTrack.stopped, true);
    assert.equal(env.appendedTiles.length, 0);
    assert.equal(env.offersSent.length, 0);
    assert.equal(env.emitted.filter((e) => e.ev === 'stream-state' && e.payload.state === 'started').length, 0);
});

test('T6: In-flight WASAPI capture cancelled by invalidateGeneration calls stopAppAudioCapture in finally', async () => {
    const mods = await loadModules();
    let resolveWasapi;
    let markEnteredWasapi;
    const enteredWasapi = new Promise((r) => { markEnteredWasapi = r; });

    const videoTrack = createMockTrack('video', 'v-wasapi-cancel');
    const wasapiTrack = createMockTrack('audio', 'a-wasapi-cancel', { _isDesktopWasapiTrack: true });

    const env = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: () => {
            markEnteredWasapi();
            return new Promise((resolve) => { resolveWasapi = resolve; });
        }
    });
    env.navigatorObj.mediaDevices.getDisplayMedia = async () => new MockMediaStream([videoTrack]);

    const sharePromise = env.controller.startScreenShare('exclude_discord');
    await enteredWasapi;

    // Simula cleanupRoomState chamando invalidateGeneration antes de localStream ser criado
    env.controller.invalidateGeneration();
    resolveWasapi(wasapiTrack);
    await sharePromise;

    assert.equal(env.state.localStream, null);
    assert.equal(videoTrack.stopped, true);
    assert.equal(wasapiTrack.stopped, true);
    assert.ok(env.events.some((e) => e.type === 'stopAppAudioCapture'), 'stopAppAudioCapture deve encerrar sessão WASAPI órfã');
});

test('T7: startScreenShare awaits async replaceTrack in addLocalTracksToPC before sendOffer and QoS update', async () => {
    const mods = await loadModules();
    const eventsOrder = [];
    let resolveReplace;
    const replacePromise = new Promise((r) => { resolveReplace = r; });

    const sender = {
        track: null,
        _kind: 'video',
        replaceTrack(t) {
            eventsOrder.push('replaceTrack:start');
            return replacePromise.then(() => {
                sender.track = t;
                eventsOrder.push('replaceTrack:done');
            });
        },
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async () => {}
    };
    const pc = createMockPeerConnection({ senders: [sender], transceivers: [{ direction: 'inactive', sender, receiver: { track: { kind: 'video' } } }] });
    const peers = new Map([['peer-1', { pc }]]);
    const state = { roomId: 'r1', localStream: null, selectedVideoResolution: '1080p', selectedVideoFps: 60, contentHintMode: 'motion' };
    const doc = createMockDocument({ streamGrid: createMockElement('div', { id: 'streamGrid' }) });
    let mesh;
    mesh = mods.createWebRtcMesh({
        state,
        dom: { streamGrid: doc.getElementById('streamGrid') },
        getSocket: () => ({ emit: () => {} }),
        getQosMonitor: () => ({
            configureSenderParams: () => {},
            updateSendersForActivePeers: () => eventsOrder.push('qosUpdate')
        }),
        RTCPeerConnectionCtor: function () { return pc; },
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: doc,
        windowObj: { addEventListener() {} },
        storage: createMockStorage()
    });
    mesh.peers.set('peer-1', { pc, stream: new MockMediaStream(), iceCandidateQueue: [], _signalChain: Promise.resolve() });
    const origSendOffer = mesh.sendOffer;
    const wrappedWebRtc = {
        addLocalTracksToPC: mesh.addLocalTracksToPC,
        sendOffer: (pid) => { eventsOrder.push('sendOffer'); return origSendOffer(pid); }
    };

    const controller = mods.createScreenShareController({
        state,
        dom: { streamGrid: doc.getElementById('streamGrid'), btnStartShare: createMockElement('button'), btnStopShare: createMockElement('button'), btnQualityToggle: createMockElement('button') },
        getSocket: () => ({ emit: () => {} }),
        getPeers: () => mesh.peers,
        getWebRtc: () => wrappedWebRtc,
        getGrid: () => ({ createStreamTile: () => createMockElement('div', { id: 'localStreamTile' }), startTilePlayback: () => {}, updateGridState: () => {} }),
        getQosMonitor: () => ({ startQualityMonitor: () => {}, stopQualityMonitor: () => {}, applyQualityModeUI: () => {}, updateSendersForActivePeers: () => eventsOrder.push('qosUpdate') }),
        navigatorObj: { mediaDevices: { getDisplayMedia: async () => new MockMediaStream([createMockTrack('video', 'new-v')]) } },
        documentObj: doc,
        MediaStreamCtor: MockMediaStream
    });

    const sharePromise = controller.startScreenShare('none');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(eventsOrder.includes('sendOffer'), false, 'sendOffer não pode rodar antes de replaceTrack resolver');
    resolveReplace();
    await sharePromise;

    const doneIdx = eventsOrder.indexOf('replaceTrack:done');
    const offerIdx = eventsOrder.indexOf('sendOffer');
    assert.ok(doneIdx !== -1 && offerIdx > doneIdx, 'sendOffer deve ocorrer somente após replaceTrack resolver');
});

test('T8: exclude_discord faz fallback para áudio do sistema quando exclusão do Discord falha', async () => {
    const mods = await loadModules();
    const videoOnlyTrack = createMockTrack('video', 'v-initial');
    const fallbackVideoTrack = createMockTrack('video', 'v-fallback');
    const fallbackAudioTrack = createMockTrack('audio', 'a-fallback-sys');
    const getDisplayCalls = [];

    const env = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: async () => {
            throw new Error('Discord não encontrado');
        }
    });

    env.navigatorObj.mediaDevices.getDisplayMedia = async (constraints) => {
        getDisplayCalls.push(constraints);
        if (getDisplayCalls.length === 1) {
            return new MockMediaStream([videoOnlyTrack]);
        }
        return new MockMediaStream([fallbackVideoTrack, fallbackAudioTrack]);
    };

    await env.controller.startScreenShare('exclude_discord');

    assert.equal(getDisplayCalls.length, 2, 'Deve tentar getDisplayMedia com áudio do sistema como fallback');
    assert.equal(Boolean(getDisplayCalls[1].audio), true, 'Segunda chamada deve solicitar áudio do sistema');
    assert.equal(videoOnlyTrack.stopped, true, 'Track de vídeo inicial sem áudio deve ser encerrada ao assumir stream fallback');
    assert.ok(env.state.localStream, 'localStream deve permanecer ativo após fallback');
    assert.equal(env.state.localStream.getVideoTracks()[0], fallbackVideoTrack);
    assert.equal(env.state.localStream.getAudioTracks()[0], fallbackAudioTrack);
    assert.ok(
        env.events.some((e) => e.type === 'toast' && e.toastType === 'warning'),
        'Deve avisar o usuário via toast ao fazer fallback do modo excluir Discord'
    );
});
