// ==========================================
// Rust Audio Helper (WASAPI Application Loopback via Tauri v2 IPC)
// ==========================================
let availableWindows = [];
let helperAudioContext = null;
let activeAudioWorkletNode = null;
let helperAudioDestination = null;
let desktopCaptureGeneration = 0;
let captureStoppedUnlisten = null;
let helperSuspendPromise = null;
let latestStartGeneration = 0;
let latestStopGeneration = 0;
let activeCaptureSessionMeta = null;
const audioWorkletLoadedContexts = new WeakSet();

export function isDesktopApp(windowObj) {
    const win = windowObj || (typeof window !== 'undefined' ? window : null);
    if (!win) return false;
    if (win.StreamGridDesktop && typeof win.StreamGridDesktop.isDesktop === 'function') {
        return win.StreamGridDesktop.isDesktop();
    }
    return Boolean(win.__TAURI_INTERNALS__ || win.__TAURI__);
}

export function forwardPcmBufferToWorklet(arrayBuffer) {
    if (!activeAudioWorkletNode || !(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) {
        return;
    }
    const usableBytes = arrayBuffer.byteLength - (arrayBuffer.byteLength % 8);
    if (usableBytes <= 0) {
        return;
    }
    const alignedBuffer = usableBytes === arrayBuffer.byteLength
        ? arrayBuffer
        : arrayBuffer.slice(0, usableBytes);
    const float32Data = new Float32Array(alignedBuffer);
    try {
        activeAudioWorkletNode.port.postMessage(float32Data, [float32Data.buffer]);
    } catch (_) {}
}

export async function prepareHelperAudioWorklet(expectedGeneration = desktopCaptureGeneration) {
    if (helperSuspendPromise) {
        try {
            await helperSuspendPromise;
        } catch (e) {}
    }

    if (expectedGeneration !== desktopCaptureGeneration) {
        return;
    }

    if (!helperAudioContext || helperAudioContext.state === 'closed') {
        helperAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    } else if (helperAudioContext.state === 'suspended') {
        await helperAudioContext.resume();
    }

    if (expectedGeneration !== desktopCaptureGeneration) {
        return;
    }

    if (!audioWorkletLoadedContexts.has(helperAudioContext)) {
        await helperAudioContext.audioWorklet.addModule('js/audio-worklet-processor.js');
        if (expectedGeneration !== desktopCaptureGeneration) {
            return;
        }
    }

    if (activeAudioWorkletNode) {
        try { activeAudioWorkletNode.disconnect(); } catch (e) {}
    }

    const node = new AudioWorkletNode(helperAudioContext, 'pcm-ring-buffer-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
    });
    if (helperAudioContext.state !== 'closed') {
        audioWorkletLoadedContexts.add(helperAudioContext);
    }
    activeAudioWorkletNode = node;
    helperAudioDestination = helperAudioContext.createMediaStreamDestination();
    activeAudioWorkletNode.connect(helperAudioDestination);
}

export async function checkDiscordStatus() {
    if (!isDesktopApp() || !window.StreamGridDesktop) return;
    try {
        const msg = await window.StreamGridDesktop.getDiscordStatus();
        const badge = document.getElementById('discordStatusBadge');
        if (badge && msg) {
            if (msg.detected) {
                badge.style.color = '#3ba55d';
                badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Discord detectado (PID ${Number(msg.pid) || 0}) — Chamadas serão excluídas do stream`;
            } else {
                badge.style.color = '#faa81a';
                badge.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Discord Desktop não detectado (inicie-o para isolar a chamada)`;
            }
        }
    } catch (err) {
        console.warn('[AudioHelper] Erro ao consultar status do Discord:', err);
    }
}

export async function fetchWindowList() {
    if (!isDesktopApp() || !window.StreamGridDesktop) return;
    try {
        const windows = await window.StreamGridDesktop.listWindows();
        availableWindows = Array.isArray(windows) ? windows : [];
        updateAudioAppSelect(availableWindows);
    } catch (err) {
        console.warn('[AudioHelper] Erro ao listar janelas compatíveis:', err);
        availableWindows = [];
        const select = document.getElementById('selectAudioApp');
        if (select) {
            select.innerHTML = '';
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Erro ao carregar janelas de áudio';
            select.appendChild(opt);
        }
    }
}

export function updateAudioAppSelect(windows) {
    const select = document.getElementById('selectAudioApp');
    if (!select) return;

    select.innerHTML = '';
    if (!windows || windows.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Nenhuma janela compatível encontrada';
        select.appendChild(opt);
        return;
    }

    windows.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.pid;
        const exeInfo = w.exe ? ` [${w.exe}]` : '';
        const titleTrimmed = w.title.length > 40 ? w.title.substring(0, 37) + '...' : w.title;
        opt.textContent = `${titleTrimmed}${exeInfo}`;
        select.appendChild(opt);
    });
}

