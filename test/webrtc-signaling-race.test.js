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

async function loadWebRtcMod() {
    const webrtcUrl = pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js')).href;
    return import(webrtcUrl);
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

function createHarness(createWebRtcMesh, options = {}) {
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
    const dom = { streamGrid };
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
        windowObj: { addEventListener: () => {} },
        storage: createMockStorage()
    });

    return { mesh, emitted, createdPcs, socket, state };
}

test('Serialized _signalChain queues concurrent candidate until slow setRemoteDescription resolves', async () => {
    const { createWebRtcMesh } = await loadWebRtcMod();
    const srdGate = createDeferred();
    const order = [];

    const { mesh } = createHarness(createWebRtcMesh, {
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

test('Peer disconnection during createOffer, setLocalDescription, or setRemoteDescription aborts safely without signals', async () => {
    const { createWebRtcMesh } = await loadWebRtcMod();

    // 2a: disconnect during createOffer
    {
        const offerGate = createDeferred();
        let sldCalled = false;
        const { mesh, emitted } = createHarness(createWebRtcMesh, {
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

    // 2b: disconnect during setLocalDescription
    {
        const sldGate = createDeferred();
        const { mesh, emitted } = createHarness(createWebRtcMesh, {
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

    // 2c: disconnect during setRemoteDescription in handleSignal
    {
        const srdGate = createDeferred();
        let createAnswerCalled = false;
        const { mesh, emitted } = createHarness(createWebRtcMesh, {
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

test('Failed renegotiation setRemoteDescription preserves isRemoteDescriptionSet and keeps _signalChain alive', async () => {
    const { createWebRtcMesh } = await loadWebRtcMod();
    let callNum = 0;

    const { mesh } = createHarness(createWebRtcMesh, {
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

    // Initial valid offer
    mesh.handleSignal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'v=0\r\n' } });
    await mesh.peers.get('peer-b')._signalChain;
    assert.equal(mesh.peers.get('peer-b').isRemoteDescriptionSet, true);

    // Failing renegotiation offer while pc.remoteDescription already exists
    mesh.handleSignal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'bad-sdp' } });
    await mesh.peers.get('peer-b')._signalChain;
    assert.equal(
        mesh.peers.get('peer-b').isRemoteDescriptionSet,
        true,
        'isRemoteDescriptionSet must be restored if previous remoteDescription remains valid'
    );

    // Subsequent candidate still executes on surviving _signalChain
    mesh.handleSignal({ senderId: 'peer-b', signal: { candidate: { candidate: 'cand-after-err', sdpMid: '0' } } });
    await mesh.peers.get('peer-b')._signalChain;
    assert.equal(mesh.peers.get('peer-b').pc.addedCandidates.length, 1);
});

test('Invalid signals, self-signals, orphan request-keyframe are ignored and closed pc stops emitting candidates', async () => {
    const { createWebRtcMesh } = await loadWebRtcMod();
    const { mesh, createdPcs, emitted } = createHarness(createWebRtcMesh);

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
