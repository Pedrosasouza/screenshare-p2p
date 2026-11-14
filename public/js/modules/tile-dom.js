let fullscreenChangeCallback = null;



export function registerFullscreenChangeHandler(handler) {

    fullscreenChangeCallback = typeof handler === 'function' ? handler : null;

}



function notifyFullscreenChange() {
    if (typeof fullscreenChangeCallback === 'function') {
        fullscreenChangeCallback();
    }
}



/**
 * @param {HTMLVideoElement | null} videoEl
 * @param {{
 *   documentObj?: import('./types.js').AnyDocument | null,
 *   showToast?: import('./types.js').ShowToastFn
 * }} [options]
 */
export async function toggleVideoPictureInPicture(
    videoEl,
    {
        documentObj = /** @type {import('./types.js').AnyDocument | null} */ (typeof document !== 'undefined' ? document : null),
        showToast = /** @type {import('./types.js').ShowToastFn} */ (() => {})
    } = {}
) {
    if (!documentObj || !documentObj.pictureInPictureEnabled) {
        showToast('Janela Flutuante (Picture-in-Picture) não é suportada neste navegador.', 'warning');
        return false;
    }

    if (!videoEl) {
        showToast('Nenhuma transmissão ativa para abrir em janela flutuante.', 'info');
        return false;
    }

    try {
        if (documentObj.pictureInPictureElement === videoEl) {
            await documentObj.exitPictureInPicture();
            return true;
        }

        if (typeof videoEl.requestPictureInPicture !== 'function') {
            showToast('Este vídeo não suporta janela flutuante (PiP).', 'warning');
            return false;
        }

        await videoEl.requestPictureInPicture();
        return true;
    } catch (err) {
        console.error('[PiP] Falha ao alternar Picture-in-Picture:', err);
        showToast('Não foi possível ativar a janela flutuante: ' + (err && err.message ? err.message : 'Erro desconhecido'), 'error');
        return false;
    }
}

/**
 * @param {any} tileEl
 * @param {import('./types.js').AnyDocument | null} [documentObj]
 */
export function disposeTileElement(tileEl, documentObj = /** @type {import('./types.js').AnyDocument | null} */ (typeof document !== 'undefined' ? document : null)) {
    if (!tileEl) return;
    if (typeof tileEl._cleanupTapUnmute === 'function') {
        tileEl._cleanupTapUnmute();
    }
    const videoEl = typeof tileEl.querySelector === 'function'
        ? tileEl.querySelector('video')
        : null;
    if (videoEl) {
        if (documentObj && documentObj.pictureInPictureElement === videoEl && typeof documentObj.exitPictureInPicture === 'function') {
            Promise.resolve(documentObj.exitPictureInPicture()).catch(() => {});
        }
        videoEl.srcObject = null;
    }
    if (documentObj && (documentObj.fullscreenElement === tileEl || documentObj.webkitFullscreenElement === tileEl)) {
        if (typeof documentObj.exitFullscreen === 'function') {
            Promise.resolve(documentObj.exitFullscreen()).catch(() => {});
        } else if (typeof documentObj.webkitExitFullscreen === 'function') {
            Promise.resolve(documentObj.webkitExitFullscreen()).catch(() => {});
        }
    }
    if (typeof tileEl.remove === 'function') {
        tileEl.remove();
    }
}

/**
 * @param {any} tile
 * @param {any} video
 * @param {import('./types.js').AnyDocument | null} [documentObj]
 */
