import { isDesktopApp } from './desktop-audio.js';
import { sanitizeRoomId } from './room-utils.js';



export const SERVER_URL_STORAGE_KEY = 'streamgrid_server_url';

export const COLD_START_NOTICE_DELAY_MS = 3000;

export const SESSION_PASS_STORAGE_KEY = 'streamgrid_room_pass';



export function resolveSignalingServerUrl() {
    const isLoopbackHost = (hostname) => (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === '::1'
    );

    const desktopMode = isDesktopApp();
    const hasWindow = typeof window !== 'undefined' && window.location;
    const pageProtocol = hasWindow ? (window.location.protocol || '') : '';
    const pageOrigin = hasWindow ? (window.location.origin || '') : '';

    const parseSafeServerUrl = (raw) => {
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;

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
    };

    try {
        const params = new URLSearchParams(window.location.search);
        const paramServer = params.get('server');
        if (paramServer) {
            const validParam = parseSafeServerUrl(paramServer);
            if (validParam) {
                return validParam;
            }
        }

        const savedServer = localStorage.getItem(SERVER_URL_STORAGE_KEY);
        if (savedServer) {
            const validSaved = parseSafeServerUrl(savedServer);
            if (validSaved) {
                return validSaved;
            }
            try { localStorage.removeItem(SERVER_URL_STORAGE_KEY); } catch (_) {}
        }
    } catch (_) {}

    return (window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1')
        ? window.location.origin
        : 'https://screenshare-p2p.onrender.com';
}

export function saveSessionRoomPassword(targetRoomId, password) {
    if (typeof sessionStorage === 'undefined') return;
    try {
        const cleanRoom = typeof sanitizeRoomId === 'function'
            ? sanitizeRoomId(targetRoomId)
            : String(targetRoomId || '').trim().toLowerCase();
        const cleanPass = typeof password === 'string' ? password.trim() : '';
        if (!cleanRoom || !cleanPass) {
            sessionStorage.removeItem(SESSION_PASS_STORAGE_KEY);
            return;
        }
        sessionStorage.setItem(SESSION_PASS_STORAGE_KEY, JSON.stringify({
            roomId: cleanRoom,
            password: cleanPass
        }));
    } catch (_) {}
}

export function getSessionRoomPassword(targetRoomId) {
    if (typeof sessionStorage === 'undefined') return '';
    try {
        const raw = sessionStorage.getItem(SESSION_PASS_STORAGE_KEY);
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

export function clearSessionRoomPassword() {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.removeItem(SESSION_PASS_STORAGE_KEY);
    } catch (_) {}
}

export function buildInviteUrl({
    roomId,
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
