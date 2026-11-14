export const STORAGE_KEY = 'streamgrid_last_room';
export const CLIENT_ID_KEY = 'streamgrid_client_id';
export const USERNAME_KEY = 'streamgrid_username';
export const VIDEO_RES_KEY = 'streamgrid_video_resolution';
export const VIDEO_FPS_KEY = 'streamgrid_video_fps';
export const AUDIO_SOURCE_KEY = 'streamgrid_audio_source';
export const CONTENT_HINT_KEY = 'streamgrid_content_hint';
export const USE_VB_CABLE_KEY = 'streamgrid_use_vb_cable';
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
            const savedVbCable = storage.getItem(USE_VB_CABLE_KEY);
            if (savedVbCable === 'true' || savedVbCable === 'false') {
                state.useVbCableAudio = savedVbCable === 'true';
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
