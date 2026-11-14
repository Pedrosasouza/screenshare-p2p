export const THEME_KEY = 'streamgrid_theme';



export function setSignalingStatus(status, customLabel) {
    const labels = {
        connecting: 'Conectando...',
        waking: 'Acordando...',
        connected: 'Conectado',
        reconnecting: 'Reconectando...',
        offline: 'Offline'
    };
    const normalized = Object.prototype.hasOwnProperty.call(labels, status)
        ? status
        : 'connecting';
    const label = customLabel || labels[normalized];
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const pill = document.getElementById('connectionStatusPill');
    const textEl = document.getElementById('connectionStatusText');
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

export function getOrCreateToastContainer() {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    return container;
}

export function showToast(message, type = 'info', durationMs = 4000) {
    if (!message) return;
    const container = getOrCreateToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconClass = 'fa-solid fa-circle-info';
    if (type === 'error') iconClass = 'fa-solid fa-circle-xmark';
    else if (type === 'warning') iconClass = 'fa-solid fa-triangle-exclamation';
    else if (type === 'success') iconClass = 'fa-solid fa-circle-check';

    const iconEl = document.createElement('i');
    iconEl.className = `${iconClass} toast-icon`;

    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;

    const closeBtn = document.createElement('button');
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

export function playPresenceChime(type = 'join') {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!window._presenceAudioCtx) {
            window._presenceAudioCtx = new AudioCtx();
        }
        const ctx = window._presenceAudioCtx;
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

export function initTheme() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch(e) {}
    
    if (!savedTheme) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        savedTheme = prefersDark ? 'dark' : 'light';
    }
    applyTheme(savedTheme);
}

export function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) {}
    
    const themeBtn = typeof btnThemeToggle !== 'undefined' && btnThemeToggle ? btnThemeToggle : (typeof document !== 'undefined' ? document.getElementById('btnThemeToggle') : null);
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

export function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
}
