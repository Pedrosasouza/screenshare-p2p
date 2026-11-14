'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockTrack,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');

async function loadModules() {
    const [tileDomMod, webrtcMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/tile-dom.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/webrtc-mesh.js')).href)
    ]);
    return { ...tileDomMod, ...webrtcMod };
}

function createTileMock(peerId, videoObj, onCleanup) {
    const tile = createMockElement('div', { className: 'stream-tile' });
    tile.dataset.peerId = peerId;
    tile.inDom = true;
    tile._cleanupTapUnmute = onCleanup || null;
    tile.querySelector = (sel) => {
        if (sel === 'video') return videoObj;
        if (sel === '.btn-exit-pseudo-fs') return tile.children.find((c) => c.className === 'btn-exit-pseudo-fs') || null;
        return null;
    };
    const origRemove = tile.remove.bind(tile);
    tile.remove = () => {
        tile.inDom = false;
        origRemove();
    };
    return tile;
}

function createHarness({ createWebRtcMesh, registerFullscreenChangeHandler }) {
    const peers = new Map();
    const doc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    doc.hidden = false;
    doc.fullscreenElement = null;
    doc.webkitFullscreenElement = null;
    doc.exitFullscreen = () => {
        doc.fullscreenElement = null;
        return Promise.resolve();
    };
    doc.querySelector = (sel) => {
        if (sel === '.stream-tile.pseudo-fullscreen') {
            for (const peerObj of peers.values()) {
                if (peerObj.tileEl && peerObj.tileEl.inDom && peerObj.tileEl.classList.contains('pseudo-fullscreen')) {
                    return peerObj.tileEl;
                }
            }
            return null;
        }
        return null;
    };

    const mesh = createWebRtcMesh({
        state: { myId: 'me' },
        dom: { streamGrid: createMockElement('div') },
        getSocket: () => null,
        getQosMonitor: () => null,
        getGrid: () => ({ updateGridState: () => {} }),
        getScreenShare: () => null,
        getRoomModal: () => null,
        getServerUrl: () => '',
        rtcConfig: { iceServers: [] },
        refreshIceServers: async () => {},
        scheduleIceRefreshTimer: () => {},
        registerFullscreenChangeHandler,
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
    mesh.bindLifecycleListeners();

    // Point doc.querySelector at mesh.peers
    doc.querySelector = (sel) => {
        if (sel === '.stream-tile.pseudo-fullscreen') {
            for (const peerObj of mesh.peers.values()) {
                if (peerObj.tileEl && peerObj.tileEl.inDom && peerObj.tileEl.classList.contains('pseudo-fullscreen')) {
                    return peerObj.tileEl;
                }
            }
            return null;
        }
        return null;
    };

    return { mesh, doc };
}

test('Background track optimization pauses non-fullscreen tracks during pseudo-fullscreen and restores on exit', async () => {
    const { createWebRtcMesh, registerFullscreenChangeHandler, enterPseudoFullscreen, toggleTileFullscreen } = await loadModules();
    const { mesh, doc } = createHarness({ createWebRtcMesh, registerFullscreenChangeHandler });

    const trackA = createMockTrack('video', 'va');
    const trackB = createMockTrack('video', 'vb');
    const tileA = createTileMock('peer-a', { srcObject: null });
    const tileB = createTileMock('peer-b', { srcObject: null });

    mesh.peers.set('peer-a', { pc: createMockPeerConnection(), stream: new MockMediaStream([trackA]), tileEl: tileA });
    mesh.peers.set('peer-b', { pc: createMockPeerConnection(), stream: new MockMediaStream([trackB]), tileEl: tileB });

    enterPseudoFullscreen(tileA, doc);
    assert.equal(trackA.enabled, true, 'Focused fullscreen track stays enabled');
    assert.equal(trackB.enabled, false, 'Background track pauses in pseudo-fullscreen');

    toggleTileFullscreen(tileA, null, doc);
    assert.equal(tileA.classList.contains('pseudo-fullscreen'), false);
    assert.equal(trackA.enabled, true);
    assert.equal(trackB.enabled, true, 'Background track resumes when exiting pseudo-fullscreen');
});

test('removePeerConnection disposes tile listeners, clears srcObject, removes tile, and restores other tracks', async () => {
    const { createWebRtcMesh, registerFullscreenChangeHandler, enterPseudoFullscreen } = await loadModules();
    const { mesh, doc } = createHarness({ createWebRtcMesh, registerFullscreenChangeHandler });

    let cleanupCalled = 0;
    const videoA = { srcObject: { id: 'stream-a' } };
    const tileA = createTileMock('peer-a', videoA, () => { cleanupCalled += 1; });
    const trackA = createMockTrack('video', 'va');
    const trackB = createMockTrack('video', 'vb');

    mesh.peers.set('peer-a', { pc: createMockPeerConnection(), stream: new MockMediaStream([trackA]), tileEl: tileA });
    mesh.peers.set('peer-b', { pc: createMockPeerConnection(), stream: new MockMediaStream([trackB]), tileEl: createTileMock('peer-b', { srcObject: { id: 'stream-b' } }) });

    enterPseudoFullscreen(tileA, doc);
    assert.equal(trackB.enabled, false);

    mesh.removePeerConnection('peer-a');
    assert.equal(mesh.peers.has('peer-a'), false);
    assert.equal(cleanupCalled, 1);
    assert.equal(videoA.srcObject, null);
    assert.equal(tileA.removed, true);
    assert.equal(trackB.enabled, true, 'Remaining peer track must be re-enabled');
});

test('toggleTileFullscreen handles undefined returns and synchronous throws without crashing', async () => {
    const { toggleTileFullscreen, registerFullscreenChangeHandler } = await loadModules();
    registerFullscreenChangeHandler(null);
    const doc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });

    const tileLegacy = createTileMock('peer-legacy', { srcObject: null });
    tileLegacy.webkitRequestFullscreen = () => undefined;
    assert.doesNotThrow(() => toggleTileFullscreen(tileLegacy, null, doc));

    const tileThrow = createTileMock('peer-throw', { srcObject: null });
    tileThrow.webkitRequestFullscreen = () => { throw new Error('Fullscreen disallowed'); };
    assert.doesNotThrow(() => toggleTileFullscreen(tileThrow, null, doc));
    assert.equal(tileThrow.classList.contains('pseudo-fullscreen'), true);

    doc.fullscreenElement = tileLegacy;
    doc.exitFullscreen = () => undefined;
    assert.doesNotThrow(() => toggleTileFullscreen(tileLegacy, null, doc));
});
