import { toggleTileFullscreen, showTapToUnmuteBadge, toggleVideoPictureInPicture } from './tile-dom.js';
import { buildInviteUrl } from './signaling-url.js';

/**
 * @typedef {import('./types.js').AppState} AppState
 * @typedef {import('./types.js').DomRefs} DomRefs
 * @typedef {import('./types.js').ShowToastFn} ShowToastFn
 * @typedef {import('./types.js').AnyWindow} AnyWindow
 * @typedef {import('./types.js').AnyDocument} AnyDocument
 */

/**
 * @param {{
 *   state: AppState,
 *   dom?: DomRefs,
 *   getPeers?: () => Map<string, any>,
 *   getRemoteActiveStreams?: () => Set<string>,
 *   getQualityMonitor?: () => any,
 *   isDesktopApp?: () => boolean,
 *   getServerUrl?: () => string,
 *   showToast?: ShowToastFn,
 *   documentObj?: AnyDocument | null,
 *   windowObj?: AnyWindow | null,
 *   navigatorObj?: Navigator | null,
 *   onToggleTileFullscreen?: typeof toggleTileFullscreen,
 *   onShowTapToUnmuteBadge?: typeof showTapToUnmuteBadge,
 *   onToggleVideoPictureInPicture?: typeof toggleVideoPictureInPicture
 * }} options
 */
