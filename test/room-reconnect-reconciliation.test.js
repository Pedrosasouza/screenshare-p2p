const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.resolve(__dirname, '../public/app.js');
const { loadClientBundleSource } = require('./helpers/client-source');
const appJs = loadClientBundleSource();
function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Function ${name} not found in public/app.js`);
    return match[0];
}

function extractSocketHandler(source, eventName) {
    const regex = new RegExp(`socket\\.on\\('${eventName}'[\\s\\S]*?\\n\\}\\);`);
    const match = source.match(regex);
    assert(match, `Handler socket.on('${eventName}') not found in public/app.js`);
    return match[0];
}

function createHarness(overrides = {}) {
    const socketHandlers = {};
    const emittedEvents = [];
    const timeouts = new Map();
    const intervals = new Map();
    let nextTimerId = 1;
    let echoVisibilityUpdates = 0;
    let sendOfferCalls = [];

    class MockMediaStream {
        constructor(tracks = []) {
            this._tracks = tracks;
        }
        getTracks() { return this._tracks; }
        getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
        addTrack(t) { this._tracks.push(t); }
    }

    function createMockPC() {
        return {
            signalingState: 'stable',
            connectionState: 'connected',
            iceConnectionState: 'connected',
            closed: false,
            restartIceCalls: 0,
            _senders: [],
            getSenders() { return this._senders; },
            restartIce() { this.restartIceCalls++; },
            close() {
                this.closed = true;
                this.signalingState = 'closed';
                this.connectionState = 'closed';
            }
        };
    }

    const peers = new Map();
    const remoteActiveStreams = new Set();

    const sandbox = {
        Map,
        Set,
        Array,
        Promise,
        encodeURIComponent,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        STORAGE_KEY: 'screenshare_room_id',
        rtcConfig: {},
        MediaStream: MockMediaStream,
        RTCPeerConnection: function MockRTCPeerConnection() {
            return createMockPC();
        },
        roomId: 'sala-1',
        pendingRoomJoin: null,
        currentRoomPassword: '',
        myId: 'my-socket-id',
        localStream: overrides.localStream || null,
        peers,
        remoteActiveStreams,
        displayRoomId: { textContent: '', appendChild() {} },
        memberCountText: { textContent: '' },
        streamGrid: {
            children: [],
            appendChild(el) { this.children.push(el); },
            querySelectorAll() { return []; }
        },
        document: {
            createElement(tag) {
                return { tagName: tag, className: '', style: {}, title: '' };
            }
        },
        window: {
            location: { protocol: 'http:', pathname: '/' },
            history: { pushState() {} }
        },
        localStorage: { setItem() {} },
        socket: {
            id: 'my-socket-id',
            connected: true,
            on(ev, fn) { socketHandlers[ev] = fn; },
            emit(ev, payload) { emittedEvents.push({ ev, payload }); }
        },
        setTimeout(fn, ms) {
            const id = nextTimerId++;
            timeouts.set(id, { id, fn, ms, cleared: false });
            return id;
        },
        clearTimeout(id) {
            if (timeouts.has(id)) {
                timeouts.get(id).cleared = true;
                timeouts.delete(id);
            }
        },
        setInterval(fn, ms) {
            const id = nextTimerId++;
            intervals.set(id, { id, fn, ms, cleared: false });
            return id;
        },
        clearInterval(id) {
            if (intervals.has(id)) {
                intervals.get(id).cleared = true;
                intervals.delete(id);
            }
        },
        closeRoomModal() {},
        updateRoomModalCloseButton() {},
        updateEchoWarningVisibility() { echoVisibilityUpdates++; },
        updateMemberCount() {},
        updateGridState() {},
        updatePeerUserName() {},
        addLocalTracksToPC() {},
        updateSendersForActivePeers() {},
        stopScreenShare() {},
        showToast() {},
        playPresenceChime() {},
        setPeerConnectionStatus() {},
        logPeerConnectionTelemetry() {},
        createStreamTile(id, stream) {
            const video = { srcObject: stream, videoWidth: 0 };
            const tile = {
                id,
                removed: false,
                querySelector(sel) { return sel === 'video' ? video : null; },
                remove() { this.removed = true; }
            };
            return tile;
        },
        startTilePlayback() {},
        sendOffer(peerId) {
            sendOfferCalls.push(peerId);
        }
    };

    if (overrides.useRealSendOffer !== true) {
        // Keep stubbed sendOffer so T4 verifies sendOffer wasn't even called
    }

    vm.createContext(sandbox);
    vm.runInContext(extractFn(appJs, 'disposeTileElement'), sandbox);
    vm.runInContext(extractFn(appJs, 'clearPeerTimers'), sandbox);
    vm.runInContext(extractFn(appJs, 'removePeerConnection'), sandbox);
    vm.runInContext(extractFn(appJs, 'removeStreamTile'), sandbox);
    vm.runInContext(extractFn(appJs, 'cleanupRoomState'), sandbox);
    vm.runInContext(extractFn(appJs, 'isPeerConnectionActive'), sandbox);
    vm.runInContext(extractFn(appJs, 'getOrCreatePeerConnection'), sandbox);
    vm.runInContext(extractSocketHandler(appJs, 'room-users'), sandbox);
    vm.runInContext(extractSocketHandler(appJs, 'user-joined'), sandbox);

    return {
        sandbox,
        socketHandlers,
        emittedEvents,
        timeouts,
        intervals,
        createMockPC,
        MockMediaStream,
        getEchoVisibilityUpdates: () => echoVisibilityUpdates,
        getSendOfferCalls: () => sendOfferCalls
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: RECONCILIAÇÃO DE PEERS & TIMERS');
    console.log('===============================================================\n');

    // T1: room-users on reconnect (!pendingRoomJoin) removes stale peers, keeps active ones, ignores myId
    process.stdout.write('  [Teste] T1: room-users em reconexão remove peers obsoletos e ignora myId ... ');
    {
        const h = createHarness();
        const stalePc = h.createMockPC();
        const activePc = h.createMockPC();
        const staleVideo = { srcObject: { id: 'stale-stream' } };
        const staleTile = {
            removed: false,
            querySelector(sel) { return sel === 'video' ? staleVideo : null; },
            remove() { this.removed = true; }
        };
        const activeTile = {
            removed: false,
            querySelector() { return null; },
            remove() { this.removed = true; }
        };
        const staleIntervalId = h.sandbox.setInterval(() => {}, 1000);
        const stalePulseId = h.sandbox.setTimeout(() => {}, 400);

        h.sandbox.peers.set('peer-stale', {
            pc: stalePc,
            stream: new h.MockMediaStream([{ stop() {} }]),
            tileEl: staleTile,
            _keyframeCheckInterval: staleIntervalId,
            _keyframePulseTimeout: stalePulseId
        });
        h.sandbox.peers.set('peer-keep', {
            pc: activePc,
            stream: new h.MockMediaStream([]),
            tileEl: activeTile
        });

        await h.socketHandlers['room-users']({
            users: ['peer-keep', 'peer-new', 'my-socket-id'],
            userNames: { 'peer-keep': 'Keep', 'peer-new': 'New' },
            activeStreams: [],
            socketId: 'my-socket-id',
            memberCount: 3,
            hasPassword: false
        });

        assert.strictEqual(h.sandbox.peers.has('peer-stale'), false, 'Stale peer must be removed');
        assert.strictEqual(stalePc.closed, true, 'Stale pc must be closed');
        assert.strictEqual(staleTile.removed, true, 'Stale tile must be removed');
        assert.strictEqual(staleVideo.srcObject, null, 'Stale video srcObject must be cleared');
        assert.strictEqual(h.intervals.has(staleIntervalId), false, 'Stale interval must be cleared');
        assert.strictEqual(h.timeouts.has(stalePulseId), false, 'Stale pulse timeout must be cleared');

        assert.strictEqual(h.sandbox.peers.has('peer-keep'), true, 'Present peer must remain');
        assert.strictEqual(activePc.closed, false, 'Present peer pc must stay open');
        assert.strictEqual(h.sandbox.peers.has('peer-new'), true, 'New peer must be initialized');
        assert.strictEqual(h.sandbox.peers.has('my-socket-id'), false, 'Self socketId must be ignored');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: cleanupRoomState clears remoteActiveStreams, calls updateEchoWarningVisibility, and nulls video.srcObject
    process.stdout.write('  [Teste] T2: cleanupRoomState limpa remoteActiveStreams e zera videoEl.srcObject ... ');
    {
        const h = createHarness();
        const video1 = { srcObject: { id: 'stream-1' } };
        const tile1 = {
            removed: false,
            querySelector(sel) { return sel === 'video' ? video1 : null; },
            remove() { this.removed = true; }
        };
        const tileMockWithoutQuery = {
            removed: false,
            remove() { this.removed = true; }
        };

        h.sandbox.peers.set('p1', {
            pc: h.createMockPC(),
            stream: new h.MockMediaStream([]),
            tileEl: tile1
        });
        h.sandbox.peers.set('p2', {
            pc: h.createMockPC(),
            stream: new h.MockMediaStream([]),
            tileEl: tileMockWithoutQuery
        });
        h.sandbox.remoteActiveStreams.add('p1');
        h.sandbox.remoteActiveStreams.add('p2');

        const beforeEchoUpdates = h.getEchoVisibilityUpdates();
        h.sandbox.cleanupRoomState();

        assert.strictEqual(h.sandbox.peers.size, 0, 'peers must be cleared');
        assert.strictEqual(h.sandbox.remoteActiveStreams.size, 0, 'remoteActiveStreams must be cleared');
        assert.strictEqual(h.getEchoVisibilityUpdates(), beforeEchoUpdates + 1, 'updateEchoWarningVisibility must be called');
        assert.strictEqual(video1.srcObject, null, 'video1.srcObject must be nulled before tile removal');
        assert.strictEqual(tile1.removed, true, 'tile1 must be removed');
        assert.strictEqual(tileMockWithoutQuery.removed, true, 'mock tile without querySelector must still be removed safely');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: user-joined ignores myId and cancels _keyframePulseTimeout when peer is removed before 400ms
    process.stdout.write('  [Teste] T3: user-joined ignora myId e cancela _keyframePulseTimeout ao remover peer ... ');
    {
        let replaceCalls = 0;
        const fakeVideoTrack = { id: 'v1', kind: 'video' };
        const h = createHarness({
            localStream: {
                getTracks: () => [fakeVideoTrack],
                getVideoTracks: () => [fakeVideoTrack]
            }
        });

        await h.socketHandlers['user-joined']({
            socketId: 'my-socket-id',
            userName: 'Self',
            memberCount: 1
        });
        assert.strictEqual(h.sandbox.peers.size, 0, 'Self user-joined must be ignored');
        assert.strictEqual(h.timeouts.size, 0, 'No keyframe pulse timeout scheduled for self');

        await h.socketHandlers['user-joined']({
            socketId: 'peer-late',
            userName: 'Late Joiner',
            memberCount: 2
        });
        const peerObj = h.sandbox.peers.get('peer-late');
        assert(peerObj, 'peer-late should exist');
        peerObj.pc._senders = [{
            track: fakeVideoTrack,
            replaceTrack: async () => { replaceCalls++; }
        }];
        assert(peerObj._keyframePulseTimeout, '_keyframePulseTimeout should be stored on peerObj');
        assert.strictEqual(h.timeouts.size, 1, 'One pulse timeout scheduled');

        const capturedTimer = Array.from(h.timeouts.values())[0];
        h.sandbox.removePeerConnection('peer-late');
        assert.strictEqual(h.timeouts.size, 0, 'removePeerConnection/clearPeerTimers must clear _keyframePulseTimeout');

        // Even if timer callback were triggered manually after removal, guard must block replaceTrack
        capturedTimer.fn();
        assert.strictEqual(replaceCalls, 0, 'replaceTrack must not run after peer removal');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T4: _keyframeCheckInterval and _iceRestartTimeout abort cleanly when peer is closed/removed
    process.stdout.write('  [Teste] T4: _keyframeCheckInterval e _iceRestartTimeout abortam quando peer fecha/sai ... ');
    {
        const h = createHarness({
            localStream: {
                getTracks: () => [],
                getVideoTracks: () => []
            }
        });

        const pc = h.sandbox.getOrCreatePeerConnection('peer-x');
        const peerObj = h.sandbox.peers.get('peer-x');

        // Trigger ontrack for video -> schedules _keyframeCheckInterval
        const mockTrack = { kind: 'video', onended: null };
        pc.ontrack({ track: mockTrack, streams: [] });
        assert.strictEqual(h.intervals.size, 1, '_keyframeCheckInterval should be scheduled');
        const kfInterval = Array.from(h.intervals.values())[0];

        // Trigger oniceconnectionstatechange('disconnected') -> schedules _iceRestartTimeout
        pc.iceConnectionState = 'disconnected';
        pc.oniceconnectionstatechange();
        assert.strictEqual(h.timeouts.size, 1, '_iceRestartTimeout should be scheduled');
        const iceTimeout = Array.from(h.timeouts.values())[0];

        // Close PC / delete peer WITHOUT clearing timers manually (race simulation)
        pc.close();
        h.sandbox.peers.delete('peer-x');

        // Firing stale interval must self-clear and NOT emit request-keyframe
        kfInterval.fn();
        assert.strictEqual(h.emittedEvents.length, 0, 'No request-keyframe emitted for closed/removed peer');
        assert.strictEqual(peerObj._keyframeCheckInterval, null, '_keyframeCheckInterval must clear itself when inactive');
        assert.strictEqual(h.intervals.size, 0, 'Interval must be cleared');

        // Firing stale ICE restart timeout must NOT call restartIce or sendOffer
        iceTimeout.fn();
        assert.strictEqual(pc.restartIceCalls, 0, 'restartIce must not run on closed/removed peer');
        assert.strictEqual(h.getSendOfferCalls().length, 0, 'sendOffer must not run on closed/removed peer');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes de reconciliação passaram.');
    console.log('===============================================================\n');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
