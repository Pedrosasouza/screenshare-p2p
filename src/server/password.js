const { scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
    if (typeof password !== 'string' || !password) {
        return { hash: null, salt: null };
    }
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 32);
    return { hash, salt };
}

async function verifyPassword(password, storedHash, storedSalt) {
    if (typeof password !== 'string' || !password || !Buffer.isBuffer(storedHash) || !Buffer.isBuffer(storedSalt)) {
        return false;
    }
    try {
        const derivedKey = await scryptAsync(password, storedSalt, storedHash.length);
        return timingSafeEqual(derivedKey, storedHash);
    } catch (_) {
        return false;
    }
}

module.exports = {
    hashPassword,
    verifyPassword
};
