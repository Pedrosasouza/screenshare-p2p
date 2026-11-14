export const THEME_KEY = 'streamgrid_theme';



export function setSignalingStatus(status, customLabelOrOptions, maybeDoc) {
    const labels = {
        connecting: 'Conectando...',
        waking: 'Acordando...',
        connected: 'Conectado',
        reconnecting: 'Reconectando...',
        offline: 'Offline'
    };
    const isOptsObj = customLabelOrOptions && typeof customLabelOrOptions === 'object';
    const customLabel = isOptsObj ? customLabelOrOptions.customLabel : customLabelOrOptions;
    const doc = (isOptsObj ? customLabelOrOptions.documentObj : maybeDoc)
        || (typeof document !== 'undefined' ? document : null);
    const normalized = Object.prototype.hasOwnProperty.call(labels, status)
        ? status
        : 'connecting';
    const label = customLabel || labels[normalized];
    if (!doc || typeof doc.getElementById !== 'function') return;
    const pill = doc.getElementById('connectionStatusPill');
    const textEl = doc.getElementById('connectionStatusText');
    if (pill) {
        if (pill.dataset) {
            pill.dataset.status = normalized;
        } else if (typeof pill.setAttribute === 'function') {
            pill.setAttribute('data-status', normalized);
        }
    }
    if (textEl) {
        textEl.textContent = label;
    }
}

export function getOrCreateToastContainer(doc = typeof document !== 'undefined' ? document : null) {
    if (!doc || typeof doc.getElementById !== 'function') return null;
    let container = doc.getElementById('toastContainer');
    if (!container && typeof doc.createElement === 'function' && doc.body) {
        container = doc.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        doc.body.appendChild(container);
    }
    return container;
}

export function showToast(message, type = 'info', durationMs = 4000, doc) {
    if (!message) return;
    const targetDoc = doc || (typeof document !== 'undefined' ? document : null);
    const container = getOrCreateToastContainer(targetDoc);
    if (!container || typeof targetDoc.createElement !== 'function') return;
    const toast = targetDoc.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconClass = 'fa-solid fa-circle-info';
    if (type === 'error') iconClass = 'fa-solid fa-circle-xmark';
    else if (type === 'warning') iconClass = 'fa-solid fa-triangle-exclamation';
    else if (type === 'success') iconClass = 'fa-solid fa-circle-check';

    const iconEl = targetDoc.createElement('i');
    iconEl.className = `${iconClass} toast-icon`;

    const messageEl = targetDoc.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;

    const closeBtn = targetDoc.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.title = 'Fechar notificação';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    let timeoutId = null;
    const dismiss = () => {
        if (timeoutId) clearTimeout(timeoutId);
        toast.classList.add('hiding');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 250);
    };

    closeBtn.addEventListener('click', dismiss);
    if (durationMs > 0) {
        timeoutId = setTimeout(dismiss, durationMs);
    }

    toast.appendChild(iconEl);
    toast.appendChild(messageEl);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
}

export function playPresenceChime(type = 'join', windowObj = (typeof window !== 'undefined' ? window : null)) {
    try {
        const win = windowObj || (typeof window !== 'undefined' ? window : null);
        if (!win) return;
        const AudioCtx = win.AudioContext || win.webkitAudioContext;
        if (!AudioCtx) return;
        if (!win._presenceAudioCtx) {
            win._presenceAudioCtx = new AudioCtx();
        }
        const ctx = win._presenceAudioCtx;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        if (type === 'join') {
            // Dois tons ascendentes suaves (440Hz -> 587.33Hz)
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(587.33, now + 0.12);
        } else {
            // Dois tons descendentes suaves (587.33Hz -> 392Hz)
            osc.frequency.setValueAtTime(587.33, now);
            osc.frequency.exponentialRampToValueAtTime(392, now + 0.12);
        }

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.onended = () => {
            try { osc.disconnect(); } catch (_) {}
            try { gain.disconnect(); } catch (_) {}
        };

        osc.start(now);
        osc.stop(now + 0.23);
    } catch (_) {}
}

export function initTheme(options = {}) {
    const win = options.windowObj || (typeof window !== 'undefined' ? window : null);
    const storageObj = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    let savedTheme = null;
    if (storageObj && typeof storageObj.getItem === 'function') {
        try { savedTheme = storageObj.getItem(THEME_KEY); } catch (e) {}
    }

    if (!savedTheme) {
        const prefersDark = Boolean(win && win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches);
        savedTheme = prefersDark ? 'dark' : 'light';
    }
    applyTheme(savedTheme, null, options);
}

export function applyTheme(theme, themeBtnEl = null, options = {}) {
    const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
    const storageObj = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (doc && doc.documentElement && typeof doc.documentElement.setAttribute === 'function') {
        doc.documentElement.setAttribute('data-theme', theme);
    }
    if (storageObj && typeof storageObj.setItem === 'function') {
        try { storageObj.setItem(THEME_KEY, theme); } catch (e) {}
    }

    const themeBtn = themeBtnEl || (doc && typeof doc.getElementById === 'function' ? doc.getElementById('btnThemeToggle') : null);
    if (themeBtn) {
        if (theme === 'dark') {
            themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
            themeBtn.title = 'Mudar para Tema Claro';
        } else {
            themeBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
            themeBtn.title = 'Mudar para Tema Escuro';
        }
    }
}

export function toggleTheme(options = {}) {
    const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
    const currentTheme = (doc && doc.documentElement && typeof doc.documentElement.getAttribute === 'function'
        ? doc.documentElement.getAttribute('data-theme')
        : null) || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme, null, options);
}
