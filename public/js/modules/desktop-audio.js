// ==========================================
// Rust Audio Helper (WASAPI Application Loopback via Tauri v2 IPC)
// ==========================================
let availableWindows = [];
let helperAudioContext = null;
let activeAudioWorkletNode = null;
let helperAudioDestination = null;
let desktopCaptureGeneration = 0;
let captureStoppedUnlisten = null;
let captureReboundUnlisten = null;
let helperSuspendPromise = null;
let latestStartGeneration = 0;
let latestStopGeneration = 0;
let activeCaptureSessionMeta = null;
const audioWorkletLoadedContexts = new WeakSet();
let runtimeWindowObj = null;
let runtimeDocumentObj = null;

export function configureDesktopAudioRuntime({ windowObj = null, documentObj = null } = {}) {
    runtimeWindowObj = windowObj;
    runtimeDocumentObj = documentObj;
}

function getRuntimeWindow(overrideWin) {
    return overrideWin || runtimeWindowObj || (typeof window !== 'undefined' ? window : null);
}

function getRuntimeDocument(overrideDoc) {
    return overrideDoc || runtimeDocumentObj || (typeof document !== 'undefined' ? document : null);
}

export function isDesktopApp(windowObj) {
    const win = getRuntimeWindow(windowObj);
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
        } catch (_) {}
    }

    if (expectedGeneration !== desktopCaptureGeneration) {
        return;
    }

    const win = getRuntimeWindow();
    if (!helperAudioContext || helperAudioContext.state === 'closed') {
        const AudioCtx = win && (win.AudioContext || win.webkitAudioContext);
        helperAudioContext = new AudioCtx({ sampleRate: 48000 });
    } else if (helperAudioContext.state === 'suspended') {
        await helperAudioContext.resume();
    }

    if (expectedGeneration !== desktopCaptureGeneration) {
        return;
    }

    if (!audioWorkletLoadedContexts.has(helperAudioContext)) {
        await helperAudioContext.audioWorklet.addModule('js/audio-worklet-processor.js');
        if (helperAudioContext.state !== 'closed') {
            audioWorkletLoadedContexts.add(helperAudioContext);
        }
        if (expectedGeneration !== desktopCaptureGeneration) {
            return;
        }
    }

    if (activeAudioWorkletNode) {
        try {
            activeAudioWorkletNode.port.postMessage({ type: 'stop' });
            activeAudioWorkletNode.disconnect();
        } catch (_) {}
    }

    const AudioWorkletCtor = (win && win.AudioWorkletNode) || (typeof AudioWorkletNode !== 'undefined' ? AudioWorkletNode : null);
    const node = new AudioWorkletCtor(helperAudioContext, 'pcm-ring-buffer-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
    });
    activeAudioWorkletNode = node;
    helperAudioDestination = helperAudioContext.createMediaStreamDestination();
    activeAudioWorkletNode.connect(helperAudioDestination);
}

