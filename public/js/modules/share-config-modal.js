import {
    VIDEO_RES_KEY,
    VIDEO_FPS_KEY,
    AUDIO_SOURCE_KEY,
    USE_VB_CABLE_KEY,
    EXCLUDE_SELECTED_APP_KEY,
    saveClientPreference
} from './preferences.js';
import { activateModalFocus, restoreModalFocus } from './modal-a11y.js';

/**
 * @typedef {import('./types.js').AppState} AppState
 * @typedef {import('./types.js').DomRefs} DomRefs
 * @typedef {import('./types.js').AnyDocument} AnyDocument
 */

/**
 * @param {{
 *   state: AppState,
 *   dom?: DomRefs,
 *   isDesktopApp?: () => boolean,
 *   checkDiscordStatus?: () => void,
 *   fetchWindowList?: () => void,
 *   updateEchoWarningVisibility?: () => void,
 *   onStartScreenShare?: (...args: any[]) => Promise<void>,
 *   documentObj?: AnyDocument | null,
 *   storage?: Storage | null
 * }} options
 */
export function createShareConfigModalController({
    state,
    dom = /** @type {DomRefs} */ ({}),
    isDesktopApp = () => false,
    checkDiscordStatus = () => {},
    fetchWindowList = () => {},
    updateEchoWarningVisibility = () => {},
    onStartScreenShare = async () => {},
    documentObj = (typeof document !== 'undefined' ? /** @type {AnyDocument} */ (document) : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null)
} = /** @type {any} */ ({})) {
    let previousFocusEl = null;
    function syncAudioOptionContainers() {
        const {
            audioSourceApp,
            audioSourceSystem,
            appSelectorContainer,
            appExcludeOptionContainer,
            vbCableOptionContainer
        } = dom;

        const checkedAudioRadio = documentObj && typeof documentObj.querySelector === 'function'
            ? /** @type {HTMLInputElement | null} */ (documentObj.querySelector('input[name="audioSourceType"]:checked'))
            : null;
        const selectedMode = checkedAudioRadio ? checkedAudioRadio.value : null;
        const isAppMode = selectedMode ? selectedMode === 'app' : Boolean(audioSourceApp && audioSourceApp.checked);
        const isSystemMode = selectedMode ? selectedMode === 'system' : Boolean(audioSourceSystem && audioSourceSystem.checked);

        if (appSelectorContainer) {
            appSelectorContainer.style.display = isAppMode ? 'flex' : 'none';
        }
        if (appExcludeOptionContainer) {
            appExcludeOptionContainer.style.display = (isDesktopApp() && isAppMode) ? 'flex' : 'none';
        }
        if (vbCableOptionContainer) {
            vbCableOptionContainer.style.display = isSystemMode ? 'block' : 'none';
        }
    }

    function openShareConfigModal() {
        updateEchoWarningVisibility();

        const {
            shareConfigModal,
            audioSourceExcludeDiscord,
            audioSourceApp,
            audioSourceSystem,
            audioSourceNone,
            chkUseVbCable,
            chkExcludeSelectedApp
        } = dom;

        const isDesktop = isDesktopApp();
        const desktopOnlyCard1 = audioSourceExcludeDiscord?.closest('.audio-option-card');
        const desktopOnlyCard2 = audioSourceApp?.closest('.audio-option-card');
        const preferredAudioSource = (state.selectedAudioSource === 'exclude_discord' ||
            state.selectedAudioSource === 'app' ||
            state.selectedAudioSource === 'system' ||
            state.selectedAudioSource === 'none')
            ? state.selectedAudioSource
            : null;

        if (!isDesktop) {
            if (desktopOnlyCard1) desktopOnlyCard1.style.display = 'none';
            if (desktopOnlyCard2) desktopOnlyCard2.style.display = 'none';
            if (audioSourceExcludeDiscord) audioSourceExcludeDiscord.checked = false;
            if (audioSourceApp) audioSourceApp.checked = false;
            const webSource = preferredAudioSource === 'none' && audioSourceNone ? 'none' : 'system';
            if (audioSourceNone) audioSourceNone.checked = webSource === 'none';
            if (audioSourceSystem) audioSourceSystem.checked = webSource === 'system';
        } else {
            if (desktopOnlyCard1) desktopOnlyCard1.style.display = 'flex';
            if (desktopOnlyCard2) desktopOnlyCard2.style.display = 'flex';
            const desktopRadioMap = {
                exclude_discord: audioSourceExcludeDiscord || null,
                app: audioSourceApp || null,
                system: audioSourceSystem || null,
                none: audioSourceNone || null
            };
            const targetRadio = preferredAudioSource ? desktopRadioMap[preferredAudioSource] : null;
            if (targetRadio) {
                Object.values(desktopRadioMap).forEach((r) => {
                    if (r) r.checked = r === targetRadio;
                });
            }
            checkDiscordStatus();
            fetchWindowList();
        }

        if (chkUseVbCable) {
            chkUseVbCable.checked = Boolean(state.useVbCableAudio);
        }
        if (chkExcludeSelectedApp) {
            chkExcludeSelectedApp.checked = Boolean(state.excludeSelectedApp);
        }
        syncAudioOptionContainers();

        const audioRadios = (documentObj && typeof documentObj.querySelectorAll === 'function')
            ? documentObj.querySelectorAll('input[name="audioSourceType"]')
            : [audioSourceExcludeDiscord, audioSourceApp, audioSourceSystem, audioSourceNone];

        audioRadios.forEach((radio) => {
            const card = radio && typeof radio.closest === 'function' ? radio.closest('.audio-option-card') : null;
            if (!card) return;
            if (card.classList && typeof card.classList.toggle === 'function') {
                card.classList.toggle('is-selected', Boolean(radio.checked));
            }
            if (!radio.checked && card.style && card.style.border) {
                card.style.border = '';
            }
        });

        if (documentObj && typeof documentObj.querySelector === 'function') {
            const resRadio = /** @type {HTMLInputElement | null} */ (documentObj.querySelector(`input[name="videoResolution"][value="${state.selectedVideoResolution}"]`));
            if (resRadio) resRadio.checked = true;
            const fpsRadio = /** @type {HTMLInputElement | null} */ (documentObj.querySelector(`input[name="videoFps"][value="${state.selectedVideoFps}"]`));
            if (fpsRadio) fpsRadio.checked = true;
        }

        if (shareConfigModal) {
            const wasOpen = isShareConfigModalOpen();
            shareConfigModal.removeAttribute('hidden');
            shareConfigModal.style.display = 'flex';
            if (!wasOpen) {
                previousFocusEl = activateModalFocus(shareConfigModal, documentObj);
            }
        }
    }

    function closeShareConfigModal() {
        const { shareConfigModal } = dom;
        if (shareConfigModal) {
            shareConfigModal.setAttribute('hidden', '');
            shareConfigModal.style.display = 'none';
            restoreModalFocus(previousFocusEl, documentObj);
            previousFocusEl = null;
        }
    }

    function isShareConfigModalOpen() {
        const { shareConfigModal } = dom;
        return Boolean(shareConfigModal && !shareConfigModal.hidden && shareConfigModal.style.display !== 'none');
    }

    function bindEvents() {
        const {
            btnStartShare,
            btnStartShareBig,
            shareConfigModal,
            btnCloseShareConfig,
            btnRefreshAudioApps,
            btnConfirmStartShare,
            selectAudioApp,
            audioSourceExcludeDiscord,
            audioSourceApp,
            audioSourceSystem,
            audioSourceNone,
            chkUseVbCable,
            chkExcludeSelectedApp
        } = dom;

        if (btnStartShare) btnStartShare.addEventListener('click', openShareConfigModal);
        if (btnStartShareBig) btnStartShareBig.addEventListener('click', openShareConfigModal);
        if (btnCloseShareConfig) btnCloseShareConfig.addEventListener('click', closeShareConfigModal);

        if (btnRefreshAudioApps) {
            btnRefreshAudioApps.addEventListener('click', () => fetchWindowList());
        }

        if (chkUseVbCable) {
            chkUseVbCable.addEventListener('change', () => {
                state.useVbCableAudio = Boolean(chkUseVbCable.checked);
                saveClientPreference(USE_VB_CABLE_KEY, String(state.useVbCableAudio), storage);
            });
        }

        if (chkExcludeSelectedApp) {
            chkExcludeSelectedApp.addEventListener('change', () => {
                state.excludeSelectedApp = Boolean(chkExcludeSelectedApp.checked);
                saveClientPreference(EXCLUDE_SELECTED_APP_KEY, String(state.excludeSelectedApp), storage);
            });
        }

        [audioSourceExcludeDiscord, audioSourceApp, audioSourceSystem, audioSourceNone].forEach((radio) => {
            if (!radio) return;
            radio.addEventListener('change', () => {
                if (radio.checked && radio.value) {
                    state.selectedAudioSource = radio.value;
                    saveClientPreference(AUDIO_SOURCE_KEY, radio.value, storage);
                }
                syncAudioOptionContainers();
                const audioRadios = (documentObj && typeof documentObj.querySelectorAll === 'function')
                    ? documentObj.querySelectorAll('input[name="audioSourceType"]')
                    : [audioSourceExcludeDiscord, audioSourceApp, audioSourceSystem, audioSourceNone];
                audioRadios.forEach((r) => {
                    const card = r && typeof r.closest === 'function' ? r.closest('.audio-option-card') : null;
                    if (!card) return;
                    if (card.classList && typeof card.classList.toggle === 'function') {
                        card.classList.toggle('is-selected', Boolean(r.checked));
                    }
                    if (card.style) {
                        card.style.border = '';
                    }
                });
            });
        });

        if (shareConfigModal) {
            shareConfigModal.addEventListener('click', (e) => {
                if (e.target === shareConfigModal) {
                    closeShareConfigModal();
                }
            });
        }

        if (btnConfirmStartShare) {
            btnConfirmStartShare.addEventListener('click', async () => {
                closeShareConfigModal();
                const checkedMode = documentObj && typeof documentObj.querySelector === 'function'
                    ? /** @type {HTMLInputElement | null} */ (documentObj.querySelector('input[name="audioSourceType"]:checked'))?.value
                    : null;
                const mode = checkedMode || 'exclude_discord';
                state.selectedAudioSource = mode;
                saveClientPreference(AUDIO_SOURCE_KEY, mode, storage);

                const targetPid = selectAudioApp ? selectAudioApp.value : null;

                if (documentObj && typeof documentObj.querySelector === 'function') {
                    const resChoice = /** @type {HTMLInputElement | null} */ (documentObj.querySelector('input[name="videoResolution"]:checked'))?.value;
                    if (resChoice === '720p' || resChoice === '1080p') {
                        state.selectedVideoResolution = resChoice;
                        saveClientPreference(VIDEO_RES_KEY, state.selectedVideoResolution, storage);
                    }
                    const fpsChoice = Number(/** @type {HTMLInputElement | null} */ (documentObj.querySelector('input[name="videoFps"]:checked'))?.value);
                    if (fpsChoice === 30 || fpsChoice === 60) {
                        state.selectedVideoFps = fpsChoice;
                        saveClientPreference(VIDEO_FPS_KEY, String(state.selectedVideoFps), storage);
                    }
                }

                if (chkUseVbCable) {
                    state.useVbCableAudio = Boolean(chkUseVbCable.checked);
                    saveClientPreference(USE_VB_CABLE_KEY, String(state.useVbCableAudio), storage);
                }
                if (chkExcludeSelectedApp) {
                    state.excludeSelectedApp = Boolean(chkExcludeSelectedApp.checked);
                    saveClientPreference(EXCLUDE_SELECTED_APP_KEY, String(state.excludeSelectedApp), storage);
                }
                const useVbCable = Boolean(chkUseVbCable ? chkUseVbCable.checked : state.useVbCableAudio);
                const excludeApp = Boolean(chkExcludeSelectedApp ? chkExcludeSelectedApp.checked : state.excludeSelectedApp);

                await onStartScreenShare(
                    mode,
                    targetPid,
                    state.selectedVideoResolution,
                    state.selectedVideoFps,
                    { useVbCable, excludeApp }
                );
            });
        }
    }

    return {
        openShareConfigModal,
        closeShareConfigModal,
        isShareConfigModalOpen,
        bindEvents
    };
}
