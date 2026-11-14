const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { loadClientBundleSource } = require('./helpers/client-source');

const rootDir = path.resolve(__dirname, '..');

function httpGetJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        json: JSON.parse(body)
                    });
                } catch (err) {
                    reject(new Error(`Resposta inválida (${res.statusCode}): ${body}`));
                }
            });
        });
        req.on('error', reject);
    });
}

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Função ${name} não encontrada no bundle cliente`);
    return match[0];
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: DYNAMIC TURN (/ice-servers & CLIENT ICE)');
    console.log('===============================================================\n');

    let failures = 0;

    // T1: Cloudflare TURN provider, cache em memória e proteção contra vazamento de segredos
    process.stdout.write('  [Teste] T1: Cloudflare TURN gera credenciais, faz cache e não vaza segredos ... ');
    try {
        const serverExports = require('../server.js');
        assert.strictEqual(typeof serverExports.createIceServersResolver, 'function', 'server.js deve exportar createIceServersResolver');

        let fetchCount = 0;
        let capturedReq = null;
        let nowMs = 1_700_000_000_000;
        const fakeTokenId = 'cf-token-id-secret';
        const fakeApiToken = 'cf-api-bearer-secret';

        const resolver = serverExports.createIceServersResolver({
            env: {
                CF_TURN_TOKEN_ID: fakeTokenId,
                CF_TURN_API_TOKEN: fakeApiToken,
                CF_TURN_TTL_SECONDS: '3600'
            },
            nowFn: () => nowMs,
            fetchImpl: async (url, init) => {
                fetchCount++;
                capturedReq = { url, init };
                await new Promise((r) => setTimeout(r, 25));
                return {
                    ok: true,
                    status: 201,
                    async json() {
                        return {
                            iceServers: [
                                { urls: ['stun:stun.cloudflare.com:3478'] },
                                {
                                    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
                                    username: 'cf-temp-user',
                                    credential: 'cf-temp-pass'
                                }
                            ]
                        };
                    }
                };
            }
        });

        // Dispara duas chamadas concorrentes para validar single-flight + cache
        const [r1, r2] = await Promise.all([resolver(), resolver()]);
        assert.strictEqual(fetchCount, 1, 'Chamadas concorrentes devem compartilhar 1 único fetch');
        assert.strictEqual(capturedReq.url, `https://rtc.live.cloudflare.com/v1/turn/keys/${fakeTokenId}/credentials/generate-ice-servers`);
        assert.strictEqual(capturedReq.init.method, 'POST');
        assert.strictEqual(capturedReq.init.headers.Authorization, `Bearer ${fakeApiToken}`);
        assert.strictEqual(JSON.parse(capturedReq.init.body).ttl, 3600);
        assert.strictEqual(r1.provider, 'cloudflare');
        assert.strictEqual(r2.provider, 'cloudflare');
        assert.strictEqual(r1.iceServers.length, 2);

        const serialized = JSON.stringify(r1);
        assert(!serialized.includes(fakeTokenId), 'Resposta não pode expor CF_TURN_TOKEN_ID');
        assert(!serialized.includes(fakeApiToken), 'Resposta não pode expor CF_TURN_API_TOKEN');

        // Dentro do TTL deve reutilizar cache
        nowMs += 10 * 60 * 1000;
        await resolver();
        assert.strictEqual(fetchCount, 1, 'Dentro do TTL deve reutilizar cache em memória');

        // Próximo da expiração deve renovar
        nowMs += 55 * 60 * 1000;
        await resolver();
        assert.strictEqual(fetchCount, 2, 'Após expiração da margem de cache deve renovar na Cloudflare');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T2: Coturn HMAC-SHA1 ephemeral credentials
    process.stdout.write('  [Teste] T2: Coturn REST HMAC gera username com expiração e assinatura SHA-1 ... ');
    try {
        const { createIceServersResolver } = require('../server.js');
        assert.strictEqual(typeof createIceServersResolver, 'function', 'createIceServersResolver ausente');
        const fixedNow = 1_700_000_000_000;
        const secret = 'minha-chave-coturn-super-secreta';
        const resolver = createIceServersResolver({
            env: {
                TURN_URLS: 'turn:turn.meudominio.com:3478?transport=udp, turns:turn.meudominio.com:443?transport=tcp',
                TURN_SECRET: secret,
                TURN_TTL_SECONDS: '7200'
            },
            nowFn: () => fixedNow
        });

        const result = await resolver();
        assert.strictEqual(result.provider, 'coturn');
        const turnEntry = result.iceServers.find((s) => Array.isArray(s.urls) && s.urls.some((u) => u.startsWith('turn:')));
        assert(turnEntry, 'Deve incluir entrada TURN para Coturn');
        assert.deepStrictEqual(turnEntry.urls, [
            'turn:turn.meudominio.com:3478?transport=udp',
            'turns:turn.meudominio.com:443?transport=tcp'
        ]);
        const expectedExpiry = Math.floor(fixedNow / 1000) + 7200;
        assert.strictEqual(turnEntry.username, `${expectedExpiry}:streamgrid`);
        const expectedCred = crypto.createHmac('sha1', secret).update(turnEntry.username).digest('base64');
        assert.strictEqual(turnEntry.credential, expectedCred);
        assert(!JSON.stringify(result).includes(secret), 'TURN_SECRET jamais deve ser exposto');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T3: GET /ice-servers fallback gracioso, headers Cache-Control: no-store e rate limit por IP
    process.stdout.write('  [Teste] T3: GET /ice-servers retorna fallback sem falhar, no-store e aplica rate limit ... ');
    try {
        const { server, iceRateLimitMap } = require('../server.js');
        if (iceRateLimitMap && typeof iceRateLimitMap.clear === 'function') {
            iceRateLimitMap.clear();
        }
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const res = await httpGetJson(`http://127.0.0.1:${port}/ice-servers`);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['cache-control'], 'no-store');
            assert(Array.isArray(res.json.iceServers) && res.json.iceServers.length >= 2, 'Fallback deve conter servidores STUN/ICE');
            assert.strictEqual(res.json.provider, 'fallback');

            // Dispara rajada até atingir 429
            let got429 = false;
            for (let i = 0; i < 40; i++) {
                const r = await httpGetJson(`http://127.0.0.1:${port}/ice-servers`);
                if (r.statusCode === 429) {
                    got429 = true;
                    assert.strictEqual(r.json.error, 'rate_limited');
                    break;
                }
            }
            assert(got429, 'Excesso de requisições a /ice-servers deve retornar HTTP 429');
        } finally {
            if (iceRateLimitMap && typeof iceRateLimitMap.clear === 'function') {
                iceRateLimitMap.clear();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T4: Módulo public/js/modules/ice-config.js atualiza rtcConfig e pc.setConfiguration em peers ativos
    process.stdout.write('  [Teste] T4: ice-config.js atualiza rtcConfig, chama setConfiguration e tolera falha ... ');
    try {
        const iceModPath = path.join(rootDir, 'public', 'js', 'modules', 'ice-config.js');
        assert(fs.existsSync(iceModPath), 'Módulo public/js/modules/ice-config.js deve existir');
        const bundleSrc = loadClientBundleSource();

        let setConfigCalls = 0;
        let lastConfigApplied = null;
        let fetchCalls = 0;
        let shouldFail = false;

        const mockPeer = {
            pc: {
                connectionState: 'connecting',
                setConfiguration(cfg) {
                    setConfigCalls++;
                    lastConfigApplied = cfg;
                }
            }
        };

        const sandbox = {
            URL,
            Map,
            Set,
            Promise,
            Date,
            Math,
            setTimeout,
            clearTimeout,
            AbortController: global.AbortController,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            peers: new Map([['peer-1', mockPeer]]),
            fetch: async (url) => {
                fetchCalls++;
                assert.strictEqual(url, 'https://screenshare-p2p.onrender.com/ice-servers');
                if (shouldFail) throw new Error('network down');
                return {
                    ok: true,
                    async json() {
                        return {
                            provider: 'cloudflare',
                            ttlSeconds: 3600,
                            iceServers: [
                                { urls: ['stun:stun.cloudflare.com:3478'] },
                                { urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' }
                            ]
                        };
                    }
                };
            }
        };

        vm.createContext(sandbox);
        const code = [
            extractFn(bundleSrc, 'createDefaultRtcConfig'),
            extractFn(bundleSrc, 'getIceProviderDisplayLabel'),
            extractFn(bundleSrc, 'refreshIceServers')
        ].join('\n\n');
        vm.runInContext(`
            var activeIceProvider = 'fallback';
            var iceServersExpiresAt = 0;
            var iceServersFetchPromise = null;
            var rtcConfig = createDefaultRtcConfig();
            ${code}
        `, sandbox);

        const firstResult = await sandbox.refreshIceServers('https://screenshare-p2p.onrender.com');
        assert.strictEqual(fetchCalls, 1);
        assert.strictEqual(firstResult.provider, 'cloudflare');
        assert.strictEqual(sandbox.rtcConfig.iceServers.length, 2);
        assert.strictEqual(sandbox.rtcConfig.iceServers[1].username, 'u1');
        assert.strictEqual(setConfigCalls, 1, 'Deve atualizar RTCPeerConnection ativo via setConfiguration');
        assert.strictEqual(lastConfigApplied.iceServers[1].credential, 'c1');
        assert.strictEqual(sandbox.getIceProviderDisplayLabel('cloudflare'), 'Cloudflare TURN');

        // Dentro do cache do cliente não deve refazer fetch sem force=true
        await sandbox.refreshIceServers('https://screenshare-p2p.onrender.com');
        assert.strictEqual(fetchCalls, 1, 'Não deve refazer fetch se credenciais ainda estão dentro da validade');

        // Com force=true e falha de rede, mantém servidores válidos sem quebrar
        shouldFail = true;
        await sandbox.refreshIceServers('https://screenshare-p2p.onrender.com', { force: true });
        assert.strictEqual(sandbox.rtcConfig.iceServers[1].username, 'u1', 'Falha não deve limpar servidores já carregados');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T5: Diagnóstico #statsIceProvider e render.yaml com env vars sem segredo
    process.stdout.write('  [Teste] T5: #statsModal exibe #statsIceProvider e render.yaml declara CF_TURN_* ... ');
    try {
        const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
        const renderYaml = fs.readFileSync(path.join(rootDir, 'render.yaml'), 'utf8');
        const bundleSrc = loadClientBundleSource();

        assert(html.includes('id="statsIceProvider"'), 'public/index.html deve possuir #statsIceProvider no modal de estatísticas');
        assert(bundleSrc.includes('statsIceProvider'), 'updateStatsDisplay deve atualizar #statsIceProvider');
        assert(renderYaml.includes('CF_TURN_TOKEN_ID'), 'render.yaml deve declarar CF_TURN_TOKEN_ID');
        assert(renderYaml.includes('CF_TURN_API_TOKEN'), 'render.yaml deve declarar CF_TURN_API_TOKEN');
        assert(renderYaml.includes('sync: false'), 'Segredos CF_TURN_* devem usar sync: false no render.yaml');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Todos os 5 testes de /ice-servers passaram com sucesso!');
        console.log('===============================================================\n');
    } else {
        console.log(`  ❌ ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('❌ Erro fatal na suíte ice-servers:', err);
    process.exit(1);
});
