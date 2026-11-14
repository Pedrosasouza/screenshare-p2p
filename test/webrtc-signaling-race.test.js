const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Função ${name} não encontrada em public/app.js`);
    }
    return match[0];
}

function extractSignalHandler(source) {
    const match = source.match(/socket\.on\('signal'[\s\S]*?\n\}\);/);
    if (!match) {
        throw new Error("Handler socket.on('signal') não encontrado em public/app.js");
    }
    return match[0];
}

function createSignalingRaceHarness(appJs, pcFactory) {
    const emittedSignals = [];
    const socketHandlers = {};
    const peers = new Map();
    let createdPcCount = 0;

    class MockRTCSessionDescription {
        constructor(init) {
            this.type = init.type;
            this.sdp = init.sdp;
        }
    }

    class MockRTCIceCandidate {
        constructor(init) {
            Object.assign(this, init);
        }
    }

    class MockMediaStream {
        getTracks() { return []; }
        getVideoTracks() { return []; }
        getAudioTracks() { return []; }
    }

    class DefaultMockRTCPeerConnection {
        constructor() {
            createdPcCount += 1;
            this.signalingState = 'stable';
            this.connectionState = 'connected';
            this.remoteDescription = null;
            this.localDescription = null;
            this.onicecandidate = null;
            this.ontrack = null;
            this.oniceconnectionstatechange = null;
            this.onconnectionstatechange = null;
            this.log = [];
            if (pcFactory) pcFactory(this, createdPcCount);
        }
        async createOffer() {
            this.log.push('createOffer');
            return { type: 'offer', sdp: 'v=0\r\noffer' };
        }
        async createAnswer() {
            this.log.push('createAnswer');
            return { type: 'answer', sdp: 'v=0\r\nanswer' };
        }
        async setLocalDescription(desc) {
            this.log.push(`setLocalDescription:${desc.type}`);
            if (desc.type === 'rollback') {
                this.signalingState = 'stable';
                return;
            }
            this.localDescription = desc;
            this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
        }
        async setRemoteDescription(desc) {
            this.log.push(`setRemoteDescription:${desc.type}`);
            this.remoteDescription = desc;
            this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
        }
        async addIceCandidate(cand) {
            this.log.push(`addIceCandidate:${cand.candidate}`);
        }
        getSenders() { return []; }
        close() {
            this.signalingState = 'closed';
            this.connectionState = 'closed';
        }
    }

    const sandbox = {
        Promise,
        Map,
        Set,
        Boolean,
        Error,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        myId: 'self-socket',
        rtcConfig: {},
        peers,
        localStream: null,
        RTCPeerConnection: DefaultMockRTCPeerConnection,
        RTCSessionDescription: MockRTCSessionDescription,
        RTCIceCandidate: MockRTCIceCandidate,
        MediaStream: MockMediaStream,
        optimizeSDP: (sdp) => sdp,
        addLocalTracksToPC: () => {},
        socket: {
            on(event, fn) {
                socketHandlers[event] = fn;
            },
            emit(event, payload) {
                if (event === 'signal') {
                    emittedSignals.push(payload);
                }
            }
        }
    };

    vm.createContext(sandbox);
    vm.runInContext(extractFn(appJs, 'isPeerConnectionActive'), sandbox);
    vm.runInContext(extractFn(appJs, 'sendOffer'), sandbox);
    vm.runInContext(extractFn(appJs, 'getOrCreatePeerConnection'), sandbox);
    vm.runInContext(extractSignalHandler(appJs), sandbox);

    return {
        sandbox,
        peers,
        emittedSignals,
        getSignalHandler: () => socketHandlers['signal'],
        getCreatedPcCount: () => createdPcCount
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: RACE CONDITIONS & VALIDAÇÃO WEBRTC SIGNAL');
    console.log('===============================================================\n');

    let failures = 0;
    const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

    // T1: offer lento + candidate concorrente executam serializados em _signalChain sem perder candidate
    process.stdout.write('  [Teste] T1: offer lento + candidate concorrente são serializados via _signalChain ... ');
    try {
        let releaseRemoteDesc;
        const remoteDescGate = new Promise((resolve) => { releaseRemoteDesc = resolve; });

        const h = createSignalingRaceHarness(appJs, (pc) => {
            pc.setRemoteDescription = async (desc) => {
                pc.log.push('setRemoteDescription:start');
                await remoteDescGate;
                pc.remoteDescription = desc;
                pc.signalingState = 'have-remote-offer';
                pc.log.push('setRemoteDescription:end');
            };
        });

        const onSignal = h.getSignalHandler();

        // Dispara offer e logo em seguida candidate concorrente para o mesmo senderId
        onSignal({ senderId: 'peer-1', signal: { type: 'offer', sdp: 'v=0\r\noffer-1' } });
        onSignal({ senderId: 'peer-1', signal: { candidate: { candidate: 'candidate:1 1 udp 123 127.0.0.1 9000 typ host' } } });

        await delay(15);
        const peerObj = h.peers.get('peer-1');
        assert(peerObj, 'peerObj deve existir');
        // Enquanto setRemoteDescription não resolveu, addIceCandidate ainda NÃO pode ter sido executado
        assert.strictEqual(
            peerObj.pc.log.some((entry) => entry.startsWith('addIceCandidate:')),
            false,
            'Candidate concorrente não deve chamar addIceCandidate antes de setRemoteDescription concluir'
        );

        releaseRemoteDesc();
        await peerObj._signalChain;

        const endIdx = peerObj.pc.log.indexOf('setRemoteDescription:end');
        const candIdx = peerObj.pc.log.indexOf('addIceCandidate:candidate:1 1 udp 123 127.0.0.1 9000 typ host');
        assert(endIdx !== -1, 'setRemoteDescription deve ter concluído');
        assert(candIdx > endIdx, 'addIceCandidate deve executar somente após setRemoteDescription concluir');
        assert.strictEqual(peerObj.iceCandidateQueue.length, 0, 'Fila de candidatos não deve reter candidato após flush');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: Peer removido/fechado durante await em sendOffer e socket.on('signal') não emite signal nem chama setLocalDescription
    process.stdout.write('  [Teste] T2: Peer fechado/removido durante await em sendOffer e signal aborta com segurança ... ');
    try {
        // 2a: Remoção durante createOffer em sendOffer
        let releaseCreateOffer;
        const createOfferGate = new Promise((resolve) => { releaseCreateOffer = resolve; });
        const hOffer = createSignalingRaceHarness(appJs, (pc) => {
            pc.createOffer = async () => {
                pc.log.push('createOffer:start');
                await createOfferGate;
                return { type: 'offer', sdp: 'v=0\r\nlate-offer' };
            };
        });
        const pcOffer = hOffer.sandbox.getOrCreatePeerConnection('peer-dead-1');
        const sendPromise = hOffer.sandbox.sendOffer('peer-dead-1');
        await delay(10);

        // Remove peer e fecha pc enquanto createOffer ainda está pendente
        hOffer.peers.delete('peer-dead-1');
        pcOffer.close();
        releaseCreateOffer();
        await sendPromise;

        assert.strictEqual(
            pcOffer.log.some((e) => e.startsWith('setLocalDescription:')),
            false,
            'Não deve chamar setLocalDescription após peer removido/fechado em createOffer'
        );
        assert.strictEqual(hOffer.emittedSignals.length, 0, 'Não deve emitir signal para peer morto');

        // 2b: Fechamento durante setLocalDescription em sendOffer
        let releaseSetLocal;
        const setLocalGate = new Promise((resolve) => { releaseSetLocal = resolve; });
        const hLocal = createSignalingRaceHarness(appJs, (pc) => {
            pc.setLocalDescription = async (desc) => {
                pc.log.push('setLocalDescription:start');
                await setLocalGate;
                pc.localDescription = desc;
            };
        });
        const pcLocal = hLocal.sandbox.getOrCreatePeerConnection('peer-dead-2');
        const sendPromise2 = hLocal.sandbox.sendOffer('peer-dead-2');
        await delay(10);

        hLocal.peers.delete('peer-dead-2');
        pcLocal.close();
        releaseSetLocal();
        await sendPromise2;

        assert.strictEqual(hLocal.emittedSignals.length, 0, 'Não deve emitir signal após peer removido durante setLocalDescription');

        // 2c: Remoção durante await setRemoteDescription ao receber offer em socket.on('signal')
        let releaseOfferSig;
        const offerSigGate = new Promise((resolve) => { releaseOfferSig = resolve; });
        const hSig = createSignalingRaceHarness(appJs, (pc) => {
            pc.setRemoteDescription = async (desc) => {
                pc.log.push('setRemoteDescription:start');
                await offerSigGate;
                pc.remoteDescription = desc;
            };
        });
        hSig.getSignalHandler()({ senderId: 'peer-dead-3', signal: { type: 'offer', sdp: 'v=0\r\noffer' } });
        await delay(10);
        const deadPeerObj = hSig.peers.get('peer-dead-3');
        hSig.peers.delete('peer-dead-3');
        deadPeerObj.pc.close();
        releaseOfferSig();
        await deadPeerObj._signalChain;

        assert.strictEqual(deadPeerObj.pc.log.includes('createAnswer'), false, 'Não deve criar answer em peer morto');
        assert.strictEqual(hSig.emittedSignals.length, 0, 'Não deve emitir answer para peer morto');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3: Erro em setRemoteDescription na renegociação preserva isRemoteDescriptionSet quando remoteDescription existe e não trava _signalChain
    process.stdout.write('  [Teste] T3: Falha em setRemoteDescription na renegociação preserva isRemoteDescriptionSet e _signalChain ... ');
    try {
        let shouldFailNextRemote = false;
        const h = createSignalingRaceHarness(appJs, (pc) => {
            pc.setRemoteDescription = async (desc) => {
                if (shouldFailNextRemote) {
                    throw new Error('Invalid SDP during renegotiation');
                }
                pc.log.push(`setRemoteDescription:${desc.type}`);
                pc.remoteDescription = desc;
                pc.signalingState = 'have-remote-offer';
            };
        });

        const onSignal = h.getSignalHandler();
        // 1. Primeiro offer válido estabelece remoteDescription
        onSignal({ senderId: 'peer-reneg', signal: { type: 'offer', sdp: 'v=0\r\ninitial' } });
        await h.peers.get('peer-reneg')._signalChain;

        const peerObj = h.peers.get('peer-reneg');
        assert.strictEqual(peerObj.isRemoteDescriptionSet, true);
        assert.strictEqual(peerObj.pc.remoteDescription.sdp, 'v=0\r\ninitial');

        // Volta signalingState para stable como após setLocalDescription(answer)
        peerObj.pc.signalingState = 'stable';

        // 2. Renegociação falha em setRemoteDescription
        shouldFailNextRemote = true;
        onSignal({ senderId: 'peer-reneg', signal: { type: 'offer', sdp: 'v=0\r\nbad-reneg' } });
        await peerObj._signalChain;

        assert.strictEqual(
            peerObj.isRemoteDescriptionSet,
            true,
            'isRemoteDescriptionSet deve ser preservado como true quando pc.remoteDescription válido ainda existe'
        );

        // 3. Cadeia _signalChain continua funcional para candidatos e novos offers
        shouldFailNextRemote = false;
        onSignal({ senderId: 'peer-reneg', signal: { candidate: { candidate: 'candidate:after-error' } } });
        await peerObj._signalChain;
        assert(
            peerObj.pc.log.includes('addIceCandidate:candidate:after-error'),
            'Cadeia _signalChain deve continuar processando sinais após erro isolado'
        );

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4: Payload inválido / senderId === myId / request-keyframe órfão ignorados e onicecandidate bloqueado para peer morto
    process.stdout.write('  [Teste] T4: Payloads inválidos, auto-sinalização e onicecandidate pós-fechamento são bloqueados ... ');
    try {
        const h = createSignalingRaceHarness(appJs);
        const onSignal = h.getSignalHandler();

        onSignal(null);
        onSignal(undefined);
        onSignal({});
        onSignal({ senderId: 123, signal: { type: 'offer' } });
        onSignal({ senderId: 'peer-x', signal: null });
        onSignal({ senderId: 'self-socket', signal: { type: 'offer', sdp: 'v=0' } });
        onSignal({ senderId: 'unknown-peer', signal: { type: 'request-keyframe' } });

        await delay(20);
        assert.strictEqual(h.getCreatedPcCount(), 0, 'Nenhum RTCPeerConnection órfão deve ser criado');
        assert.strictEqual(h.peers.size, 0);

        // Cria peer ativo e valida onicecandidate antes vs depois da remoção/fechamento
        const pc = h.sandbox.getOrCreatePeerConnection('peer-ice');
        pc.onicecandidate({ candidate: { candidate: 'cand-active' } });
        assert.strictEqual(h.emittedSignals.length, 1);

        // Remove de peers -> onicecandidate não deve emitir
        h.peers.delete('peer-ice');
        pc.onicecandidate({ candidate: { candidate: 'cand-removed' } });
        assert.strictEqual(h.emittedSignals.length, 1, 'Não deve emitir ICE candidate após remoção do peer');

        // Re-insere mas fecha pc -> onicecandidate não deve emitir
        const pc2 = h.sandbox.getOrCreatePeerConnection('peer-ice-2');
        pc2.close();
        pc2.onicecandidate({ candidate: { candidate: 'cand-closed' } });
        assert.strictEqual(h.emittedSignals.length, 1, 'Não deve emitir ICE candidate quando pc está closed');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests().catch((err) => {
    console.error('Erro fatal na suíte:', err);
    process.exit(1);
});