export async function startDesktopCaptureWith(startFn) {
    if (!isDesktopApp() || !window.StreamGridDesktop) {
        throw new Error('Captura WASAPI por processo está disponível apenas no aplicativo Desktop.');
    }

    const captureGen = ++desktopCaptureGeneration;
    latestStartGeneration = captureGen;

    try {
        await prepareHelperAudioWorklet(captureGen);
        if (captureGen !== desktopCaptureGeneration) {
            throw new Error('Captura de áudio cancelada antes do início.');
        }

        const info = await startFn((buffer) => {
            if (captureGen === desktopCaptureGeneration) {
                forwardPcmBufferToWorklet(buffer);
            }
        });

        if (captureGen !== desktopCaptureGeneration) {
            if (latestStopGeneration > captureGen && latestStartGeneration <= captureGen) {
                if (isDesktopApp() && window.StreamGridDesktop) {
                    window.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
                }
            }
            throw new Error('Captura de áudio cancelada durante a inicialização.');
        }

        if (typeof activeCaptureSessionMeta !== 'undefined') {
            activeCaptureSessionMeta = {
                pid: info && typeof info.pid === 'number' ? info.pid : null,
                generation: info && typeof info.generation === 'number' ? info.generation : null
            };
        }

        if (info) {
            const modeDesc = info.mode === 'exclude' ? 'Exclusão do Discord' : 'Aplicativo Isolado';
            console.log(`[AudioHelper] ✅ Captura iniciada no modo [${modeDesc}] para PID ${info.pid} (${info.sample_rate}Hz, ${info.channels} canais)`);
        }

        const track = helperAudioDestination && helperAudioDestination.stream
            ? helperAudioDestination.stream.getAudioTracks()[0]
            : null;
        if (!track) {
            throw new Error('Nenhuma trilha de áudio disponível no destino AudioWorklet.');
        }
        track._isDesktopWasapiTrack = true;
        return track;
    } catch (err) {
        if (captureGen === desktopCaptureGeneration) {
            stopAppAudioCapture();
        }
        const message = (err && err.message) ? err.message : String(err);
        throw new Error(message);
    }
}

export async function startAppAudioCapture(pid) {
    return startDesktopCaptureWith((onPcm) => window.StreamGridDesktop.startAppAudioCapture(pid, onPcm));
}

export async function startExcludeDiscordCapture() {
    return startDesktopCaptureWith((onPcm) => window.StreamGridDesktop.startExcludeDiscordCapture(onPcm));
}

export function stopAppAudioCapture() {
    desktopCaptureGeneration += 1;
    latestStopGeneration = desktopCaptureGeneration;
    if (typeof activeCaptureSessionMeta !== 'undefined') {
        activeCaptureSessionMeta = null;
    }
    if (isDesktopApp() && window.StreamGridDesktop) {
        window.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
    }
    if (activeAudioWorkletNode) {
        try {
            activeAudioWorkletNode.port.postMessage({ type: 'flush' });
            activeAudioWorkletNode.disconnect();
        } catch (e) {}
        activeAudioWorkletNode = null;
    }
    if (helperAudioContext && helperAudioContext.state !== 'closed') {
        const suspendOp = Promise.resolve(helperAudioContext.suspend()).catch(() => {});
        helperSuspendPromise = suspendOp.finally(() => {
            if (helperSuspendPromise === suspendOp) {
                helperSuspendPromise = null;
            }
        });
    }
}

export async function registerDesktopCaptureListeners(onUnexpectedStop) {
    if (!isDesktopApp() || !window.StreamGridDesktop || typeof window.StreamGridDesktop.onCaptureStopped !== 'function') {
        return () => {};
    }
    if (typeof captureStoppedUnlisten === 'function') {
        try { captureStoppedUnlisten(); } catch (_) {}
        captureStoppedUnlisten = null;
    }
    const unlisten = await window.StreamGridDesktop.onCaptureStopped((payload) => {
        if (typeof activeCaptureSessionMeta !== 'undefined' && activeCaptureSessionMeta) {
            if (
                payload &&
                typeof payload.generation === 'number' &&
                activeCaptureSessionMeta.generation !== null &&
                payload.generation !== activeCaptureSessionMeta.generation
            ) {
                return;
            }
            if (
                payload &&
                typeof payload.pid === 'number' &&
                activeCaptureSessionMeta.pid !== null &&
                payload.pid !== activeCaptureSessionMeta.pid
            ) {
                return;
            }
        }
        stopAppAudioCapture();
        if (typeof onUnexpectedStop === 'function') {
            onUnexpectedStop(payload);
        }
    });
    captureStoppedUnlisten = typeof unlisten === 'function' ? unlisten : null;
    return captureStoppedUnlisten || (() => {});
}
