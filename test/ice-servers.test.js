const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createIceServersResolver } = require('../src/server/ice');
const { startTestServer, httpRequest } = require('./helpers/test-server');

const rootDir = path.resolve(__dirname, '..');
const ICE_CONFIG_URL = pathToFileURL(path.join(rootDir, 'public', 'js', 'modules', 'ice-config.js')).href;
let iceImportSeq = 0;

describe('Dynamic TURN (/ice-servers & client ICE)', () => {
    it('T1: Cloudflare TURN gera credenciais, faz cache e não vaza segredos', async () => {
        let fetchCount = 0;
        let capturedReq = null;
        let nowMs = 1_700_000_000_000;
        const fakeTokenId = 'cf-token-id-secret';
        const fakeApiToken = 'cf-api-bearer-secret';

        const resolver = createIceServersResolver({
            env: {
                CF_TURN_TOKEN_ID: fakeTokenId,
                CF_TURN_API_TOKEN: fakeApiToken,
                CF_TURN_TTL_SECONDS: '3600'
            },
            nowFn: () => nowMs,
            fetchImpl: async (url, init) => {
                fetchCount++;
                capturedReq = { url, init };
                await new Promise((r) => setTimeout(r, 20));
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

        const [r1, r2] = await Promise.all([resolver(), resolver()]);
        assert.strictEqual(fetchCount, 1);
        assert.strictEqual(
            capturedReq.url,
            `https://rtc.live.cloudflare.com/v1/turn/keys/${fakeTokenId}/credentials/generate-ice-servers`
        );
        assert.strictEqual(capturedReq.init.method, 'POST');
        assert.strictEqual(capturedReq.init.headers.Authorization, `Bearer ${fakeApiToken}`);
        assert.strictEqual(JSON.parse(capturedReq.init.body).ttl, 3600);
        assert.strictEqual(r1.provider, 'cloudflare');
        assert.strictEqual(r2.provider, 'cloudflare');
        assert.strictEqual(r1.iceServers.length, 2);

        const serialized = JSON.stringify(r1);
        assert.ok(!serialized.includes(fakeTokenId));
        assert.ok(!serialized.includes(fakeApiToken));

        nowMs += 10 * 60 * 1000;
        await resolver();
        assert.strictEqual(fetchCount, 1);

        nowMs += 55 * 60 * 1000;
        await resolver();
        assert.strictEqual(fetchCount, 2);
    });

    it('T2: Coturn REST HMAC gera username com expiração e assinatura SHA-1', async () => {
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
        const turnEntry = result.iceServers.find(
            (s) => Array.isArray(s.urls) && s.urls.some((u) => u.startsWith('turn:'))
        );
        assert.ok(turnEntry);
        assert.deepStrictEqual(turnEntry.urls, [
            'turn:turn.meudominio.com:3478?transport=udp',
            'turns:turn.meudominio.com:443?transport=tcp'
        ]);
        const expectedExpiry = Math.floor(fixedNow / 1000) + 7200;
        assert.strictEqual(turnEntry.username, `${expectedExpiry}:streamgrid`);
        const expectedCred = crypto.createHmac('sha1', secret).update(turnEntry.username).digest('base64');
        assert.strictEqual(turnEntry.credential, expectedCred);
        assert.ok(!JSON.stringify(result).includes(secret));
    });

    it('T3: GET /ice-servers retorna fallback sem falhar, no-store e aplica rate limit', async () => {
        const ts = await startTestServer({ env: { ...process.env, CF_TURN_TOKEN_ID: '', CF_TURN_API_TOKEN: '', TURN_URLS: '', TURN_SECRET: '' } });
        try {
            const res = await httpRequest(`${ts.baseUrl}/ice-servers`);
            const json = JSON.parse(res.body);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['cache-control'], 'no-store');
            assert.ok(Array.isArray(json.iceServers) && json.iceServers.length >= 2);
            assert.strictEqual(json.provider, 'fallback');

            let got429 = false;
            for (let i = 0; i < 40; i++) {
                const r = await httpRequest(`${ts.baseUrl}/ice-servers`);
                if (r.statusCode === 429) {
                    got429 = true;
                    assert.strictEqual(JSON.parse(r.body).error, 'rate_limited');
                    break;
                }
            }
            assert.ok(got429, 'Excesso de requisições a /ice-servers deve retornar HTTP 429');
        } finally {
            await ts.close();
        }
    });

    it('T4: ice-config.js atualiza rtcConfig, chama setConfiguration e tolera falha', async () => {
        const iceMod = await import(`${ICE_CONFIG_URL}?t=${++iceImportSeq}`);
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
        const peers = new Map([['peer-1', mockPeer]]);

        const origFetch = global.fetch;
        global.fetch = async (url) => {
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
        };

        try {
            const firstResult = await iceMod.refreshIceServers('https://screenshare-p2p.onrender.com', { peers });
            assert.strictEqual(fetchCalls, 1);
            assert.strictEqual(firstResult.provider, 'cloudflare');
            assert.strictEqual(iceMod.rtcConfig.iceServers.length, 2);
            assert.strictEqual(iceMod.rtcConfig.iceServers[1].username, 'u1');
            assert.strictEqual(setConfigCalls, 1);
            assert.strictEqual(lastConfigApplied.iceServers[1].credential, 'c1');
            assert.strictEqual(iceMod.getIceProviderDisplayLabel('cloudflare'), 'Cloudflare TURN');

            await iceMod.refreshIceServers('https://screenshare-p2p.onrender.com');
            assert.strictEqual(fetchCalls, 1);

            shouldFail = true;
            await iceMod.refreshIceServers('https://screenshare-p2p.onrender.com', { force: true });
            assert.strictEqual(iceMod.rtcConfig.iceServers[1].username, 'u1');
        } finally {
            iceMod.stopIceRefreshTimer();
            global.fetch = origFetch;
        }
    });

    it('T5: #statsModal exibe #statsIceProvider e render.yaml declara CF_TURN_*', () => {
        const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
        const renderYaml = fs.readFileSync(path.join(rootDir, 'render.yaml'), 'utf8');
        const statsModalSrc = fs.readFileSync(path.join(rootDir, 'public', 'js', 'modules', 'stats-modal.js'), 'utf8');

        assert.ok(html.includes('id="statsIceProvider"'));
        assert.ok(statsModalSrc.includes('statsIceProvider'));
        assert.ok(renderYaml.includes('CF_TURN_TOKEN_ID'));
        assert.ok(renderYaml.includes('CF_TURN_API_TOKEN'));
        assert.ok(renderYaml.includes('sync: false'));
    });

    it('T6: cache retorna ttlSeconds restante, preserva cache válido se refresh falhar e responde OPTIONS 204', async () => {
        let nowMs = 1_700_000_000_000;
        let shouldFailFetch = false;
        let calls = 0;

        const resolver = createIceServersResolver({
            env: {
                CF_TURN_TOKEN_ID: 'cf-id-ttl',
                CF_TURN_API_TOKEN: 'cf-tok-ttl',
                CF_TURN_TTL_SECONDS: '3600'
            },
            nowFn: () => nowMs,
            fetchImpl: async () => {
                calls++;
                if (shouldFailFetch) throw new Error('cloudflare temporary outage');
                return {
                    ok: true,
                    status: 201,
                    async json() {
                        return {
                            iceServers: [
                                { urls: ['stun:stun.cloudflare.com:3478'] },
                                { urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u-live', credential: 'p-live' }
                            ]
                        };
                    }
                };
            }
        });

        const initial = await resolver();
        assert.strictEqual(initial.ttlSeconds, 3600);
        assert.strictEqual(calls, 1);

        nowMs += 1000 * 1000;
        const cachedHit = await resolver();
        assert.strictEqual(calls, 1);
        assert.strictEqual(cachedHit.ttlSeconds, 2600);

        nowMs += 2350 * 1000;
        shouldFailFetch = true;
        const staleWhileValid = await resolver();
        assert.strictEqual(calls, 2);
        assert.strictEqual(staleWhileValid.provider, 'cloudflare');
        assert.strictEqual(staleWhileValid.iceServers[1].username, 'u-live');
        assert.ok(staleWhileValid.ttlSeconds <= 250 && staleWhileValid.ttlSeconds >= 240);

        nowMs += 300 * 1000;
        const expiredFallback = await resolver();
        assert.strictEqual(expiredFallback.provider, 'fallback');

        const ts = await startTestServer();
        try {
            const optRes = await httpRequest(`${ts.baseUrl}/ice-servers`, {
                method: 'OPTIONS',
                headers: { Origin: ts.baseUrl }
            });
            assert.strictEqual(optRes.statusCode, 204);
        } finally {
            await ts.close();
        }
    });

    it('T7: timer ICE não ressuscita após stopIceRefreshTimer e aplica backoff curto em falha', async () => {
        const iceMod = await import(`${ICE_CONFIG_URL}?t=${++iceImportSeq}`);
        let pendingFetchResolve;
        let fetchShouldFail = false;
        const timers = [];

        const origFetch = global.fetch;
        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        const origDateNow = Date.now;
        let fakeNow = 1_700_000_000_000;

        Date.now = () => fakeNow;
        global.setTimeout = (fn, delay) => {
            const entry = { fn, delay, cleared: false };
            timers.push(entry);
            return entry;
        };
        global.clearTimeout = (entry) => {
            if (entry) entry.cleared = true;
        };
        global.fetch = () => {
            if (fetchShouldFail) {
                return Promise.reject(new Error('transient timeout'));
            }
            return new Promise((resolve) => {
                pendingFetchResolve = () => resolve({
                    ok: true,
                    status: 200,
                    async json() {
                        return {
                            provider: 'cloudflare',
                            ttlSeconds: 300,
                            iceServers: [{ urls: 'turn:cf:3478', username: 'u', credential: 'c' }]
                        };
                    }
                });
            });
        };

        try {
            const refreshTimers = () => timers.filter((t) => t.delay !== 3500);

            iceMod.scheduleIceRefreshTimer('https://srv.test', {});
            assert.strictEqual(refreshTimers().length, 1);
            const firstTimerCb = refreshTimers()[0].fn();
            await Promise.resolve();
            iceMod.stopIceRefreshTimer();
            assert.ok(pendingFetchResolve, 'fetch do timer deveria estar pendente');
            pendingFetchResolve();
            await firstTimerCb;
            assert.strictEqual(refreshTimers().length, 1, 'stopIceRefreshTimer durante fetch em voo deve impedir novo agendamento');

            fetchShouldFail = true;
            fakeNow += 600_000;
            iceMod.scheduleIceRefreshTimer('https://srv.test', {});
            const activeTimer = refreshTimers()[refreshTimers().length - 1];
            await activeTimer.fn();
            const retryDelay = refreshTimers()[refreshTimers().length - 1].delay;
            assert.ok(
                retryDelay >= 15000 && retryDelay <= 30000,
                `Retry após falha com cache expirado deve usar backoff curto (15s-30s), recebido ${retryDelay}ms`
            );
        } finally {
            iceMod.stopIceRefreshTimer();
            global.fetch = origFetch;
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
            Date.now = origDateNow;
        }
    });
});
