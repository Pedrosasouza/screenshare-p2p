'use strict';

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { ROOT_DIR, loadClientModules } = require('./helpers/client-env');

async function loadModules() {
    return loadClientModules(['stream-grid', 'tile-dom', 'qos-monitor', 'stats-modal', 'preferences', 'room-modal']);
}

function createHarness(mods, overrides = {}) {
    const createdVideos = [];
    const clipboardWrites = [];
    const toasts = [];

    const btnCopyLink = createMockElement('button', {
        id: 'btnCopyLink',
        innerHTML: '<i class="fa-solid fa-link"></i> <span class="btn-text">Copiar Link</span>'
    });
    const statsModal = createMockElement('div', { id: 'statsModal', style: { display: 'none' } });
    const statsGrid = createMockElement('div', { id: 'statsGrid', style: { display: 'grid' } });
    const doc = createMockDocument({ btnCopyLink, statsModal, statsGrid }, {
        playImpl: overrides.videoPlayImpl
            ? (videoEl) => {
                createdVideos.push(videoEl);
                return overrides.videoPlayImpl(videoEl);
            }
            : null
    });

    const state = {
        roomId: overrides.roomId !== undefined ? overrides.roomId : 'room-123',
        currentRoomPassword: overrides.currentRoomPassword || '',
        localStream: null,
        contentHintMode: 'motion',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60
    };
    const peers = overrides.peers || new Map();

    const grid = mods.createStreamGridController({
        state,
        dom: { btnCopyLink },
        getPeers: () => peers,
        isDesktopApp: () => Boolean(overrides.isDesktop),
        getServerUrl: () => 'https://stream.example.com',
        showToast: (msg, type) => toasts.push({ msg, type }),
        documentObj: doc,
        windowObj: { location: { origin: 'https://stream.example.com', pathname: '/' } },
        navigatorObj: {
            userAgent: overrides.userAgent || 'Mozilla/5.0',
            clipboard: { writeText: async (txt) => { clipboardWrites.push(txt); } }
        }
    });
    grid.bindCopyInviteLink();

    const qm = mods.createQosMonitor({
        state,
        dom: {},
        getPeers: () => peers,
        storage: createMockStorage()
    });

    const statsCtrl = mods.createStatsModalController({
        state,
        dom: { statsModal, statsGrid },
        getPeers: () => peers,
        getServerUrl: () => 'https://stream.example.com',
        showToast: (msg, type) => toasts.push({ msg, type }),
        documentObj: doc,
        windowObj: { location: { origin: 'https://stream.example.com', pathname: '/' } },
        storage: createMockStorage()
    });

    return { grid, qm, statsCtrl, state, peers, doc, btnCopyLink, clipboardWrites, toasts, createdVideos };
}

test('T1: showTapToUnmuteBadge removes listeners on badge & tile, syncs UI, and cleans up via muteBtn', async () => {
    const mods = await loadModules();
    const h = createHarness(mods);
    const tile = h.grid.createStreamTile('tile-1', { id: 'stream-1' }, 'Peer 1', false);
    const video = tile.querySelector('video');
    video.muted = true;
    video.volume = 0;
    video.setAttribute('muted', '');

    mods.showTapToUnmuteBadge(tile, video, h.doc);
    const badge = tile.querySelector('.tap-unmute-badge');
    assert(badge, 'badge should be appended to tile');
    assert.equal(tile.listenerCount('click'), 1);

    badge.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, false);
    assert.equal(video.hasAttribute('muted'), false);
    assert.equal(video.volume, 1);
    assert.equal(tile.listenerCount('click'), 0);
    assert.equal(tile.querySelector('.tap-unmute-badge'), null);

    const slider = tile.querySelector('.tile-controls-overlay input[type="range"]');
    const muteBtn = tile.querySelector('.tile-controls-overlay .btn-icon');
    assert.equal(String(slider.value), '1');
    assert.equal(muteBtn.innerHTML, '<i class="fa-solid fa-volume-high"></i>');

    muteBtn.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, true);
    tile.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, true, 'clicking tile after badge unmute must not unmute again');

    mods.showTapToUnmuteBadge(tile, video, h.doc);
    assert(tile.querySelector('.tap-unmute-badge'));
    assert.equal(tile.listenerCount('click'), 1);
    muteBtn.dispatchEvent({ type: 'click' });
    assert.equal(video.muted, false);
    assert.equal(tile.querySelector('.tap-unmute-badge'), null);
    assert.equal(tile.listenerCount('click'), 0);
});

