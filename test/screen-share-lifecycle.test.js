'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockTrack,
    createMockSender,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { loadClientModules } = require('./helpers/client-env');

async function loadModules() {
    return loadClientModules(['screen-share', 'webrtc-mesh']);
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
        startExcludeAppCapture: overrides.startExcludeAppCapture || null,
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

    // 2c: system mode with VB-Cable opt-in + extra cableStream tracks + tile error
    const videoTrackC = createMockTrack('video', 'v-c');
    const cableTrack1 = createMockTrack('audio', 'cab-1');
    const cableTrackExtra = createMockTrack('audio', 'cab-2');
    const envC = createScreenShareEnv(mods, {
        createStreamTile: () => { throw new Error('Tile fail on cable'); }
    });
    envC.state.useVbCableAudio = true;
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

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(unhandledError, null);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('T4: system mode ignores VB-Cable by default and supports opt-in with mic permission guard', async () => {
    const mods = await loadModules();

    // 4a: opt-in enabled + permission prompt + empty labels -> does NOT call getUserMedia({ audio: true })
    let micPromptCalled = false;
    let displayMediaAudioOpt = null;
    const envA = createScreenShareEnv(mods);
    envA.state.useVbCableAudio = true;
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
    assert.ok(envA.events.some((e) => e.type === 'toast' && e.toastType === 'warning'));

    // 4b: opt-in enabled + VB-Cable fails -> emits actionable warning toast
    const envB = createScreenShareEnv(mods);
    envB.state.useVbCableAudio = true;
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

    // 4c: default system mode (no opt-in) ignores VB-Cable even when present, skips enumerateDevices/getUserMedia, and uses native getDisplayMedia audio
    let enumerateCalled = false;
    let userMediaCalled = false;
    let nativeDisplayOpts = null;
    const nativeVideo = createMockTrack('video', 'v-native');
    const nativeAudio = createMockTrack('audio', 'a-native');
    const envC = createScreenShareEnv(mods);
    envC.navigatorObj.mediaDevices.enumerateDevices = async () => {
        enumerateCalled = true;
        return [{ kind: 'audioinput', deviceId: 'cable-1', label: 'CABLE Output (VB-Audio Virtual Cable)' }];
    };
    envC.navigatorObj.mediaDevices.getUserMedia = async () => {
        userMediaCalled = true;
        return new MockMediaStream([createMockTrack('audio', 'a-cable')]);
    };
    envC.navigatorObj.mediaDevices.getDisplayMedia = async (opts) => {
        nativeDisplayOpts = opts;
        return new MockMediaStream([nativeVideo, nativeAudio]);
    };

    await envC.controller.startScreenShare('system');
    assert.equal(enumerateCalled, false, 'Sem opt-in, não deve enumerar dispositivos');
    assert.equal(userMediaCalled, false, 'Sem opt-in, não deve chamar getUserMedia para VB-Cable');
    assert.ok(nativeDisplayOpts && typeof nativeDisplayOpts.audio === 'object');
    assert.equal(envC.state.localStream.getAudioTracks()[0], nativeAudio);
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

    let displayMediaCalled = false;
    const wasapiTrack = createMockTrack('audio', 'a-wasapi-cancel', { _isDesktopWasapiTrack: true });

    const env = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: () => {
            markEnteredWasapi();
            return new Promise((resolve) => { resolveWasapi = resolve; });
        }
    });
    env.navigatorObj.mediaDevices.getDisplayMedia = async () => {
        displayMediaCalled = true;
        return new MockMediaStream([createMockTrack('video', 'v-wasapi-cancel')]);
    };

    const sharePromise = env.controller.startScreenShare('exclude_discord');
    await enteredWasapi;

    // Simula cleanupRoomState chamando invalidateGeneration antes de getDisplayMedia e localStream
    env.controller.invalidateGeneration();
    resolveWasapi(wasapiTrack);
    await sharePromise;

    assert.equal(displayMediaCalled, false, 'getDisplayMedia não deve ser chamado se cancelado durante WASAPI');
    assert.equal(env.state.localStream, null);
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

test('T8: exclude_discord faz fallback com único getDisplayMedia e limpa WASAPI se cancelado depois', async () => {
    const mods = await loadModules();
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
        return new MockMediaStream([fallbackVideoTrack, fallbackAudioTrack]);
    };

    await env.controller.startScreenShare('exclude_discord');

    assert.equal(getDisplayCalls.length, 1, 'Deve chamar getDisplayMedia apenas 1 vez já com áudio no fallback');
    assert.equal(Boolean(getDisplayCalls[0].audio), true, 'Chamada única deve solicitar áudio do sistema');
    assert.ok(env.state.localStream, 'localStream deve permanecer ativo após fallback');
    assert.equal(env.state.localStream.getVideoTracks()[0], fallbackVideoTrack);
    assert.equal(env.state.localStream.getAudioTracks()[0], fallbackAudioTrack);
    assert.ok(
        env.events.some((e) => e.type === 'toast' && e.toastType === 'warning'),
        'Deve avisar o usuário via toast ao fazer fallback do modo excluir Discord'
    );

    // 8b: startExcludeDiscordCapture tem sucesso, mas usuário cancela getDisplayMedia (NotAllowedError)
    const wasapiTrackCancel = createMockTrack('audio', 'a-wasapi-not-allowed', { _isDesktopWasapiTrack: true });
    const envCancel = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: async () => wasapiTrackCancel
    });
    envCancel.navigatorObj.mediaDevices.getDisplayMedia = async () => {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
    };

    await envCancel.controller.startScreenShare('exclude_discord');
    assert.equal(envCancel.state.localStream, null);
    assert.equal(wasapiTrackCancel.stopped, true);
    assert.ok(envCancel.events.some((e) => e.type === 'stopAppAudioCapture'));
    assert.equal(envCancel.events.some((e) => e.type === 'toast' && e.toastType === 'error'), false);

    // 8c: startExcludeDiscordCapture tem sucesso, mas share é invalidado durante getDisplayMedia
    const wasapiTrackInv = createMockTrack('audio', 'a-wasapi-inv', { _isDesktopWasapiTrack: true });
    const lateVideoInv = createMockTrack('video', 'v-inv');
    let resolveDisplayInv;
    let markEnteredInv;
    const enteredDisplayInv = new Promise((r) => { markEnteredInv = r; });

    const envInv = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: async () => wasapiTrackInv
    });
    envInv.navigatorObj.mediaDevices.getDisplayMedia = () => {
        markEnteredInv();
        return new Promise((resolve) => { resolveDisplayInv = resolve; });
    };

    const pInv = envInv.controller.startScreenShare('exclude_discord');
    await enteredDisplayInv;
    envInv.controller.invalidateGeneration();
    resolveDisplayInv(new MockMediaStream([lateVideoInv]));
    await pInv;

    assert.equal(envInv.state.localStream, null);
    assert.equal(lateVideoInv.stopped, true);
    assert.equal(wasapiTrackInv.stopped, true);
    assert.ok(envInv.events.some((e) => e.type === 'stopAppAudioCapture'));
});

