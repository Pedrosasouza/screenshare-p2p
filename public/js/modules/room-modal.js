import { sanitizeRoomId, generateRandomRoomId } from './room-utils.js';
import {
    STORAGE_KEY,
    saveUserName,
    loadRecentRooms,
    removeRecentRoom,
    clearRecentRooms
} from './preferences.js';
import {
    getSessionRoomPassword as defaultGetSessionPass,
    clearSessionRoomPassword as defaultClearSessionPass
} from './signaling-url.js';
import { activateModalFocus, restoreModalFocus } from './modal-a11y.js';

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
 *   getSocket?: () => any,
 *   onCleanupRoomState?: (opts?: any) => void,
 *   getMembership?: () => { isRoomMembershipConfirmed: boolean },
 *   showToast?: ShowToastFn,
 *   getSessionRoomPassword?: (targetRoomId: string, sessionStore?: Storage | null) => string,
 *   clearSessionRoomPassword?: (sessionStore?: Storage | null) => void,
 *   onThemeInit?: () => void,
 *   onLoadPreferences?: () => void,
 *   documentObj?: AnyDocument | null,
 *   storage?: Storage | null,
 *   windowObj?: AnyWindow | null
 * }} options
 */
export function createRoomModalController({
    state,
    dom = /** @type {DomRefs} */ ({}),
    getSocket = () => null,
    onCleanupRoomState = () => {},
    getMembership = () => ({ isRoomMembershipConfirmed: true }),
    showToast = /** @type {ShowToastFn} */ (() => {}),
    getSessionRoomPassword = /** @type {(targetRoomId: string, sessionStore?: Storage | null) => string} */ (defaultGetSessionPass),
    clearSessionRoomPassword = defaultClearSessionPass,
    onThemeInit = () => {},
    onLoadPreferences = () => {},
    documentObj = (typeof document !== 'undefined' ? /** @type {AnyDocument} */ (document) : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    windowObj = (typeof window !== 'undefined' ? /** @type {AnyWindow} */ (window) : null)
} = /** @type {any} */ ({})) {
    let checkCreateTimeout = null;
    let checkJoinTimeout = null;
    let previousFocusEl = null;
    let recentRoomsRenderSeq = 0;

    function showRoomError(msg) {
        const { roomErrorBanner } = dom;
        if (!roomErrorBanner) return;
        roomErrorBanner.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span></span>';
        const span = roomErrorBanner.querySelector('span');
        if (span) span.textContent = msg || '';
        roomErrorBanner.hidden = false;
    }

    function clearRoomError() {
        const { roomErrorBanner } = dom;
        if (!roomErrorBanner) return;
        roomErrorBanner.innerHTML = '';
        roomErrorBanner.hidden = true;
    }

    function updateRoomModalCloseButton() {
        const canClose = Boolean(state.roomId);
        if (dom.btnCloseRoomModal) {
            dom.btnCloseRoomModal.hidden = !canClose;
        }
        if (dom.btnCancelRoomModal) {
            dom.btnCancelRoomModal.hidden = !canClose;
        }
        if (dom.roomChoiceCancelContainer) {
            dom.roomChoiceCancelContainer.hidden = !canClose;
        }
    }

    function checkCreateRoomStatus(roomIdToCheck) {
        const indicator = dom.createRoomStatusIndicator;
        if (!indicator) return;
        const cleanId = sanitizeRoomId(roomIdToCheck);
        if (!cleanId || cleanId.length < 3) {
            indicator.textContent = '';
            indicator.className = 'room-status-indicator';
            return;
        }

        const socket = getSocket();
        if (socket && socket.connected) {
            socket.emit('check-room', { roomId: cleanId }, (res) => {
                if (!res) return;
                if (dom.inputCreateRoomId && sanitizeRoomId(dom.inputCreateRoomId.value) !== cleanId) {
                    return;
                }
                if (res.exists) {
                    indicator.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Sala já existe (${res.memberCount} online)`;
                    indicator.className = 'room-status-indicator active';
                } else {
                    indicator.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Código disponível!`;
                    indicator.className = 'room-status-indicator new';
                }
            });
        }
    }

    function checkJoinRoomStatus(roomIdToCheck) {
        const indicator = dom.joinRoomStatusIndicator;
        const hint = dom.joinPasswordHint;
        if (!indicator) return;
        const cleanId = sanitizeRoomId(roomIdToCheck);
        if (!cleanId || cleanId.length < 3) {
            indicator.textContent = '';
            indicator.className = 'room-status-indicator';
            if (hint) {
                hint.textContent = '';
                hint.className = 'password-hint';
            }
            return;
        }

        const socket = getSocket();
        if (socket && socket.connected) {
            socket.emit('check-room', { roomId: cleanId }, (res) => {
                if (!res) return;
                if (dom.inputJoinRoomId && sanitizeRoomId(dom.inputJoinRoomId.value) !== cleanId) {
                    return;
                }
                if (res.exists) {
                    const count = res.memberCount;
                    const lockBadge = res.hasPassword ? ' &bull; <i class="fa-solid fa-lock" title="Protegida por senha"></i> Com senha' : '';
                    indicator.innerHTML = `<i class="fa-solid fa-circle-check"></i> Sala ativa (${count} ${count === 1 ? 'pessoa' : 'pessoas'})${lockBadge}`;
                    indicator.className = 'room-status-indicator active';
                    if (hint) {
                        if (res.hasPassword) {
                            hint.innerHTML = '<i class="fa-solid fa-lock"></i> Requer senha';
                            hint.className = 'password-hint required';
                        } else {
                            hint.innerHTML = 'Sem senha (Pública)';
                            hint.className = 'password-hint optional';
                        }
                    }
                } else {
                    indicator.innerHTML = `<i class="fa-solid fa-circle-info"></i> Sala vazia (será criada ao entrar)`;
                    indicator.className = 'room-status-indicator new';
                    if (hint) {
                        hint.innerHTML = 'Opcional (Deixe em branco p/ pública)';
                        hint.className = 'password-hint optional';
                    }
                }
            });
        }
    }

    function clearElementChildren(el) {
        if (!el) return;
        if (typeof el.replaceChildren === 'function') {
            el.replaceChildren();
            return;
        }
        if (typeof el.removeChild === 'function' && Array.isArray(el.children)) {
            while (el.children.length > 0) {
                el.removeChild(el.children[el.children.length - 1]);
            }
        }
        el.innerHTML = '';
    }

    function renderRecentRooms() {
        const section = dom.recentRoomsSection;
        const list = dom.recentRoomsList;
        if (!section || !list || !documentObj) return;

        const rooms = loadRecentRooms(storage);
        recentRoomsRenderSeq += 1;
        const currentSeq = recentRoomsRenderSeq;

        if (!rooms.length) {
            clearElementChildren(list);
            section.hidden = false;
            if (dom.btnClearRecentRooms) {
                dom.btnClearRecentRooms.hidden = true;
            }
            const emptyState = documentObj.createElement('div');
            emptyState.className = 'recent-rooms-empty';
            emptyState.innerHTML = '<i class="fa-regular fa-clock" aria-hidden="true"></i> <span>Nenhuma sala recente ainda. As salas que você acessar aparecerão aqui.</span>';
            list.appendChild(emptyState);
            return;
        }

        section.hidden = false;
        if (dom.btnClearRecentRooms) {
            dom.btnClearRecentRooms.hidden = false;
        }
        clearElementChildren(list);

        const socket = getSocket();
        const isSocketConnected = Boolean(socket && socket.connected);

        rooms.forEach((roomId) => {
            const isCurrent = Boolean(state.roomId && state.roomId === roomId);
            let roomRequiresPassword = false;

            const itemRow = documentObj.createElement('div');
            itemRow.className = 'recent-room-item' + (isCurrent ? ' is-current' : '');
            itemRow.setAttribute('role', 'listitem');

            const mainBtn = documentObj.createElement('button');
            mainBtn.type = 'button';
            mainBtn.className = 'recent-room-btn';
            mainBtn.setAttribute('aria-label', isCurrent ? `Sala atual: ${roomId}` : `Conectar à sala ${roomId}`);

            const iconWrap = documentObj.createElement('span');
            iconWrap.className = 'recent-room-icon';
            iconWrap.setAttribute('aria-hidden', 'true');
            iconWrap.innerHTML = '<i class="fa-solid fa-hashtag"></i>';

            const infoWrap = documentObj.createElement('span');
            infoWrap.className = 'recent-room-info';

            const idEl = documentObj.createElement('span');
            idEl.className = 'recent-room-id';
            idEl.textContent = roomId;

            const statusPill = documentObj.createElement('span');
            statusPill.className = 'recent-room-pill' + (isCurrent ? ' is-live' : '');

            const dot = documentObj.createElement('span');
            dot.className = 'status-dot';
            dot.setAttribute('aria-hidden', 'true');

            const statusText = documentObj.createElement('span');
            statusText.textContent = isCurrent ? 'Atual' : 'Recente';

            statusPill.appendChild(dot);
            statusPill.appendChild(statusText);

            infoWrap.appendChild(idEl);
            infoWrap.appendChild(statusPill);

            mainBtn.appendChild(iconWrap);
            mainBtn.appendChild(infoWrap);

            mainBtn.addEventListener('click', () => {
                if (state.roomId && state.roomId === roomId) {
                    closeRoomModal();
                    return;
                }
                const restoredPass = getSessionRoomPassword(roomId);
                if (roomRequiresPassword && !restoredPass) {
                    if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = roomId;
                    switchRoomView('join');
                    if (dom.inputJoinRoomPassword) {
                        setTimeout(() => {
                            dom.inputJoinRoomPassword.focus();
                        }, 50);
                    }
                    return;
                }
                joinRoom(roomId, restoredPass);
            });

            const removeBtn = documentObj.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'recent-room-remove';
            removeBtn.title = `Remover ${roomId} das recentes`;
            removeBtn.setAttribute('aria-label', `Remover ${roomId} das recentes`);
            removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeRecentRoom(roomId, storage);
                renderRecentRooms();
            });

            itemRow.appendChild(mainBtn);
            itemRow.appendChild(removeBtn);
            list.appendChild(itemRow);

            if (isSocketConnected && !isCurrent) {
                socket.emit('check-room', { roomId }, (res) => {
                    if (currentSeq !== recentRoomsRenderSeq || !res) return;
                    roomRequiresPassword = Boolean(res.hasPassword);
                    if (res.exists && res.memberCount > 0) {
                        statusPill.className = 'recent-room-pill is-live';
                        statusText.textContent = `${res.memberCount} online`;
                    } else {
                        statusPill.className = 'recent-room-pill';
                        statusText.textContent = 'Vazia';
                    }
                    if (res.hasPassword) {
                        const lockIcon = documentObj.createElement('i');
                        lockIcon.className = 'fa-solid fa-lock recent-room-lock';
                        lockIcon.setAttribute('aria-hidden', 'true');
                        statusPill.appendChild(lockIcon);
                    }
                });
            }
        });
    }

    function rollRandomCreateRoom() {
        clearRoomError();
        const uniqueId = generateRandomRoomId();
        if (dom.inputCreateRoomId) {
            dom.inputCreateRoomId.value = uniqueId;
            checkCreateRoomStatus(uniqueId);
        }
    }

    function switchRoomView(viewName) {
        clearRoomError();
        if (dom.roomViewChoice) {
            dom.roomViewChoice.hidden = (viewName !== 'choice');
        }
        if (dom.roomViewCreate) {
            dom.roomViewCreate.hidden = (viewName !== 'create');
        }
        if (dom.roomViewJoin) {
            dom.roomViewJoin.hidden = (viewName !== 'join');
        }

        if (viewName === 'choice') {
            updateRoomModalCloseButton();
            renderRecentRooms();
        } else if (viewName === 'create') {
            if (dom.inputCreateUserName && state.currentUserName) dom.inputCreateUserName.value = state.currentUserName;
            if (dom.inputCreateRoomId && !dom.inputCreateRoomId.value.trim()) {
                rollRandomCreateRoom();
            } else if (dom.inputCreateRoomId) {
                checkCreateRoomStatus(dom.inputCreateRoomId.value);
            }
            setTimeout(() => {
                if (dom.inputCreateRoomId) {
                    dom.inputCreateRoomId.focus();
                    dom.inputCreateRoomId.select();
                }
            }, 50);
        } else if (viewName === 'join') {
            if (dom.inputJoinUserName && state.currentUserName) dom.inputJoinUserName.value = state.currentUserName;
            if (dom.inputJoinRoomId) checkJoinRoomStatus(dom.inputJoinRoomId.value);
            setTimeout(() => {
                if (dom.inputJoinRoomId) {
                    dom.inputJoinRoomId.focus();
                    if (dom.inputJoinRoomId.value) dom.inputJoinRoomId.select();
                }
            }, 50);
        }
    }

    function openRoomModal(initialView = 'choice') {
        const wasOpen = isRoomModalOpen();
        clearRoomError();
        updateRoomModalCloseButton();
        switchRoomView(initialView);
        if (dom.roomModal) {
            dom.roomModal.classList.remove('hidden');
            dom.roomModal.hidden = false;
            if (typeof dom.roomModal.removeAttribute === 'function') {
                dom.roomModal.removeAttribute('hidden');
            }
            if (!wasOpen) {
                previousFocusEl = activateModalFocus(dom.roomModal, documentObj);
            }
        }
    }

    function closeRoomModal() {
        if (!state.roomId) return;
        if (state.pendingRoomJoin && !state.pendingRoomJoin.inFlight) {
            state.pendingRoomJoin = null;
        }
        clearRoomError();
        if (dom.inputQuickRoomId) {
            dom.inputQuickRoomId.value = '';
        }
        if (dom.roomModal) {
            dom.roomModal.classList.add('hidden');
            dom.roomModal.hidden = true;
            if (typeof dom.roomModal.setAttribute === 'function') {
                dom.roomModal.setAttribute('hidden', '');
            }
        }
        restoreModalFocus(previousFocusEl, documentObj);
        previousFocusEl = null;
    }

    function isRoomModalOpen() {
        return Boolean(
            dom.roomModal &&
            !dom.roomModal.hidden &&
            !(dom.roomModal.classList && typeof dom.roomModal.classList.contains === 'function' && dom.roomModal.classList.contains('hidden'))
        );
    }

    function joinRoom(targetRoomId, targetPass = '', targetUserName = '') {
        clearRoomError();
        const cleanId = sanitizeRoomId(targetRoomId) || generateRandomRoomId();
        if (cleanId.length < 3) {
            openRoomModal('join');
            showRoomError('O código da sala deve ter pelo menos 3 caracteres alfanuméricos.');
            return;
        }
        const newRoomId = cleanId;
        const pendingPassword = (targetPass || '').trim();
        if (targetUserName) {
            state.currentUserName = saveUserName(targetUserName, storage);
        }

        state.pendingRoomJoin = {
            roomId: newRoomId,
            password: pendingPassword,
            userName: state.currentUserName,
            inFlight: false
        };

        const socket = getSocket();
        if (socket && socket.connected) {
            state.pendingRoomJoin.inFlight = true;
            socket.emit('join-room', {
                roomId: state.pendingRoomJoin.roomId,
                clientId: state.clientId,
                password: state.pendingRoomJoin.password,
                userName: state.pendingRoomJoin.userName
            });
        } else {
            showToast('Conectando ao servidor... Você entrará na sala automaticamente.', 'info', 3500);
        }
    }

    function handleConfirmCreate() {
        clearRoomError();
        const rawName = dom.inputCreateUserName ? dom.inputCreateUserName.value.trim().slice(0, 24) : '';
        if (rawName) {
            state.currentUserName = saveUserName(rawName, storage);
        }
        const raw = dom.inputCreateRoomId ? dom.inputCreateRoomId.value : '';
        let newRoomId;
        if (!raw.trim()) {
            newRoomId = generateRandomRoomId();
        } else {
            newRoomId = sanitizeRoomId(raw);
            if (newRoomId.length < 3) {
                showRoomError('Nome de sala inválido. Use pelo menos 3 caracteres alfanuméricos.');
                if (dom.inputCreateRoomId) dom.inputCreateRoomId.focus();
                return;
            }
        }
        if (dom.inputCreateRoomId) dom.inputCreateRoomId.value = newRoomId;
        const pass = dom.inputCreateRoomPassword ? dom.inputCreateRoomPassword.value.trim() : '';
        joinRoom(newRoomId, pass, state.currentUserName);
    }

    function handleConfirmJoin() {
        clearRoomError();
        const rawName = dom.inputJoinUserName ? dom.inputJoinUserName.value.trim().slice(0, 24) : '';
        if (rawName) {
            state.currentUserName = saveUserName(rawName, storage);
        }
        const rawRoom = dom.inputJoinRoomId ? dom.inputJoinRoomId.value : '';
        const newRoomId = sanitizeRoomId(rawRoom);
        if (!newRoomId || newRoomId.length < 3) {
            showRoomError('Por favor, informe um código de sala válido (mínimo de 3 caracteres alfanuméricos).');
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.focus();
            return;
        }
        const pass = dom.inputJoinRoomPassword ? dom.inputJoinRoomPassword.value.trim() : '';
        joinRoom(newRoomId, pass, state.currentUserName);
    }

    function handleQuickJoin() {
        clearRoomError();
        const rawRoom = dom.inputQuickRoomId ? dom.inputQuickRoomId.value : '';
        const cleanRoomId = sanitizeRoomId(rawRoom);
        if (!cleanRoomId || cleanRoomId.length < 3) {
            showRoomError('Informe um código de sala válido (mínimo 3 caracteres alfanuméricos).');
            if (dom.inputQuickRoomId) dom.inputQuickRoomId.focus();
            return;
        }
        const restoredPass = getSessionRoomPassword(cleanRoomId);
        joinRoom(cleanRoomId, restoredPass, state.currentUserName);
    }

    function handleJoinError({ error, message }) {
        console.warn('[Auth] Join error:', error, message);
        const failedRoomId = (state.pendingRoomJoin && state.pendingRoomJoin.roomId) || state.roomId || '';
        state.pendingRoomJoin = null;

        const membership = getMembership();
        if (membership && !membership.isRoomMembershipConfirmed && state.roomId) {
            onCleanupRoomState({ silent: true });
            state.roomId = '';
            state.currentRoomPassword = '';
            if (dom.displayRoomId) {
                dom.displayRoomId.textContent = '------';
            }
            if (storage) {
                try { storage.removeItem(STORAGE_KEY); } catch (_) {}
            }
            updateRoomModalCloseButton();
        }

        openRoomModal('join');
        if (error === 'invalid_password') {
            clearSessionRoomPassword();
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = failedRoomId;
            showRoomError(message || 'Senha incorreta para esta sala.');
            if (dom.inputJoinRoomPassword) {
                dom.inputJoinRoomPassword.focus();
                dom.inputJoinRoomPassword.select();
            }
        } else if (error === 'invalid_room' || error === 'invalid_password_format') {
            clearSessionRoomPassword();
            if (!state.roomId || failedRoomId === state.roomId) {
                state.roomId = '';
                state.currentRoomPassword = '';
                if (storage) {
                    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
                }
                if (windowObj && windowObj.history && windowObj.history.replaceState) {
                    try { windowObj.history.replaceState({}, '', windowObj.location.pathname); } catch (_) {}
                }
                updateRoomModalCloseButton();
            }
            showRoomError(message || 'Código de sala ou formato inválido.');
        } else if (error === 'rate_limited') {
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = failedRoomId;
            showRoomError(message || 'Muitas tentativas incorretas. Aguarde antes de tentar novamente.');
        } else {
            showRoomError(message || 'Erro ao entrar na sala.');
        }
    }

    function setupPasswordToggle(btn, input) {
        if (!btn || !input) return;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            btn.innerHTML = isPassword
                ? '<i class="fa-solid fa-eye-slash"></i>'
                : '<i class="fa-solid fa-eye"></i>';
        });
    }

    function applyInitialUrlAndRestore() {
        onThemeInit();
        onLoadPreferences();

        const loc = windowObj && windowObj.location ? windowObj.location : { search: '', hash: '', pathname: '/' };
        const urlParams = new URLSearchParams(loc.search || '');
        const roomParam = urlParams.get('room');
        const rawHash = (loc.hash || '').replace(/^#/, '');
        const hashParams = new URLSearchParams(rawHash);
        const hashPass = hashParams.get('pass');
        const queryPass = urlParams.get('pass');
        const passParam = hashPass !== null ? hashPass : queryPass;

        if ((hashPass !== null || queryPass !== null) && windowObj && windowObj.history && windowObj.history.replaceState) {
            try {
                urlParams.delete('pass');
                hashParams.delete('pass');
                const remainingQuery = urlParams.toString();
                const remainingHash = hashParams.toString();
                const cleanUrl = `${loc.pathname}${remainingQuery ? '?' + remainingQuery : ''}${remainingHash ? '#' + remainingHash : ''}`;
                windowObj.history.replaceState(windowObj.history.state || {}, '', cleanUrl);
            } catch (_) {}
        }

        if (passParam) {
            if (dom.inputCreateRoomPassword) dom.inputCreateRoomPassword.value = passParam;
            if (dom.inputJoinRoomPassword) dom.inputJoinRoomPassword.value = passParam;
        }

        let savedRoom = null;
        if (storage) {
            try { savedRoom = storage.getItem(STORAGE_KEY); } catch (_) {}
        }

        if (roomParam) {
            const clean = sanitizeRoomId(roomParam);
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = clean;
            if (clean.length >= 3) {
                const restoredPass = passParam || getSessionRoomPassword(clean);
                joinRoom(clean, restoredPass);
            } else {
                openRoomModal('join');
                showRoomError('Código de sala na URL inválido.');
            }
        } else if (savedRoom) {
            const clean = sanitizeRoomId(savedRoom);
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = clean;
            if (clean.length >= 3) {
                const restoredPass = getSessionRoomPassword(clean);
                joinRoom(clean, restoredPass);
            } else {
                if (storage) {
                    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
                }
                openRoomModal('choice');
            }
        } else {
            openRoomModal('choice');
        }
    }

    function bindEvents() {
        setupPasswordToggle(dom.btnToggleCreatePass, dom.inputCreateRoomPassword);
        setupPasswordToggle(dom.btnToggleJoinPass, dom.inputJoinRoomPassword);

        if (dom.btnChooseCreate) dom.btnChooseCreate.addEventListener('click', () => switchRoomView('create'));
        if (dom.btnChooseJoin) dom.btnChooseJoin.addEventListener('click', () => switchRoomView('join'));
        if (dom.btnClearRecentRooms) {
            dom.btnClearRecentRooms.addEventListener('click', () => {
                clearRecentRooms(storage);
                renderRecentRooms();
            });
        }
        if (dom.inputQuickRoomId) {
            dom.inputQuickRoomId.addEventListener('input', clearRoomError);
            dom.inputQuickRoomId.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleQuickJoin();
            });
        }
        if (dom.btnQuickJoin) {
            dom.btnQuickJoin.addEventListener('click', handleQuickJoin);
        }

        if (dom.inputCreateUserName) {
            if (state.currentUserName) dom.inputCreateUserName.value = state.currentUserName;
            dom.inputCreateUserName.addEventListener('input', (e) => {
                state.currentUserName = saveUserName(e.target.value, storage);
                if (dom.inputJoinUserName) dom.inputJoinUserName.value = e.target.value;
            });
        }
        if (dom.btnRandomRoom) dom.btnRandomRoom.addEventListener('click', rollRandomCreateRoom);
        if (dom.btnGenerateRandomQuick) dom.btnGenerateRandomQuick.addEventListener('click', rollRandomCreateRoom);

        if (dom.inputCreateRoomId) {
            dom.inputCreateRoomId.addEventListener('input', () => {
                clearRoomError();
                clearTimeout(checkCreateTimeout);
                checkCreateTimeout = setTimeout(() => {
                    checkCreateRoomStatus(dom.inputCreateRoomId.value);
                }, 250);
            });
            dom.inputCreateRoomId.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmCreate();
            });
        }
        if (dom.inputCreateRoomPassword) {
            dom.inputCreateRoomPassword.addEventListener('input', clearRoomError);
            dom.inputCreateRoomPassword.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmCreate();
            });
        }
        if (dom.btnConfirmCreate) dom.btnConfirmCreate.addEventListener('click', handleConfirmCreate);
        if (dom.btnBackFromCreate) dom.btnBackFromCreate.addEventListener('click', () => switchRoomView('choice'));

        if (dom.inputJoinUserName) {
            if (state.currentUserName) dom.inputJoinUserName.value = state.currentUserName;
            dom.inputJoinUserName.addEventListener('input', (e) => {
                state.currentUserName = saveUserName(e.target.value, storage);
                if (dom.inputCreateUserName) dom.inputCreateUserName.value = e.target.value;
            });
        }
        if (dom.inputJoinRoomId) {
            dom.inputJoinRoomId.addEventListener('input', () => {
                clearRoomError();
                clearTimeout(checkJoinTimeout);
                checkJoinTimeout = setTimeout(() => {
                    checkJoinRoomStatus(dom.inputJoinRoomId.value);
                }, 250);
            });
            dom.inputJoinRoomId.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmJoin();
            });
        }
        if (dom.inputJoinRoomPassword) {
            dom.inputJoinRoomPassword.addEventListener('input', clearRoomError);
            dom.inputJoinRoomPassword.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmJoin();
            });
        }
        if (dom.btnConfirmJoin) dom.btnConfirmJoin.addEventListener('click', handleConfirmJoin);
        if (dom.btnBackFromJoin) dom.btnBackFromJoin.addEventListener('click', () => switchRoomView('choice'));

        if (dom.btnCloseRoomModal) dom.btnCloseRoomModal.addEventListener('click', closeRoomModal);
        if (dom.btnCancelRoomModal) dom.btnCancelRoomModal.addEventListener('click', closeRoomModal);
        if (dom.roomModal) {
            dom.roomModal.addEventListener('click', (e) => {
                if (e.target === dom.roomModal && state.roomId) {
                    closeRoomModal();
                }
            });
        }
        if (dom.btnChangeRoom) dom.btnChangeRoom.addEventListener('click', () => openRoomModal('choice'));
    }

    function cleanup() {
        if (checkCreateTimeout) {
            clearTimeout(checkCreateTimeout);
            checkCreateTimeout = null;
        }
        if (checkJoinTimeout) {
            clearTimeout(checkJoinTimeout);
            checkJoinTimeout = null;
        }
    }

    return {
        showRoomError,
        clearRoomError,
        updateRoomModalCloseButton,
        checkCreateRoomStatus,
        checkJoinRoomStatus,
        rollRandomCreateRoom,
        switchRoomView,
        openRoomModal,
        closeRoomModal,
        isRoomModalOpen,
        joinRoom,
        handleConfirmCreate,
        handleConfirmJoin,
        handleJoinError,
        applyInitialUrlAndRestore,
        renderRecentRooms,
        bindEvents,
        cleanup
    };
}
