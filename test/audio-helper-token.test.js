const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

const TEST_PORT = 45458;
const HELPER_BIN = path.resolve(__dirname, '../bin/streamgrid-audio-helper.exe');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function connectAndAuth(port, token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { ws.close(); } catch (_) {}
                reject(new Error('Timeout de autenticação WebSocket'));
            }
        }, 2000);

        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token }));
        });

        ws.on('message', data => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                try {
                    const parsed = JSON.parse(data.toString());
                    resolve({ ws, response: parsed });
                } catch (e) {
                    reject(e);
                }
            }
        });

        ws.on('error', err => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                reject(err);
            }
        });
    });
}

async function runTest() {
    console.log('\n===============================================================');
    console.log('  🧪 TESTE DE VALIDAÇÃO: TOKEN DO AUDIO HELPER APÓS F5');
    console.log('===============================================================\n');

    process.stdout.write('  Iniciando streamgrid-audio-helper.exe na porta ' + TEST_PORT + ' ... ');
    const helper = spawn(HELPER_BIN, ['--port', String(TEST_PORT), '--token', 'token_inicial_sessao'], {
        stdio: 'pipe'
    });

    await sleep(600);
    console.log('\x1b[32mPRONTO\x1b[0m');

    try {
        // 1. Conexão inicial
        process.stdout.write('  [Passo 1] Conexão inicial com token correto ... ');
        const step1 = await connectAndAuth(TEST_PORT, 'token_inicial_sessao');
        if (step1.response.type === 'auth_ok') {
            console.log('\x1b[32mPASSOU (auth_ok)\x1b[0m');
        } else {
            console.log('\x1b[31mFALHOU: ' + JSON.stringify(step1.response) + '\x1b[0m');
            process.exitCode = 1;
            return;
        }
        step1.ws.close();

        // 2. Simulação de F5 rápido (100ms depois)
        await sleep(100);

        // 2a. Se um novo token for gerado (comportamento sem sessionStorage) -> DEVE FALHAR (auth_failed)
        process.stdout.write('  [Passo 2] F5 sem persistência (novo token gerado) ... ');
        const step2 = await connectAndAuth(TEST_PORT, 'novo_token_gerado_no_f5');
        if (step2.response.type === 'auth_failed') {
            console.log('\x1b[33mCONFIRMADO (auth_failed: token novo rejeitado pelo helper)\x1b[0m');
        } else {
            console.log('\x1b[31mFALHA DE ASSERTIVA (esperado auth_failed): ' + JSON.stringify(step2.response) + '\x1b[0m');
            process.exitCode = 1;
            return;
        }
        step2.ws.close();

        // 2b. Se o token for preservado (comportamento com sessionStorage) -> DEVE PASSAR (auth_ok)
        await sleep(100);
        process.stdout.write('  [Passo 3] F5 com token preservado em sessionStorage ... ');
        const step3 = await connectAndAuth(TEST_PORT, 'token_inicial_sessao');
        if (step3.response.type === 'auth_ok') {
            console.log('\x1b[32mPASSOU (auth_ok: reconexão pós-F5 bem-sucedida)\x1b[0m');
        } else {
            console.log('\x1b[31mFALHOU: ' + JSON.stringify(step3.response) + '\x1b[0m');
            process.exitCode = 1;
            return;
        }

        // Encerramento limpo via protocolo
        step3.ws.send(JSON.stringify({ type: 'shutdown' }));
        step3.ws.close();

        console.log('\n===============================================================');
        console.log('  Resultado: Ciclo de vida e persistência de token validados com sucesso.');
        console.log('===============================================================\n');
    } finally {
        try { helper.kill(); } catch (_) {}
    }
}

runTest().catch(err => {
    console.error('Erro na execução do teste:', err);
    process.exit(1);
});