test('T2: createStreamTile defers video.play() until startTilePlayback, with muted autoplay fallback', async () => {
    const mods = await loadModules();
    let attempt = 0;
    const h = createHarness(mods, {
        videoPlayImpl: () => {
            attempt += 1;
            if (attempt === 1) return Promise.reject(new Error('NotAllowedError'));
            return Promise.resolve();
        }
    });

    const tile = h.grid.createStreamTile('tile-2', { id: 'stream-2' }, 'Peer 2', false);
    const video = tile.querySelector('video');
    assert.equal(video.playCalls, 0, 'createStreamTile must NOT call video.play() on detached DOM');

    assert.doesNotThrow(() => h.grid.startTilePlayback({ id: 'mock-tile' }));

    h.grid.startTilePlayback(tile, video);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(video.playCalls, 2);
    assert.equal(video.muted, true);
    assert.equal(video.hasAttribute('muted'), true);
    assert(tile.querySelector('.tap-unmute-badge'), 'fallback should show tap-to-unmute badge');
});

test('T3: btnCopyLink guards empty roomId and debounces rapid clicks preserving default HTML', async () => {
    const mods = await loadModules();
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const timers = new Map();
    let nextId = 1;

    global.setTimeout = (fn) => {
        const id = nextId++;
        timers.set(id, fn);
        return id;
    };
    global.clearTimeout = (id) => { timers.delete(id); };

    try {
        const hEmpty = createHarness(mods, { roomId: null });
        hEmpty.btnCopyLink.dispatchEvent({ type: 'click' });
        assert.equal(hEmpty.clipboardWrites.length, 0);
        assert.equal(hEmpty.toasts.length, 1);
        assert.equal(hEmpty.toasts[0].type, 'warning');

        const h = createHarness(mods, { roomId: 'room-xyz', currentRoomPassword: 'secret' });
        const originalHtml = h.btnCopyLink.innerHTML;
        h.btnCopyLink.dispatchEvent({ type: 'click' });
        await Promise.resolve();
        assert.ok(h.btnCopyLink.innerHTML.includes('Link Copiado!'));
        assert.equal(timers.size, 1);

        h.btnCopyLink.dispatchEvent({ type: 'click' });
        await Promise.resolve();
        assert.equal(h.clipboardWrites.length, 2);
        assert.equal(timers.size, 1, 'rapid click must cancel previous timer');

        for (const fn of timers.values()) fn();
        timers.clear();
        assert.equal(h.btnCopyLink.innerHTML, originalHtml);
    } finally {
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
    }
});

