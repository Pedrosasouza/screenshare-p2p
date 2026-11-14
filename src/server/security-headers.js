const CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function getCorsOrigin(env = process.env) {
    const raw = env.ALLOWED_ORIGINS;
    if (typeof raw !== 'string' || !raw.trim()) {
        return '*';
    }
    const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length === 0) return '*';
    return (origin, callback) => {
        if (!origin || allowed.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS'));
    };
}

function securityHeadersMiddleware(_req, res, next) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
}

function setIceEndpointCorsHeaders(req, res, env = process.env) {
    const rawAllowed = env.ALLOWED_ORIGINS;
    const reqOrigin = req && req.headers ? req.headers.origin : '';
    if (typeof rawAllowed !== 'string' || !rawAllowed.trim()) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return true;
    }
    const allowed = rawAllowed.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return true;
    }
    if (!reqOrigin || allowed.includes(reqOrigin)) {
        if (reqOrigin) {
            res.setHeader('Access-Control-Allow-Origin', reqOrigin);
            res.setHeader('Vary', 'Origin');
        }
        return true;
    }
    return false;
}

module.exports = {
    CONTENT_SECURITY_POLICY,
    getCorsOrigin,
    securityHeadersMiddleware,
    setIceEndpointCorsHeaders
};
