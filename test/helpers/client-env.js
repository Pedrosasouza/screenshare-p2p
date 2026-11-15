'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const CLIENT_MODULES_DIR = path.join(ROOT_DIR, 'public', 'js', 'modules');
const APP_ENTRY_PATH = path.join(ROOT_DIR, 'public', 'app.js');

let cacheBustSeq = 0;

/**
 * Dynamically imports one or more client ES modules from `public/js/modules/`
 * (or `'app'` for `public/app.js`) and returns a merged namespace object.
 *
 * @param {string[]} moduleNames
 * @param {{ cacheBustTag?: string }} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function loadClientModules(moduleNames, options = {}) {
    const suffix = options.cacheBustTag
        ? `?${options.cacheBustTag}=${Date.now()}-${++cacheBustSeq}`
        : '';

    const loaded = await Promise.all(
        moduleNames.map((name) => {
            const filePath = name === 'app'
                ? APP_ENTRY_PATH
                : path.join(CLIENT_MODULES_DIR, name.endsWith('.js') ? name : `${name}.js`);
            const url = `${pathToFileURL(filePath).href}${name === 'app' || options.bustAll ? suffix : ''}`;
            return import(url);
        })
    );

    return Object.assign({}, ...loaded);
}

/**
 * Creates an in-memory Socket.IO-compatible mock socket for client unit tests.
 *
 * @param {object} [options]
 * @returns {object}
 */
function createMockSocket(options = {}) {
    const listeners = new Map();
    const emitted = [];

    const socket = {
        id: options.id !== undefined ? options.id : 'mock-socket-1',
        connected: options.connected !== undefined ? options.connected : true,
        emitted,
        _listeners: listeners,
        emit(event, payload, cb) {
            emitted.push({ event, payload, hasCb: typeof cb === 'function' });
            if (typeof options.onEmit === 'function') {
                options.onEmit(event, payload, cb);
            }
        },
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
            return socket;
        },
        once(event, fn) {
            const wrapper = (...args) => {
                socket.off(event, wrapper);
                return fn(...args);
            };
            return socket.on(event, wrapper);
        },
        off(event, fn) {
            const list = listeners.get(event);
            if (!list) return socket;
            listeners.set(event, list.filter((entry) => entry !== fn));
            return socket;
        },
        trigger(event, ...args) {
            const list = [...(listeners.get(event) || [])];
            for (const fn of list) {
                fn(...args);
            }
        },
        connect() {
            socket.connected = true;
            socket.trigger('connect');
            return socket;
        },
        disconnect() {
            socket.connected = false;
            socket.trigger('disconnect', 'io client disconnect');
            return socket;
        }
    };

    return socket;
}

/**
 * Creates a lightweight `window` stub with event listener and history tracking.
 *
 * @param {object} [options]
 * @returns {object}
 */
function createMockWindow(options = {}) {
    const listeners = new Map();
    return {
        _listeners: listeners,
        location: {
            protocol: 'http:',
            origin: 'http://localhost:3000',
            pathname: '/',
            search: '',
            hash: '',
            reload: () => {},
            ...(options.location || {})
        },
        history: {
            pushState: () => {},
            replaceState: () => {},
            ...(options.history || {})
        },
        matchMedia: options.matchMedia || (() => ({ matches: false })),
        addEventListener(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
        },
        removeEventListener(event, fn) {
            const list = listeners.get(event);
            if (!list) return;
            listeners.set(event, list.filter((entry) => entry !== fn));
        },
        dispatchEvent(event = {}) {
            const list = [...(listeners.get(event.type) || [])];
            for (const fn of list) {
                fn(event);
            }
        }
    };
}

module.exports = {
    ROOT_DIR,
    CLIENT_MODULES_DIR,
    APP_ENTRY_PATH,
    loadClientModules,
    createMockSocket,
    createMockWindow
};
