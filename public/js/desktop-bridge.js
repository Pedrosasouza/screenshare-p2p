// ==========================================
// StreamGrid Desktop Bridge (Tauri v2 IPC)
// Abstrai comandos nativos WASAPI mantendo modo Web puro intacto.
// ==========================================
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.StreamGridDesktop = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function (win) {
    function getTauriCore() {
        if (!win) return null;
        if (win.__TAURI__ && win.__TAURI__.core && typeof win.__TAURI__.core.invoke === 'function') {
            return win.__TAURI__.core;
        }
        return null;
    }

    function getTauriEvent() {
        if (!win) return null;
        if (win.__TAURI__ && win.__TAURI__.event && typeof win.__TAURI__.event.listen === 'function') {
            return win.__TAURI__.event;
        }
        return null;
    }

    function isDesktop() {
        if (!win) return false;
        return Boolean(win.__TAURI_INTERNALS__ || win.__TAURI__);
    }

    function toArrayBuffer(payload) {
        if (!payload) return null;
        if (
            payload instanceof ArrayBuffer ||
            Object.prototype.toString.call(payload) === '[object ArrayBuffer]'
        ) {
            return payload;
        }
        if (ArrayBuffer.isView(payload)) {
            if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
                return payload.buffer;
            }
            return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        }
        if (Array.isArray(payload)) {
            return new Uint8Array(payload).buffer;
        }
        return null;
    }

    function createAudioChannel(onPcmBuffer) {
        const core = getTauriCore();
        if (!core || typeof core.Channel !== 'function') {
            throw new Error('Runtime Tauri Channel indisponível.');
        }
        const channel = new core.Channel();
        channel.onmessage = (message) => {
            if (typeof onPcmBuffer !== 'function') return;
            const buffer = toArrayBuffer(message);
            if (buffer && buffer.byteLength > 0) {
                onPcmBuffer(buffer);
            }
        };
        return channel;
    }

    async function invokeCommand(command, args) {
        const core = getTauriCore();
        if (!core) {
            throw new Error('Bridge Tauri v2 indisponível fora do aplicativo Desktop.');
        }
        return core.invoke(command, args || {});
    }

    async function getDiscordStatus() {
        if (!isDesktop()) {
            return { detected: false, pid: 0, name: 'Discord Desktop' };
        }
        return invokeCommand('get_discord_status');
    }

    async function listWindows() {
        if (!isDesktop()) {
            return [];
        }
        return invokeCommand('list_windows');
    }

    async function startAppAudioCapture(pid, onPcmBuffer) {
        const numericPid = Number(pid);
        if (!Number.isInteger(numericPid) || numericPid <= 0) {
            throw new Error('PID inválido para captura de áudio.');
        }
        const onAudio = createAudioChannel(onPcmBuffer);
        return invokeCommand('start_capture', {
            pid: numericPid,
            exclude: false,
            onAudio,
        });
    }

    async function startExcludeDiscordCapture(onPcmBuffer) {
        const onAudio = createAudioChannel(onPcmBuffer);
        return invokeCommand('start_exclude_discord', { onAudio });
    }

    async function stopAppAudioCapture() {
        if (!isDesktop()) return;
        return invokeCommand('stop_capture');
    }

    async function onCaptureStopped(callback) {
        if (!isDesktop() || typeof callback !== 'function') {
            return () => {};
        }
        const eventApi = getTauriEvent();
        if (!eventApi) {
            return () => {};
        }
        return eventApi.listen('wasapi-capture-stopped', (event) => {
            const payload = event && typeof event === 'object' && 'payload' in event
                ? event.payload
                : event;
            callback(payload);
        });
    }

    return {
        isDesktop,
        toArrayBuffer,
        getDiscordStatus,
        listWindows,
        startAppAudioCapture,
        startExcludeDiscordCapture,
        stopAppAudioCapture,
        onCaptureStopped,
    };
});