export function toggleTileFullscreen(tile, video, documentObj = /** @type {import('./types.js').AnyDocument | null} */ (typeof document !== 'undefined' ? document : null)) {
    if (!tile) return;

    // 1. If currently in pseudo-fullscreen, exit it
    if (tile.classList.contains('pseudo-fullscreen')) {
        tile.classList.remove('pseudo-fullscreen');
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        if (exitBtn) exitBtn.remove();
        notifyFullscreenChange();
        return;
    }

    // 2. If native document fullscreen is active, exit it
    if (documentObj && (documentObj.fullscreenElement || documentObj.webkitFullscreenElement)) {
        if (documentObj.exitFullscreen) {
            Promise.resolve(documentObj.exitFullscreen()).catch(() => {});
        } else if (documentObj.webkitExitFullscreen) {
            try {
                Promise.resolve(documentObj.webkitExitFullscreen()).catch(() => {});
            } catch (_) {}
        }
        return;
    }

    // 3. iOS Safari native video player fullscreen
    if (video && typeof video.webkitEnterFullscreen === 'function') {
        try {
            video.webkitEnterFullscreen();
            return;
        } catch (e) {
            console.warn('[FS] iOS webkitEnterFullscreen error, using pseudo:', e);
        }
    }

    // 4. Standard Element Fullscreen (Android Chrome, PC)
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen || tile.mozRequestFullScreen || tile.msRequestFullscreen;
    if (req) {
        try {
            Promise.resolve(req.call(tile)).catch(err => {
                console.warn('[FS] Native requestFullscreen rejected, falling back to pseudo:', err);
                enterPseudoFullscreen(tile, documentObj);
            });
        } catch (err) {
            console.warn('[FS] Native requestFullscreen threw synchronously, falling back to pseudo:', err);
            enterPseudoFullscreen(tile, documentObj);
        }
    } else {
        // 5. Fallback: Pseudo-fullscreen
        enterPseudoFullscreen(tile, documentObj);
    }
}

export function enterPseudoFullscreen(tile, documentObj = (typeof document !== 'undefined' ? document : null)) {
    tile.classList.add('pseudo-fullscreen');
    notifyFullscreenChange();
    if (!tile.querySelector('.btn-exit-pseudo-fs') && documentObj && typeof documentObj.createElement === 'function') {
        const exitBtn = documentObj.createElement('button');
        exitBtn.type = 'button';
        exitBtn.className = 'btn-exit-pseudo-fs';
        exitBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        exitBtn.title = 'Sair da Tela Cheia';
        if (typeof exitBtn.setAttribute === 'function') {
            exitBtn.setAttribute('aria-label', 'Sair da Tela Cheia');
        }
        exitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            tile.classList.remove('pseudo-fullscreen');
            exitBtn.remove();
            notifyFullscreenChange();
        });
        tile.appendChild(exitBtn);
    }
}

export function showTapToUnmuteBadge(tile, video, documentObj = (typeof document !== 'undefined' ? document : null)) {
    if (!tile || tile.querySelector('.tap-unmute-badge') || !documentObj || typeof documentObj.createElement !== 'function') return;
    const badge = documentObj.createElement('div');
    badge.className = 'tap-unmute-badge tile-unmute-badge';
    badge.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> Toque para ativar o som';
    const cleanup = () => {
        badge.removeEventListener('click', unmute);
        tile.removeEventListener('click', unmute);
        badge.remove();
        if (tile._cleanupTapUnmute === cleanup) {
            delete tile._cleanupTapUnmute;
        }
    };
    const unmute = (e) => {
        if (e && typeof e.stopPropagation === 'function') {
            e.stopPropagation();
        }
        video.muted = false;
        video.removeAttribute('muted');
        if (video.volume === 0) {
            video.volume = 1;
        }
        if (typeof video.play === 'function') {
            Promise.resolve(video.play()).catch(() => {});
        }
        cleanup();
        const slider = tile.querySelector('.tile-controls-overlay input[type="range"]');
        if (slider) {
            slider.value = String(video.volume || 1);
        }
        const muteBtn = tile.querySelector('.tile-controls-overlay .btn-mute-toggle') || tile.querySelector('.tile-controls-overlay .btn-icon');
        if (muteBtn) muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
    };
    tile._cleanupTapUnmute = cleanup;
    badge.addEventListener('click', unmute);
    tile.addEventListener('click', unmute);
    tile.appendChild(badge);
}
