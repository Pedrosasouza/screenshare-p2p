'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');

async function loadModules() {
    const [prefsMod, roomModalMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/preferences.js')).href),
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/room-modal.js')).href)
    ]);
    return { ...prefsMod, ...roomModalMod };
}

test('Salas Recentes: persistência e renderização no room-modal', async (t) => {
    const mods = await loadModules();

    await t.test('saveRecentRoom, loadRecentRooms, removeRecentRoom e clearRecentRooms respeitam limite, deduplicação e sanitização', () => {
        const storage = createMockStorage();

        assert.deepEqual(mods.loadRecentRooms(storage), []);

        mods.saveRecentRoom('ab', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), []);

        mods.saveRecentRoom('sala-1', storage);
        mods.saveRecentRoom('sala-2', storage);
        mods.saveRecentRoom('sala-3', storage);
        mods.saveRecentRoom('sala-1', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), ['sala-1', 'sala-3', 'sala-2']);

        mods.saveRecentRoom('sala-4', storage);
        mods.saveRecentRoom('sala-5', storage);
        mods.saveRecentRoom('sala-6', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), ['sala-6', 'sala-5', 'sala-4', 'sala-1', 'sala-3']);

        mods.removeRecentRoom('sala-4', storage);
        assert.deepEqual(mods.loadRecentRooms(storage), ['sala-6', 'sala-5', 'sala-1', 'sala-3']);

        mods.clearRecentRooms(storage);
        assert.deepEqual(mods.loadRecentRooms(storage), []);
    });

    await t.test('renderRecentRooms exibe lista, consulta check-room, remove item e redireciona sala com senha para view join', () => {
        const storage = createMockStorage();
        mods.saveRecentRoom('sala-publica', storage);
        mods.saveRecentRoom('sala-privada', storage);
        mods.saveRecentRoom('sala-atual', storage);

        const recentRoomsSection = createMockElement('div', { id: 'recentRoomsSection', hidden: true });
        const recentRoomsList = createMockElement('div', { id: 'recentRoomsList' });
        const btnClearRecentRooms = createMockElement('button', { id: 'btnClearRecentRooms' });
        const inputJoinRoomId = createMockElement('input', { id: 'inputJoinRoomId' });
        const inputJoinRoomPassword = createMockElement('input', { id: 'inputJoinRoomPassword' });
        const roomViewChoice = createMockElement('div', { id: 'roomViewChoice', style: { display: 'block' } });
        const roomViewCreate = createMockElement('div', { id: 'roomViewCreate', style: { display: 'none' } });
        const roomViewJoin = createMockElement('div', { id: 'roomViewJoin', style: { display: 'none' } });
        const roomModal = createMockElement('div', { id: 'roomModal', hidden: false, style: { display: 'flex' } });

        const dom = {
            roomModal,
            roomViewChoice,
            roomViewCreate,
            roomViewJoin,
            recentRoomsSection,
            recentRoomsList,
            btnClearRecentRooms,
            inputJoinRoomId,
            inputJoinRoomPassword
        };
        const doc = createMockDocument(dom, { createElement: (tag) => createMockElement(tag) });

        const emittedJoin = [];
        const socket = {
            connected: true,
            emit(event, payload, cb) {
                if (event === 'check-room' && typeof cb === 'function') {
                    if (payload.roomId === 'sala-privada') {
                        cb({ exists: true, memberCount: 3, hasPassword: true });
                    } else if (payload.roomId === 'sala-publica') {
                        cb({ exists: false, memberCount: 0, hasPassword: false });
                    }
                } else if (event === 'join-room') {
                    emittedJoin.push(payload);
                }
            }
        };

        const state = {
            roomId: 'sala-atual',
            clientId: 'c_test',
            currentUserName: 'Pedro',
            pendingRoomJoin: null
        };

        const ctrl = mods.createRoomModalController({
            state,
            dom,
            getSocket: () => socket,
            getSessionRoomPassword: () => '',
            clearSessionRoomPassword: () => {},
            documentObj: doc,
            storage,
            windowObj: { location: { search: '', hash: '', pathname: '/' } }
        });

        ctrl.bindEvents();
        ctrl.openRoomModal('choice');

        assert.equal(recentRoomsSection.hidden, false);
        assert.equal(recentRoomsList.children.length, 3);

        // Primeiro item é a sala atual
        const firstRow = recentRoomsList.children[0];
        assert.ok(firstRow.className.includes('is-current'));

        // Segundo item é sala-privada (3 online + hasPassword) -> clicar abre view join
        const privateRow = recentRoomsList.children[1];
        const privateMainBtn = privateRow.children[0];
        privateMainBtn.dispatchEvent({ type: 'click' });
        assert.equal(inputJoinRoomId.value, 'sala-privada');
        assert.equal(roomViewJoin.hidden, false);

        // Volta para choice e clica no botão remover de sala-publica
        ctrl.switchRoomView('choice');
        const publicRow = recentRoomsList.children[2];
        const removeBtn = publicRow.children[1];
        removeBtn.dispatchEvent({ type: 'click', stopPropagation: () => {} });
        assert.equal(recentRoomsList.children.length, 2);

        // Limpar tudo esconde o botão Limpar e exibe estado vazio na seção
        btnClearRecentRooms.dispatchEvent({ type: 'click' });
        assert.equal(recentRoomsSection.hidden, false);
        assert.equal(btnClearRecentRooms.hidden, true);
        assert.equal(recentRoomsList.children.length, 1);
        assert.equal(recentRoomsList.children[0].className, 'recent-rooms-empty');
    });
});
