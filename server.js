import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ Лимит размера JSON, защита от гигантских body
app.use(express.json({ limit: '100kb' }));

// ✅ Whitelist хостов — защита от SSRF
const ALLOWED_HOSTS = new Set([
    'graphql.anilist.co',
    'shikimori.io',
    'aniliberty.top'
]);

// ✅ Простейший rate-limit в памяти (60 запросов / 60 сек с одного IP)
const rateBuckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60_000;
function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start > RATE_WINDOW) {
        bucket = { start: now, count: 0 };
        rateBuckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    next();
}
// Периодическая очистка старых бакетов
setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of rateBuckets) {
        if (now - b.start > RATE_WINDOW * 2) rateBuckets.delete(ip);
    }
}, RATE_WINDOW);

// ✅ CORS + основной обработчик
app.all('*', rateLimit, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const targetUrl = req.query.target;
    if (!targetUrl || typeof targetUrl !== 'string') {
        return res.status(400).json({ error: 'Missing target' });
    }

    // ✅ Валидация URL и whitelist хостов
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        return res.status(400).json({ error: 'Bad URL' });
    }
    if (parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only HTTPS allowed' });
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        return res.status(403).json({ error: 'Host not allowed' });
    }

    try {
        const fetchOpts = {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'OnikaAnime/1.0 (https://t.me/onikaanime)'
            },
            // ✅ Таймаут на upstream — 15 секунд
            timeout: 15000
        };

        // ✅ Body передаём ТОЛЬКО для POST и только если он есть
        if (req.method === 'POST' && req.body && Object.keys(req.body).length > 0) {
            fetchOpts.body = JSON.stringify(req.body);
        }

        console.log(`[Proxy] ${req.method} -> ${parsed.hostname}${parsed.pathname}`);

        const response = await fetch(targetUrl, fetchOpts);
        const text = await response.text();

        // ✅ Пытаемся распарсить JSON, но не падаем при ошибке
        try {
            const data = JSON.parse(text);
            if (data && data.errors) {
                console.error(`[Proxy] API errors from ${parsed.hostname}:`, JSON.stringify(data.errors).slice(0, 300));
            }
            res.status(response.status).json(data);
        } catch {
            console.error(`[Proxy] Non-JSON from ${parsed.hostname} (${response.status}):`, text.slice(0, 200));
            res.status(502).json({
                error: 'Upstream returned non-JSON',
                status: response.status,
                preview: text.slice(0, 200)
            });
        }
    } catch (e) {
        console.error(`[Proxy] Error:`, e.message);
        res.status(500).json({ error: 'Proxy error: ' + e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
