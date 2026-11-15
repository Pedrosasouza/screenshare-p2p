'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockTrack,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { loadClientModules } = require('./helpers/client-env');

async function loadWebRtcMod() {
    return loadClientModules(['webrtc-mesh']);
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createRaceHarness(createWebRtcMesh, options = {}) {
    const emitted = [];
    const socket = {
        id: options.myId || 'aaa-self',
        emit(event, data) {
            emitted.push({ event, data });
        }
    };
    const state = {
        myId: socket.id,
        roomId: 'room-race',
        localStream: null,
        selectedVideoFps: 60,
        contentHintMode: 'motion'
    };
    const streamGrid = createMockElement('div', { id: 'streamGrid' });
    const doc = createMockDocument({ streamGrid });

    const createdPcs = [];
    class FakePeerConnection {
        constructor() {
            const pc = options.createPc ? options.createPc() : createMockPeerConnection();
            createdPcs.push(pc);
            return pc;
        }
    }

    const mesh = createWebRtcMesh({
        state,
        dom: { streamGrid },
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
        windowObj: { addEventListener: () => {} },
        storage: createMockStorage()
    });

    return { mesh, emitted, createdPcs, socket, state };
}

function createReconcileEnv(createWebRtcMesh, overrides = {}) {
    const emittedEvents = [];
    let echoVisibilityUpdates = 0;

    const streamGrid = createMockElement('div', { id: 'streamGrid' });
    const displayRoomId = createMockElement('span', { id: 'displayRoomId' });
    const memberCountText = createMockElement('span', { id: 'memberCountText' });
    const doc = createMockDocument({ streamGrid, displayRoomId, memberCountText }, {
        createElement: (tag) => createMockElement(tag)
    });

    const socket = {
        id: 'my-socket-id',
        connected: true,
        emit(ev, payload) {
            emittedEvents.push({ ev, payload });
        }
    };

    const state = {
        myId: 'my-socket-id',
        roomId: 'sala-1',
        pendingRoomJoin: null,
        currentRoomPassword: '',
        localStream: overrides.localStream || null
    };

    class FakePeerConnection {
        constructor() {
            return createMockPeerConnection({ connectionState: 'connected', iceConnectionState: 'connected' });
        }
    }

    const mesh = createWebRtcMesh({
        state,
        dom: { streamGrid, displayRoomId, memberCountText },
        getSocket: () => socket,
        getQosMonitor: () => ({
            configureSenderParams: () => {},
            updateSendersForActivePeers: () => {}
        }),
        getGrid: () => ({
            updateEchoWarningVisibility: () => { echoVisibilityUpdates += 1; },
            updateMemberCount: () => {},
            updateGridState: () => {},
            updatePeerUserName: () => {},
            createStreamTile: (id, stream) => {
                const tile = createMockElement('div', { id: `tile-${id}`, className: 'stream-tile' });
                const video = createMockElement('video');
                video.srcObject = stream;
                video.videoWidth = 0;
                tile.appendChild(video);
                return tile;
            },
            startTilePlayback: () => {}
        }),
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
        RTCPeerConnectionCtor: FakePeerConnection,
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: doc,
        windowObj: { location: { protocol: 'http:', pathname: '/' }, history: { pushState() {} }, addEventListener() {} },
        storage: createMockStorage()
    });

    return {
        mesh,
        state,
        emittedEvents,
        getEchoVisibilityUpdates: () => echoVisibilityUpdates
    };
}

describe('Serialização de sinalização & corridas de desconexão', () => {
    it('Serialized _signalChain queues concurrent candidate until slow setRemoteDescription resolves', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        const srdGate = createDeferred();
        const order = [];

        const { mesh } = createRaceHarness(createWebRtcMesh, {
            createPc: () => {
                const pc = createMockPeerConnection();
                pc.setRemoteDescription = async (desc) => {
                    order.push('start-srd');
                    await srdGate.promise;
                    pc.remoteDescription = desc;
                    order.push('end-srd');
                };
                pc.addIceCandidate = async (cand) => {
                    order.push(`add-cand:${cand.candidate}`);
                    pc.addedCandidates.push(cand);
                };
                return pc;
            }
        });

        mesh.handleSignal({ senderId: 'zzz-peer', signal: { type: 'offer', sdp: 'v=0\r\n' } });
        mesh.handleSignal({ senderId: 'zzz-peer', signal: { candidate: { candidate: 'c1', sdpMid: '0' } } });

        await new Promise((r) => setTimeout(r, 10));
        const peerObj = mesh.peers.get('zzz-peer');
        assert.ok(peerObj, 'Peer entry should exist');
        assert.equal(order[0], 'start-srd');
        assert.equal(peerObj.pc.addedCandidates.length, 0, 'Candidate must not run before offer completes');

        srdGate.resolve();
        await peerObj._signalChain;

        assert.deepEqual(order, ['start-srd', 'end-srd', 'add-cand:c1']);
        assert.equal(peerObj.pc.addedCandidates.length, 1);
    });

    it('Peer disconnection during createOffer, setLocalDescription, or setRemoteDescription aborts safely without signals', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();

        {
            const offerGate = createDeferred();
            let sldCalled = false;
            const { mesh, emitted } = createRaceHarness(createWebRtcMesh, {
                createPc: () => {
                    const pc = createMockPeerConnection();
                    pc.createOffer = async () => offerGate.promise;
                    pc.setLocalDescription = async () => { sldCalled = true; };
                    return pc;
                }
            });
            mesh.getOrCreatePeerConnection('peer-b');
            const p = mesh.sendOffer('peer-b');
            mesh.removePeerConnection('peer-b');
            offerGate.resolve({ type: 'offer', sdp: 'v=0\r\n' });
            await p;
            assert.equal(sldCalled, false, 'Must not call setLocalDescription after peer removed');
            assert.equal(emitted.length, 0);
        }

        {
            const sldGate = createDeferred();
            const { mesh, emitted } = createRaceHarness(createWebRtcMesh, {
                createPc: () => {
                    const pc = createMockPeerConnection();
                    pc.setLocalDescription = async (d) => {
                        await sldGate.promise;
                        pc.localDescription = d;
                    };
                    return pc;
                }
            });
            mesh.getOrCreatePeerConnection('peer-b');
            const p = mesh.sendOffer('peer-b');
            await new Promise((r) => setTimeout(r, 10));
            mesh.removePeerConnection('peer-b');
            sldGate.resolve();
            await p;
            assert.equal(emitted.length, 0, 'Must not emit signal after peer removed during setLocalDescription');
        }

        {
            const srdGate = createDeferred();
            let createAnswerCalled = false;
            const { mesh, emitted } = createRaceHarness(createWebRtcMesh, {
                createPc: () => {
                    const pc = createMockPeerConnection();
                    pc.setRemoteDescription = async (d) => {
                        await srdGate.promise;
                        pc.remoteDescription = d;
                    };
                    pc.createAnswer = async () => {
                        createAnswerCalled = true;
                        return { type: 'answer', sdp: 'v=0\r\n' };
                    };
                    return pc;
                }
            });
            mesh.handleSignal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'v=0\r\n' } });
            await new Promise((r) => setTimeout(r, 10));
            const chain = mesh.peers.get('peer-b')._signalChain;
            mesh.removePeerConnection('peer-b');
            srdGate.resolve();
            await chain;
            assert.equal(createAnswerCalled, false, 'Must not call createAnswer after peer removed');
            assert.equal(emitted.length, 0);
        }
    });

    it('Failed renegotiation setRemoteDescription preserves isRemoteDescriptionSet and keeps _signalChain alive', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        let callNum = 0;

        const { mesh } = createRaceHarness(createWebRtcMesh, {
            createPc: () => {
                const pc = createMockPeerConnection();
                pc.setRemoteDescription = async (desc) => {
                    callNum += 1;
                    if (callNum === 2) {
                        throw new Error('Renegotiation SDP parse failure');
                    }
                    pc.remoteDescription = desc;
                };
                return pc;
            }
        });

        mesh.handleSignal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'v=0\r\n' } });
        await mesh.peers.get('peer-b')._signalChain;
        assert.equal(mesh.peers.get('peer-b').isRemoteDescriptionSet, true);

        mesh.handleSignal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'bad-sdp' } });
        await mesh.peers.get('peer-b')._signalChain;
        assert.equal(
            mesh.peers.get('peer-b').isRemoteDescriptionSet,
            true,
            'isRemoteDescriptionSet must be restored if previous remoteDescription remains valid'
        );

        mesh.handleSignal({ senderId: 'peer-b', signal: { candidate: { candidate: 'cand-after-err', sdpMid: '0' } } });
        await mesh.peers.get('peer-b')._signalChain;
        assert.equal(mesh.peers.get('peer-b').pc.addedCandidates.length, 1);
    });

    it('Invalid signals, self-signals, orphan request-keyframe are ignored and closed pc stops emitting candidates', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        const { mesh, createdPcs, emitted } = createRaceHarness(createWebRtcMesh);

        mesh.handleSignal(null);
        mesh.handleSignal({ senderId: '', signal: { type: 'offer' } });
        mesh.handleSignal({ senderId: 'aaa-self', signal: { type: 'offer', sdp: 'v=0\r\n' } });
        mesh.handleSignal({ senderId: 'peer-unknown', signal: { type: 'request-keyframe' } });

        assert.equal(createdPcs.length, 0, 'Invalid/self/orphan signals must not create PeerConnections');

        const pc = mesh.getOrCreatePeerConnection('peer-active');
        pc.onicecandidate({ candidate: { candidate: 'valid-cand' } });
        assert.equal(emitted.length, 1);

        mesh.removePeerConnection('peer-active');
        pc.onicecandidate({ candidate: { candidate: 'post-close-cand' } });
        assert.equal(emitted.length, 1, 'Closed/removed peer must not emit ICE candidates');
    });
});

