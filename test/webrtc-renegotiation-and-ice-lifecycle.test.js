const assert = require('assert');
const vm = require('vm');
const { loadClientBundleSource } = require('./helpers/client-source');

function extractFn(source, name, isAsync = false) {
    const prefix = isAsync ? 'async\\s+function' : '(?:async\\s+)?function';
    const regex = new RegExp(`${prefix}\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Função ${name} não encontrada no bundle`);
    }
    return match[0];
}

function extractSocketHandler(source, eventName) {
    const regex = new RegExp(`socket\\.on\\('${eventName}'[\\s\\S]*?\\n\\}\\);`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Handler socket.on('${eventName}') não encontrado no bundle`);
    }
    return match[0];
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: RENEGOCIAÇÃO WEBRTC, TRANSCEIVERS & ICE');
    console.log('===============================================================\n');

    const bundleSrc = loadClientBundleSource();
    let failures = 0;

    // T1: removeStreamTile não chama stop() em tracks remotas e stream-state:'started' recria tile via getReceivers()
    process.stdout.write('  [Teste] T1: removeStreamTile preserva tracks remotas e stream-state:started restaura tile ... ');
    try {
        let remoteStopped = false;
        const remoteVideoTrack = {
            id: 'remote-v1',
            kind: 'video',
            readyState: 'live',
            muted: false,
            stop() { remoteStopped = true; }
        };

        class MockMediaStream {
            constructor(tracks = []) {
                this._tracks = [...tracks];
            }
            getTracks() { return [...this._tracks]; }
            getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
            getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
            addTrack(t) { if (!this._tracks.some((x) => x.id === t.id)) this._tracks.push(t); }
            removeTrack(t) { this._tracks = this._tracks.filter((x) => x.id !== t.id); }
        }

        const appendedTiles = [];
        const socketHandlers = {};
        const peers = new Map();
        const remoteActiveStreams = new Set();

        const sandbox = {
            Map,
            Set,
            Array,
            Promise,
            MediaStream: MockMediaStream,
            peers,
            activeRoomPeers: new Set(['a-peer']),
            recentlyRemovedPeers: new Map(),
            hasRoomMembershipSnapshot: true,
            remoteActiveStreams,
            document: { fullscreenElement: null, exitFullscreen: () => {} },
            streamGrid: { appendChild: (el) => appendedTiles.push(el) },
            socket: {
                on(ev, fn) { socketHandlers[ev] = fn; },
                emit() {}
            },
            updateGridState() {},
            updateEchoWarningVisibility() {},
            updateBackgroundTracksOptimization() {},
            createStreamTile(peerId, stream, label) {
                return {
                    id: `tile-${peerId}`,
                    peerId,
                    stream,
                    label,
                    querySelector: () => ({ srcObject: stream, play: async () => {} }),
                    remove() {}
                };
            },
            startTilePlayback() {}
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'disposeTileElement'),
            extractFn(bundleSrc, 'ensureRemoteStreamTile'),
            extractFn(bundleSrc, 'removeStreamTile'),
            extractSocketHandler(bundleSrc, 'stream-state')
        ].join('\n\n'), sandbox);

        const initialStream = new MockMediaStream([remoteVideoTrack]);
        peers.set('peer-a', {
            userName: 'Alice',
            stream: initialStream,
            tileEl: { remove() {}, querySelector: () => null },
            pc: {
                signalingState: 'stable',
                connectionState: 'connected',
                getReceivers: () => [{ track: remoteVideoTrack }]
            }
        });

        socketHandlers['stream-state']({ senderId: 'peer-a', state: 'stopped' });
        assert.strictEqual(remoteStopped, false, 'removeStreamTile nunca deve chamar .stop() em track remota');
        assert.strictEqual(peers.get('peer-a').tileEl, null, 'Tile deve ser removido ao parar stream');

        socketHandlers['stream-state']({ senderId: 'peer-a', state: 'started' });
        assert.notStrictEqual(peers.get('peer-a').tileEl, null, 'stream-state:started deve recriar o tile via getReceivers() mesmo sem novo ontrack');
        assert.strictEqual(peers.get('peer-a').stream.getVideoTracks().length, 1);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: addLocalTracksToPC atualiza transceiver.direction de recvonly para sendrecv / sendonly
    process.stdout.write('  [Teste] T2: addLocalTracksToPC promove transceiver recvonly para sendrecv/sendonly ... ');
    try {
        const localVideo = { id: 'local-v1', kind: 'video', stop() {} };
        const sandbox = {
            Promise,
            localStream: {
                getTracks: () => [localVideo],
                getVideoTracks: () => [localVideo],
                getAudioTracks: () => []
            },
            configureSenderParams() {}
        };
        vm.createContext(sandbox);
        vm.runInContext(extractFn(bundleSrc, 'addLocalTracksToPC'), sandbox);

        const recvonlyTransceiver = {
            direction: 'recvonly',
            currentDirection: 'recvonly',
            receiver: { track: { id: 'remote-v1', kind: 'video' } },
            sender: {
                track: null,
                _replacedWith: null,
                replaceTrack(t) { this._replacedWith = t; this.track = t; return Promise.resolve(); }
            }
        };
        const mockPc = {
            getSenders: () => [recvonlyTransceiver.sender],
            getTransceivers: () => [recvonlyTransceiver],
            addTrack() { throw new Error('Deveria reutilizar transceiver existente'); }
        };

        sandbox.addLocalTracksToPC(mockPc);
        assert.strictEqual(recvonlyTransceiver.sender._replacedWith, localVideo);
        assert.strictEqual(recvonlyTransceiver.direction, 'sendrecv', 'Transceiver recvonly deve passar para sendrecv ao adicionar mídia local');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3: sendOffer enfileira pendingOffer quando makingOffer ou signalingState !== 'stable' e reenvia após estabilizar
    process.stdout.write('  [Teste] T3: sendOffer agenda pendingOffer em estado ocupado e reenvia ao estabilizar ... ');
    try {
        let createOfferGate = null;
        const gatePromise = new Promise((r) => { createOfferGate = r; });
        const sentOffers = [];
        let offerCount = 0;

        const peerObj = {
            makingOffer: false,
            pendingOffer: false,
            pc: {
                signalingState: 'stable',
                connectionState: 'connected',
                async createOffer() {
                    offerCount++;
                    if (offerCount === 1) await gatePromise;
                    return { type: 'offer', sdp: `v=0\r\noffer-${offerCount}` };
                },
                async setLocalDescription(d) {
                    this.localDescription = d;
                }
            }
        };

        const sandbox = {
            Promise,
            Boolean,
            Map,
            RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
            peers: new Map([['p1', peerObj]]),
            optimizeSDP: (sdp) => sdp,
            socket: {
                emit(ev, payload) {
                    if (ev === 'signal') sentOffers.push(payload.signal.sdp);
                }
            },
            console: { log: () => {}, warn: () => {}, error: () => {} }
        };
        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'isPeerConnectionActive'),
            extractFn(bundleSrc, 'sendOffer', true)
        ].join('\n\n'), sandbox);

        const firstRun = sandbox.sendOffer('p1');
        await delay(5);
        // Chamada concorrente enquanto firstRun ainda cria o offer
        await sandbox.sendOffer('p1');
        assert.strictEqual(peerObj.pendingOffer, true, 'sendOffer ocupado deve marcar pendingOffer = true');

        createOfferGate();
        await firstRun;
        await delay(10);

        assert.strictEqual(sentOffers.length, 2, 'Oferta pendente deve ser despachada após conclusão da primeira');
        assert.strictEqual(peerObj.pendingOffer, false);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4: signal ignora candidatos quando ignoreOffer=true e rejeita sinais de peer removido (user-left)
    process.stdout.write('  [Teste] T4: signal ignora candidatos com ignoreOffer e bloqueia zombie após user-left ... ');
    try {
        const socketHandlers = {};
        const peers = new Map();
        const remoteActiveStreams = new Set();
        const addedCandidates = [];

        class MockPC {
            constructor() {
                this.signalingState = 'have-local-offer';
                this.connectionState = 'connected';
                this.remoteDescription = null;
                this.localDescription = null;
            }
            async setRemoteDescription(d) { this.remoteDescription = d; }
            async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
            async setLocalDescription(d) {
                if (d.type === 'rollback') this.signalingState = 'stable';
                else this.localDescription = d;
            }
            async addIceCandidate(c) { addedCandidates.push(c.candidate); }
            close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
        }

        const sandbox = {
            Promise,
            Map,
            Set,
            Boolean,
            Date,
            RTCPeerConnection: MockPC,
            RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
            RTCIceCandidate: class { constructor(d) { Object.assign(this, d); } },
            MediaStream: class { getTracks() { return []; } },
            rtcConfig: {},
            myId: 'z-impolite', // 'z-impolite' > 'a-peer' => isPolite = false
            peers,
            activeRoomPeers: new Set(['a-peer']),
            recentlyRemovedPeers: new Map(),
            hasRoomMembershipSnapshot: true,
            remoteActiveStreams,
            localStream: null,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            socket: {
                on(ev, fn) { socketHandlers[ev] = fn; },
                emit() {}
            },
            optimizeSDP: (s) => s,
            updateEchoWarningVisibility() {},
            showToast() {},
            playPresenceChime() {},
            updateMemberCount() {},
            updateGridState() {},
            updateBackgroundTracksOptimization() {},
            setPeerConnectionStatus() {},
            logPeerConnectionTelemetry() {},
            disposeTileElement() {},
            clearPeerTimers(p) { if (p && p._iceRestartTimeout) clearTimeout(p._iceRestartTimeout); },
            setTimeout,
            clearTimeout
        };
        sandbox.removePeerConnection = (peerId) => {
            const p = peers.get(peerId);
            if (p) {
                p.pc.close();
                peers.delete(peerId);
            }
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'isPeerConnectionActive'),
            extractFn(bundleSrc, 'getOrCreatePeerConnection'),
            extractSocketHandler(bundleSrc, 'signal'),
            extractSocketHandler(bundleSrc, 'user-left')
        ].join('\n\n'), sandbox);

        const pcA = sandbox.getOrCreatePeerConnection('a-peer');
        pcA.signalingState = 'have-local-offer';
        const peerObjA = peers.get('a-peer');
        assert.strictEqual(peerObjA.isPolite, false);

        // Oferta em colisão sendo impolite => ignoreOffer = true
        socketHandlers.signal({ senderId: 'a-peer', signal: { type: 'offer', sdp: 'v=0\r\nignored' } });
        await peerObjA._signalChain;
        assert.strictEqual(peerObjA.ignoreOffer, true);

        // Candidato subsequente da oferta ignorada não deve ser enfileirado nem aplicado
        socketHandlers.signal({ senderId: 'a-peer', signal: { candidate: { candidate: 'cand-from-ignored-offer' } } });
        await peerObjA._signalChain;
        assert.strictEqual(peerObjA.iceCandidateQueue.length, 0, 'Candidato sob ignoreOffer=true não deve ir para iceCandidateQueue');
        assert.strictEqual(addedCandidates.length, 0);

        // Após user-left, sinal atrasado do peer removido não deve recriar PeerConnection zumbi
        socketHandlers['user-left']({ socketId: 'a-peer', memberCount: 1 });
        assert.strictEqual(peers.has('a-peer'), false);
        socketHandlers.signal({ senderId: 'a-peer', signal: { candidate: { candidate: 'zombie-cand' } } });
        await delay(10);
        assert.strictEqual(peers.has('a-peer'), false, 'Sinal atrasado pós user-left não deve criar PeerConnection zumbi');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T5: refreshIceServers recebe { peers } e espectador (localStream === null) dispara ICE restart em falha
    process.stdout.write('  [Teste] T5: app.js passa { peers } ao refreshIceServers e espectador recupera via ICE restart ... ');
    try {
        assert(
            /refreshIceServers\s*\(\s*SERVER_URL\s*,\s*\{\s*peers\s*\}/.test(bundleSrc),
            'app.js deve passar { peers } para refreshIceServers(SERVER_URL, { peers })'
        );

        let restartCalled = 0;
        let sendOfferCalled = 0;
        const peers = new Map();

        class MockPC {
            constructor() {
                this.signalingState = 'stable';
                this.iceConnectionState = 'new';
                this.connectionState = 'new';
            }
            restartIce() { restartCalled++; }
        }

        const sandbox = {
            Map,
            Promise,
            Boolean,
            RTCPeerConnection: MockPC,
            MediaStream: class {},
            rtcConfig: {},
            myId: 'viewer-1',
            peers,
            localStream: null, // espectador sem stream local!
            setTimeout: (fn) => { fn(); return 1; },
            clearTimeout: () => {},
            console: { log: () => {}, warn: () => {}, error: () => {} },
            socket: { emit() {} },
            sendOffer() { sendOfferCalled++; },
            setPeerConnectionStatus() {},
            logPeerConnectionTelemetry() {},
            updateGridState() {}
        };
        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'isPeerConnectionActive'),
            extractFn(bundleSrc, 'getOrCreatePeerConnection')
        ].join('\n\n'), sandbox);

        const pc = sandbox.getOrCreatePeerConnection('broadcaster-1');
        pc.iceConnectionState = 'failed';
        pc.oniceconnectionstatechange();

        assert.strictEqual(restartCalled, 1, 'Espectador também deve iniciar restartIce() em falha ICE');
        assert.strictEqual(sendOfferCalled, 1, 'Espectador deve chamar sendOffer no ICE restart');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T6: cleanupRoomState silencioso em troca de sala + teardown no pagehide
    process.stdout.write('  [Teste] T6: Troca de sala faz cleanup silencioso e pagehide encerra peers/tracks ... ');
    try {
        const emitted = [];
        const sentOffers = [];
        let localStopped = false;
        let peerClosed = false;

        const sandbox = {
            Map,
            Set,
            Promise,
            MediaStream: class {},
            peers: new Map([['old-peer', { pc: { close() { peerClosed = true; } }, stream: null, tileEl: null }]]),
            remoteActiveStreams: new Set(['old-peer']),
            localStream: { getTracks: () => [{ stop() { localStopped = true; } }] },
            roomId: 'sala-antiga',
            pendingRoomJoin: { roomId: 'sala-nova', password: '', userName: 'Pedro' },
            currentRoomPassword: '',
            myId: 'me',
            displayRoomId: { textContent: '', appendChild() {} },
            memberCountText: { textContent: '' },
            streamGrid: { querySelectorAll: () => [], appendChild() {} },
            document: { getElementById: () => null },
            btnStartShare: { hidden: true },
            btnStopShare: { hidden: false },
            btnQualityToggle: { hidden: false },
            window: { location: { protocol: 'http:', pathname: '/' }, history: { pushState() {} } },
            localStorage: { setItem() {} },
            socket: {
                on(ev, fn) { sandbox._handlers[ev] = fn; },
                emit(ev, p) { emitted.push({ ev, p }); }
            },
            _handlers: {},
            console: { log: () => {}, warn: () => {}, error: () => {} },
            clearPeerTimers() {},
            disposeTileElement() {},
            updateEchoWarningVisibility() {},
            updateMemberCount() {},
            updateGridState() {},
            updateBackgroundTracksOptimization() {},
            stopQualityMonitor() {},
            stopAppAudioCapture() {},
            closeRoomModal() {},
            updateRoomModalCloseButton() {},
            sendOffer(id) { sentOffers.push(id); }
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'stopScreenShare'),
            extractFn(bundleSrc, 'cleanupRoomState'),
            extractSocketHandler(bundleSrc, 'room-users')
        ].join('\n\n'), sandbox);

        await sandbox._handlers['room-users']({
            users: [],
            userNames: {},
            activeStreams: [],
            socketId: 'me',
            memberCount: 1,
            hasPassword: false
        });

        assert.strictEqual(localStopped, true, 'localStream anterior deve parar na troca de sala');
        assert.strictEqual(peerClosed, true, 'Peer anterior deve fechar na troca de sala');
        assert.strictEqual(sentOffers.length, 0, 'Troca de sala não deve enviar sendOffer aos peers encerrados');
        const leakedStreamStopped = emitted.filter((e) => e.ev === 'stream-state');
        assert.strictEqual(leakedStreamStopped.length, 0, 'Troca de sala não deve emitir stream-state para a nova sala');

        assert(
            bundleSrc.includes("addEventListener('pagehide'"),
            'app.js deve registrar teardown no evento pagehide'
        );
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T7: stopScreenShare aguarda sender.replaceTrack(null) resolver antes de sendOffer(peerId)
    process.stdout.write('  [Teste] T7: stopScreenShare aguarda replaceTrack(null) resolver antes de sendOffer ... ');
    try {
        const sentOffers = [];
        let resolve1, resolve2;
        const p1 = new Promise((r) => { resolve1 = r; });
        const p2 = new Promise((r) => { resolve2 = r; });

        const s1 = { track: { id: 'v1', kind: 'video' }, replaceTrack(t) { this.track = t; return p1; } };
        const s2 = { track: { id: 'a1', kind: 'audio' }, replaceTrack(t) { this.track = t; return p2; } };
        const sClosed = { track: { id: 'vc', kind: 'video' }, replaceTrack() { return Promise.resolve(); } };

        const pcOpen = {
            signalingState: 'stable',
            connectionState: 'connected',
            getTransceivers: () => [{ sender: s1, direction: 'sendrecv' }, { sender: s2, direction: 'sendonly' }],
            getSenders: () => [s1, s2]
        };
        const pcClosing = {
            signalingState: 'stable',
            connectionState: 'closed',
            getTransceivers: () => [{ sender: sClosed, direction: 'sendonly' }],
            getSenders: () => [sClosed]
        };

        const peers = new Map([
            ['peer-open', { pc: pcOpen }],
            ['peer-closed', { pc: pcClosing }]
        ]);

        const sandbox = {
            Map,
            Promise,
            Boolean,
            peers,
            roomId: 'room-1',
            localStream: { getTracks: () => [{ stop() {} }] },
            document: { getElementById: () => null },
            btnStartShare: { hidden: true },
            btnStopShare: { hidden: false },
            btnQualityToggle: { hidden: false },
            socket: { emit() {} },
            stopQualityMonitor() {},
            stopAppAudioCapture() {},
            updateGridState() {},
            sendOffer(id) { sentOffers.push(id); }
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(bundleSrc, 'stopScreenShare'), sandbox);

        const stopPromise = sandbox.stopScreenShare();
        assert.strictEqual(sentOffers.length, 0, 'sendOffer não pode disparar antes de replaceTrack(null) resolver');

        resolve1();
        await delay(10);
        assert.strictEqual(sentOffers.length, 0, 'sendOffer deve aguardar TODOS os senders de replaceTrack(null)');

        resolve2();
        await Promise.resolve(stopPromise);
        await delay(10);

        assert.deepStrictEqual(sentOffers, ['peer-open'], 'sendOffer deve disparar apenas após replaceTrack(null) e ignorar peer fechado');
        assert.strictEqual(s1.track, null);
        assert.strictEqual(s2.track, null);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T8: socket connect aguarda refreshIceServers concluir antes de scheduleIceRefreshTimer
    process.stdout.write('  [Teste] T8: Timer inicial ICE usa TTL real após refreshIceServers resolver ... ');
    try {
        const fs = require('fs');
        const path = require('path');
        const iceConfigSrc = fs.readFileSync(path.resolve(__dirname, '../public/js/modules/ice-config.js'), 'utf8')
            .replace(/^export\s+/gm, '')
            .replace(/^import\s+[\s\S]*?;\s*$/gm, '');

        let resolveFetch = null;
        const fetchGate = new Promise((r) => { resolveFetch = r; });
        const scheduledDelays = [];
        const socketHandlers = {};

        const sandbox = {
            Map,
            Set,
            Array,
            Number,
            Math,
            Date,
            Promise,
            AbortController: undefined,
            SERVER_URL: 'https://screenshare-p2p.onrender.com',
            peers: new Map(),
            myId: '',
            pendingRoomJoin: null,
            roomId: '',
            clientId: 'c1',
            currentRoomPassword: '',
            currentUserName: '',
            wasSocketDisconnected: false,
            hasShownConnectErrorToast: false,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            setTimeout: (_fn, ms) => {
                scheduledDelays.push(ms);
                return scheduledDelays.length;
            },
            clearTimeout: () => {},
            fetch: async () => {
                await fetchGate;
                return {
                    ok: true,
                    status: 200,
                    async json() {
                        return {
                            provider: 'cloudflare',
                            ttlSeconds: 14400,
                            iceServers: [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'p' }]
                        };
                    }
                };
            },
            socket: {
                id: 'sock-1',
                on(ev, fn) { socketHandlers[ev] = fn; }
            },
            cancelColdStartNotice() {},
            setSignalingStatus() {},
            showToast() {},
            document: { getElementById: () => null },
            updateStatsDisplay() {}
        };

        vm.createContext(sandbox);
        vm.runInContext(iceConfigSrc + '\n\n' + extractSocketHandler(bundleSrc, 'connect'), sandbox);

        socketHandlers.connect();
        assert.strictEqual(scheduledDelays.length, 0, 'Não deve agendar timer de 4 min antes de refreshIceServers resolver');

        resolveFetch();
        await delay(15);

        assert.strictEqual(scheduledDelays.length, 1, 'Deve agendar timer único após refreshIceServers concluir');
        assert(scheduledDelays[0] > 10_000_000, `Esperado delay próximo de ~3h55m para ttl=14400s, recebido ${scheduledDelays[0]}ms`);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T9: wasapi-capture-stopped remove trilha WASAPI morta, mantém vídeo e renegocia peers
    process.stdout.write('  [Teste] T9: handleDesktopCaptureStopped remove áudio morto e renegocia peers mantendo vídeo ... ');
    try {
        const fs = require('fs');
        const path = require('path');
        const desktopAudioSrc = fs.readFileSync(path.resolve(__dirname, '../public/js/modules/desktop-audio.js'), 'utf8');
        assert(
            desktopAudioSrc.includes('_isDesktopWasapiTrack'),
            'desktop-audio.js deve marcar track WASAPI com _isDesktopWasapiTrack'
        );

        const videoTrack = { id: 'v1', kind: 'video', stopped: false, stop() { this.stopped = true; } };
        const audioTrack = { id: 'a1', kind: 'audio', _isDesktopWasapiTrack: true, stopped: false, stop() { this.stopped = true; } };

        class MockLocalStream {
            constructor(tracks) { this._tracks = [...tracks]; }
            getTracks() { return [...this._tracks]; }
            getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
            getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
            removeTrack(t) { this._tracks = this._tracks.filter((x) => x !== t); }
        }

        let resolveAudioReplace;
        const audioReplacePromise = new Promise((r) => { resolveAudioReplace = r; });
        const videoSender = { track: videoTrack, replaceTrack() { throw new Error('Não deve limpar vídeo'); } };
        const audioSender = { track: audioTrack, replaceTrack(t) { this.track = t; return audioReplacePromise; } };
        const audioTransceiver = { direction: 'sendrecv', sender: audioSender };
        const videoTransceiver = { direction: 'sendrecv', sender: videoSender };

        const sentOffers = [];
        const toasts = [];
        const localStream = new MockLocalStream([videoTrack, audioTrack]);
        const peers = new Map([
            ['peer-1', {
                pc: {
                    signalingState: 'stable',
                    connectionState: 'connected',
                    getTransceivers: () => [videoTransceiver, audioTransceiver],
                    getSenders: () => [videoSender, audioSender]
                }
            }]
        ]);

        const sandbox = {
            Map,
            Set,
            Promise,
            Boolean,
            peers,
            localStream,
            showToast: (msg, type) => toasts.push({ msg, type }),
            sendOffer: (id) => sentOffers.push(id)
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(bundleSrc, 'handleDesktopCaptureStopped', true), sandbox);

        const done = sandbox.handleDesktopCaptureStopped({ pid: 4321, reason: 'process_exited' });
        assert.strictEqual(toasts.length, 1);
        assert.strictEqual(audioTrack.stopped, true, 'Track WASAPI morta deve ser parada');
        assert.strictEqual(videoTrack.stopped, false, 'Track de vídeo deve continuar ativa');
        assert.strictEqual(localStream.getAudioTracks().length, 0, 'Track WASAPI morta deve ser removida de localStream');
        assert.strictEqual(localStream.getVideoTracks().length, 1);
        assert.strictEqual(audioTransceiver.direction, 'recvonly');
        assert.strictEqual(sentOffers.length, 0, 'sendOffer deve aguardar replaceTrack(null) do áudio');

        resolveAudioReplace();
        await done;
        assert.deepStrictEqual(sentOffers, ['peer-1']);
        assert.strictEqual(audioSender.track, null);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T10: room-users durante await de refreshIceServers não descarta sinais nem apaga user-joined/stream-state concorrentes
    process.stdout.write('  [Teste] T10: room-users aplica snapshot antes do await de ICE e preserva eventos concorrentes ... ');
    try {
        let resolveIceGate = null;
        const iceGate = new Promise((r) => { resolveIceGate = r; });

        class MockPC {
            constructor() {
                this.signalingState = 'stable';
                this.connectionState = 'connected';
                this.remoteDescription = null;
                this.localDescription = null;
            }
            async setRemoteDescription(d) { this.remoteDescription = d; }
            async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nans' }; }
            async setLocalDescription(d) { this.localDescription = d; }
            close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
        }

        const socketHandlers = {};
        const peers = new Map([
            ['old-peer', { pc: new MockPC(), stream: null, tileEl: null }]
        ]);
        const activeRoomPeers = new Set(['old-peer']);
        const recentlyRemovedPeers = new Map();
        const remoteActiveStreams = new Set(['old-peer']);

        const sandbox = {
            Map,
            Set,
            Array,
            Boolean,
            Date,
            Promise,
            encodeURIComponent,
            setTimeout,
            clearTimeout,
            SERVER_URL: 'https://screenshare-p2p.onrender.com',
            RTCPeerConnection: MockPC,
            RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
            RTCIceCandidate: class { constructor(d) { Object.assign(this, d); } },
            MediaStream: class { constructor() { this._t = []; } getTracks() { return this._t; } getVideoTracks() { return []; } },
            rtcConfig: {},
            myId: 'sock-old',
            roomId: 'sala-antiga',
            currentRoomPassword: '',
            currentUserName: 'Pedro',
            pendingRoomJoin: { roomId: 'sala-nova', password: '', userName: 'Pedro' },
            hasRoomMembershipSnapshot: true,
            lastJoinedSocketId: 'sock-old',
            roomUsersGeneration: 0,
            localStream: null,
            peers,
            activeRoomPeers,
            recentlyRemovedPeers,
            remoteActiveStreams,
            STORAGE_KEY: 'streamgrid_last_room',
            displayRoomId: { textContent: '', appendChild() {} },
            memberCountText: { textContent: '' },
            streamGrid: { querySelectorAll: () => [], appendChild() {} },
            document: { getElementById: () => null },
            btnStartShare: { hidden: false },
            btnStopShare: { hidden: true },
            btnQualityToggle: { hidden: true },
            localStorage: { setItem() {}, removeItem() {} },
            window: { location: { protocol: 'http:', pathname: '/' }, history: { pushState() {} } },
            socket: {
                id: 'sock-old',
                on(ev, fn) { socketHandlers[ev] = fn; },
                emit() {}
            },
            console: { log: () => {}, warn: () => {}, error: () => {} },
            refreshIceServers: async () => { await iceGate; },
            scheduleIceRefreshTimer: () => {},
            saveSessionRoomPassword: () => {},
            clearSessionRoomPassword: () => {},
            closeRoomModal: () => {},
            updateRoomModalCloseButton: () => {},
            clearPeerTimers: () => {},
            disposeTileElement: () => {},
            removeStreamTile: () => {},
            ensureRemoteStreamTile: () => {},
            updateEchoWarningVisibility: () => {},
            updateMemberCount: () => {},
            updateGridState: () => {},
            updateBackgroundTracksOptimization: () => {},
            stopQualityMonitor: () => {},
            stopAppAudioCapture: () => {},
            setPeerConnectionStatus: () => {},
            logPeerConnectionTelemetry: () => {},
            showToast: () => {},
            playPresenceChime: () => {},
            optimizeSDP: (s) => s,
            updateSendersForActivePeers: () => {}
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'isPeerConnectionActive'),
            extractFn(bundleSrc, 'getOrCreatePeerConnection'),
            extractFn(bundleSrc, 'updatePeerUserName'),
            extractFn(bundleSrc, 'removePeerConnection'),
            extractFn(bundleSrc, 'stopScreenShare'),
            extractFn(bundleSrc, 'cleanupRoomState'),
            extractSocketHandler(bundleSrc, 'room-users'),
            extractSocketHandler(bundleSrc, 'user-joined'),
            extractSocketHandler(bundleSrc, 'user-left'),
            extractSocketHandler(bundleSrc, 'signal'),
            extractSocketHandler(bundleSrc, 'stream-state')
        ].join('\n\n'), sandbox);

        // Inicia room-users (trava no await refreshIceServers)
        const roomUsersPromise = socketHandlers['room-users']({
            users: ['peer-b', 'sock-old'],
            userNames: { 'peer-b': 'Bob' },
            activeStreams: ['peer-b'],
            socketId: 'sock-old',
            memberCount: 2,
            hasPassword: false
        });

        // Enquanto room-users aguarda refreshIceServers:
        // 1) Chega oferta de peer-b (não pode ser descartada como estranho da sala antiga)
        socketHandlers.signal({ senderId: 'peer-b', signal: { type: 'offer', sdp: 'v=0\r\noffer-from-b' } });
        // 2) peer-c entra e começa a transmitir durante o await
        socketHandlers['user-joined']({ socketId: 'peer-c', userName: 'Carol', memberCount: 3 });
        socketHandlers['stream-state']({ senderId: 'peer-c', state: 'started' });
        // 3) peer-b sai durante o await
        socketHandlers['user-left']({ socketId: 'peer-b', memberCount: 2 });

        resolveIceGate();
        await roomUsersPromise;

        assert.strictEqual(peers.has('old-peer'), false, 'old-peer deve ter sido limpo');
        assert.strictEqual(peers.has('peer-b'), false, 'peer-b que saiu durante o await NÃO pode ser ressuscitado');
        assert.strictEqual(peers.has('peer-c'), true, 'peer-c que entrou durante o await NÃO pode ser destruído');
        assert.strictEqual(activeRoomPeers.has('peer-c'), true, 'peer-c deve permanecer em activeRoomPeers');
        assert.strictEqual(remoteActiveStreams.has('peer-c'), true, 'stream-state:started de peer-c deve ser preservado');
        assert.strictEqual(remoteActiveStreams.has('peer-b'), false, 'stream de peer-b removido deve sair de remoteActiveStreams');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T11: Reconexão Socket.IO com novo socketId recria PCs obsoletas, recalcula isPolite e re-emite stream-state:started
    process.stdout.write('  [Teste] T11: Reconexão com novo socketId fecha PC antiga, recalcula isPolite e re-emite stream-state ... ');
    try {
        class MockPC {
            constructor() {
                this.signalingState = 'stable';
                this.connectionState = 'connected';
                this.closed = false;
                this._senders = [];
            }
            getSenders() { return this._senders; }
            close() { this.closed = true; this.signalingState = 'closed'; this.connectionState = 'closed'; }
        }

        const emitted = [];
        const sentOffers = [];
        const socketHandlers = {};
        const oldPc = new MockPC();
        const peers = new Map([
            ['m-peer', { pc: oldPc, stream: null, tileEl: null, isPolite: false }]
        ]);

        const sandbox = {
            Map,
            Set,
            Array,
            Boolean,
            Date,
            Promise,
            encodeURIComponent,
            RTCPeerConnection: MockPC,
            MediaStream: class { getTracks() { return []; } getVideoTracks() { return []; } },
            rtcConfig: {},
            myId: 'a-new-id', // após connect com novo socket.id ('a-new-id' < 'm-peer' => true)
            lastJoinedSocketId: 'z-old-id', // anteriormente era 'z-old-id' ('z-old-id' < 'm-peer' => false)
            roomUsersGeneration: 0,
            roomId: 'sala-1',
            pendingRoomJoin: null,
            currentRoomPassword: '',
            currentUserName: 'Pedro',
            hasRoomMembershipSnapshot: true,
            activeRoomPeers: new Set(['m-peer']),
            recentlyRemovedPeers: new Map(),
            remoteActiveStreams: new Set(),
            localStream: { getTracks: () => [{ id: 'v1', kind: 'video' }], getVideoTracks: () => [{ id: 'v1', kind: 'video' }] },
            peers,
            displayRoomId: { textContent: '', appendChild() {} },
            memberCountText: { textContent: '' },
            streamGrid: { querySelectorAll: () => [], appendChild() {} },
            socket: {
                id: 'a-new-id',
                on(ev, fn) { socketHandlers[ev] = fn; },
                emit(ev, payload) { emitted.push({ ev, payload }); }
            },
            console: { log: () => {}, warn: () => {}, error: () => {} },
            clearPeerTimers() {},
            disposeTileElement() {},
            updateEchoWarningVisibility() {},
            updateMemberCount() {},
            updateGridState() {},
            updateBackgroundTracksOptimization() {},
            updatePeerUserName() {},
            addLocalTracksToPC() {},
            sendOffer(id) { sentOffers.push(id); },
            updateSendersForActivePeers() {}
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(bundleSrc, 'getOrCreatePeerConnection'),
            extractFn(bundleSrc, 'removePeerConnection'),
            extractSocketHandler(bundleSrc, 'room-users')
        ].join('\n\n'), sandbox);

        await socketHandlers['room-users']({
            users: ['m-peer', 'a-new-id'],
            userNames: { 'm-peer': 'Maria' },
            activeStreams: [],
            socketId: 'a-new-id',
            memberCount: 2,
            hasPassword: false
        });

        assert.strictEqual(oldPc.closed, true, 'PC antiga de socket desconectado deve ser fechada');
        const currentPeer = peers.get('m-peer');
        assert(currentPeer && currentPeer.pc !== oldPc, 'Deve criar nova RTCPeerConnection para m-peer');
        assert.strictEqual(currentPeer.isPolite, true, 'isPolite deve ser recalculado com o novo socketId');
        assert(sentOffers.includes('m-peer'), 'Deve enviar nova oferta pela PC recriada');
        assert(
            emitted.some((e) => e.ev === 'stream-state' && e.payload && e.payload.roomId === 'sala-1' && e.payload.state === 'started'),
            'Deve re-emitir stream-state:started ao reconectar transmitindo'
        );
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T12: updateBackgroundTracksOptimization mantém vídeo ativo para stream em Picture-in-Picture
    process.stdout.write('  [Teste] T12: updateBackgroundTracksOptimization preserva track em Picture-in-Picture ... ');
    try {
        const pipTrack = { enabled: true };
        const bgTrack = { enabled: true };
        const pipVideoEl = { id: 'vid-pip' };
        const bgVideoEl = { id: 'vid-bg' };
        const pipTileEl = {
            dataset: { peerId: 'peer-pip' },
            contains: (el) => el === pipVideoEl,
            querySelector: (sel) => (sel === 'video' ? pipVideoEl : null)
        };
        const bgTileEl = {
            dataset: { peerId: 'peer-bg' },
            contains: (el) => el === bgVideoEl,
            querySelector: (sel) => (sel === 'video' ? bgVideoEl : null)
        };

        const sandbox = {
            document: {
                hidden: true,
                fullscreenElement: null,
                pictureInPictureElement: pipVideoEl,
                querySelector: () => null
            },
            peers: new Map([
                ['peer-pip', { tileEl: pipTileEl, stream: { getVideoTracks: () => [pipTrack] } }],
                ['peer-bg', { tileEl: bgTileEl, stream: { getVideoTracks: () => [bgTrack] } }]
            ])
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(bundleSrc, 'updateBackgroundTracksOptimization'), sandbox);

        sandbox.updateBackgroundTracksOptimization();
        assert.strictEqual(pipTrack.enabled, true, 'Track do vídeo em Picture-in-Picture deve permanecer ativa');
        assert.strictEqual(bgTrack.enabled, false, 'Demais tracks em segundo plano devem pausar quando oculto');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T13: user-joined durante await de ICE não duplica sendOffer e offer inicial sincroniza setConfiguration antes de setRemoteDescription
    process.stdout.write('  [Teste] T13: room-users evita oferta duplicada para user-joined concorrente e sincroniza TURN no signal ... ');
    try {
        let resolveIce;
        const iceGate = new Promise((r) => { resolveIce = r; });
        const socketHandlers = {};
        const peers = new Map();
        const sentOffers = [];
        const opLog = [];
        const activeRoomPeers = new Set();

        class MockPcT13 {
            constructor() {
                this.signalingState = 'stable';
                this.connectionState = 'new';
                this.localDescription = null;
                this.remoteDescription = null;
            }
            setConfiguration(cfg) {
                opLog.push({ op: 'setConfiguration', urls: cfg && cfg.iceServers ? cfg.iceServers[0].urls : null });
            }
            async setRemoteDescription(desc) {
                opLog.push({ op: 'setRemoteDescription', type: desc && desc.type });
                this.remoteDescription = desc;
            }
            async createAnswer() {
                return { type: 'answer', sdp: 'v=0\r\n' };
            }
            async setLocalDescription(desc) {
                this.localDescription = desc;
            }
            getSenders() { return []; }
            addTrack() { return {}; }
            close() { this.connectionState = 'closed'; }
        }

        const rtcConfigObj = { iceServers: [{ urls: 'stun:fallback' }] };
        const sandbox = {
            Promise,
            Set,
            Map,
            Math,
            setTimeout,
            clearTimeout,
            RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
            SERVER_URL: 'https://srv.test',
            roomId: 'sala-t13',
            myId: null,
            lastJoinedSocketId: '',
            roomUsersGeneration: 0,
            isRoomMembershipConfirmed: false,
            hasRoomMembershipSnapshot: false,
            activeRoomPeers,
            recentlyRemovedPeers: new Set(),
            pendingRoomJoin: null,
            localStream: { getTracks: () => [{ id: 'v1', kind: 'video' }], getVideoTracks: () => [{ id: 'v1', kind: 'video' }] },
            remoteActiveStreams: new Set(),
            peers,
            rtcConfig: rtcConfigObj,
            displayRoomId: { textContent: '', appendChild() {} },
            document: { createElement: () => ({ style: {} }) },
            socket: {
                id: 'me-13',
                on(ev, fn) { socketHandlers[ev] = fn; },
                emit() {}
            },
            refreshIceServers: async () => {
                await iceGate;
                rtcConfigObj.iceServers = [{ urls: 'turns:cf.turn:443' }];
            },
            scheduleIceRefreshTimer() {},
            cleanupRoomState() {},
            closeRoomModal() {},
            updateRoomModalCloseButton() {},
            updateEchoWarningVisibility() {},
            updateMemberCount() {},
            updatePeerUserName() {},
            updateSendersForActivePeers() {},
            removePeerConnection(id) { peers.delete(id); activeRoomPeers.delete(id); },
            showToast() {},
            playPresenceChime() {},
            addLocalTracksToPC() {},
            sendOffer(id) { sentOffers.push(id); },
            isPeerConnectionActive: (id, obj, pc) => Boolean(obj && obj.pc === pc && pc.connectionState !== 'closed'),
            getOrCreatePeerConnection(id) {
                if (peers.has(id)) return peers.get(id).pc;
                const pc = new MockPcT13();
                peers.set(id, { pc, isPolite: id > 'me-13', iceCandidateQueue: [], isRemoteDescriptionSet: false });
                return pc;
            }
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractSocketHandler(bundleSrc, 'room-users'),
            extractSocketHandler(bundleSrc, 'user-joined'),
            extractSocketHandler(bundleSrc, 'signal')
        ].join('\n\n'), sandbox);

        // Inicia room-users com peer existente 'peer-a' (awaiting ICE)
        const roomUsersPromise = socketHandlers['room-users']({
            users: ['peer-a'],
            userNames: { 'peer-a': 'Alice' },
            activeStreams: ['peer-a'],
            socketId: 'me-13',
            memberCount: 2,
            hasPassword: false
        });

        // Enquanto room-users aguarda ICE:
        // 1) peer-a envia offer inicial via signal
        socketHandlers['signal']({ senderId: 'peer-a', signal: { type: 'offer', sdp: 'v=0\r\n' } });
        // 2) Novo peer-d entra na sala via user-joined
        await socketHandlers['user-joined']({ socketId: 'peer-d', userName: 'Daniel', memberCount: 3 });

        assert.strictEqual(sentOffers.filter((id) => id === 'peer-d').length, 1, 'user-joined deve enviar 1 oferta para peer-d');

        resolveIce();
        await roomUsersPromise;
        await delay(20);

        assert.strictEqual(
            sentOffers.filter((id) => id === 'peer-d').length,
            1,
            `peer-d não deve receber segunda oferta duplicada após room-users retomar (total=${sentOffers.filter((id) => id === 'peer-d').length})`
        );

        const idxSetCfg = opLog.findIndex((o) => o.op === 'setConfiguration' && o.urls === 'turns:cf.turn:443');
        const idxSetRemote = opLog.findIndex((o) => o.op === 'setRemoteDescription');
        assert(idxSetCfg !== -1 && idxSetRemote !== -1, 'setConfiguration e setRemoteDescription devem executar para offer inicial');
        assert(idxSetCfg < idxSetRemote, 'setConfiguration com TURN novo deve rodar antes de setRemoteDescription ao responder offer inicial');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Todos os 12 testes de renegociação/ICE passaram!');
        console.log('===============================================================\n');
    } else {
        console.log(`  ❌ ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
});
