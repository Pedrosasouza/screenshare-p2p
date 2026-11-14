function createMockClassList(el) {
    const set = new Set();
    const syncClassName = () => {
        if (el) {
            el._classSet = set;
            el.className = Array.from(set).join(' ');
        }
    };
    return {
        add(...cls) {
            cls.forEach((c) => { if (c) set.add(c); });
            syncClassName();
        },
        remove(...cls) {
            cls.forEach((c) => set.delete(c));
            syncClassName();
        },
        contains(c) {
            return set.has(c);
        },
        toggle(c, force) {
            if (force === undefined) {
                if (set.has(c)) {
                    set.delete(c);
                    syncClassName();
                    return false;
                }
                set.add(c);
                syncClassName();
                return true;
            }
            if (force) set.add(c);
            else set.delete(c);
            syncClassName();
            return Boolean(force);
        },
        toArray() {
            return Array.from(set);
        }
    };
}

function matchesSingleSelector(el, sel) {
    if (!el || !sel) return false;
    if (sel.startsWith('#')) {
        return el.id === sel.slice(1);
    }
    const notMatch = sel.match(/^\.([a-zA-Z0-9_-]+):not\(#([a-zA-Z0-9_-]+)\)$/);
    if (notMatch) {
        return matchesSingleSelector(el, `.${notMatch[1]}`) && el.id !== notMatch[2];
    }
    const valAttrMatch = sel.match(/^([a-zA-Z0-9_-]+)\[name="([^"]+)"\]\[value="([^"]+)"\]$/);
    if (valAttrMatch) {
        return el.tagName === valAttrMatch[1].toUpperCase() && el.name === valAttrMatch[2] && el.value === valAttrMatch[3];
    }
    const checkedAttrMatch = sel.match(/^([a-zA-Z0-9_-]+)\[name="([^"]+)"\]:checked$/);
    if (checkedAttrMatch) {
        return el.tagName === checkedAttrMatch[1].toUpperCase() && el.name === checkedAttrMatch[2] && Boolean(el.checked);
    }
    const nameAttrMatch = sel.match(/^([a-zA-Z0-9_-]+)\[name="([^"]+)"\]$/);
    if (nameAttrMatch) {
        return el.tagName === nameAttrMatch[1].toUpperCase() && el.name === nameAttrMatch[2];
    }
    if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        if (el.classList && el.classList.contains(cls)) return true;
        return typeof el.className === 'string' && el.className.split(/\s+/).includes(cls);
    }
    const attrMatch = sel.match(/^([a-zA-Z0-9_-]+)\[type="([^"]+)"\]$/);
    if (attrMatch) {
        return el.tagName === attrMatch[1].toUpperCase() && el.type === attrMatch[2];
    }
    return el.tagName === sel.toUpperCase();
}

function matchesSelectorParts(el, parts) {
    if (!matchesSingleSelector(el, parts[parts.length - 1])) return false;
    let idx = parts.length - 2;
    let cur = el.parentNode;
    while (idx >= 0 && cur) {
        if (matchesSingleSelector(cur, parts[idx])) idx--;
        cur = cur.parentNode;
    }
    return idx < 0;
}

function matchCompoundSelector(el, compound) {
    const parts = compound.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    return matchesSelectorParts(el, parts);
}

function createMockElement(tagName = 'div', options = {}) {
    const listeners = new Map();
    const attrs = new Map();
    const styleStore = {};
    const style = new Proxy(styleStore, {
        get(target, prop) {
            if (prop === 'removeProperty') {
                return (name) => {
                    delete target[name];
                };
            }
            return target[prop] !== undefined ? target[prop] : '';
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        }
    });

    const el = {
        tagName: String(tagName || 'div').toUpperCase(),
        id: options.id || '',
        name: options.name || '',
        type: options.type || '',
        value: options.value || '',
        checked: Boolean(options.checked),
        className: options.className || '',
        dataset: { ...(options.dataset || {}) },
        hidden: Boolean(options.hidden),
        disabled: Boolean(options.disabled),
        style,
        innerHTML: options.innerHTML || '',
        textContent: options.textContent || '',
        title: options.title || '',
        srcObject: null,
        muted: Boolean(options.muted),
        volume: options.volume !== undefined ? options.volume : 1,
        autoplay: false,
        playsInline: false,
        children: [],
        parentNode: null,
        removed: false,
        _listeners: listeners,
        playCalls: 0,
        _focused: false,
        _selected: false,
        setAttribute(k, v) {
            const val = String(v);
            attrs.set(k, val);
            if (k === 'id') this.id = val;
            if (k === 'name') this.name = val;
            if (k === 'type') this.type = val;
            if (k === 'hidden') this.hidden = true;
            if (k.startsWith('data-')) {
                const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
                this.dataset[camel] = val;
            }
        },
        getAttribute(k) {
            return attrs.has(k) ? attrs.get(k) : null;
        },
        hasAttribute(k) {
            if (k === 'hidden' && this.hidden) return true;
            return attrs.has(k);
        },
        removeAttribute(k) {
            attrs.delete(k);
            if (k === 'hidden') this.hidden = false;
        },
        appendChild(child) {
            if (!child) return child;
            child.parentNode = this;
            child.removed = false;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            if (child && this.children.includes(child)) {
                child.remove();
            }
            return child;
        },
        remove() {
            this.removed = true;
            if (this.parentNode && Array.isArray(this.parentNode.children)) {
                const idx = this.parentNode.children.indexOf(this);
                if (idx >= 0) this.parentNode.children.splice(idx, 1);
            }
            this.parentNode = null;
        },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = listeners.get(type);
            if (!arr) return;
            listeners.set(type, arr.filter((item) => item !== fn));
        },
        listenerCount(type) {
            return (listeners.get(type) || []).length;
        },
        dispatchEvent(event = {}) {
            const ev = {
                target: this,
                currentTarget: this,
                defaultPrevented: false,
                _stopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this._stopped = true; },
                ...event
            };
            let node = this;
            while (node) {
                ev.currentTarget = node;
                const list = node._listeners ? (node._listeners.get(ev.type) || []) : [];
                for (const fn of list) {
                    fn(ev);
                }
                if (ev._stopped) break;
                node = node.parentNode;
            }
            return !ev.defaultPrevented;
        },
        contains(target) {
            let cur = target;
            while (cur) {
                if (cur === this) return true;
                cur = cur.parentNode;
            }
            return false;
        },
        closest(selector) {
            let cur = this;
            while (cur) {
                if (matchCompoundSelector(cur, selector)) return cur;
                cur = cur.parentNode;
            }
            return null;
        },
        querySelector(selector) {
            const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
            const walk = (node) => {
                for (const child of node.children || []) {
                    if (selectors.some((sel) => matchCompoundSelector(child, sel))) {
                        return child;
                    }
                    const nested = walk(child);
                    if (nested) return nested;
                }
                return null;
            };
            return walk(this);
        },
        querySelectorAll(selector) {
            const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
            const results = [];
            const walk = (node) => {
                for (const child of node.children || []) {
                    if (selectors.some((sel) => matchCompoundSelector(child, sel))) {
                        results.push(child);
                    }
                    walk(child);
                }
            };
            walk(this);
            return results;
        },
        click() {
            return this.dispatchEvent({ type: 'click', target: this });
        },
        focus() {
            this._focused = true;
        },
        select() {
            this._selected = true;
        },
        play: options.playImpl
            ? function playWrapper() {
                this.playCalls += 1;
                return options.playImpl(this);
            }
            : function playDefault() {
                this.playCalls += 1;
                return Promise.resolve();
            }
    };

    if (options.dataset) {
        for (const [k, v] of Object.entries(options.dataset)) {
            attrs.set(`data-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`, String(v));
        }
    }
    el.classList = createMockClassList(el);
    if (options.className) {
        options.className.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    }
    return el;
}

