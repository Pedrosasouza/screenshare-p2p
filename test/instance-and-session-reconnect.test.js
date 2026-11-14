const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const renderYamlPath = path.join(rootDir, 'render.yaml');
const indexPath = path.join(rootDir, 'public', 'index.html');
const appPath = path.join(rootDir, 'public', 'app.js');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Função ${name} não encontrada em public/app.js`);
    return match[0];
}

function extractSocketHandler(source, eventName) {
    const regex = new RegExp(`socket\\.on\\('${eventName}'[\\s\\S]*?\\n\\}\\);`);
    const match = source.match(regex);
    assert(match, `Handler socket.on('${eventName}') não encontrado em public/app.js`);
    return match[0];
}

function extractDomContentLoaded(source) {
    const match = source.match(/window\.addEventListener\('DOMContentLoaded'[\s\S]*?\n\}\);/);
    assert(match, "Handler window.addEventListener('DOMContentLoaded') não encontrado em public/app.js");
    return match[0];
}

function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: INSTÂNCIA ÚNICA, SERVER VISIBILITY & F5 PASS');
    console.log('===============================================================\n');

    let failures = 0;

    // T1: render.yaml explícito travando 1 instância e healthCheckPath: /health
    process.stdout.write('  [Teste] T1: render.yaml trava numInstances: 1 e healthCheckPath: /health ... ');
    try {
        assert(fs.existsSync(renderYamlPath), 'Arquivo render.yaml não encontrado na raiz do projeto');
        const renderYaml = fs.readFileSync(renderYamlPath, 'utf8');
        assert(/numInstances:\s*1\b/.test(renderYaml), 'render.yaml deve definir numInstances: 1');
        assert(/healthCheckPath:\s*\/health\b/.test(renderYaml), 'render.yaml deve definir healthCheckPath: /health');
        assert(/startCommand:\s*npm start\b/.test(renderYaml), 'render.yaml deve definir startCommand: npm start');
        assert(/TRUST_PROXY/.test(renderYaml) && /["']?true["']?/.test(renderYaml), 'render.yaml deve configurar TRUST_PROXY=true');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: index.html possui #statsServerUrl e #btnResetServerUrl dentro de #statsModal
    process.stdout.write('  [Teste] T2: index.html exibe #statsServerUrl e #btnResetServerUrl no modal de diagnóstico ... ');
    try {
        const indexHtml = fs.readFileSync(indexPath, 'utf8');
        const statsModalMatch = indexHtml.match(/id="statsModal"[\s\S]*$/);
        assert(statsModalMatch, '#statsModal não encontrado em public/index.html');
        const statsSection = statsModalMatch[0];
        assert(statsSection.includes('id="statsServerUrl"'), '#statsServerUrl deve estar dentro de #statsModal');
        assert(statsSection.includes('id="btnResetServerUrl"'), '#btnResetServerUrl deve estar dentro de #statsModal');
        assert(/id="btnResetServerUrl"[^>]*type="button"|type="button"[^>]*id="btnResetServerUrl"/.test(statsSection), '#btnResetServerUrl deve ter type="button"');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    const { loadClientBundleSource } = require('./helpers/client-source');

    const appJs = loadClientBundleSource();
    // T3: updateStatsDisplay mostra SERVER_URL e resetSavedSignalingServerUrl limpa localStorage
    process.stdout.write('  [Teste] T3: updateStatsDisplay exibe SERVER_URL e reset limpa streamgrid_server_url ... ');
    try {
        const localMap = new Map([['streamgrid_server_url', 'https://outro.onrender.com']]);
        const toasts = [];
        let reloadCount = 0;

        const elServerUrl = { textContent: '' };
        const btnReset = { hidden: false, style: { display: '' } };
        const elements = {
            statsServerUrl: elServerUrl,
            btnResetServerUrl: btnReset,
            statsConnectionState: { textContent: '' },
            statsRtt: { textContent: '' },
            statsPacketLoss: { textContent: '' },
            statsLocalStream: { textContent: '' },
            statsContentHint: { textContent: '' },
            statsVideoTelemetry: { textContent: '' },
            statsCodecEncoder: { textContent: '' },
            statsQualityLimitation: { textContent: '' },
            statsIceRoute: { textContent: '' }
        };

        const sandbox = {
            Map,
            Set,
            Promise,
            Boolean,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            SERVER_URL: 'https://outro.onrender.com',
            SERVER_URL_STORAGE_KEY: 'streamgrid_server_url',
            peers: new Map(),
            localStream: null,
            selectedVideoFps: 60,
            selectedVideoResolution: '1080p',
            contentHintMode: 'motion',
            isStatsUpdateRunning: false,
            statsUpdateGeneration: 0,
            localStorage: {
                getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
                setItem: (k, v) => localMap.set(k, String(v)),
                removeItem: (k) => localMap.delete(k)
            },
            document: {
                getElementById: (id) => elements[id] || null
            },
            window: {
                location: {
                    reload: () => { reloadCount += 1; }
                }
            },
            showToast: (msg, type) => toasts.push({ msg, type })
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'updateStatsDisplay'), sandbox);
        vm.runInContext(extractFn(appJs, 'resetSavedSignalingServerUrl'), sandbox);

        sandbox.updateStatsDisplay();
        assert(
            elServerUrl.textContent.includes('https://outro.onrender.com'),
            'statsServerUrl deve exibir a URL do servidor conectada'
        );
        assert(
            elServerUrl.textContent.includes('override'),
            'statsServerUrl deve indicar quando há override salvo no localStorage'
        );
        assert.strictEqual(btnReset.hidden, false, 'btnResetServerUrl deve ficar visível quando houver override');

        sandbox.resetSavedSignalingServerUrl();
        assert.strictEqual(localMap.has('streamgrid_server_url'), false, 'Reset deve remover streamgrid_server_url do localStorage');
        assert(toasts.length >= 1, 'Reset deve exibir toast informativo');
        assert.strictEqual(reloadCount, 1, 'Reset deve recarregar para reconectar na instância padrão');

        // Sem override salvo: apenas avisa sem recarregar e oculta botão
        sandbox.updateStatsDisplay();
        assert.strictEqual(btnReset.hidden, true, 'btnResetServerUrl deve ocultar quando não há override no localStorage');
        sandbox.resetSavedSignalingServerUrl();
        assert.strictEqual(reloadCount, 1, 'Sem override salvo, não deve recarregar a página');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4: Cold start notice (>3s sem connect exibe aviso; connect/connect_error antes de 3s cancela)
    process.stdout.write('  [Teste] T4: Aviso de cold start dispara após 3000ms e é cancelado em connect/connect_error ... ');
    try {
        const delayMatch = appJs.match(/const COLD_START_NOTICE_DELAY_MS\s*=\s*(\d+);/);
        assert(delayMatch, 'Constante COLD_START_NOTICE_DELAY_MS não encontrada em public/app.js');
        assert.strictEqual(Number(delayMatch[1]), 3000, 'COLD_START_NOTICE_DELAY_MS deve ser 3000');

        const timers = new Map();
        let nextTimerId = 1;
        const toasts = [];
        const socketHandlers = {};

        const socket = {
            id: 'sock-cold',
            connected: false,
            on(ev, fn) { socketHandlers[ev] = fn; },
            emit() {}
        };

        const sandbox = {
            Map,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            COLD_START_NOTICE_DELAY_MS: 3000,
            coldStartTimer: null,
            hasShownColdStartToast: false,
            wasSocketDisconnected: false,
            hasShownConnectErrorToast: false,
            myId: '',
            roomId: '',
            pendingRoomJoin: null,
            currentRoomPassword: '',
            currentUserName: '',
            clientId: 'c1',
            socket,
            setTimeout: (fn, ms) => {
                const id = nextTimerId++;
                timers.set(id, { fn, ms });
                return id;
            },
            clearTimeout: (id) => {
                timers.delete(id);
            },
            showToast: (msg, type, duration) => toasts.push({ msg, type, duration })
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'scheduleColdStartNotice'), sandbox);
        vm.runInContext(extractFn(appJs, 'cancelColdStartNotice'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'connect'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'connect_error'), sandbox);

        // Caso 1: demora > 3s -> dispara toast de cold start
        sandbox.scheduleColdStartNotice();
        assert.strictEqual(timers.size, 1, 'Deve agendar timer de cold start enquanto desconectado');
        const [id1, entry1] = Array.from(timers.entries())[0];
        assert.strictEqual(entry1.ms, 3000);
        timers.delete(id1);
        entry1.fn();
        assert.strictEqual(toasts.length, 1, 'Deve exibir toast após 3000ms sem conexão');
        assert(/acordando|servidor/i.test(toasts[0].msg), 'Toast deve informar que o servidor está acordando');

        // Caso 2: connect chega antes de 3s -> cancela timer sem toast de cold start
        toasts.length = 0;
        sandbox.hasShownColdStartToast = false;
        socket.connected = false;
        sandbox.scheduleColdStartNotice();
        assert.strictEqual(timers.size, 1);
        socket.connected = true;
        socketHandlers.connect();
        assert.strictEqual(timers.size, 0, 'connect deve cancelar coldStartTimer');
        assert.strictEqual(toasts.filter((t) => /acordando/i.test(t.msg)).length, 0);

        // Caso 3: connect_error chega antes de 3s -> cancela coldStartTimer
        socket.connected = false;
        sandbox.scheduleColdStartNotice();
        assert.strictEqual(timers.size, 1);
        socketHandlers.connect_error(new Error('network'));
        assert.strictEqual(timers.size, 0, 'connect_error deve cancelar coldStartTimer');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T5: sessionStorage guarda senha da sala atual para reconectar após F5 e limpa em erro/pública
    process.stdout.write('  [Teste] T5: sessionStorage preserva senha no F5 da mesma aba e limpa em join-error ... ');
    try {
        const keyMatch = appJs.match(/const SESSION_PASS_STORAGE_KEY\s*=\s*'([^']+)';/);
        assert(keyMatch, 'Constante SESSION_PASS_STORAGE_KEY não encontrada em public/app.js');

        const localMap = new Map();
        const sessionMap = new Map();
        const socketHandlers = {};
        const joinCalls = [];
        const domListeners = {};

        const makeEl = () => ({
            style: { display: '', removeProperty() {} },
            classList: { add() {}, remove() {}, contains: () => false },
            hidden: false,
            value: '',
            textContent: '',
            focus() {},
            select() {}
        });

        const windowObj = {
            location: { protocol: 'https:', origin: 'https://screenshare-p2p.onrender.com', pathname: '/', search: '?room=sala-casal', hash: '' },
            history: { state: null, pushState() {}, replaceState() {} },
            addEventListener(ev, fn) { domListeners[ev] = fn; }
        };

        const sandbox = {
            Map,
            Set,
            JSON,
            URLSearchParams,
            encodeURIComponent,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            STORAGE_KEY: 'streamgrid_last_room',
            SESSION_PASS_STORAGE_KEY: keyMatch[1],
            roomId: '',
            pendingRoomJoin: null,
            currentRoomPassword: '',
            currentUserName: 'Pedro',
            clientId: 'c1',
            myId: '',
            localStream: null,
            peers: new Map(),
            remoteActiveStreams: new Set(),
            roomModal: makeEl(),
            btnCloseRoomModal: makeEl(),
            btnCancelRoomModal: makeEl(),
            roomChoiceCancelContainer: makeEl(),
            inputCreateRoomPassword: makeEl(),
            inputJoinRoomPassword: makeEl(),
            inputJoinRoomId: makeEl(),
            displayRoomId: makeEl(),
            localStorage: {
                getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
                setItem: (k, v) => localMap.set(k, String(v)),
                removeItem: (k) => localMap.delete(k)
            },
            sessionStorage: {
                getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
                setItem: (k, v) => sessionMap.set(k, String(v)),
                removeItem: (k) => sessionMap.delete(k)
            },
            window: windowObj,
            socket: {
                id: 's1',
                connected: true,
                on(ev, fn) { socketHandlers[ev] = fn; },
                emit() {}
            },
            initTheme() {},
            sanitizeRoomId: (s) => (s || '').trim().toLowerCase(),
            closeRoomModal() {},
            openRoomModal() {},
            showRoomError() {},
            updateRoomModalCloseButton() {},
            updateEchoWarningVisibility() {},
            updateMemberCount() {},
            updateGridState() {},
            cleanupRoomState() {},
            joinRoom: (r, p = '') => {
                joinCalls.push({ r, p });
                sandbox.pendingRoomJoin = { roomId: r, password: p, userName: 'Pedro' };
            }
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'saveSessionRoomPassword'), sandbox);
        vm.runInContext(extractFn(appJs, 'getSessionRoomPassword'), sandbox);
        vm.runInContext(extractFn(appJs, 'clearSessionRoomPassword'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'room-users'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'join-error'), sandbox);
        vm.runInContext(extractDomContentLoaded(appJs), sandbox);

        // 1. Confirma entrada em sala com senha -> salva em sessionStorage e nunca em localStorage
        sandbox.joinRoom('sala-casal', 'segredo-123');
        socketHandlers['room-users']({
            users: [],
            userNames: {},
            activeStreams: [],
            socketId: 's1',
            memberCount: 1,
            hasPassword: true
        });
        assert.strictEqual(sessionMap.has(keyMatch[1]), true, 'Senha deve ser salva em sessionStorage após room-users');
        assert.strictEqual(sandbox.getSessionRoomPassword('sala-casal'), 'segredo-123');
        assert.strictEqual(sandbox.getSessionRoomPassword('outra-sala'), '', 'Senha não deve vazar para outra sala');
        assert.strictEqual(localMap.get(keyMatch[1]), undefined, 'Senha nunca deve ser salva em localStorage');

        // 2. Simula F5 (?room=sala-casal sem ?pass=) -> DOMContentLoaded deve passar senha restaurada para joinRoom
        joinCalls.length = 0;
        domListeners.DOMContentLoaded();
        assert.strictEqual(joinCalls.length, 1);
        assert.deepStrictEqual(joinCalls[0], { r: 'sala-casal', p: 'segredo-123' });

        // 3. Simula F5 usando apenas localStorage (sem ?room= na URL) -> também restaura senha da sessão
        windowObj.location.search = '';
        joinCalls.length = 0;
        domListeners.DOMContentLoaded();
        assert.strictEqual(joinCalls.length, 1);
        assert.deepStrictEqual(joinCalls[0], { r: 'sala-casal', p: 'segredo-123' });

        // 4. join-error invalid_password limpa sessionStorage para evitar loop
        socketHandlers['join-error']({ error: 'invalid_password', message: 'Senha incorreta' });
        assert.strictEqual(sandbox.getSessionRoomPassword('sala-casal'), '', 'join-error invalid_password deve limpar sessionStorage');

        // 5. Sala sem senha também limpa sessionStorage
        sandbox.saveSessionRoomPassword('sala-casal', 'velha');
        sandbox.joinRoom('sala-casal', '');
        socketHandlers['room-users']({
            users: [],
            userNames: {},
            activeStreams: [],
            socketId: 's1',
            memberCount: 1,
            hasPassword: false
        });
        assert.strictEqual(sandbox.getSessionRoomPassword('sala-casal'), '', 'Sala pública não deve manter senha antiga na sessão');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Todos os 5 testes passaram com sucesso!');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();
