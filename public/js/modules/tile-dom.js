let fullscreenChangeCallback = null;



export function registerFullscreenChangeHandler(handler) {

    fullscreenChangeCallback = typeof handler === 'function' ? handler : null;

}



function notifyFullscreenChange() {

    if (typeof fullscreenChangeCallback === 'function') {

        fullscreenChangeCallback();

    } else if (typeof updateBackgroundTracksOptimization === 'function') {

        updateBackgroundTracksOptimization();

    }

}



export function disposeTileElement(tileEl) {
    if (!tileEl) return;
    if (typeof tileEl._cleanupTapUnmute === 'function') {
        tileEl._cleanupTapUnmute();
    }
    const videoEl = typeof tileEl.querySelector === 'function'
        ? tileEl.querySelector('video')
        : null;
    if (videoEl) {
        videoEl.srcObject = null;
    }
    if (typeof document !== 'undefined' && document.fullscreenElement === tileEl && typeof document.exitFullscreen === 'function') {
        Promise.resolve(document.exitFullscreen()).catch(() => {});
    }
    if (typeof tileEl.remove === 'function') {
        tileEl.remove();
    }
}

export function toggleTileFullscreen(tile, video) {
    if (!tile) return;

    // 1. If currently in pseudo-fullscreen, exit it
    if (tile.classList.contains('pseudo-fullscreen')) {
        tile.classList.remove('pseudo-fullscreen');
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        if (exitBtn) exitBtn.remove();
        if (typeof notifyFullscreenChange === 'function') notifyFullscreenChange();
        else if (typeof updateBackgroundTracksOptimization === 'function') updateBackgroundTracksOptimization();
        return;
    }

    // 2. If native document fullscreen is active, exit it
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
            Promise.resolve(document.exitFullscreen()).catch(() => {});
        } else if (document.webkitExitFullscreen) {
            try {
                Promise.resolve(document.webkitExitFullscreen()).catch(() => {});
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
                enterPseudoFullscreen(tile);
            });
        } catch (err) {
            console.warn('[FS] Native requestFullscreen threw synchronously, falling back to pseudo:', err);
            enterPseudoFullscreen(tile);
        }
    } else {
        // 5. Fallback: Pseudo-fullscreen
        enterPseudoFullscreen(tile);
    }
}

export function enterPseudoFullscreen(tile) {
    tile.classList.add('pseudo-fullscreen');
    if (typeof notifyFullscreenChange === 'function') notifyFullscreenChange();
    else if (typeof updateBackgroundTracksOptimization === 'function') updateBackgroundTracksOptimization();
    if (!tile.querySelector('.btn-exit-pseudo-fs')) {
        const exitBtn = document.createElement('button');
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
            if (typeof notifyFullscreenChange === 'function') notifyFullscreenChange();
            else if (typeof updateBackgroundTracksOptimization === 'function') updateBackgroundTracksOptimization();
        });
        tile.appendChild(exitBtn);
    }
}

export function showTapToUnmuteBadge(tile, video) {
    if (!tile || tile.querySelector('.tap-unmute-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'tap-unmute-badge';
    badge.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> Toque para ativar o som';
    badge.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15, 18, 26, 0.9);
        color: #fff;
        padding: 10px 18px;
        border-radius: 24px;
        font-size: 0.85rem;
        font-weight: 600;
        border: 1px solid var(--border);
        box-shadow: 0 4px 18px rgba(0,0,0,0.5);
        cursor: pointer;
        z-index: 15;
    `;
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
