const CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' blob:; style-src 'self'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

let warnedMissingProdOrigins = false;

function parseAllowedOrigins(env = process.env) {
    const raw = env && typeof env.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
    const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const isProduction = Boolean(env && env.NODE_ENV === 'production');

    if (allowed.length === 0 && isProduction) {
        const renderUrl = env && typeof env.RENDER_EXTERNAL_URL === 'string'
            ? env.RENDER_EXTERNAL_URL.trim()
            : '';
        if (renderUrl) {
            try {
                const parsed = new URL(renderUrl);
                if (parsed.origin && parsed.origin !== 'null') {
                    allowed.push(parsed.origin);
                }
            } catch (_) {}
        }
        if (allowed.length === 0 && !warnedMissingProdOrigins) {
            warnedMissingProdOrigins = true;
            console.warn('[Security] ALLOWED_ORIGINS não configurado em produção; wildcard CORS desabilitado.');
        }
        return { allowed, allowWildcard: false, isProduction };
    }

    return {
        allowed,
        allowWildcard: allowed.length === 0 && !isProduction,
        isProduction
    };
}

function getCorsOrigin(env = process.env) {
    const { allowed, allowWildcard } = parseAllowedOrigins(env);
    if (allowWildcard) {
        return '*';
    }
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
    const { allowed, allowWildcard } = parseAllowedOrigins(env);
    const reqOrigin = req && req.headers ? req.headers.origin : '';
    if (allowWildcard) {
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
    parseAllowedOrigins,
    getCorsOrigin,
    securityHeadersMiddleware,
    setIceEndpointCorsHeaders
};
