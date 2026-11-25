export const STORAGE_KEY = 'streamgrid_last_room';
export const RECENT_ROOMS_KEY = 'streamgrid_recent_rooms';
export const MAX_RECENT_ROOMS = 5;
export const CLIENT_ID_KEY = 'streamgrid_client_id';
export const USERNAME_KEY = 'streamgrid_username';
export const VIDEO_RES_KEY = 'streamgrid_video_resolution';
export const VIDEO_FPS_KEY = 'streamgrid_video_fps';
export const AUDIO_SOURCE_KEY = 'streamgrid_audio_source';
export const CONTENT_HINT_KEY = 'streamgrid_content_hint';
export const EXCLUDE_SELECTED_APP_KEY = 'streamgrid_exclude_selected_app';

function resolveStorage(explicitStorage) {
    if (explicitStorage !== undefined) return explicitStorage;
    return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function getOrCreateClientId(explicitStorage) {
    const storage = resolveStorage(explicitStorage);
    let clientId;
    try {
        clientId = storage ? (storage.getItem(CLIENT_ID_KEY) || '') : '';
        if (!clientId) {
            clientId = 'c_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
            if (storage) storage.setItem(CLIENT_ID_KEY, clientId);
        }
    } catch (_) {
        clientId = 'c_' + Math.random().toString(36).substr(2, 9);
    }
    return clientId;
}

export function loadSavedUserName(explicitStorage) {
    const storage = resolveStorage(explicitStorage);
    try {
        return storage ? (storage.getItem(USERNAME_KEY) || '').trim().slice(0, 24) : '';
    } catch (_) {
        return '';
    }
}

export function saveUserName(userName, explicitStorage) {
    const clean = typeof userName === 'string' ? userName.trim().slice(0, 24) : '';
    const storage = resolveStorage(explicitStorage);
    if (storage) {
        try {
            storage.setItem(USERNAME_KEY, clean);
        } catch (_) {}
    }
    return clean;
}

export function saveClientPreference(key, value, explicitStorage) {
    const storage = resolveStorage(explicitStorage);
    if (!storage) return;
    try {
        storage.setItem(key, String(value));
    } catch (_) {}
}

function normalizeRecentRoomId(roomId) {
    if (typeof roomId !== 'string') return '';
    return roomId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

export function loadRecentRooms(explicitStorage) {
    const storage = resolveStorage(explicitStorage);
    if (!storage) return [];
    try {
        const raw = storage.getItem(RECENT_ROOMS_KEY);
        if (!raw) {
            const legacyLast = normalizeRecentRoomId(storage.getItem(STORAGE_KEY));
            return legacyLast.length >= 3 ? [legacyLast] : [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const seen = new Set();
        const result = [];
        for (const item of parsed) {
            const clean = normalizeRecentRoomId(item);
            if (clean.length >= 3 && !seen.has(clean)) {
                seen.add(clean);
                result.push(clean);
                if (result.length >= MAX_RECENT_ROOMS) break;
            }
        }
        return result;
    } catch (_) {
        return [];
    }
}

export function saveRecentRoom(roomId, explicitStorage) {
    const clean = normalizeRecentRoomId(roomId);
    if (clean.length < 3) return loadRecentRooms(explicitStorage);
    const storage = resolveStorage(explicitStorage);
    const existing = loadRecentRooms(storage).filter((id) => id !== clean);
    const updated = [clean, ...existing].slice(0, MAX_RECENT_ROOMS);
    if (storage) {
        try {
            storage.setItem(RECENT_ROOMS_KEY, JSON.stringify(updated));
        } catch (_) {}
    }
    return updated;
}

export function removeRecentRoom(roomId, explicitStorage) {
    const clean = normalizeRecentRoomId(roomId);
    const storage = resolveStorage(explicitStorage);
    const updated = loadRecentRooms(storage).filter((id) => id !== clean);
    if (storage) {
        try {
            storage.setItem(RECENT_ROOMS_KEY, JSON.stringify(updated));
        } catch (_) {}
    }
    return updated;
}

export function clearRecentRooms(explicitStorage) {
    const storage = resolveStorage(explicitStorage);
    if (storage) {
        try {
            storage.setItem(RECENT_ROOMS_KEY, '[]');
        } catch (_) {}
    }
    return [];
}

/**
 * @param {{
 *   state?: import('./types.js').AppState,
 *   storage?: Storage | null,
 *   onApplied?: (() => void) | null
 * }} [options]
 */
export function loadSavedClientPreferences({ state, storage: explicitStorage, onApplied } = {}) {
    const storage = resolveStorage(explicitStorage);
    if (storage && state) {
        try {
            const savedRes = storage.getItem(VIDEO_RES_KEY);
            if (savedRes === '720p' || savedRes === '1080p') {
                state.selectedVideoResolution = savedRes;
            }
            const savedFps = Number(storage.getItem(VIDEO_FPS_KEY));
            if (savedFps === 30 || savedFps === 60) {
                state.selectedVideoFps = savedFps;
            }
            const savedAudio = storage.getItem(AUDIO_SOURCE_KEY);
            if (savedAudio === 'exclude_discord' || savedAudio === 'app' || savedAudio === 'system' || savedAudio === 'none') {
                state.selectedAudioSource = savedAudio;
            }
            const savedHint = storage.getItem(CONTENT_HINT_KEY);
            if (savedHint === 'motion' || savedHint === 'detail') {
                state.contentHintMode = savedHint;
            }
            const savedExcludeApp = storage.getItem(EXCLUDE_SELECTED_APP_KEY);
            if (savedExcludeApp === 'true' || savedExcludeApp === 'false') {
                state.excludeSelectedApp = savedExcludeApp === 'true';
            }
        } catch (_) {}
    }
    if (typeof onApplied === 'function') {
        onApplied();
    }
    return state;
}
