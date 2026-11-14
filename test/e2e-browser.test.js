const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function findEdgeExecutable() {
    const candidates = [
        process.env.EDGE_PATH,
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p)) || null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100, label = 'condição' } = {}) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs) {
        try {
            const val = await fn();
            if (val) return val;
        } catch (err) {
            lastErr = err;
        }
        await delay(intervalMs);
    }
    throw new Error(`Timeout (${timeoutMs}ms) aguardando ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

class CDPClient {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Set();
        this.ready = new Promise((resolve, reject) => {
            this.ws.once('open', resolve);
            this.ws.once('error', reject);
        });
        this.ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch (_) {
                return;
            }
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) {
                    reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
                } else {
                    resolve(msg.result || {});
                }
            } else if (msg.method) {
                for (const fn of this.eventListeners) {
                    try { fn(msg); } catch (_) {}
                }
            }
        });
    }

    onEvent(fn) {
        this.eventListeners.add(fn);
        return () => this.eventListeners.delete(fn);
    }

    send(method, params = {}, sessionId = undefined) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout em ${method}`));
                }
            }, 15000);
            this.pending.set(id, {
                resolve: (res) => { clearTimeout(timer); resolve(res); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });
            this.ws.send(JSON.stringify(payload));
        });
    }

    async evalInSession(sessionId, expression) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        }, sessionId);
        if (res.exceptionDetails) {
            throw new Error(`Erro JS na página: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result ? res.result.value : undefined;
    }

    close() {
        for (const { reject } of this.pending.values()) {
            reject(new Error('CDP fechado'));
        }
        this.pending.clear();
        try { this.ws.close(); } catch (_) {}
    }
}

async function launchHeadlessBrowser(exePath, userDataDir) {
    const proc = spawn(exePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const wsUrl = await waitFor(() => {
        const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) return m[1];
        if (fs.existsSync(activePortFile)) {
            const lines = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
            if (lines.length >= 2 && lines[0] && lines[1]) {
                return `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
            }
        }
        return null;
    }, { timeoutMs: 15000, intervalMs: 100, label: 'DevTools WebSocket do Edge' });

    return { proc, wsUrl };
}