export async function checkDiscordStatus(windowObj, documentObj) {
    const win = getRuntimeWindow(windowObj);
    const doc = getRuntimeDocument(documentObj);
    if (!isDesktopApp(win) || !win || !win.StreamGridDesktop) return;
    try {
        const msg = await win.StreamGridDesktop.getDiscordStatus();
        const badge = doc && typeof doc.getElementById === 'function'
            ? doc.getElementById('discordStatusBadge')
            : null;
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

export async function fetchWindowList(windowObj, documentObj) {
    const win = getRuntimeWindow(windowObj);
    const doc = getRuntimeDocument(documentObj);
    if (!isDesktopApp(win) || !win || !win.StreamGridDesktop) return;
    try {
        const windows = await win.StreamGridDesktop.listWindows();
        availableWindows = Array.isArray(windows) ? windows : [];
        updateAudioAppSelect(availableWindows, doc);
    } catch (err) {
        console.warn('[AudioHelper] Erro ao listar janelas compatíveis:', err);
        availableWindows = [];
        const select = doc && typeof doc.getElementById === 'function'
            ? doc.getElementById('selectAudioApp')
            : null;
        if (select) {
            select.innerHTML = '';
            const opt = doc.createElement('option');
            opt.value = '';
            opt.textContent = 'Erro ao carregar janelas de áudio';
            select.appendChild(opt);
        }
    }
}

export function updateAudioAppSelect(windows, documentObj) {
    const doc = getRuntimeDocument(documentObj);
    const select = doc && typeof doc.getElementById === 'function'
        ? doc.getElementById('selectAudioApp')
        : null;
    if (!select || !doc) return;

    const prevValue = String(select.value || '');
    select.innerHTML = '';
    if (!windows || windows.length === 0) {
        const opt = doc.createElement('option');
        opt.value = '';
        opt.textContent = 'Nenhuma janela compatível encontrada';
        select.appendChild(opt);
        return;
    }

    let preserved = false;
    windows.forEach(w => {
        const opt = doc.createElement('option');
        opt.value = w.pid;
        const exeInfo = w.exe ? ` [${w.exe}]` : '';
        const titleTrimmed = w.title.length > 40 ? w.title.substring(0, 37) + '...' : w.title;
        opt.textContent = `${titleTrimmed}${exeInfo}`;
        select.appendChild(opt);
        if (prevValue && String(w.pid) === prevValue) {
            preserved = true;
        }
    });
    if (preserved) {
        select.value = prevValue;
    }
}

export async function startDesktopCaptureWith(startFn, windowObj) {
    const win = getRuntimeWindow(windowObj);
    if (!isDesktopApp(win) || !win || !win.StreamGridDesktop) {
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
                if (isDesktopApp(win) && win.StreamGridDesktop) {
                    win.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
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
            const modeDesc = info.mode === 'exclude' ? 'Exclusão de Aplicativo' : 'Aplicativo Isolado';
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
            stopAppAudioCapture(win);
        }
        const message = (err && err.message) ? err.message : String(err);
        throw new Error(message, { cause: err });
    }
}

export async function startAppAudioCapture(pid, windowObj, options = {}) {
    const win = getRuntimeWindow(windowObj);
    const exclude = Boolean(options && options.exclude);
    return startDesktopCaptureWith((onPcm) => (
        exclude
            ? win.StreamGridDesktop.startAppAudioCapture(pid, onPcm, { exclude: true })
            : win.StreamGridDesktop.startAppAudioCapture(pid, onPcm)
    ), win);
}

export async function startExcludeAppCapture(pid, windowObj) {
    return startAppAudioCapture(pid, windowObj, { exclude: true });
}

export async function startExcludeDiscordCapture(windowObj) {
    const win = getRuntimeWindow(windowObj);
    return startDesktopCaptureWith((onPcm) => win.StreamGridDesktop.startExcludeDiscordCapture(onPcm), win);
}

export function stopAppAudioCapture(windowObj) {
    const win = getRuntimeWindow(windowObj);
    desktopCaptureGeneration += 1;
    latestStopGeneration = desktopCaptureGeneration;
    if (typeof activeCaptureSessionMeta !== 'undefined') {
        activeCaptureSessionMeta = null;
    }
    if (isDesktopApp(win) && win && win.StreamGridDesktop) {
        win.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
    }
    if (activeAudioWorkletNode) {
        try {
            activeAudioWorkletNode.port.postMessage({ type: 'flush' });
            activeAudioWorkletNode.port.postMessage({ type: 'stop' });
            activeAudioWorkletNode.disconnect();
        } catch (_) {}
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

/**
 * @param {(payload: any) => void} [onUnexpectedStop]
 * @param {any} [windowObj]
 * @param {(payload: any) => void} [onCaptureReboundCb]
 */
export async function registerDesktopCaptureListeners(onUnexpectedStop, windowObj, onCaptureReboundCb) {
    const win = getRuntimeWindow(windowObj);
    if (!isDesktopApp(win) || !win || !win.StreamGridDesktop || typeof win.StreamGridDesktop.onCaptureStopped !== 'function') {
        return () => {};
    }
    if (typeof captureStoppedUnlisten === 'function') {
        try { captureStoppedUnlisten(); } catch (_) {}
        captureStoppedUnlisten = null;
    }
    if (typeof captureReboundUnlisten === 'function') {
        try { captureReboundUnlisten(); } catch (_) {}
        captureReboundUnlisten = null;
    }

    const unlistenStop = await win.StreamGridDesktop.onCaptureStopped((payload) => {
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
        stopAppAudioCapture(win);
        if (typeof onUnexpectedStop === 'function') {
            onUnexpectedStop(payload);
        }
    });
    captureStoppedUnlisten = typeof unlistenStop === 'function' ? unlistenStop : null;

    if (typeof win.StreamGridDesktop.onCaptureRebound === 'function') {
        const unlistenRebound = await win.StreamGridDesktop.onCaptureRebound((payload) => {
            if (typeof activeCaptureSessionMeta !== 'undefined' && activeCaptureSessionMeta) {
                if (
                    payload &&
                    typeof payload.generation === 'number' &&
                    activeCaptureSessionMeta.generation !== null &&
                    payload.generation !== activeCaptureSessionMeta.generation
                ) {
                    return;
                }
                if (payload && typeof payload.pid === 'number') {
                    activeCaptureSessionMeta.pid = payload.pid;
                }
            }
            if (typeof onCaptureReboundCb === 'function') {
                onCaptureReboundCb(payload);
            }
        });
        captureReboundUnlisten = typeof unlistenRebound === 'function' ? unlistenRebound : null;
    }

    return () => {
        if (typeof captureStoppedUnlisten === 'function') {
            try { captureStoppedUnlisten(); } catch (_) {}
            captureStoppedUnlisten = null;
        }
        if (typeof captureReboundUnlisten === 'function') {
            try { captureReboundUnlisten(); } catch (_) {}
            captureReboundUnlisten = null;
        }
    };
}
