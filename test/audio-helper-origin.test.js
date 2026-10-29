const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const assert = require('assert');

const TEST_PORT = 45459;
const HELPER_BIN = path.resolve(__dirname, '../bin/streamgrid-audio-helper.exe');
const TEST_TOKEN = 'test_token_secret_12345';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function connectWebSocket(port, origin, token) {
    return new Promise((resolve, reject) => {
        const headers = origin ? { 'Origin': origin } : {};
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { ws.close(); } catch (_) {}
                reject(new Error('Timeout de conexão WebSocket'));
            }
        }, 3000);

        ws.on('open', () => {
            if (!token) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ status: 'connected', ws });
                }
                return;
            }

            ws.send(JSON.stringify({ type: 'auth', token }));
            ws.once('message', data => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    try {
                        const parsed = JSON.parse(data.toString());
                        resolve({ status: 'connected', ws, authResponse: parsed });
                    } catch (e) {
                        reject(e);
                    }
                }
            });
        });

        ws.on('error', err => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ status: 'rejected', error: err.message });
            }
        });
    });
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: VALIDAÇÃO DE ORIGIN & SEGURANÇA HELPER');
    console.log('===============================================================\n');

    let failures = 0;

    // Teste 0: Execução sem --token deve falhar com código 1
    process.stdout.write('  [Teste] T0: Bloqueio de inicialização sem argumento --token ... ');
    const noTokenRun = spawnSync(HELPER_BIN, [], { encoding: 'utf8' });
    if (noTokenRun.status === 1 && noTokenRun.stderr.includes('token é obrigatório')) {
        console.log('PASSOU (Encerrado com código 1 e mensagem de segurança)');
    } else {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe: Helper deveria encerrar com código 1 sem token');
    }

    process.stdout.write('  Iniciando streamgrid-audio-helper.exe na porta ' + TEST_PORT + ' ... ');
    const helper = spawn(HELPER_BIN, ['--port', String(TEST_PORT), '--token', TEST_TOKEN], {
        stdio: 'pipe'
    });

    await sleep(600);

    if (helper.exitCode !== null) {
        console.error('Falha ao iniciar binário do helper. Exit code:', helper.exitCode);
        process.exit(1);
    }
    console.log('PRONTO\n');

    try {
        // Teste 1: Origem externa não autorizada (https://evil.com) deve ser rejeitada no handshake HTTP
        process.stdout.write('  [Teste] T1: Bloqueio de handshake com Origin não autorizado (https://evil.com) ... ');
        const evilRes = await connectWebSocket(TEST_PORT, 'https://evil.com', TEST_TOKEN);
        if (evilRes.status === 'connected') {
            try { evilRes.ws.close(); } catch (_) {}
            failures++;
            console.log('FALHOU');
            console.error('    Detalhe: Conexão com Origin https://evil.com foi aceita! O servidor deveria rejeitar no handshake.');
        } else {
            assert.ok(
                evilRes.error.includes('403') || evilRes.error.includes('Unexpected server response'),
                `Esperado erro 403, recebido: ${evilRes.error}`
            );
            console.log('PASSOU (Rejeitado no handshake com 403)');
        }

        // Teste 2: Origem autorizada local (http://localhost:3000) deve ser aceita e autenticar com sucesso
        process.stdout.write('  [Teste] T2: Aceitação de handshake com Origin autorizado (http://localhost:3000) ... ');
        const legitRes = await connectWebSocket(TEST_PORT, 'http://localhost:3000', TEST_TOKEN);
        if (legitRes.status === 'connected') {
            assert.strictEqual(legitRes.authResponse.type, 'auth_ok', 'Autenticação deveria ser auth_ok');
            try { legitRes.ws.close(); } catch (_) {}
            console.log('PASSOU (Handshake aceito e autenticado com auth_ok)');
        } else {
            failures++;
            console.log('FALHOU');
            console.error('    Detalhe: Conexão local legítima foi rejeitada:', legitRes.error);
        }

        // Teste 3: Conexão sem header de Origin (processos locais / clientes diretos) deve ser aceita
        process.stdout.write('  [Teste] T3: Aceitação de handshake direto sem Origin (cliente nativo local) ... ');
        const directRes = await connectWebSocket(TEST_PORT, null, TEST_TOKEN);
        if (directRes.status === 'connected') {
            assert.strictEqual(directRes.authResponse.type, 'auth_ok', 'Cliente direto deve autenticar');
            try { directRes.ws.close(); } catch (_) {}
            console.log('PASSOU (Handshake direto aceito e autenticado)');
        } else {
            failures++;
            console.log('FALHOU');
            console.error('    Detalhe: Conexão direta foi rejeitada:', directRes.error);
        }

    } finally {
        try { helper.kill('SIGINT'); } catch (_) {}
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} falhas encontradas.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();