describe('Reconciliação de sala e limpeza em reconexão', () => {
    it('T1: room-users on reconnect removes stale peers, clears timers & video.srcObject, keeps active peers, ignores self', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        const h = createReconcileEnv(createWebRtcMesh);

        const stalePc = createMockPeerConnection();
        const activePc = createMockPeerConnection();
        const staleVideo = createMockElement('video');
        staleVideo.srcObject = { id: 'stale-stream' };
        const staleTile = createMockElement('div');
        staleTile.appendChild(staleVideo);
        const activeTile = createMockElement('div');

        const staleIntervalId = setInterval(() => {}, 10000);
        const stalePulseId = setTimeout(() => {}, 10000);

        h.mesh.peers.set('peer-stale', {
            pc: stalePc,
            stream: new MockMediaStream([createMockTrack('video', 'v-stale')]),
            tileEl: staleTile,
            _keyframeCheckInterval: staleIntervalId,
            _keyframePulseTimeout: stalePulseId
        });
        h.mesh.peers.set('peer-keep', {
            pc: activePc,
            stream: new MockMediaStream(),
            tileEl: activeTile
        });

        await h.mesh.handleRoomUsers({
            users: ['peer-keep', 'peer-new', 'my-socket-id'],
            userNames: { 'peer-keep': 'Keep', 'peer-new': 'New' },
            activeStreams: [],
            socketId: 'my-socket-id',
            memberCount: 3,
            hasPassword: false
        });

        assert.equal(h.mesh.peers.has('peer-stale'), false);
        assert.equal(stalePc.closed, true);
        assert.equal(staleTile.removed, true);
        assert.equal(staleVideo.srcObject, null);

        assert.equal(h.mesh.peers.has('peer-keep'), true);
        assert.equal(activePc.closed, false);
        assert.equal(h.mesh.peers.has('peer-new'), true);
        assert.equal(h.mesh.peers.has('my-socket-id'), false);
    });

    it('T2: cleanupRoomState clears remoteActiveStreams, calls updateEchoWarningVisibility, and nulls video.srcObject', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        const h = createReconcileEnv(createWebRtcMesh);

        const video1 = createMockElement('video');
        video1.srcObject = { id: 'stream-1' };
        const tile1 = createMockElement('div');
        tile1.appendChild(video1);
        const tileMinimal = {
            removed: false,
            remove() { this.removed = true; }
        };

        h.mesh.peers.set('p1', { pc: createMockPeerConnection(), stream: new MockMediaStream(), tileEl: tile1 });
        h.mesh.peers.set('p2', { pc: createMockPeerConnection(), stream: new MockMediaStream(), tileEl: tileMinimal });
        h.mesh.remoteActiveStreams.add('p1');
        h.mesh.remoteActiveStreams.add('p2');

        const beforeEcho = h.getEchoVisibilityUpdates();
        h.mesh.cleanupRoomState();

        assert.equal(h.mesh.peers.size, 0);
        assert.equal(h.mesh.remoteActiveStreams.size, 0);
        assert.equal(h.getEchoVisibilityUpdates(), beforeEcho + 1);
        assert.equal(video1.srcObject, null);
        assert.equal(tile1.removed, true);
        assert.equal(tileMinimal.removed, true);
    });

    it('T3: handleUserJoined ignores self socketId and cancels _keyframePulseTimeout when peer removed early', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        const timeouts = new Map();
        let nextId = 1;
        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        global.setTimeout = (fn, ms) => {
            const id = nextId++;
            timeouts.set(id, { id, fn, ms });
            return id;
        };
        global.clearTimeout = (id) => { timeouts.delete(id); };

        try {
            let replaceCalls = 0;
            const fakeVideoTrack = createMockTrack('video', 'v1');
            const h = createReconcileEnv(createWebRtcMesh, {
                localStream: new MockMediaStream([fakeVideoTrack])
            });

            await h.mesh.handleUserJoined({ socketId: 'my-socket-id', userName: 'Self', memberCount: 1 });
            assert.equal(h.mesh.peers.size, 0);
            assert.equal(timeouts.size, 0);

            await h.mesh.handleUserJoined({ socketId: 'peer-late', userName: 'Late Joiner', memberCount: 2 });
            const peerObj = h.mesh.peers.get('peer-late');
            assert.ok(peerObj);
            const videoSender = peerObj.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            videoSender.replaceTrack = async () => { replaceCalls += 1; };
            assert.ok(peerObj._keyframePulseTimeout);
            assert.equal(timeouts.size, 1);

            const captured = Array.from(timeouts.values())[0];
            h.mesh.removePeerConnection('peer-late');
            assert.equal(timeouts.size, 0);

            captured.fn();
            assert.equal(replaceCalls, 0);
        } finally {
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
        }
    });

    it('T4: _keyframeCheckInterval and _iceRestartTimeout abort cleanly when peer is closed/deleted', async () => {
        const { createWebRtcMesh } = await loadWebRtcMod();
        const timeouts = new Map();
        const intervals = new Map();
        let nextId = 1;
        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        const origSetInterval = global.setInterval;
        const origClearInterval = global.clearInterval;

        global.setTimeout = (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, ms }); return id; };
        global.clearTimeout = (id) => { timeouts.delete(id); };
        global.setInterval = (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; };
        global.clearInterval = (id) => { intervals.delete(id); };

        try {
            const h = createReconcileEnv(createWebRtcMesh, {
                localStream: new MockMediaStream()
            });

            const pc = h.mesh.getOrCreatePeerConnection('peer-x');
            const peerObj = h.mesh.peers.get('peer-x');

            pc.ontrack({ track: createMockTrack('video', 'remote-v'), streams: [] });
            assert.equal(intervals.size, 1);
            const kfInterval = Array.from(intervals.values())[0];

            pc.iceConnectionState = 'disconnected';
            pc.oniceconnectionstatechange();
            assert.equal(timeouts.size, 1);
            const iceTimeout = Array.from(timeouts.values())[0];

            pc.close();
            h.mesh.peers.delete('peer-x');

            kfInterval.fn();
            assert.equal(h.emittedEvents.length, 0);
            assert.equal(peerObj._keyframeCheckInterval, null);
            assert.equal(intervals.size, 0);

            iceTimeout.fn();
            assert.equal(pc.iceRestarts, 0);
            assert.equal(h.emittedEvents.length, 0);
        } finally {
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
            global.setInterval = origSetInterval;
            global.clearInterval = origClearInterval;
        }
    });
});