test('T9: startScreenShare com modo app + excludeApp=true usa startExcludeAppCapture com fallback único e rollback', async () => {
    const mods = await loadModules();

    // 9a: sucesso usando startExcludeAppCapture(pid) e getDisplayMedia único com audio=false
    const excludedAppTrack = createMockTrack('audio', 'a-excl-app', { _isDesktopWasapiTrack: true });
    const screenVideoTrack = createMockTrack('video', 'v-excl-app');
    const capturedPids = [];
    const displayCalls = [];

    const envOk = createScreenShareEnv(mods, {
        startExcludeAppCapture: async (pid) => {
            capturedPids.push(pid);
            return excludedAppTrack;
        }
    });
    envOk.navigatorObj.mediaDevices.getDisplayMedia = async (constraints) => {
        displayCalls.push(constraints);
        return new MockMediaStream([screenVideoTrack]);
    };

    await envOk.controller.startScreenShare('app', 5555, '1080p', 60, { excludeApp: true });
    assert.deepEqual(capturedPids, [5555]);
    assert.equal(displayCalls.length, 1);
    assert.equal(displayCalls[0].audio, false);
    assert.equal(envOk.state.localStream.getAudioTracks()[0], excludedAppTrack);

    // 9b: falha de startExcludeAppCapture cai no fallback único com áudio do sistema + toast warning
    const fallbackCalls = [];
    const envFallback = createScreenShareEnv(mods, {
        startExcludeAppCapture: async () => {
            throw new Error('App protegido');
        }
    });
    envFallback.navigatorObj.mediaDevices.getDisplayMedia = async (constraints) => {
        fallbackCalls.push(constraints);
        return new MockMediaStream([createMockTrack('video', 'v-fb'), createMockTrack('audio', 'a-fb')]);
    };

    await envFallback.controller.startScreenShare('app', 5555, '1080p', 60, { excludeApp: true });
    assert.equal(fallbackCalls.length, 1);
    assert.ok(fallbackCalls[0].audio && typeof fallbackCalls[0].audio === 'object');
    assert.ok(envFallback.events.some((e) => e.type === 'toast' && e.toastType === 'warning'));

    // 9c: cancelamento (NotAllowedError) após startExcludeAppCapture ter sucesso faz rollback
    const wasapiCancelTrack = createMockTrack('audio', 'a-excl-cancel', { _isDesktopWasapiTrack: true });
    const envCancel = createScreenShareEnv(mods, {
        startExcludeAppCapture: async () => wasapiCancelTrack
    });
    envCancel.navigatorObj.mediaDevices.getDisplayMedia = async () => {
        const err = new Error('Cancelled');
        err.name = 'NotAllowedError';
        throw err;
    };

    await envCancel.controller.startScreenShare('app', 5555, '1080p', 60, { excludeApp: true });
    assert.equal(envCancel.state.localStream, null);
    assert.equal(wasapiCancelTrack.stopped, true);
    assert.ok(envCancel.events.some((e) => e.type === 'stopAppAudioCapture'));
});

test('T10: handleDesktopCaptureRebound exibe aviso informativo sem interromper a trilha de áudio', async () => {
    const mods = await loadModules();
    const excludeTrack = createMockTrack('audio', 'a-discord-excl', { _isDesktopWasapiTrack: true });
    const screenVideo = createMockTrack('video', 'v-discord-excl');

    const env = createScreenShareEnv(mods, {
        startExcludeDiscordCapture: async () => excludeTrack
    });
    env.navigatorObj.mediaDevices.getDisplayMedia = async () => new MockMediaStream([screenVideo]);

    await env.controller.startScreenShare('exclude_discord');
    assert.ok(env.state.localStream);
    assert.equal(env.state.localStream.getAudioTracks()[0], excludeTrack);

    env.controller.handleDesktopCaptureRebound({
        pid: 9999,
        generation: 1,
        mode: 'system_fallback',
        reason: 'Discord encerrado; mantendo áudio completo do sistema.'
    });

    assert.equal(excludeTrack.stopped, false, 'trilha de áudio deve permanecer ativa após rebound');
    assert.equal(env.state.localStream.getAudioTracks().length, 1);
    assert.ok(
        env.events.some((e) => e.type === 'toast' && e.toastType === 'info' && e.msg.includes('mantendo áudio completo do sistema')),
        'deve exibir toast informativo sobre atualização do modo exclusão'
    );
});
