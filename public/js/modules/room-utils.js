export function sanitizeRoomId(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .trim()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 64);
}

export function generateRandomRoomId() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    const array = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(array);
    } else {
        for (let i = 0; i < 8; i++) array[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 8; i++) {
        code += chars[array[i] % chars.length];
    }
    return `grid-${code.slice(0, 4)}-${code.slice(4)}`;
}
