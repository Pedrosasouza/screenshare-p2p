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

function extractSocketHandler(source, eventName) {
    const regex = new RegExp(`socket\\.on\\('${eventName}'[\\s\\S]*?\\n\\}\\);`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Handler socket.on('${eventName}') não encontrado em public/app.js`);
    }
    return match[0];
}

function createRoomJoinHarness(appJs) {
    const storageMap = new Map();
    const socketHandlers = {};
    const emittedEvents = [];
    const pushedUrls = [];
    const replacedUrls = [];
    let cleanupCalls = 0;

    const makeEl = (extra = {}) => ({
        style: {
            display: '',
            removeProperty(prop) {
                if (prop === 'display') this.display = '';
            }
        },
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); }
        },
        hidden: false,
        value: '',
        textContent: '',
        children: [],
        appendChild(ch) { this.children.push(ch); },
        focus() {},
        select() {},
        ...extra
    });

    const roomModal = makeEl({ hidden: false, style: { display: 'flex', removeProperty(p) { if (p === 'display') this.display = ''; } } });
    const btnCloseRoomModal = makeEl({ style: { display: 'none', removeProperty() {} } });
    const btnCancelRoomModal = makeEl({ style: { display: 'none', removeProperty() {} } });
    const roomChoiceCancelContainer = makeEl({ style: { display: 'none', removeProperty() {} } });
    const inputJoinRoomId = makeEl();
    const inputJoinRoomPassword = makeEl();
    const displayRoomId = makeEl();
    const remoteActiveStreams = new Set();
    const peers = new Map();

    const socket = {
        id: 'sock-1',
        connected: true,
        on(event, fn) {
            socketHandlers[event] = fn;
        },
        emit(event, payload) {
            emittedEvents.push({ event, payload });
        }
    };

    const sandbox = {
        Map,
        Set,
        encodeURIComponent,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        STORAGE_KEY: 'screenshare_room_id',
        USERNAME_KEY: 'screenshare_username',
        roomId: '',
        pendingRoomJoin: null,
        currentRoomPassword: '',
        currentUserName: 'Pedro',
        clientId: 'client-123',
        myId: '',
        localStream: null,
        peers,
        remoteActiveStreams,
        socket,
        roomModal,
        btnCloseRoomModal,
        btnCancelRoomModal,
        roomChoiceCancelContainer,
        inputJoinRoomId,
        inputJoinRoomPassword,
        displayRoomId,
        localStorage: {
            getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
            setItem: (k, v) => storageMap.set(k, String(v)),
            removeItem: (k) => storageMap.delete(k)
        },
        window: {
            location: { protocol: 'http:', pathname: '/' },
            history: {
                pushState: (_s, _t, url) => pushedUrls.push(url),
                replaceState: (_s, _t, url) => replacedUrls.push(url)
            }
        },
        document: {
            createElement: (tag) => makeEl({ tagName: tag })
        },
        clearRoomError: () => {},
        showRoomError: (msg) => { sandbox._lastError = msg; },
        switchRoomView: (view) => { sandbox._lastView = view; },
        updateEchoWarningVisibility: () => {},
        updateMemberCount: () => {},
        getOrCreatePeerConnection: (peerId) => {
            if (!peers.has(peerId)) peers.set(peerId, { pc: { close() {} } });
            return peers.get(peerId).pc;
        },
        updatePeerUserName: () => {},
        addLocalTracksToPC: () => {},
        sendOffer: () => {},
        updateSendersForActivePeers: () => {},
        cleanupRoomState: () => {
            cleanupCalls += 1;
            peers.clear();
        }
    };

    vm.createContext(sandbox);
    vm.runInContext(extractFn(appJs, 'sanitizeRoomId'), sandbox);
    vm.runInContext(extractFn(appJs, 'generateRandomRoomId'), sandbox);
    vm.runInContext(extractFn(appJs, 'updateRoomModalCloseButton'), sandbox);
    vm.runInContext(extractFn(appJs, 'openRoomModal'), sandbox);
    vm.runInContext(extractFn(appJs, 'closeRoomModal'), sandbox);
    vm.runInContext(extractFn(appJs, 'joinRoom'), sandbox);
    vm.runInContext(extractSocketHandler(appJs, 'connect'), sandbox);
    vm.runInContext(extractSocketHandler(appJs, 'join-error'), sandbox);
    vm.runInContext(extractSocketHandler(appJs, 'room-users'), sandbox);

    return {
        sandbox,
        storageMap,
        socketHandlers,
        emittedEvents,
        pushedUrls,
        replacedUrls,
        getCleanupCalls: () => cleanupCalls
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: SINCRONIZAÇÃO DE ESTADO NO JOIN DE SALA');
    console.log('===============================================================\n');

    let failures = 0;
    const { loadClientBundleSource } = require('./helpers/client-source');
    const appJs = loadClientBundleSource();
    // T1: Entrada inicial falha mantém roomId === '', STORAGE_KEY não gravado, modal bloqueado
    process.stdout.write('  [Teste] T1: Entrada inicial falha preserva roomId="" e impede fechar modal ... ');
    try {
        const h = createRoomJoinHarness(appJs);
        const { sandbox, storageMap, socketHandlers, emittedEvents, pushedUrls } = h;

        sandbox.joinRoom('sala-secreta', 'senha-errada');
        assert.strictEqual(emittedEvents.length, 1);
        assert.strictEqual(emittedEvents[0].event, 'join-room');
        assert.strictEqual(emittedEvents[0].payload.roomId, 'sala-secreta');

        // Antes da resposta do servidor, nada foi confirmado
        assert.strictEqual(sandbox.roomId, '');
        assert.strictEqual(storageMap.has(sandbox.STORAGE_KEY), false);
        assert.strictEqual(pushedUrls.length, 0);

        // Servidor rejeita com invalid_password
        socketHandlers['join-error']({ error: 'invalid_password', message: 'Senha incorreta' });

        assert.strictEqual(sandbox.roomId, '', 'roomId deve continuar vazio após erro inicial');
        assert.strictEqual(sandbox.pendingRoomJoin, null);
        assert.strictEqual(storageMap.has(sandbox.STORAGE_KEY), false, 'STORAGE_KEY não deve ser gravado');
        assert.strictEqual(sandbox.btnCloseRoomModal.style.display, 'none', 'btnCloseRoomModal deve permanecer oculto');
        assert.strictEqual(sandbox.inputJoinRoomId.value, 'sala-secreta', 'inputJoinRoomId deve exibir sala rejeitada');

        // Tentar fechar o modal não pode fechar quando roomId === ''
        sandbox.closeRoomModal();
        assert.strictEqual(sandbox.roomModal.hidden, false, 'closeRoomModal() não deve fechar o modal sem sala confirmada');
        assert.strictEqual(sandbox.roomModal.style.display, 'flex');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: Troca da sala-a para sala-b que falha preserva sala-a, STORAGE_KEY e peers sem cleanupRoomState()
    process.stdout.write('  [Teste] T2: Troca falhada para sala-b preserva sala-a, STORAGE_KEY e peers ativos ... ');
    try {
        const h = createRoomJoinHarness(appJs);
        const { sandbox, storageMap, socketHandlers } = h;

        // Entra na sala-a com sucesso
        sandbox.joinRoom('sala-a', 'pass-a');
        await socketHandlers['room-users']({
            users: ['peer-a1'],
            userNames: { 'peer-a1': 'Alice' },
            activeStreams: [],
            socketId: 'sock-1',
            memberCount: 2,
            hasPassword: true
        });
        assert.strictEqual(sandbox.roomId, 'sala-a');
        assert.strictEqual(storageMap.get(sandbox.STORAGE_KEY), 'sala-a');
        assert.strictEqual(sandbox.peers.has('peer-a1'), true);

        // Tenta trocar para sala-b e falha com invalid_password e depois rate_limited
        sandbox.joinRoom('sala-b', 'errada');
        assert.strictEqual(h.getCleanupCalls(), 0, 'cleanupRoomState não pode ser chamado antes da confirmação');
        socketHandlers['join-error']({ error: 'invalid_password', message: 'Senha incorreta' });

        assert.strictEqual(sandbox.roomId, 'sala-a', 'roomId deve permanecer sala-a');
        assert.strictEqual(sandbox.currentRoomPassword, 'pass-a');
        assert.strictEqual(storageMap.get(sandbox.STORAGE_KEY), 'sala-a');
        assert.strictEqual(sandbox.peers.has('peer-a1'), true, 'Peers da sala-a devem permanecer intactos');
        assert.strictEqual(h.getCleanupCalls(), 0);
        assert.strictEqual(sandbox.inputJoinRoomId.value, 'sala-b');

        // Agora falha com rate_limited
        sandbox.joinRoom('sala-b', 'errada-2');
        socketHandlers['join-error']({ error: 'rate_limited', message: 'Bloqueado' });
        assert.strictEqual(sandbox.roomId, 'sala-a');
        assert.strictEqual(storageMap.get(sandbox.STORAGE_KEY), 'sala-a');
        assert.strictEqual(sandbox.peers.has('peer-a1'), true);
        assert.strictEqual(h.getCleanupCalls(), 0);
        assert.strictEqual(sandbox.inputJoinRoomId.value, 'sala-b');

        // E falha com invalid_room também não deve apagar sala-a confirmada
        sandbox.joinRoom('sala-b', '');
        socketHandlers['join-error']({ error: 'invalid_room', message: 'Sala inválida' });
        assert.strictEqual(sandbox.roomId, 'sala-a');
        assert.strictEqual(storageMap.get(sandbox.STORAGE_KEY), 'sala-a');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3: room-users após joinRoom('sala-b', 'segredo') limpa sala-a, confirma estado e fecha modal
    process.stdout.write('  [Teste] T3: Confirmação via room-users executa cleanupRoomState, atualiza estado e fecha modal ... ');
    try {
        const h = createRoomJoinHarness(appJs);
        const { sandbox, storageMap, socketHandlers, pushedUrls } = h;

        sandbox.joinRoom('sala-a', 'pass-a');
        await socketHandlers['room-users']({
            users: ['peer-a1'],
            userNames: {},
            activeStreams: [],
            socketId: 'sock-1',
            memberCount: 2,
            hasPassword: true
        });
        assert.strictEqual(h.getCleanupCalls(), 0);

        // Abre modal para trocar de sala
        sandbox.openRoomModal('join');
        assert.strictEqual(sandbox.roomModal.hidden, false);

        sandbox.joinRoom('sala-b', 'segredo');
        assert.strictEqual(h.getCleanupCalls(), 0, 'Ainda não limpou sala-a antes de room-users');

        await socketHandlers['room-users']({
            users: ['peer-b1'],
            userNames: { 'peer-b1': 'Bob' },
            activeStreams: [],
            socketId: 'sock-1',
            memberCount: 2,
            hasPassword: true
        });

        assert.strictEqual(h.getCleanupCalls(), 1, 'cleanupRoomState deve ser chamado ao confirmar troca para sala-b');
        assert.strictEqual(sandbox.roomId, 'sala-b');
        assert.strictEqual(sandbox.currentRoomPassword, 'segredo');
        assert.strictEqual(storageMap.get(sandbox.STORAGE_KEY), 'sala-b');
        assert.strictEqual(sandbox.displayRoomId.textContent, 'sala-b');
        assert.strictEqual(sandbox.peers.has('peer-a1'), false, 'Peer antigo da sala-a deve ter sido removido');
        assert.strictEqual(sandbox.peers.has('peer-b1'), true, 'Peer da sala-b deve estar presente');
        assert.strictEqual(sandbox.roomModal.hidden, true, 'Modal deve fechar após confirmação');
        assert(pushedUrls.some((u) => u.includes('?room=sala-b')), 'URL deve ser atualizada com sala-b');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4: connect com pendingRoomJoin emite join-room para pendingRoomJoin e não para sala antiga
    process.stdout.write('  [Teste] T4: connect com pendingRoomJoin emite join-room para sala pendente ... ');
    try {
        const h = createRoomJoinHarness(appJs);
        const { sandbox, socketHandlers, emittedEvents } = h;

        // Simula usuário previamente conectado na sala-antiga, depois socket desconecta
        sandbox.roomId = 'sala-antiga';
        sandbox.currentRoomPassword = 'pass-antiga';
        sandbox.socket.connected = false;

        // Solicita entrada na sala-nova enquanto desconectado
        sandbox.joinRoom('sala-nova', 'pass-nova', 'Carlos');
        assert.strictEqual(emittedEvents.length, 0, 'Não deve emitir enquanto socket estiver desconectado');
        assert.strictEqual(sandbox.roomId, 'sala-antiga');

        // Socket conecta
        sandbox.socket.connected = true;
        sandbox.socket.id = 'sock-reconn';
        socketHandlers['connect']();

        assert.strictEqual(emittedEvents.length, 1);
        assert.strictEqual(emittedEvents[0].event, 'join-room');
        assert.strictEqual(emittedEvents[0].payload.roomId, 'sala-nova', 'connect deve priorizar pendingRoomJoin');
        assert.strictEqual(emittedEvents[0].payload.password, 'pass-nova');
        assert.strictEqual(emittedEvents[0].payload.userName, 'Carlos');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T5: checkCreateRoomStatus/checkJoinRoomStatus usam sanitizeRoomId e closeRoomModal limpa pendingRoomJoin
    process.stdout.write('  [Teste] T5: status checkers sanitizam roomId e closeRoomModal limpa pendingRoomJoin ... ');
    try {
        const emitted = [];
        const createIndicator = { textContent: '', className: '', innerHTML: '' };
        const joinIndicator = { textContent: '', className: '', innerHTML: '' };
        const roomModal = {
            hidden: false,
            style: { display: 'flex' },
            classList: { add() {}, remove() {} }
        };

        const sandbox = {
            socket: {
                connected: true,
                emit(ev, payload) { emitted.push({ ev, payload }); }
            },
            roomId: 'sala-atual',
            pendingRoomJoin: { roomId: 'sala-cancelada', password: '', userName: 'Pedro' },
            createRoomStatusIndicator: createIndicator,
            joinRoomStatusIndicator: joinIndicator,
            joinPasswordHint: { textContent: '', className: '' },
            roomModal,
            clearRoomError() {}
        };

        vm.createContext(sandbox);
        vm.runInContext([
            extractFn(appJs, 'sanitizeRoomId'),
            extractFn(appJs, 'checkCreateRoomStatus'),
            extractFn(appJs, 'checkJoinRoomStatus'),
            extractFn(appJs, 'closeRoomModal')
        ].join('\n\n'), sandbox);

        sandbox.checkCreateRoomStatus('  Sala Teste!!  ');
        sandbox.checkJoinRoomStatus('  Sala Outro  ');

        assert.strictEqual(emitted.length, 2, 'Ambos checkers devem emitir check-room após sanitização');
        assert.strictEqual(emitted[0].payload.roomId, sandbox.sanitizeRoomId('  Sala Teste!!  '));
        assert.strictEqual(emitted[1].payload.roomId, sandbox.sanitizeRoomId('  Sala Outro  '));

        sandbox.closeRoomModal();
        assert.strictEqual(sandbox.pendingRoomJoin, null, 'Fechar modal deve cancelar pendingRoomJoin offline');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T6: closeRoomModal com join-room já em voo preserva pendingRoomJoin e reconcilia room-users corretamente
    process.stdout.write('  [Teste] T6: closeRoomModal com join-room em voo reconcilia nova sala sem vazar stream anterior ... ');
    try {
        const h = createRoomJoinHarness(appJs);
        const { sandbox, socketHandlers, emittedEvents, getCleanupCalls } = h;
        sandbox.roomId = 'sala-a';

        sandbox.joinRoom('sala-b', 'senha-b', 'Pedro');
        assert.strictEqual(emittedEvents.length, 1);

        // Usuário fecha o modal antes da resposta room-users voltar do servidor
        sandbox.closeRoomModal();
        assert(sandbox.pendingRoomJoin !== null, 'join-room em voo não deve ser apagado ao fechar o modal');

        // Resposta room-users da sala-b chega logo depois
        await socketHandlers['room-users']({
            users: ['peer-b'],
            userNames: { 'peer-b': 'Ana' },
            activeStreams: [],
            socketId: 'sock-1',
            memberCount: 2,
            hasPassword: true
        });

        assert.strictEqual(getCleanupCalls(), 1, 'cleanupRoomState deve rodar ao confirmar transição em voo para sala-b');
        assert.strictEqual(sandbox.roomId, 'sala-b', 'roomId deve atualizar para sala-b mesmo após fechar modal');
        assert.strictEqual(sandbox.displayRoomId.textContent, 'sala-b');

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
