'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockTrack,
    createMockPeerConnection
} = require('./helpers/mock-webrtc');
const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { ROOT_DIR, CLIENT_MODULES_DIR, loadClientModules } = require('./helpers/client-env');

function readAllClientSources() {
    const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public/app.js'), 'utf8');
    const files = fs.readdirSync(CLIENT_MODULES_DIR).filter((f) => f.endsWith('.js')).sort();
    return [
        { name: 'public/app.js', content: appJs },
        ...files.map((f) => ({
            name: `public/js/modules/${f}`,
            content: fs.readFileSync(path.join(CLIENT_MODULES_DIR, f), 'utf8')
        }))
    ];
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

function createFullscreenHarness({ createWebRtcMesh, registerFullscreenChangeHandler }) {
    const peers = new Map();
    const doc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    doc.hidden = false;
    doc.fullscreenElement = null;
    doc.webkitFullscreenElement = null;
    doc.exitFullscreen = () => {
        doc.fullscreenElement = null;
        return Promise.resolve();
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

    return { mesh, doc, peers };
}

describe('Eliminação de alert/prompt e sistema Toast', () => {
    it('T1: cliente não contém chamadas ativas a alert() ou prompt()', () => {
        const forbiddenMatches = [];
        for (const file of readAllClientSources()) {
            file.content.split('\n').forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
                if (/\balert\(/.test(line)) {
                    forbiddenMatches.push(`${file.name}:${index + 1}: alert() encontrado: "${trimmed}"`);
                }
                if (/\bprompt\(/.test(line)) {
                    forbiddenMatches.push(`${file.name}:${index + 1}: prompt() encontrado: "${trimmed}"`);
                }
            });
        }

        assert.strictEqual(
            forbiddenMatches.length,
            0,
            `Chamadas bloqueantes encontradas:\n${forbiddenMatches.join('\n')}`
        );
    });

    it('T2: showToast renderiza mensagem usando textContent seguro (Anti-XSS)', async () => {
        const { showToast } = await loadClientModules(['ui-feedback']);
        const mockDoc = createMockDocument();
        const prevDoc = global.document;
        global.document = mockDoc;
        try {
            const payload = '<img src=x onerror=alert(1)>';
            showToast(payload, 'error', 0);

            const container = mockDoc.getElementById('toastContainer');
            assert.ok(container, 'toastContainer deve ser criado');
            assert.strictEqual(container.children.length, 1);

            const toastEl = container.children[0];
            assert.ok(toastEl.className.includes('toast-error'));

            const messageEl = toastEl.children.find((c) => c.className === 'toast-message');
            assert.ok(messageEl, 'span.toast-message deve existir');
            assert.strictEqual(messageEl.textContent, payload);
            assert.strictEqual(messageEl.innerHTML, '');
        } finally {
            if (prevDoc === undefined) delete global.document;
            else global.document = prevDoc;
        }
    });
});

describe('Notificação e chime de presença (join/leave)', () => {
    it('T1: playPresenceChime utiliza AudioContext e oscilador para join/leave', async () => {
        const { playPresenceChime } = await loadClientModules(['ui-feedback']);

        const oscCalls = [];
        const gainCalls = [];
        let createdCtx = 0;

        class FakeAudioContext {
            constructor() {
                createdCtx += 1;
                this.state = 'running';
                this.currentTime = 1.0;
                this.destination = {};
            }
            createOscillator() {
                return {
                    type: '',
                    frequency: {
                        setValueAtTime: (freq, t) => oscCalls.push({ op: 'set', freq, t }),
                        exponentialRampToValueAtTime: (freq, t) => oscCalls.push({ op: 'ramp', freq, t })
                    },
                    connect: () => {},
                    start: () => oscCalls.push({ op: 'start' }),
                    stop: () => oscCalls.push({ op: 'stop' })
                };
            }
            createGain() {
                return {
                    gain: {
                        setValueAtTime: (val, t) => gainCalls.push({ op: 'set', val, t }),
                        exponentialRampToValueAtTime: (val, t) => gainCalls.push({ op: 'ramp', val, t })
                    },
                    connect: () => {}
                };
            }
        }

        const prevWin = global.window;
        global.window = { AudioContext: FakeAudioContext };
        try {
            playPresenceChime('join');
            playPresenceChime('leave');

            assert.strictEqual(createdCtx, 1, 'Deve reutilizar _presenceAudioCtx');
            assert.strictEqual(oscCalls.filter((c) => c.op === 'start').length, 2);
            assert.strictEqual(oscCalls.filter((c) => c.op === 'stop').length, 2);
            assert.strictEqual(oscCalls[0].freq, 440);
            assert.strictEqual(oscCalls[1].freq, 587.33);
            assert.ok(gainCalls.length >= 4);
        } finally {
            if (prevWin === undefined) delete global.window;
            else global.window = prevWin;
        }
    });

    it('T2 & T3: webrtc-mesh handleUserJoined e handleUserLeft disparam showToast e playPresenceChime', async () => {
        const { createWebRtcMesh } = await loadClientModules(['webrtc-mesh']);

        const toasts = [];
        const chimes = [];
        const doc = createMockDocument();
        const win = { addEventListener: () => {} };
        const state = {
            currentUserName: 'Host',
            isSharing: false,
            localStream: null,
            activeShareGeneration: 0,
            currentRoomId: 'sala-teste'
        };
        const dom = {
            streamGrid: createMockElement('div', { id: 'streamGrid' }),
            memberCountEl: createMockElement('span', { id: 'memberCount' })
        };

        class MockPC {
            constructor() {
                return createMockPeerConnection();
            }
        }

        let mesh;
        mesh = createWebRtcMesh({
            state,
            dom,
            getSocket: () => ({ id: 'self-id', emit: () => {} }),
            getQosMonitor: () => ({ configureSenderParams: () => {}, updateSendersForActivePeers: () => {} }),
            getGrid: () => ({
                updateMemberCount: () => {},
                updateGridState: () => {},
                updateEchoWarningVisibility: () => {},
                updatePeerUserName: (id, name) => {
                    const p = mesh && mesh.peers.get(id);
                    if (p) p.userName = name;
                },
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
            showToast: (msg, type) => toasts.push({ msg, type }),
            playPresenceChime: (kind) => chimes.push(kind),
            RTCPeerConnectionCtor: MockPC,
            documentObj: doc,
            windowObj: win
        });

        try {
            mesh.handleUserJoined({ socketId: 'peer-1', userName: 'Alice', memberCount: 2 });
            assert.ok(toasts.some((t) => t.msg.includes('Alice') && t.msg.includes('entrou na sala')));
            assert.deepStrictEqual(chimes, ['join']);

            mesh.handleUserLeft({ socketId: 'peer-1', memberCount: 1 });
            assert.ok(toasts.some((t) => t.msg.includes('Alice') && t.msg.includes('saiu da sala')));
            assert.deepStrictEqual(chimes, ['join', 'leave']);
        } finally {
            mesh.cleanupRoomState({ keepPassword: true });
        }
    });
});

test('stream-grid renderiza crachá .user-name com textContent seguro (Anti-XSS)', async () => {
    const { createStreamGridController } = await loadClientModules(['stream-grid']);
    const doc = createMockDocument();
    const streamGrid = createMockElement('div', { id: 'streamGrid' });
    doc.body.appendChild(streamGrid);

    const ctrl = createStreamGridController({
        state: { isSharing: false, localStream: null, currentRoomId: 'sala-xss' },
        dom: { streamGrid },
        getPeers: () => new Map(),
        getRemoteActiveStreams: () => new Set(),
        getQualityMonitor: () => null,
        isDesktopApp: () => false,
        getServerUrl: () => 'http://127.0.0.1',
        showToast: () => {},
        documentObj: doc,
        windowObj: {},
        navigatorObj: {},
        onToggleTileFullscreen: () => {},
        onShowTapToUnmuteBadge: () => {}
    });

    const xssName = '<img src=x onerror=alert(1)>';
    const tile = ctrl.createStreamTile('peer-xss', new MockMediaStream([createMockTrack('video')]), xssName, true);
    const nameEl = tile.querySelector('.user-name');
    assert.ok(nameEl, 'elemento .user-name deve existir no tile');
    assert.strictEqual(nameEl.textContent, xssName);
    assert.strictEqual(nameEl.innerHTML, '');
});

test('Socket connection lifecycle toasts, connect_error de-duplication, and offline joinRoom queuing', async () => {
    const appMod = await import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?uiconn=${Date.now()}`);
    const toastContainer = createMockElement('div', { id: 'toastContainer' });
    const fakeDoc = createMockDocument({ toastContainer }, { createElement: (tag) => createMockElement(tag) });
    const socketHandlers = {};
    const emitted = [];
    const socket = {
        id: 'sock-test-1',
        connected: false,
        on(ev, fn) { socketHandlers[ev] = fn; },
        emit(ev, payload) { emitted.push({ event: ev, payload }); },
        disconnect() {}
    };

    const app = appMod.initApp({
        windowObj: {
            location: { protocol: 'http:', origin: 'http://localhost:3000', pathname: '/', search: '', hash: '' },
            addEventListener() {},
            removeEventListener() {},
            matchMedia: () => ({ matches: false })
        },
        documentObj: fakeDoc,
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => socket,
        fetchImpl: async () => ({ ok: false, status: 503 }),
        serverUrl: 'http://localhost:3000'
    });

    const origDocument = global.document;
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const toastTimers = new Set();
    global.document = fakeDoc;
    global.setTimeout = (fn, ms, ...args) => {
        if (ms >= 300) {
            const id = { cancelled: false, fn: () => fn(...args) };
            toastTimers.add(id);
            return id;
        }
        return origSetTimeout(fn, ms, ...args);
    };
    global.clearTimeout = (id) => {
        if (toastTimers.has(id)) {
            id.cancelled = true;
            toastTimers.delete(id);
            return;
        }
        return origClearTimeout(id);
    };

    try {
        // Offline joinRoom queues pendingRoomJoin without emitting
        app.roomModalCtrl.joinRoom('minha-sala', '1234', 'Pedro');
        assert.ok(app.state.pendingRoomJoin && app.state.pendingRoomJoin.roomId === 'minha-sala');
        assert.equal(emitted.filter((e) => e.event === 'join-room').length, 0);

        socketHandlers.connect_error(new Error('timeout'));
        socketHandlers.connect_error(new Error('timeout 2'));
        const errorToasts = toastContainer.children.filter((t) => t.className.includes('toast-error'));
        assert.equal(errorToasts.length, 1, 'connect_error must not spam toasts');

        socket.connected = true;
        socketHandlers.connect();
        assert.equal(emitted.filter((e) => e.event === 'join-room').length, 1, 'Pending room must emit on connect');
        assert.ok(toastContainer.children[toastContainer.children.length - 1].className.includes('toast-success'));

        const countBeforeClientDisconnect = toastContainer.children.length;
        socketHandlers.disconnect('io client disconnect');
        assert.equal(toastContainer.children.length, countBeforeClientDisconnect, 'Intentional disconnect must not warn');

        socketHandlers.disconnect('transport close');
        assert.ok(toastContainer.children[toastContainer.children.length - 1].className.includes('toast-warning'));

        socketHandlers.connect_error(new Error('retry'));
        socketHandlers.connect();
        assert.ok(toastContainer.children[toastContainer.children.length - 1].className.includes('toast-success'));
    } finally {
        app.teardownClientSession();
        toastTimers.clear();
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
        global.document = origDocument;
    }
});

test('Volume slider remembers non-zero volume on mute/unmute, falls back to 1, and slider click does not trigger tap-to-unmute', async () => {
    const { createStreamGridController, enterPseudoFullscreen, showTapToUnmuteBadge } = await loadClientModules(['stream-grid', 'tile-dom']);

    const doc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    const grid = createStreamGridController({
        state: {},
        dom: {},
        documentObj: doc,
        navigatorObj: { userAgent: 'Mozilla/5.0' }
    });

    const tile = grid.createStreamTile('peer-1', { id: 's-1' }, 'Alice', false);
    const video = tile.querySelector('video');
    const overlay = tile.querySelector('.tile-controls-overlay');
    const muteBtn = overlay.children.find((c) => c.tagName === 'BUTTON');
    const slider = overlay.children.find((c) => c.tagName === 'INPUT');

    assert.equal(video.muted, false);
    assert.equal(slider.value, '1');
    assert.ok(muteBtn.innerHTML.includes('fa-volume-high'));

    // Slider to 0.35 -> mute -> unmute restores 0.35
    slider.value = '0.35';
    slider.dispatchEvent({ type: 'input', target: slider });
    assert.equal(video.volume, 0.35);

    muteBtn.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, true);
    assert.equal(slider.value, '0');

    muteBtn.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, false);
    assert.equal(video.volume, 0.35);
    assert.equal(slider.value, '0.35');

    // Fresh tile dragged to 0 -> unmute falls back to 1
    const freshTile = grid.createStreamTile('peer-fresh', { id: 's-fresh' }, 'Bob', false);
    const freshVideo = freshTile.querySelector('video');
    const freshOverlay = freshTile.querySelector('.tile-controls-overlay');
    const freshMuteBtn = freshOverlay.children.find((c) => c.tagName === 'BUTTON');
    const freshSlider = freshOverlay.children.find((c) => c.tagName === 'INPUT');

    freshSlider.value = '0';
    freshSlider.dispatchEvent({ type: 'input', target: freshSlider });
    assert.equal(freshVideo.muted, true);

    freshMuteBtn.dispatchEvent({ type: 'click' });
    assert.equal(freshVideo.muted, false);
    assert.equal(freshVideo.volume, 1);
    assert.equal(freshSlider.value, '1');

    // enterPseudoFullscreen aria-label
    enterPseudoFullscreen(tile, doc);
    const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
    assert.equal(exitBtn.getAttribute('aria-label'), 'Sair da Tela Cheia');

    // Slider click inside tap-to-unmute tile must NOT bubble up to unmute video
    const tapTile = grid.createStreamTile('peer-slider', { id: 's-slider' }, 'Carol', false);
    const tapVideo = tapTile.querySelector('video');
    const tapSlider = tapTile.querySelector('.tile-controls-overlay').children.find((c) => c.tagName === 'INPUT');
    tapVideo.muted = true;
    tapVideo.volume = 0;
    tapSlider.value = '0';
    showTapToUnmuteBadge(tapTile, tapVideo, doc);
    assert.ok(tapTile.querySelector('.tap-unmute-badge'));

    tapSlider.dispatchEvent({ type: 'click' });
    assert.equal(tapVideo.muted, true);
    assert.equal(tapVideo.volume, 0);
});

test('Tile PiP & Spotlight: per-tile PiP switching, spotlight toggle/transfer/auto-clear, and Escape clears spotlight', async () => {
    const { createStreamGridController } = await loadClientModules(['stream-grid']);
    const { initApp } = await import(
        `${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?spotlight=${Date.now()}`
    );

    const streamGrid = createMockElement('div', { id: 'streamGrid', className: 'stream-grid' });
    const emptyGridPlaceholder = createMockElement('div', { id: 'emptyGridPlaceholder' });
    const activeStreamsText = createMockElement('span', { id: 'activeStreamsText' });
    const doc = createMockDocument({ streamGrid, emptyGridPlaceholder, activeStreamsText }, {
        createElement: (tag) => createMockElement(tag)
    });
    doc.pictureInPictureEnabled = true;
    doc.pictureInPictureElement = null;
    let exitCount = 0;
    doc.exitPictureInPicture = async () => {
        exitCount += 1;
        doc.pictureInPictureElement = null;
    };

    const grid = createStreamGridController({
        state: { localStream: null, roomId: 'sala-spot', currentRoomPassword: '' },
        dom: { streamGrid, emptyGridPlaceholder, activeStreamsText },
        documentObj: doc,
        navigatorObj: { userAgent: 'Mozilla/5.0' }
    });

    const tileA = grid.createStreamTile('peer-a', { id: 's-a' }, 'Alice', false);
    const tileB = grid.createStreamTile('peer-b', { id: 's-b' }, 'Bob', false);
    streamGrid.appendChild(tileA);
    streamGrid.appendChild(tileB);

    const videoA = tileA.querySelector('video');
    const videoB = tileB.querySelector('video');
    videoA.requestPictureInPicture = async () => { doc.pictureInPictureElement = videoA; };
    videoB.requestPictureInPicture = async () => { doc.pictureInPictureElement = videoB; };

    const pipBtnA = tileA.querySelector('.btn-tile-pip');
    const pipBtnB = tileB.querySelector('.btn-tile-pip');
    assert.ok(pipBtnA && pipBtnB);

    pipBtnA.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(doc.pictureInPictureElement, videoA);

    pipBtnB.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(doc.pictureInPictureElement, videoB);

    pipBtnB.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(exitCount, 1);
    assert.equal(doc.pictureInPictureElement, null);

    // Spotlight toggle, transfer to another tile, and auto-clear on removal
    const spotBtnA = tileA.querySelector('.btn-tile-spotlight');
    const spotBtnB = tileB.querySelector('.btn-tile-spotlight');
    assert.equal(spotBtnA.getAttribute('aria-pressed'), 'false');

    spotBtnA.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    assert.equal(streamGrid.classList.contains('is-spotlight-mode'), true);
    assert.equal(streamGrid.dataset.spotlightPeerId, 'peer-a');
    assert.equal(tileA.classList.contains('is-spotlight'), true);
    assert.equal(spotBtnA.getAttribute('aria-pressed'), 'true');

    spotBtnB.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    assert.equal(streamGrid.dataset.spotlightPeerId, 'peer-b');
    assert.equal(tileA.classList.contains('is-spotlight'), false);
    assert.equal(spotBtnA.getAttribute('aria-pressed'), 'false');
    assert.equal(tileB.classList.contains('is-spotlight'), true);
    assert.equal(spotBtnB.getAttribute('aria-pressed'), 'true');

    // Removing spotlighted tile causes updateGridState() to clear spotlight mode
    tileB.remove();
    grid.updateGridState();
    assert.equal(streamGrid.classList.contains('is-spotlight-mode'), false);
    assert.equal(streamGrid.dataset.spotlightPeerId, undefined);

    // Escape in app.js clears spotlight when no modal is open
    const windowListeners = new Map();
    const appStreamGrid = createMockElement('div', { id: 'streamGrid', className: 'stream-grid' });
    const appDoc = createMockDocument({ streamGrid: appStreamGrid }, {
        createElement: (tag) => createMockElement(tag)
    });
    const fakeWin = {
        location: { origin: 'https://example.com', protocol: 'https:', hostname: 'example.com', pathname: '/', search: '' },
        history: { replaceState: () => {} },
        addEventListener: (ev, fn) => {
            if (!windowListeners.has(ev)) windowListeners.set(ev, new Set());
            windowListeners.get(ev).add(fn);
        },
        removeEventListener: (ev, fn) => {
            windowListeners.get(ev)?.delete(fn);
        }
    };
    const app = initApp({
        windowObj: fakeWin,
        documentObj: appDoc,
        navigatorObj: { userAgent: 'Mozilla/5.0' },
        storage: createMockStorage(),
        ioFactory: () => ({ connected: false, on: () => {}, emit: () => {}, disconnect: () => {} }),
        fetchImpl: async () => ({ ok: false, status: 503 }),
        serverUrl: 'https://example.com'
    });
    try {
        const t1 = app.grid.createStreamTile('peer-1', { id: 's-1' }, 'Carol', false);
        appStreamGrid.appendChild(t1);
        app.grid.toggleTileSpotlight(t1);
        assert.equal(app.grid.isSpotlightActive(), true);
        for (const fn of windowListeners.get('keydown') || []) {
            fn({ key: 'Escape' });
        }
        assert.equal(app.grid.isSpotlightActive(), false);
    } finally {
        app.teardownClientSession();
    }
});

test('Background track optimization pauses non-fullscreen tracks during pseudo-fullscreen and restores on exit', async () => {
    const { createWebRtcMesh, registerFullscreenChangeHandler, enterPseudoFullscreen, toggleTileFullscreen } = await loadClientModules(['tile-dom', 'webrtc-mesh']);
    const { mesh, doc } = createFullscreenHarness({ createWebRtcMesh, registerFullscreenChangeHandler });

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
    const { createWebRtcMesh, registerFullscreenChangeHandler, enterPseudoFullscreen } = await loadClientModules(['tile-dom', 'webrtc-mesh']);
    const { mesh, doc } = createFullscreenHarness({ createWebRtcMesh, registerFullscreenChangeHandler });

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
    const { toggleTileFullscreen, registerFullscreenChangeHandler } = await loadClientModules(['tile-dom']);
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

test('T4 (Item E): disposeTileElement unifies cleanup', async () => {
    const { disposeTileElement } = await loadClientModules(['tile-dom']);
    let unmuteCleaned = 0;
    let removedCount = 0;
    let exitFsCalls = 0;

    const videoEl = createMockElement('video');
    videoEl.srcObject = { id: 'stream-1' };
    const tileEl = {
        _cleanupTapUnmute: () => { unmuteCleaned += 1; },
        querySelector: (sel) => (sel === 'video' ? videoEl : null),
        remove: () => { removedCount += 1; }
    };
    const fakeDoc = {
        fullscreenElement: tileEl,
        exitFullscreen: () => {
            exitFsCalls += 1;
            return Promise.resolve();
        }
    };

    disposeTileElement(tileEl, fakeDoc);
    assert.equal(unmuteCleaned, 1);
    assert.equal(videoEl.srcObject, null);
    assert.equal(exitFsCalls, 1);
    assert.equal(removedCount, 1);
});

test('Remote tile quality selector: filters by broadcaster maxQuality, emits quality-request, clamps on cap drop, and closes on Escape', async () => {
    const { createStreamGridController, createWebRtcMesh, createQosMonitor, disposeTileElement } = await loadClientModules([
        'stream-grid',
        'webrtc-mesh',
        'qos-monitor',
        'tile-dom'
    ]);
    const { initApp } = await import(
        `${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?tileq=${Date.now()}`
    );

    const doc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    const streamGrid = createMockElement('div', { id: 'streamGrid', className: 'stream-grid' });
    doc.body.appendChild(streamGrid);

    const emittedSignals = [];
    const state = {
        myId: 'viewer-me',
        roomId: 'sala-q',
        localStream: null,
        activeStreamMaxQuality: null,
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60
    };

    let mesh;
    let grid;
    const qm = createQosMonitor({
        state,
        getPeers: () => mesh.peers
    });
    grid = createStreamGridController({
        state,
        dom: { streamGrid },
        getPeers: () => mesh.peers,
        getRemoteActiveStreams: () => mesh.remoteActiveStreams,
        getQualityMonitor: () => qm,
        onRequestPeerQuality: (peerId, preset, mode) => mesh.requestPeerVideoQuality(peerId, preset, mode),
        documentObj: doc,
        navigatorObj: { userAgent: 'Mozilla/5.0' }
    });
    mesh = createWebRtcMesh({
        state,
        dom: { streamGrid },
        getSocket: () => ({
            emit: (ev, payload) => {
                if (ev === 'signal') emittedSignals.push(payload);
            }
        }),
        getQosMonitor: () => qm,
        getGrid: () => grid,
        RTCPeerConnectionCtor: function () { return createMockPeerConnection(); },
        RTCSessionDescriptionCtor: MockRTCSessionDescription,
        RTCIceCandidateCtor: MockRTCIceCandidate,
        MediaStreamCtor: MockMediaStream,
        documentObj: doc,
        windowObj: { addEventListener: () => {} },
        storage: createMockStorage()
    });

    let app = null;
    try {
        // Local tile must NOT render viewer quality selector
        const localTile = grid.createStreamTile('local', new MockMediaStream([createMockTrack('video', 'v-loc')]), 'Você', true);
        assert.equal(localTile.querySelector('.tile-quality-control'), null);

        // Broadcaster starts at 1080p60
        const pcRemote = mesh.getOrCreatePeerConnection('host-1');
        const remoteVideoTrack = createMockTrack('video', 'v-rem');
        pcRemote.getReceivers = () => [{ track: remoteVideoTrack }];
        mesh.handleStreamState({
            senderId: 'host-1',
            state: 'started',
            maxQuality: { resolution: '1080p', fps: 60 }
        });

        const remoteTile = mesh.peers.get('host-1').tileEl;
        assert.ok(remoteTile, 'Remote tile should be created');
        const qualityBtn = remoteTile.querySelector('.btn-tile-quality');
        const qualityMenu = remoteTile.querySelector('.tile-quality-menu');
        assert.ok(qualityBtn && qualityMenu);
        assert.equal(qualityMenu.hidden, true);
        assert.equal(remoteTile.querySelector('.tile-quality-btn-label').textContent, 'Auto');

        const initialModes = qualityMenu.querySelectorAll('.tile-quality-mode-btn').map((el) => el.dataset.mode);
        assert.deepEqual(initialModes, ['balanced', 'motion', 'detail']);

        const initialOptions = qualityMenu.querySelectorAll('.tile-quality-option').map((el) => el.dataset.preset);
        assert.deepEqual(initialOptions, ['auto', '1080p60', '1080p30', '720p60', '720p30', '480p30']);

        // Viewer opens menu and selects 1080p60
        qualityBtn.click();
        assert.equal(qualityMenu.hidden, false);
        assert.equal(grid.isAnyQualityMenuOpen(), true);

        const opt1080 = qualityMenu.querySelectorAll('.tile-quality-option').find((el) => el.dataset.preset === '1080p60');
        opt1080.click();
        assert.equal(qualityMenu.hidden, true);
        assert.equal(remoteTile.querySelector('.tile-quality-btn-label').textContent, '1080p60');
        assert.deepEqual(emittedSignals[emittedSignals.length - 1], {
            targetId: 'host-1',
            signal: { type: 'quality-request', preset: '1080p60', mode: 'balanced' }
        });

        // Viewer opens menu and switches mode to Nítido ('detail')
        qualityBtn.click();
        const modeDetailBtn = qualityMenu.querySelectorAll('.tile-quality-mode-btn').find((el) => el.dataset.mode === 'detail');
        modeDetailBtn.click();
        assert.equal(qualityMenu.hidden, true);
        assert.equal(remoteTile.querySelector('.tile-quality-btn-label').textContent, '1080p60 • Nítido');
        assert.deepEqual(emittedSignals[emittedSignals.length - 1], {
            targetId: 'host-1',
            signal: { type: 'quality-request', preset: '1080p60', mode: 'detail' }
        });

        // Broadcaster lowers cap to 720p30 -> viewer selection above cap resets to auto while keeping chosen mode ('detail')
        mesh.handleStreamState({
            senderId: 'host-1',
            state: 'started',
            maxQuality: { resolution: '720p', fps: 30 }
        });
        const cappedOptions = qualityMenu.querySelectorAll('.tile-quality-option').map((el) => el.dataset.preset);
        assert.deepEqual(cappedOptions, ['auto', '720p30', '480p30']);
        assert.equal(remoteTile.querySelector('.tile-quality-btn-label').textContent, 'Auto • Nítido');
        assert.deepEqual(emittedSignals[emittedSignals.length - 1], {
            targetId: 'host-1',
            signal: { type: 'quality-request', preset: 'auto', mode: 'detail' }
        });

        // Escape in app.js closes open quality menu before clearing spotlight
        const winListeners = new Map();
        const appStreamGrid = createMockElement('div', { id: 'streamGrid', className: 'stream-grid' });
        const appDoc = createMockDocument({ streamGrid: appStreamGrid }, { createElement: (tag) => createMockElement(tag) });
        app = initApp({
            windowObj: {
                location: { origin: 'https://example.com', protocol: 'https:', hostname: 'example.com', pathname: '/', search: '' },
                history: { replaceState: () => {} },
                addEventListener: (ev, fn) => {
                    if (!winListeners.has(ev)) winListeners.set(ev, new Set());
                    winListeners.get(ev).add(fn);
                },
                removeEventListener: (ev, fn) => { winListeners.get(ev)?.delete(fn); }
            },
            documentObj: appDoc,
            navigatorObj: { userAgent: 'Mozilla/5.0' },
            storage: createMockStorage(),
            ioFactory: () => ({ connected: false, on: () => {}, emit: () => {}, disconnect: () => {} }),
            fetchImpl: async () => ({ ok: false, status: 503 }),
            serverUrl: 'https://example.com'
        });

        const t = app.grid.createStreamTile('peer-esc', { id: 's-esc' }, 'Diana', false);
        appStreamGrid.appendChild(t);
        app.grid.toggleTileSpotlight(t);
        t.querySelector('.btn-tile-quality').click();
        assert.equal(app.grid.isAnyQualityMenuOpen(), true);
        assert.equal(app.grid.isSpotlightActive(), true);

        for (const fn of winListeners.get('keydown') || []) {
            fn({ key: 'Escape' });
        }
        assert.equal(app.grid.isAnyQualityMenuOpen(), false, 'First Escape closes quality menu');
        assert.equal(app.grid.isSpotlightActive(), true, 'Spotlight remains active on first Escape');

        t.querySelector('.btn-tile-quality').click();
        disposeTileElement(t, appDoc);
        assert.equal(app.grid.isAnyQualityMenuOpen(), false, 'disposeTileElement cleans up open quality menu');
    } finally {
        if (app) app.teardownClientSession();
        qm.stopQualityMonitor();
        grid.cleanup();
        mesh.cleanupRoomState({ silent: true });
    }
});