export function createStreamGridController({
    state,
    dom = /** @type {DomRefs} */ ({}),
    getPeers = () => new Map(),
    getRemoteActiveStreams = () => new Set(),
    getQualityMonitor = () => null,
    isDesktopApp = () => false,
    getServerUrl = () => '',
    showToast = /** @type {ShowToastFn} */ (() => {}),
    documentObj = (typeof document !== 'undefined' ? /** @type {AnyDocument} */ (document) : null),
    windowObj = (typeof window !== 'undefined' ? /** @type {AnyWindow} */ (window) : null),
    navigatorObj = (typeof navigator !== 'undefined' ? navigator : null),
    onToggleTileFullscreen = toggleTileFullscreen,
    onShowTapToUnmuteBadge = showTapToUnmuteBadge,
    onToggleVideoPictureInPicture = toggleVideoPictureInPicture
} = /** @type {any} */ ({})) {
    let copyLinkResetTimer = null;

    function clearSpotlight() {
        const { streamGrid } = dom;
        if (!streamGrid) return false;
        const wasActive = Boolean(
            (streamGrid.classList && streamGrid.classList.contains('is-spotlight-mode')) ||
            (streamGrid.dataset && streamGrid.dataset.spotlightPeerId)
        );
        if (streamGrid.classList) {
            streamGrid.classList.remove('is-spotlight-mode');
        }
        if (streamGrid.dataset) {
            delete streamGrid.dataset.spotlightPeerId;
        }
        const tiles = typeof streamGrid.querySelectorAll === 'function'
            ? streamGrid.querySelectorAll('.stream-tile')
            : [];
        tiles.forEach((tileEl) => {
            if (tileEl.classList) {
                tileEl.classList.remove('is-spotlight');
            }
            const spotlightBtn = typeof tileEl.querySelector === 'function'
                ? tileEl.querySelector('.btn-tile-spotlight')
                : null;
            if (spotlightBtn && typeof spotlightBtn.setAttribute === 'function') {
                spotlightBtn.setAttribute('aria-pressed', 'false');
            }
        });
        return wasActive;
    }

    function toggleTileSpotlight(tile) {
        const { streamGrid } = dom;
        if (!streamGrid || !tile) return false;
        const isAlreadySpotlight = Boolean(
            tile.classList &&
            tile.classList.contains('is-spotlight') &&
            streamGrid.classList &&
            streamGrid.classList.contains('is-spotlight-mode')
        );
        if (isAlreadySpotlight) {
            clearSpotlight();
            return false;
        }

        clearSpotlight();
        if (tile.classList) {
            tile.classList.add('is-spotlight');
        }
        const spotlightBtn = typeof tile.querySelector === 'function'
            ? tile.querySelector('.btn-tile-spotlight')
            : null;
        if (spotlightBtn && typeof spotlightBtn.setAttribute === 'function') {
            spotlightBtn.setAttribute('aria-pressed', 'true');
        }
        if (streamGrid.classList) {
            streamGrid.classList.add('is-spotlight-mode');
        }
        if (streamGrid.dataset) {
            streamGrid.dataset.spotlightPeerId = (tile.dataset && tile.dataset.peerId) || '';
        }
        return true;
    }

    function isSpotlightActive() {
        const { streamGrid } = dom;
        return Boolean(streamGrid && streamGrid.classList && streamGrid.classList.contains('is-spotlight-mode'));
    }

    function startTilePlayback(tile, videoEl) {
        const video = videoEl || (tile && typeof tile.querySelector === 'function' ? tile.querySelector('video') : null);
        if (!video || typeof video.play !== 'function') return;

        const playPromise = video.play();
        if (playPromise !== undefined) {
            Promise.resolve(playPromise).catch((e) => {
                if (!video.muted) {
                    console.warn('[Playback] Autoplay blocked, forcing muted play for mobile:', e);
                    video.muted = true;
                    video.setAttribute('muted', '');
                    if (typeof tile._syncAudioUi === 'function') {
                        tile._syncAudioUi();
                    }
                    Promise.resolve(video.play()).catch((err) => console.error('[Playback] Video play failed completely:', err));
                    onShowTapToUnmuteBadge(tile, video, documentObj);
                }
            });
        }
    }

    function createStreamTile(id, stream, labelText, isMuted) {
        const doc = documentObj;
        const nav = navigatorObj || { userAgent: '' };
        const tile = doc.createElement('div');
        if (tile.classList && typeof tile.classList.add === 'function') {
            tile.classList.add('stream-tile');
        } else {
            tile.className = 'stream-tile';
        }
        tile.dataset.peerId = id;

        const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(nav.userAgent || '');
        const startMuted = isMuted || isMobile;

        const video = doc.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        if (startMuted) {
            video.muted = true;
            video.defaultMuted = true;
            video.setAttribute('muted', '');
        } else {
            video.muted = false;
        }
        video.srcObject = stream;

        const headerBadge = doc.createElement('div');
        headerBadge.className = 'tile-header-badge';
        const liveDot = doc.createElement('span');
        liveDot.className = 'live-dot';
        const userNameSpan = doc.createElement('span');
        userNameSpan.className = 'user-name';
        userNameSpan.textContent = labelText;
        headerBadge.appendChild(liveDot);
        headerBadge.appendChild(userNameSpan);

        const controlsOverlay = doc.createElement('div');
        controlsOverlay.className = 'tile-controls-overlay';

        if (!isMuted) {
            let lastNonZeroVolume = 1;

            const muteBtn = doc.createElement('button');
            muteBtn.type = 'button';
            muteBtn.className = 'btn-icon btn-mute-toggle';
            muteBtn.title = 'Silenciar / Ativar Som';
            if (typeof muteBtn.setAttribute === 'function') {
                muteBtn.setAttribute('aria-label', 'Silenciar / Ativar Som');
            }

            const slider = doc.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '1';
            slider.step = '0.05';
            if (typeof slider.setAttribute === 'function') {
                slider.setAttribute('aria-label', 'Volume');
            }

            const syncAudioUi = () => {
                const isCurrentlyMuted = Boolean(video.muted || video.volume === 0);
                slider.value = isCurrentlyMuted ? '0' : String(video.volume > 0 ? video.volume : lastNonZeroVolume);
                muteBtn.innerHTML = isCurrentlyMuted
                    ? '<i class="fa-solid fa-volume-xmark"></i>'
                    : '<i class="fa-solid fa-volume-high"></i>';
            };
            const tileAny = /** @type {HTMLDivElement & { _syncAudioUi?: () => void, _cleanupTapUnmute?: () => void }} */ (tile);
            tileAny._syncAudioUi = syncAudioUi;
            syncAudioUi();

            slider.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            slider.addEventListener('input', (e) => {
                const inputEl = /** @type {HTMLInputElement} */ (e.target);
                const val = parseFloat(inputEl.value);
                video.volume = val;
                if (val > 0) {
                    lastNonZeroVolume = val;
                    video.muted = false;
                    video.removeAttribute('muted');
                    if (typeof tileAny._cleanupTapUnmute === 'function') {
                        tileAny._cleanupTapUnmute();
                    } else {
                        const badge = tile.querySelector('.tap-unmute-badge');
                        if (badge) badge.remove();
                    }
                } else {
                    video.muted = true;
                }
                muteBtn.innerHTML = (val === 0 || video.muted)
                    ? '<i class="fa-solid fa-volume-xmark"></i>'
                    : '<i class="fa-solid fa-volume-high"></i>';
            });

            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!video.muted && video.volume > 0) {
                    lastNonZeroVolume = video.volume > 0
                        ? video.volume
                        : (parseFloat(slider.value) > 0 ? parseFloat(slider.value) : lastNonZeroVolume);
                    video.muted = true;
                    slider.value = '0';
                    muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
                } else {
                    video.muted = false;
                    video.removeAttribute('muted');
                    const prevVal = parseFloat(slider.value);
                    const targetVol = prevVal > 0 ? prevVal : (lastNonZeroVolume > 0 ? lastNonZeroVolume : 1);
                    video.volume = targetVol;
                    slider.value = targetVol.toString();
                    muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
                    if (typeof tileAny._cleanupTapUnmute === 'function') {
                        tileAny._cleanupTapUnmute();
                    } else {
                        const badge = tile.querySelector('.tap-unmute-badge');
                        if (badge) badge.remove();
                    }
                }
            });

            controlsOverlay.appendChild(muteBtn);
            controlsOverlay.appendChild(slider);
        }

        const pipBtn = doc.createElement('button');
        pipBtn.type = 'button';
        pipBtn.className = 'btn-icon btn-tile-pip';
        pipBtn.title = 'Janela Flutuante (PiP)';
        if (typeof pipBtn.setAttribute === 'function') {
            pipBtn.setAttribute('aria-label', 'Janela Flutuante (PiP)');
        }
        pipBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square"></i>';
        pipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onToggleVideoPictureInPicture(video, { documentObj, showToast });
        });
        controlsOverlay.appendChild(pipBtn);

        const spotlightBtn = doc.createElement('button');
        spotlightBtn.type = 'button';
        spotlightBtn.className = 'btn-icon btn-tile-spotlight';
        spotlightBtn.title = 'Destacar Tela (Spotlight)';
        if (typeof spotlightBtn.setAttribute === 'function') {
            spotlightBtn.setAttribute('aria-label', 'Destacar Tela (Spotlight)');
            spotlightBtn.setAttribute('aria-pressed', 'false');
        }
        spotlightBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
        spotlightBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTileSpotlight(tile);
        });
        controlsOverlay.appendChild(spotlightBtn);

        const fsBtn = doc.createElement('button');
        fsBtn.type = 'button';
        fsBtn.className = 'btn-icon';
        fsBtn.title = 'Tela Cheia';
        if (typeof fsBtn.setAttribute === 'function') {
            fsBtn.setAttribute('aria-label', 'Tela Cheia');
        }
        fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        fsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onToggleTileFullscreen(tile, video, documentObj);
        });
        controlsOverlay.appendChild(fsBtn);

        tile.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            onToggleTileFullscreen(tile, video, documentObj);
        });

        tile.appendChild(video);
        tile.appendChild(headerBadge);
        tile.appendChild(controlsOverlay);

        if (!isMuted) {
            const qosBadge = doc.createElement('div');
            qosBadge.className = 'tile-quality-badge';
            qosBadge.innerHTML = '<span class="qos-dot good"></span><span class="qos-label">Bom</span>';
            tile.appendChild(qosBadge);

            if (isMobile) {
                onShowTapToUnmuteBadge(tile, video, documentObj);
            }
        }

        return tile;
    }

    function updateGridState() {
        const { streamGrid, emptyGridPlaceholder, activeStreamsText } = dom;
        if (!streamGrid) return;
        const tiles = streamGrid.querySelectorAll('.stream-tile');
        const count = tiles.length;

        if (streamGrid.classList && streamGrid.classList.contains('is-spotlight-mode')) {
            const hasSpotlightTile = Array.from(tiles).some(
                (t) => t.classList && t.classList.contains('is-spotlight')
            );
            if (!hasSpotlightTile) {
                clearSpotlight();
            }
        }

        if (emptyGridPlaceholder) emptyGridPlaceholder.hidden = (count > 0);
        if (activeStreamsText) activeStreamsText.textContent = `${count} ${count === 1 ? 'Transmissão Ativa' : 'Transmissões Ativas'}`;
        streamGrid.dataset.count = count;

        const qm = getQualityMonitor();
        if (qm) {
            if (count > 0 || state.localStream) {
                qm.startQualityMonitor();
            } else {
                qm.stopQualityMonitor();
            }
        }
    }

    function updateMemberCount(count) {
        if (dom.memberCountText) {
            dom.memberCountText.textContent = `${count} ${count === 1 ? 'Participante' : 'Participantes'}`;
        }
    }

    function updatePeerUserName(peerId, userName) {
        if (!userName) return;
        const cleanName = userName.trim().slice(0, 24);
        const peerObj = getPeers().get(peerId);
        if (!peerObj) return;
        peerObj.userName = cleanName;
        if (peerObj.tileEl) {
            const nameEl = peerObj.tileEl.querySelector('.user-name');
            if (nameEl) nameEl.textContent = cleanName;
        }
    }

    function updateEchoWarningVisibility() {
        const warningEl = documentObj && typeof documentObj.getElementById === 'function'
            ? documentObj.getElementById('dualStreamEchoWarning')
            : null;
        if (!warningEl) return;
        const hasOtherStream = getRemoteActiveStreams().size > 0;
        warningEl.style.display = hasOtherStream ? 'block' : 'none';
    }

    function bindCopyInviteLink() {
        const btnCopyLink = dom.btnCopyLink;
        if (!btnCopyLink) return;
        const defaultCopyLinkHtml = btnCopyLink.innerHTML || '';

        btnCopyLink.addEventListener('click', () => {
            if (!state.roomId) {
                showToast('Entre ou crie uma sala antes de copiar o link de convite.', 'warning');
                return;
            }
            const loc = windowObj && windowObj.location ? windowObj.location : { origin: '', pathname: '/' };
            const inviteUrl = buildInviteUrl({
                roomId: state.roomId,
                password: state.currentRoomPassword,
                isDesktop: isDesktopApp(),
                serverUrl: getServerUrl(),
                origin: loc.origin,
                pathname: loc.pathname
            });
            const clipboard = navigatorObj && navigatorObj.clipboard;
            if (!clipboard || typeof clipboard.writeText !== 'function') {
                showToast('Não foi possível copiar automaticamente. Acesse: ' + inviteUrl, 'warning', 6000);
                return;
            }
            clipboard.writeText(inviteUrl).then(() => {
                if (copyLinkResetTimer) {
                    clearTimeout(copyLinkResetTimer);
                    copyLinkResetTimer = null;
                }
                btnCopyLink.innerHTML = '<i class="fa-solid fa-check"></i> <span class="btn-text">Link Copiado!</span>';
                copyLinkResetTimer = setTimeout(() => {
                    btnCopyLink.innerHTML = defaultCopyLinkHtml;
                    copyLinkResetTimer = null;
                }, 2000);
            }).catch(() => {
                showToast('Não foi possível copiar automaticamente. Acesse: ' + inviteUrl, 'warning', 6000);
            });
        });
    }

    function cleanup() {
        if (copyLinkResetTimer) {
            clearTimeout(copyLinkResetTimer);
            copyLinkResetTimer = null;
        }
    }

    return {
        startTilePlayback,
        createStreamTile,
        toggleTileSpotlight,
        clearSpotlight,
        isSpotlightActive,
        updateGridState,
        updateMemberCount,
        updatePeerUserName,
        updateEchoWarningVisibility,
        bindCopyInviteLink,
        cleanup
    };
}
