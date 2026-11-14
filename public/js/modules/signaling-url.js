import { isDesktopApp } from './desktop-audio.js';
import { sanitizeRoomId } from './room-utils.js';



export const SERVER_URL_STORAGE_KEY = 'streamgrid_server_url';

export const COLD_START_NOTICE_DELAY_MS = 3000;

export const SESSION_PASS_STORAGE_KEY = 'streamgrid_room_pass';



function isLoopbackHost(hostname) {
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === '::1'
    );
}

export function parseSafeServerUrl(raw, options = {}) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const win = options && options.windowObj !== undefined
        ? options.windowObj
        : (typeof window !== 'undefined' ? window : null);
    const desktopMode = options && options.isDesktop !== undefined
        ? Boolean(options.isDesktop)
        : isDesktopApp(win);
    const hasWindow = Boolean(win && win.location);
    const pageProtocol = hasWindow ? (win.location.protocol || '') : '';
    const pageOrigin = hasWindow ? (win.location.origin || '') : '';

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_) {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }
    if (parsed.username || parsed.password) {
        return null;
    }

    const isLoopback = isLoopbackHost(parsed.hostname);
    const isSameOrigin = Boolean(pageOrigin && pageOrigin !== 'null' && parsed.origin === pageOrigin);

    if (parsed.protocol === 'http:') {
        const sameHttpOrigin = pageProtocol === 'http:' && isSameOrigin;
        if (!isLoopback && !sameHttpOrigin) {
            return null;
        }
    }

    if (!desktopMode && !isSameOrigin && !isLoopback) {
        return null;
    }

    return parsed.origin.replace(/\/+$/, '');
}

export function saveCustomSignalingServerUrl(rawUrl, options = {}) {
    const validUrl = parseSafeServerUrl(rawUrl, options);
    if (!validUrl) {
        return {
            ok: false,
            error: 'URL do servidor inválida ou insegura. Use https://... ou http://localhost:porta (sem credenciais).'
        };
    }

    const store = options && options.storage !== undefined
        ? options.storage
        : (typeof localStorage !== 'undefined' ? localStorage : null);

    try {
        if (store && typeof store.setItem === 'function') {
            store.setItem(SERVER_URL_STORAGE_KEY, validUrl);
        }
        return { ok: true, url: validUrl };
    } catch (_) {
        return {
            ok: false,
            error: 'Não foi possível salvar a URL do servidor no armazenamento local.'
        };
    }
}

export function resolveSignalingServerUrl(options = {}) {
    const win = options && options.windowObj !== undefined
        ? options.windowObj
        : (typeof window !== 'undefined' ? window : null);
    const store = options && options.storage !== undefined
        ? options.storage
        : (typeof localStorage !== 'undefined' ? localStorage : null);
    const desktopMode = options && options.isDesktop !== undefined
        ? Boolean(options.isDesktop)
        : isDesktopApp(win);
    const hasWindow = Boolean(win && win.location);
    const pageProtocol = hasWindow ? (win.location.protocol || '') : '';
    const pageOrigin = hasWindow ? (win.location.origin || '') : '';
    const pageHostname = hasWindow ? (win.location.hostname || '') : '';
    const pageSearch = hasWindow ? (win.location.search || '') : '';
    const parseOpts = { windowObj: win, isDesktop: desktopMode };

    try {
        const params = new URLSearchParams(pageSearch);
        const paramServer = params.get('server');
        if (paramServer) {
            const validParam = parseSafeServerUrl(paramServer, parseOpts);
            if (validParam) {
                return validParam;
            }
        }

        if (store && typeof store.getItem === 'function') {
            const savedServer = store.getItem(SERVER_URL_STORAGE_KEY);
            if (savedServer) {
                const validSaved = parseSafeServerUrl(savedServer, parseOpts);
                if (validSaved) {
                    return validSaved;
                }
                try { store.removeItem(SERVER_URL_STORAGE_KEY); } catch (_) {}
            }
        }
    } catch (_) {}

    return (pageProtocol.startsWith('http') && !pageHostname.includes('localhost') && pageHostname !== '127.0.0.1')
        ? pageOrigin
        : 'https://screenshare-p2p.onrender.com';
}

export function saveSessionRoomPassword(
    targetRoomId,
    password,
    sessionStore = (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
) {
    if (!sessionStore) return;
    try {
        const cleanRoom = typeof sanitizeRoomId === 'function'
            ? sanitizeRoomId(targetRoomId)
            : String(targetRoomId || '').trim().toLowerCase();
        const cleanPass = typeof password === 'string' ? password.trim() : '';
        if (!cleanRoom || !cleanPass) {
            sessionStore.removeItem(SESSION_PASS_STORAGE_KEY);
            return;
        }
        sessionStore.setItem(SESSION_PASS_STORAGE_KEY, JSON.stringify({
            roomId: cleanRoom,
            password: cleanPass
        }));
    } catch (_) {}
}

export function getSessionRoomPassword(
    targetRoomId,
    sessionStore = (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
) {
    if (!sessionStore) return '';
    try {
        const raw = sessionStore.getItem(SESSION_PASS_STORAGE_KEY);
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return '';
        const cleanRoom = typeof sanitizeRoomId === 'function'
            ? sanitizeRoomId(targetRoomId)
            : String(targetRoomId || '').trim().toLowerCase();
        if (cleanRoom && parsed.roomId === cleanRoom && typeof parsed.password === 'string') {
            return parsed.password;
        }
    } catch (_) {}
    return '';
}

export function clearSessionRoomPassword(
    sessionStore = (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
) {
    if (!sessionStore) return;
    try {
        sessionStore.removeItem(SESSION_PASS_STORAGE_KEY);
    } catch (_) {}
}

/**
 * @param {{
 *   roomId?: string,
 *   password?: string,
 *   isDesktop?: boolean,
 *   serverUrl?: string,
 *   origin?: string,
 *   pathname?: string
 * }} [options]
 */
export function buildInviteUrl({
    roomId = '',
    password = '',
    isDesktop = isDesktopApp(),
    serverUrl = '',
    origin = (typeof window !== 'undefined' && window.location ? window.location.origin : ''),
    pathname = (typeof window !== 'undefined' && window.location ? window.location.pathname : '/')
} = {}) {
    const normalizedOrigin = typeof origin === 'string' ? origin : '';
    const isTauriOrigin = normalizedOrigin.startsWith('tauri://')
        || normalizedOrigin.startsWith('http://tauri.localhost')
        || normalizedOrigin.startsWith('https://tauri.localhost');

    let baseUrl;
    if ((isDesktop || isTauriOrigin) && serverUrl) {
        baseUrl = `${String(serverUrl).replace(/\/+$/, '')}/`;
    } else {
        baseUrl = `${normalizedOrigin}${pathname || '/'}`;
    }

    let inviteUrl = `${baseUrl}?room=${encodeURIComponent(roomId)}`;
    if (password) {
        inviteUrl += `#pass=${encodeURIComponent(password)}`;
    }
    return inviteUrl;
}
