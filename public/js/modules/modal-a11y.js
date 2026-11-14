const FOCUSABLE_SELECTOR = 'a, button, input, select, textarea, [tabindex]';

function isElementFocusable(el) {
    if (!el || el.disabled) return false;
    const tag = (el.tagName || '').toUpperCase();
    const tabindex = typeof el.getAttribute === 'function' ? el.getAttribute('tabindex') : el.tabIndex;
    if (tabindex === '-1' || tabindex === -1) return false;
    if (tag === 'A') {
        const href = typeof el.getAttribute === 'function' ? el.getAttribute('href') : el.href;
        if (!href && tabindex == null) return false;
    }
    if (tag === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden') return false;
    return tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tabindex != null;
}

function isElementHidden(el) {
    if (!el) return true;
    if (el.hidden === true) return true;
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) return true;
    if (el.style && el.style.display === 'none') return true;
    if (el.classList && typeof el.classList.contains === 'function' && el.classList.contains('hidden')) {
        return true;
    }
    return false;
}

function isElementVisible(el, modalEl) {
    let cursor = el;
    while (cursor && cursor !== modalEl) {
        if (isElementHidden(cursor)) return false;
        cursor = cursor.parentElement || cursor.parentNode || null;
    }
    if (typeof getComputedStyle === 'function' && typeof el.getClientRects === 'function') {
        try {
            const computed = getComputedStyle(el);
            if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) {
                return false;
            }
        } catch (_) {}
    }
    return true;
}

export function getFocusableElements(modalEl) {
    if (!modalEl || typeof modalEl.querySelectorAll !== 'function') return [];
    const candidates = Array.from(modalEl.querySelectorAll(FOCUSABLE_SELECTOR));
    return candidates.filter((el) => isElementFocusable(el) && isElementVisible(el, modalEl));
}

export function activateModalFocus(modalEl, documentObj = (typeof document !== 'undefined' ? document : null)) {
    const previousFocusEl = documentObj && documentObj.activeElement ? documentObj.activeElement : null;
    if (!modalEl) return previousFocusEl;

    const focusable = getFocusableElements(modalEl);
    const target = focusable[0] || modalEl;
    if (target === modalEl && typeof modalEl.setAttribute === 'function' && !modalEl.hasAttribute?.('tabindex')) {
        modalEl.setAttribute('tabindex', '-1');
    }
    if (target && typeof target.focus === 'function') {
        try {
            target.focus();
        } catch (_) {}
    }
    return previousFocusEl;
}

export function restoreModalFocus(previousFocusEl, documentObj = (typeof document !== 'undefined' ? document : null)) {
    if (!previousFocusEl || typeof previousFocusEl.focus !== 'function') return false;
    if ('isConnected' in previousFocusEl && !previousFocusEl.isConnected) return false;
    if (documentObj && documentObj.body && typeof documentObj.body.contains === 'function') {
        if (!documentObj.body.contains(previousFocusEl)) return false;
    }
    try {
        previousFocusEl.focus();
        return true;
    } catch (_) {
        return false;
    }
}

export function trapModalTabKey(modalEl, event, documentObj = (typeof document !== 'undefined' ? document : null)) {
    if (!modalEl || !event || event.key !== 'Tab') return false;
    const focusable = getFocusableElements(modalEl);
    if (focusable.length === 0) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof modalEl.focus === 'function') {
            try { modalEl.focus(); } catch (_) {}
        }
        return true;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = documentObj ? documentObj.activeElement : null;
    const isInside = Boolean(
        active && (
            typeof modalEl.contains === 'function'
                ? modalEl.contains(active)
                : focusable.includes(active)
        )
    );

    if (event.shiftKey) {
        if (!isInside || active === first) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof last.focus === 'function') {
                try { last.focus(); } catch (_) {}
            }
            return true;
        }
        return false;
    }

    if (!isInside || active === last) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof first.focus === 'function') {
            try { first.focus(); } catch (_) {}
        }
        return true;
    }

    return false;
}