function createMockDocument(elementsById = {}, options = {}) {
    const docListeners = new Map();
    const documentElement = createMockElement('html');
    const body = createMockElement('body');
    const registry = new Map(Object.entries(elementsById));

    const registerTree = (node) => {
        if (!node) return;
        if (node.id && !registry.has(node.id)) {
            registry.set(node.id, node);
        }
        for (const child of node.children || []) {
            registerTree(child);
        }
    };
    registry.forEach((node) => registerTree(node));

    const doc = {
        hidden: Boolean(options.hidden),
        fullscreenElement: options.fullscreenElement || null,
        webkitFullscreenElement: options.webkitFullscreenElement || null,
        pictureInPictureEnabled: options.pictureInPictureEnabled !== undefined ? options.pictureInPictureEnabled : true,
        pictureInPictureElement: options.pictureInPictureElement || null,
        documentElement,
        body,
        _listeners: docListeners,
        registerElement(id, el) {
            registry.set(id, el);
            return el;
        },
        getElementById(id) {
            if (registry.has(id)) return registry.get(id);
            return body.querySelector(`#${id}`);
        },
        querySelector(selector) {
            const fromBody = body.querySelector(selector);
            if (fromBody) return fromBody;
            for (const el of registry.values()) {
                if (matchCompoundSelector(el, selector)) return el;
                const nested = el.querySelector(selector);
                if (nested) return nested;
            }
            return null;
        },
        querySelectorAll(selector) {
            const found = new Set(body.querySelectorAll(selector));
            for (const el of registry.values()) {
                if (matchCompoundSelector(el, selector)) found.add(el);
                el.querySelectorAll(selector).forEach((n) => found.add(n));
            }
            return Array.from(found);
        },
        createElement(tag) {
            return createMockElement(tag, options.playImpl && tag.toLowerCase() === 'video' ? { playImpl: options.playImpl } : {});
        },
        addEventListener(type, fn) {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = docListeners.get(type);
            if (!arr) return;
            docListeners.set(type, arr.filter((item) => item !== fn));
        },
        dispatchEvent(event = {}) {
            const list = docListeners.get(event.type) || [];
            list.forEach((fn) => fn(event));
        },
        exitFullscreen: options.exitFullscreen || (async () => {
            doc.fullscreenElement = null;
            doc.webkitFullscreenElement = null;
        }),
        exitPictureInPicture: options.exitPictureInPicture || (async () => {
            doc.pictureInPictureElement = null;
        })
    };
    return doc;
}

function createMockStorage(initial = {}) {
    const store = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
    return {
        _store: store,
        getItem(k) {
            return store.has(k) ? store.get(k) : null;
        },
        setItem(k, v) {
            store.set(k, String(v));
        },
        removeItem(k) {
            store.delete(k);
        },
        clear() {
            store.clear();
        }
    };
}

module.exports = {
    createMockClassList,
    createMockElement,
    createMockDocument,
    createMockStorage
};