async function createIsolatedTab(cdp, label) {
    const { browserContextId } = await cdp.send('Target.createBrowserContext');
    const { targetId } = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        browserContextId
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true
    });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    const errors = [];
    const failedResponses = [];

    const off = cdp.onEvent((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.exceptionThrown') {
            const detail = msg.params?.exceptionDetails;
            errors.push(`[${label}] Uncaught: ${detail?.exception?.description || detail?.text || 'erro'}`);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
            errors.push(`[${label}] console.error: ${text}`);
        } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
            errors.push(`[${label}] Log.error: ${msg.params.entry.text}`);
        } else if (msg.method === 'Network.responseReceived') {
            const resp = msg.params?.response;
            if (resp && resp.status >= 400 && resp.url.startsWith('http://127.0.0.1')) {
                failedResponses.push(`[${label}] HTTP ${resp.status} ${resp.url}`);
            }
        } else if (msg.method === 'Network.loadingFailed') {
            const errText = msg.params?.errorText || '';
            if (errText && !errText.includes('ERR_ABORTED')) {
                failedResponses.push(`[${label}] Network.loadingFailed: ${errText}`);
            }
        }
    });

    return {
        label,
        browserContextId,
        targetId,
        sessionId,
        errors,
        failedResponses,
        disposeEvents: off
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🌐 SUÍTE E2E DE NAVEGADOR REAL (Edge Headless + CDP)');
    console.log('===============================================================\n');

    const exePath = findEdgeExecutable();
    assert(exePath, 'Microsoft Edge/Chrome não encontrado no ambiente para teste E2E');

    const { server, rooms } = require('../server.js');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamgrid-e2e-'));
    let browserProc = null;
    let cdp = null;
    const tabs = [];

    try {
        const launched = await launchHeadlessBrowser(exePath, userDataDir);
        browserProc = launched.proc;
        cdp = new CDPClient(launched.wsUrl);
        await cdp.ready;

        const tab1 = await createIsolatedTab(cdp, 'Tab1');
        const tab2 = await createIsolatedTab(cdp, 'Tab2');
        tabs.push(tab1, tab2);

        // Direciona ambas as abas isoladas ao servidor local de teste (evita depender do Render externo)
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `try { if (location.origin === ${JSON.stringify(baseUrl)}) { localStorage.setItem('streamgrid_server_url', ${JSON.stringify(baseUrl)}); } } catch (_) {}`
        }, tab1.sessionId);
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `try { if (location.origin === ${JSON.stringify(baseUrl)}) { localStorage.setItem('streamgrid_server_url', ${JSON.stringify(baseUrl)}); } } catch (_) {}`
        }, tab2.sessionId);

        // Step 1: Verify ES Module entrypoint & clean boot in Tab1
        process.stdout.write('  [E2E] T1: Carrega index.html com <script type="module">, CSP válida e status Conectado ... ');
        await cdp.send('Page.navigate', { url: baseUrl }, tab1.sessionId);

        const isModuleLoaded = await waitFor(() => cdp.evalInSession(tab1.sessionId, `
            (() => {
                const s = document.querySelector('script[type="module"][src*="app.js"]');
                const pill = document.getElementById('connectionStatusPill');
                const txt = document.getElementById('connectionStatusText');
                if (!s || !pill || !txt) return null;
                return pill.dataset.status === 'connected' && txt.textContent.trim() === 'Conectado'
                    ? { moduleSrc: s.getAttribute('src'), status: pill.dataset.status, text: txt.textContent.trim() }
                    : null;
            })()
        `), { label: 'módulo ES + status Conectado na Tab1' });

        assert(isModuleLoaded && isModuleLoaded.moduleSrc.includes('app.js'), 'Script principal deve carregar como ES module');
        console.log('\x1b[32mPASSOU\x1b[0m');

        // Step 2: Tab1 cria sala protegida por senha e gera convite com #pass=
        process.stdout.write('  [E2E] T2: Tab1 cria sala com senha e gera link de convite com #pass= ... ');
        const inviteUrl = await cdp.evalInSession(tab1.sessionId, `
            (async () => {
                window.__copiedInvite = '';
                if (!navigator.clipboard) navigator.clipboard = {};
                navigator.clipboard.writeText = async (txt) => { window.__copiedInvite = txt; };

                document.getElementById('btnChooseCreate').click();
                document.getElementById('inputCreateRoomId').value = 'e2e-sala-f';
                document.getElementById('inputCreateRoomPassword').value = 'segredo-e2e';
                document.getElementById('inputCreateUserName').value = 'Pedro';
                document.getElementById('btnConfirmCreate').click();
                return true;
            })()
        `);
        assert.strictEqual(inviteUrl, true);

        await waitFor(() => cdp.evalInSession(tab1.sessionId, `
            (() => {
                const modal = document.getElementById('roomModal');
                const disp = document.getElementById('displayRoomId');
                const count = document.getElementById('memberCountText');
                const modalClosed = modal && (modal.hasAttribute('hidden') || modal.style.display === 'none');
                return modalClosed && disp?.textContent === 'e2e-sala-f' && count?.textContent === '1 Participante';
            })()
        `), { label: 'Tab1 entrar na sala e2e-sala-f' });

        await cdp.evalInSession(tab1.sessionId, `document.getElementById('btnCopyLink').click()`);
        const copiedInvite = await waitFor(() => cdp.evalInSession(tab1.sessionId, `window.__copiedInvite || null`), {
            label: 'captura do link copiado'
        });
        assert(copiedInvite.includes('?room=e2e-sala-f#pass=segredo-e2e'), `Convite inesperado: ${copiedInvite}`);
        console.log('\x1b[32mPASSOU\x1b[0m');

        // Step 3: Tab2 abre link #pass=, entra na sala, URL é higienizada e ambas mostram 2 Participantes
        process.stdout.write('  [E2E] T3: Tab2 entra via #pass=, limpa URL e sincroniza "2 Participantes" ... ');
        await cdp.send('Page.navigate', { url: copiedInvite }, tab2.sessionId);

        const tab2State = await waitFor(() => cdp.evalInSession(tab2.sessionId, `
            (() => {
                const modal = document.getElementById('roomModal');
                const disp = document.getElementById('displayRoomId');
                const count = document.getElementById('memberCountText');
                const pill = document.getElementById('connectionStatusPill');
                const modalClosed = modal && (modal.hasAttribute('hidden') || modal.style.display === 'none');
                if (!modalClosed || disp?.textContent !== 'e2e-sala-f' || count?.textContent !== '2 Participantes') return null;
                return {
                    href: window.location.href,
                    status: pill?.dataset?.status,
                    sessionPass: sessionStorage.getItem('streamgrid_room_pass')
                };
            })()
        `), { label: 'Tab2 entrar na sala com #pass=' });

        assert(!tab2State.href.includes('pass='), `URL após entrada não deve manter pass=: ${tab2State.href}`);
        assert.strictEqual(tab2State.status, 'connected');
        assert(tab2State.sessionPass && tab2State.sessionPass.includes('segredo-e2e'), 'sessionStorage deve reter senha da aba');

        await waitFor(() => cdp.evalInSession(tab1.sessionId, `
            document.getElementById('memberCountText')?.textContent === '2 Participantes'
        `), { label: 'Tab1 ver 2 Participantes' });
        console.log('\x1b[32mPASSOU\x1b[0m');

        // Step 4: Tab2 F5 reload reconecta automaticamente sem pedir senha
        process.stdout.write('  [E2E] T4: F5 em Tab2 reconecta automaticamente via sessionStorage e preserva prefs ... ');
        await cdp.evalInSession(tab2.sessionId, `
            (() => {
                document.getElementById('btnQualityToggle').click();
                return document.getElementById('qualityModeLabel')?.textContent;
            })()
        `);

        await cdp.send('Page.reload', {}, tab2.sessionId);

        const afterReload = await waitFor(() => cdp.evalInSession(tab2.sessionId, `
            (() => {
                const modal = document.getElementById('roomModal');
                const disp = document.getElementById('displayRoomId');
                const count = document.getElementById('memberCountText');
                const pill = document.getElementById('connectionStatusPill');
                const qLabel = document.getElementById('qualityModeLabel');
                const modalClosed = modal && (modal.hasAttribute('hidden') || modal.style.display === 'none');
                if (!modalClosed || disp?.textContent !== 'e2e-sala-f' || count?.textContent !== '2 Participantes' || pill?.dataset?.status !== 'connected') {
                    return null;
                }
                return { quality: qLabel?.textContent?.trim() };
            })()
        `), { label: 'Tab2 reconectar após F5' });

        assert.strictEqual(afterReload.quality, 'Nítido', 'Preferência de modo Nítido deve persistir após F5');
        console.log('\x1b[32mPASSOU\x1b[0m');

        // Step 5: Modal de estatísticas exibe provedor ICE obtido via /ice-servers
        process.stdout.write('  [E2E] T5: Modal de estatísticas exibe #statsIceProvider carregado via /ice-servers ... ');
        await cdp.evalInSession(tab2.sessionId, `document.getElementById('btnToggleStats')?.click()`);
        const iceProviderText = await waitFor(() => cdp.evalInSession(tab2.sessionId, `
            (() => {
                const modal = document.getElementById('statsModal');
                const el = document.getElementById('statsIceProvider');
                const isOpen = modal && !modal.hasAttribute('hidden') && modal.style.display !== 'none';
                const val = el?.textContent?.trim();
                return isOpen && val && val !== '--' ? val : null;
            })()
        `), { label: '#statsIceProvider populado em statsModal' });
        assert.strictEqual(iceProviderText, 'Fallback (STUN/OpenRelay)');
        await cdp.evalInSession(tab2.sessionId, `document.getElementById('btnCloseStatsModal')?.click()`);
        console.log('\x1b[32mPASSOU\x1b[0m');

        // Step 6: Transmissão WebRTC real (Tab1 -> Tab2), parar e reiniciar compartilhamento
        process.stdout.write('  [E2E] T6: WebRTC P2P envia vídeo real, encerra e reinicia compartilhamento entre Tab1 e Tab2 ... ');
        await cdp.evalInSession(tab1.sessionId, `
            (() => {
                if (!navigator.mediaDevices) navigator.mediaDevices = {};
                navigator.mediaDevices.getDisplayMedia = async () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 320;
                    canvas.height = 180;
                    const ctx = canvas.getContext('2d');
                    let frame = 0;
                    const draw = () => {
                        frame++;
                        ctx.fillStyle = frame % 2 === 0 ? '#2563eb' : '#10b981';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect((frame * 8) % 280, 70, 32, 32);
                    };
                    draw();
                    const timer = setInterval(draw, 66);
                    const stream = canvas.captureStream(15);
                    stream.getTracks().forEach((t) => {
                        const origStop = t.stop.bind(t);
                        t.stop = () => { clearInterval(timer); origStop(); };
                    });
                    return stream;
                };
                return true;
            })()
        `);

        const startShareInTab1 = async () => {
            await cdp.evalInSession(tab1.sessionId, `
                (() => {
                    document.getElementById('btnStartShare')?.click();
                    const noneRadio = document.getElementById('audioSourceNone');
                    if (noneRadio) noneRadio.checked = true;
                    document.getElementById('btnConfirmStartShare')?.click();
                    return true;
                })()
            `);
        };

        // 1º compartilhamento
        await startShareInTab1();
        await waitFor(() => cdp.evalInSession(tab2.sessionId, `
            (() => {
                const v = document.querySelector('#streamGrid .stream-tile:not(#localStreamTile) video');
                return v && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
            })()
        `), { timeoutMs: 15000, label: 'Tab2 receber 1º vídeo WebRTC' });

        // Parar compartilhamento
        await cdp.evalInSession(tab1.sessionId, `document.getElementById('btnStopShare')?.click()`);
        await waitFor(() => cdp.evalInSession(tab2.sessionId, `
            document.querySelectorAll('#streamGrid .stream-tile:not(#localStreamTile)').length === 0
        `), { timeoutMs: 10000, label: 'Tab2 remover tile remoto ao parar share' });

        // 2º compartilhamento (re-share na mesma conexão P2P)
        await startShareInTab1();
        await waitFor(() => cdp.evalInSession(tab2.sessionId, `
            (() => {
                const v = document.querySelector('#streamGrid .stream-tile:not(#localStreamTile) video');
                return v && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
            })()
        `), { timeoutMs: 15000, label: 'Tab2 receber 2º vídeo WebRTC após reiniciar share' });

        await cdp.evalInSession(tab1.sessionId, `document.getElementById('btnStopShare')?.click()`);
        console.log('\x1b[32mPASSOU\x1b[0m');

        // Step 7: Zero erros de console/CSP/rede
        process.stdout.write('  [E2E] T7: Zero erros de console, exceções ou violações CSP/rede em ambas as abas ... ');
        const allErrors = [
            ...tab1.errors,
            ...tab2.errors,
            ...tab1.failedResponses,
            ...tab2.failedResponses
        ];
        assert.deepStrictEqual(allErrors, [], `Erros inesperados no navegador:\n${allErrors.join('\n')}`);
        console.log('\x1b[32mPASSOU\x1b[0m');

        console.log('\n===============================================================');
        console.log('  ✅ Todos os 7 testes E2E em navegador real passaram!');
        console.log('===============================================================\n');
    } catch (err) {
        for (const t of tabs) {
            if (t.errors.length || t.failedResponses.length) {
                console.error(`\n[Diag ${t.label}] errors:`, t.errors, 'failedResponses:', t.failedResponses);
            }
            try {
                if (cdp) {
                    const snap = await cdp.evalInSession(t.sessionId, `({ href: location.href, readyState: document.readyState, status: document.getElementById('connectionStatusPill')?.dataset?.status, text: document.getElementById('connectionStatusText')?.textContent })`);
                    console.error(`[Diag ${t.label}] DOM:`, snap);
                }
            } catch (_) {}
        }
        throw err;
    } finally {
        for (const t of tabs) {
            if (t.disposeEvents) t.disposeEvents();
            try { if (cdp) await cdp.send('Target.disposeBrowserContext', { browserContextId: t.browserContextId }); } catch (_) {}
        }
        if (cdp) cdp.close();
        if (browserProc && !browserProc.killed) {
            try { browserProc.kill('SIGKILL'); } catch (_) {}
        }
        rooms.clear();
        await new Promise((resolve) => server.close(resolve));
        await delay(150);
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
}

runTests().catch((err) => {
    console.error('\n❌ FALHA NA SUÍTE E2E:', err);
    process.exit(1);
});