test('T4: Anti-reentrancy and generation guards on startQualityMonitor / openStatsModal / closeStatsModal', async () => {
    const mods = await loadModules();
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    const intervals = new Map();
    let nextIntId = 1;

    global.setInterval = (fn) => {
        const id = nextIntId++;
        intervals.set(id, fn);
        return id;
    };
    global.clearInterval = (id) => { intervals.delete(id); };

    let resolveStats;
    let statsCallCount = 0;

    try {
        const h = createHarness(mods, {
            peers: new Map([
                ['peer-1', {
                    userName: 'Alice',
                    pc: {
                        connectionState: 'connected',
                        getStats: () => {
                            statsCallCount += 1;
                            return new Promise((r) => {
                                resolveStats = () => r(new Map([
                                    ['cand-pair', { id: 'cand-pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.02 }],
                                    ['in-v', { id: 'in-v', type: 'inbound-rtp', kind: 'video', timestamp: 1000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, packetsLost: 0, bytesReceived: 1024 }]
                                ]));
                            });
                        }
                    }
                }]
            ])
        });

        // Quality monitor reentrancy test
        let resolveEval;
        let evalCount = 0;
        h.peers.get('peer-1').pc.getStats = () => {
            statsCallCount += 1;
            return new Promise((r) => {
                resolveEval = () => r(new Map([
                    ['cand-pair', { id: 'cand-pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.02 }],
                    ['in-v', { id: 'in-v', type: 'inbound-rtp', kind: 'video', timestamp: 2000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, packetsLost: 0, bytesReceived: 2048 }]
                ]));
                resolveStats = resolveEval;
                evalCount = statsCallCount;
            });
        };

        h.qm.startQualityMonitor();
        assert.equal(intervals.size, 1);
        const qFn = Array.from(intervals.values())[0];

        const p1 = qFn();
        const p2 = qFn();
        assert.equal(evalCount, 1, 'concurrent quality monitor tick must be skipped');
        resolveEval();
        await p1;
        await p2;

        const p3 = qFn();
        assert.equal(statsCallCount, 2, 'quality monitor runs again after previous tick settles');
        resolveEval();
        await p3;
        h.qm.stopQualityMonitor();
        assert.equal(intervals.size, 0);

        // Stats modal overlap + generation guard
        statsCallCount = 0;
        h.statsCtrl.openStatsModal();
        assert.equal(statsCallCount, 1);
        const overlap = h.statsCtrl.updateStatsDisplay();
        assert.equal(statsCallCount, 1, 'overlapping updateStatsDisplay must not call getStats()');
        await overlap;

        h.statsCtrl.closeStatsModal();
        assert.equal(intervals.size, 0);
        resolveStats();
        await new Promise((r) => setTimeout(r, 10));

        h.statsCtrl.openStatsModal();
        assert.equal(statsCallCount, 2, 'reopening stats modal runs fresh getStats()');
        resolveStats();
        await new Promise((r) => setTimeout(r, 10));
        h.statsCtrl.closeStatsModal();
    } finally {
        global.setInterval = origSetInterval;
        global.clearInterval = origClearInterval;
    }
});

test('T5: teardownClientSession disconnects offline sockets, stops desktop listeners, and removes window/document listeners', async () => {
    const { initApp } = await loadClientModules(['app'], { cacheBustTag: 'teardown' });

    const windowListeners = new Map();
    const docListeners = new Map();
    let disconnectCalls = 0;
    let desktopStopCalls = 0;
    let unlistenCalled = 0;

    const fakeDoc = createMockDocument({}, { createElement: (tag) => createMockElement(tag) });
    fakeDoc.addEventListener = (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
    };
    fakeDoc.removeEventListener = (type, fn) => {
        const set = docListeners.get(type);
        if (set) set.delete(fn);
    };

    const fakeWindow = {
        __TAURI_INTERNALS__: {},
        StreamGridDesktop: {
            isDesktop: () => true,
            getDiscordStatus: async () => ({ detected: false, pid: 0 }),
            listWindows: async () => [],
            stopAppAudioCapture: async () => { desktopStopCalls += 1; },
            onCaptureStopped: async () => () => { unlistenCalled += 1; }
        },
        location: { protocol: 'http:', origin: 'http://tauri.localhost', pathname: '/', search: '', hash: '' },
        addEventListener: (type, fn) => {
            if (!windowListeners.has(type)) windowListeners.set(type, new Set());
            windowListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => {
            const set = windowListeners.get(type);
            if (set) set.delete(fn);
        },
        matchMedia: () => ({ matches: false })
    };

    const socket = {
        id: '',
        connected: false,
        on() {},
        emit() {},
        disconnect() { disconnectCalls += 1; }
    };

    const app = initApp({
        windowObj: fakeWindow,
        documentObj: fakeDoc,
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => socket,
        fetchImpl: async () => ({ ok: false, status: 503 }),
        serverUrl: 'http://localhost:3000'
    });

    await new Promise((r) => setTimeout(r, 20));
    app.teardownClientSession();

    assert.equal(disconnectCalls, 1, 'teardownClientSession deve chamar disconnect mesmo com socket offline reconectando');
    assert.equal(unlistenCalled, 1, 'teardownClientSession deve remover listener wasapi-capture-stopped');
    assert.ok(desktopStopCalls >= 1, 'teardownClientSession deve garantir stopAppAudioCapture');
    assert.equal((windowListeners.get('keydown') || new Set()).size, 0, 'listener keydown deve ser removido');
    assert.equal((windowListeners.get('pagehide') || new Set()).size, 0, 'listener pagehide deve ser removido');
    assert.equal((docListeners.get('visibilitychange') || new Set()).size, 0, 'listener visibilitychange deve ser removido');
});

test('Salas Recentes: persistência e renderização no room-modal', async (t) => {
    const mods = await loadModules();

    await t.test('saveRecentRoom, loadRecentRooms, removeRecentRoom e clearRecentRooms respeitam limite, deduplicação e sanitização', () => {
        const storage = createMockStorage();

        assert.deepEqual(mods.loadRecentRooms(storage), []);

        mods.saveRecentRoom('ab', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), []);

        mods.saveRecentRoom('sala-1', storage);
        mods.saveRecentRoom('sala-2', storage);
        mods.saveRecentRoom('sala-3', storage);
        mods.saveRecentRoom('sala-1', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), ['sala-1', 'sala-3', 'sala-2']);

        mods.saveRecentRoom('sala-4', storage);
        mods.saveRecentRoom('sala-5', storage);
        mods.saveRecentRoom('sala-6', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), ['sala-6', 'sala-5', 'sala-4', 'sala-1', 'sala-3']);

        mods.removeRecentRoom('sala-4', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), ['sala-6', 'sala-5', 'sala-1', 'sala-3']);

        mods.clearRecentRooms(storage);
        assert.deepEqual(mods.loadRecentRooms(storage), []);
    });

    await t.test('renderRecentRooms exibe lista, consulta check-room, remove item e redireciona sala com senha para view join', () => {
        const storage = createMockStorage();
        mods.saveRecentRoom('sala-publica', storage);
        mods.saveRecentRoom('sala-privada', storage);
        mods.saveRecentRoom('sala-atual', storage);

        const recentRoomsSection = createMockElement('div', { id: 'recentRoomsSection', hidden: true });
        const recentRoomsList = createMockElement('div', { id: 'recentRoomsList' });
        const btnClearRecentRooms = createMockElement('button', { id: 'btnClearRecentRooms' });
        const inputJoinRoomId = createMockElement('input', { id: 'inputJoinRoomId' });
        const inputJoinRoomPassword = createMockElement('input', { id: 'inputJoinRoomPassword' });
        const roomViewChoice = createMockElement('div', { id: 'roomViewChoice', style: { display: 'block' } });
        const roomViewCreate = createMockElement('div', { id: 'roomViewCreate', style: { display: 'none' } });
        const roomViewJoin = createMockElement('div', { id: 'roomViewJoin', style: { display: 'none' } });
        const roomModal = createMockElement('div', { id: 'roomModal', hidden: false, style: { display: 'flex' } });

        const dom = {
            roomModal,
            roomViewChoice,
            roomViewCreate,
            roomViewJoin,
            recentRoomsSection,
            recentRoomsList,
            btnClearRecentRooms,
            inputJoinRoomId,
            inputJoinRoomPassword
        };
        const doc = createMockDocument(dom, { createElement: (tag) => createMockElement(tag) });

        const emittedJoin = [];
        const socket = {
            connected: true,
            emit(event, payload, cb) {
                if (event === 'check-room' && typeof cb === 'function') {
                    if (payload.roomId === 'sala-privada') {
                        cb({ exists: true, memberCount: 3, hasPassword: true });
                    } else if (payload.roomId === 'sala-publica') {
                        cb({ exists: false, memberCount: 0, hasPassword: false });
                    }
                } else if (event === 'join-room') {
                    emittedJoin.push(payload);
                }
            }
        };

        const state = {
            roomId: 'sala-atual',
            clientId: 'c_test',
            currentUserName: 'Pedro',
            pendingRoomJoin: null
        };

        const ctrl = mods.createRoomModalController({
            state,
            dom,
            getSocket: () => socket,
            getSessionRoomPassword: () => '',
            clearSessionRoomPassword: () => {},
            documentObj: doc,
            storage,
            windowObj: { location: { search: '', hash: '', pathname: '/' } }
        });

        ctrl.bindEvents();
        ctrl.openRoomModal('choice');

        assert.equal(recentRoomsSection.hidden, false);
        assert.equal(recentRoomsList.children.length, 3);

        // Primeiro item é a sala atual
        const firstRow = recentRoomsList.children[0];
        assert.ok(firstRow.className.includes('is-current'));

        // Segundo item é sala-privada (3 online + hasPassword) -> clicar abre view join
        const privateRow = recentRoomsList.children[1];
        const privateMainBtn = privateRow.children[0];
        privateMainBtn.dispatchEvent({ type: 'click' });
        assert.equal(inputJoinRoomId.value, 'sala-privada');
        assert.equal(roomViewJoin.hidden, false);

        // Volta para choice e clica no botão remover de sala-publica
        ctrl.switchRoomView('choice');
        const publicRow = recentRoomsList.children[2];
        const removeBtn = publicRow.children[1];
        removeBtn.dispatchEvent({ type: 'click', stopPropagation: () => {} });
        assert.equal(recentRoomsList.children.length, 2);

        // Limpar tudo esconde o botão Limpar e exibe estado vazio na seção
        btnClearRecentRooms.dispatchEvent({ type: 'click' });
        assert.equal(recentRoomsSection.hidden, false);
        assert.equal(btnClearRecentRooms.hidden, true);
        assert.equal(recentRoomsList.children.length, 1);
        assert.equal(recentRoomsList.children[0].className, 'recent-rooms-empty');
    });
});

describe('Utilitários da barra inferior (PiP e Stats)', () => {
    it('T1: public/index.html define btnTogglePip, btnToggleStats, statsModal e formulario de servidor customizado', () => {
        const html = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
        assert.ok(html.includes('id="btnTogglePip"'));
        assert.ok(html.includes('id="btnToggleStats"'));
        assert.ok(html.includes('id="statsModal"'));
        assert.ok(html.includes('id="customServerFormContainer"'));
        assert.ok(html.includes('id="inputCustomServerUrl"'));
        assert.ok(html.includes('id="btnSaveServerUrl"'));
    });

    it('T2: stats-modal togglePictureInPicture ativa e sai de PiP corretamente', async () => {
        const { createStatsModalController } = await loadModules();

        const doc = createMockDocument();
        let pipRequested = 0;
        let pipExited = 0;
        doc.pictureInPictureEnabled = true;
        doc.pictureInPictureElement = null;
        doc.exitPictureInPicture = async () => {
            pipExited += 1;
            doc.pictureInPictureElement = null;
        };

        const streamGrid = createMockElement('div', { id: 'streamGrid' });
        const remoteTile = createMockElement('div', { id: 'tile-peer-1', className: 'stream-tile' });
        const remoteVideo = createMockElement('video');
        remoteVideo.requestPictureInPicture = async () => {
            pipRequested += 1;
            doc.pictureInPictureElement = remoteVideo;
        };
        remoteTile.appendChild(remoteVideo);
        streamGrid.appendChild(remoteTile);
        doc.body.appendChild(streamGrid);

        const toasts = [];
        const ctrl = createStatsModalController({
            state: { selectedVideoResolution: '1080p' },
            dom: { streamGrid },
            getPeers: () => new Map(),
            getServerUrl: () => 'http://127.0.0.1',
            showToast: (msg, type) => toasts.push({ msg, type }),
            documentObj: doc,
            windowObj: { location: { reload: () => {} } }
        });

        await ctrl.togglePictureInPicture();
        assert.strictEqual(pipRequested, 1);
        assert.strictEqual(doc.pictureInPictureElement, remoteVideo);

        await ctrl.togglePictureInPicture();
        assert.strictEqual(pipExited, 1);
        assert.strictEqual(doc.pictureInPictureElement, null);
        assert.strictEqual(toasts.length, 0);
    });

    it('T3: openStatsModal/closeStatsModal respondem a clique de backdrop e API pública', async () => {
        const { createStatsModalController } = await loadModules();

        const doc = createMockDocument();
        const statsModal = createMockElement('div', { id: 'statsModal' });
        statsModal.hidden = true;
        statsModal.style.display = 'none';
        const btnToggleStats = createMockElement('button', { id: 'btnToggleStats' });
        const btnCloseStatsModal = createMockElement('button', { id: 'btnCloseStatsModal' });
        doc.body.appendChild(statsModal);

        const ctrl = createStatsModalController({
            state: { selectedVideoResolution: '1080p' },
            dom: { statsModal, btnToggleStats, btnCloseStatsModal },
            getPeers: () => new Map(),
            getServerUrl: () => 'http://127.0.0.1',
            showToast: () => {},
            documentObj: doc,
            windowObj: { location: { reload: () => {} } }
        });
        ctrl.bindEvents();

        try {
            ctrl.openStatsModal();
            assert.strictEqual(ctrl.isStatsModalOpen(), true);

            // Backdrop click fecha
            statsModal.dispatchEvent({ type: 'click', target: statsModal });
            assert.strictEqual(ctrl.isStatsModalOpen(), false);
            assert.strictEqual(statsModal.style.display, 'none');

            // Reabre e fecha via botão
            btnToggleStats.click();
            assert.strictEqual(ctrl.isStatsModalOpen(), true);
            btnCloseStatsModal.click();
            assert.strictEqual(ctrl.isStatsModalOpen(), false);
        } finally {
            ctrl.closeStatsModal();
        }
    });

    it('T4: toggleVideoPictureInPicture alterna PiP entre dois vídeos distintos e trata saída no mesmo vídeo', async () => {
        const { toggleVideoPictureInPicture } = await loadModules();

        const doc = createMockDocument();
        let exitCount = 0;
        doc.pictureInPictureEnabled = true;
        doc.pictureInPictureElement = null;
        doc.exitPictureInPicture = async () => {
            exitCount += 1;
            doc.pictureInPictureElement = null;
        };

        const videoA = createMockElement('video');
        const videoB = createMockElement('video');
        let reqA = 0;
        let reqB = 0;
        videoA.requestPictureInPicture = async () => {
            reqA += 1;
            doc.pictureInPictureElement = videoA;
        };
        videoB.requestPictureInPicture = async () => {
            reqB += 1;
            doc.pictureInPictureElement = videoB;
        };

        await toggleVideoPictureInPicture(videoA, { documentObj: doc });
        assert.strictEqual(reqA, 1);
        assert.strictEqual(doc.pictureInPictureElement, videoA);

        // Ativar PiP em B enquanto A está em PiP troca direto para B
        await toggleVideoPictureInPicture(videoB, { documentObj: doc });
        assert.strictEqual(reqB, 1);
        assert.strictEqual(exitCount, 0);
        assert.strictEqual(doc.pictureInPictureElement, videoB);

        // Clicar novamente em B sai do PiP
        await toggleVideoPictureInPicture(videoB, { documentObj: doc });
        assert.strictEqual(exitCount, 1);
        assert.strictEqual(doc.pictureInPictureElement, null);
    });
});
