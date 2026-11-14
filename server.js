import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 10000;

// ============ ENV ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wsaykqhojwfhpqzxptke.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AUTH_MAX_AGE_SEC = 86400;

if (!BOT_TOKEN) console.warn('⚠️ BOT_TOKEN не задан — Telegram-авторизация не работает');
if (!SUPABASE_SERVICE_KEY) console.warn('⚠️ SUPABASE_SERVICE_KEY не задан — Telegram-авторизация не работает');

const supabaseAdmin = (SUPABASE_SERVICE_KEY && SUPABASE_URL)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    })
    : null;

// ============ MIDDLEWARE ============
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов, попробуйте позже' }
}));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// ============ WHITELIST ПРОКСИ ============
const ALLOWED_HOSTS = new Set([
    'graphql.anilist.co',
    'shikimori.io',
    'aniliberty.top',
    'api.anilibria.tv'
]);

// ============ TELEGRAM AUTH ============
function verifyTelegramAuth(data) {
    const { hash, ...fields } = data;
    if (!hash) return { ok: false, reason: 'no_hash' };

    const dataCheckString = Object.keys(fields)
        .sort()
        .map(k => `${k}=${fields[k]}`)
        .join('\n');

    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (computedHash !== hash) return { ok: false, reason: 'invalid_signature' };

    const authDate = parseInt(fields.auth_date, 10);
    const now = Math.floor(Date.now() / 1000);
    if (!authDate || now - authDate > AUTH_MAX_AGE_SEC) {
        return { ok: false, reason: 'expired' };
    }

    return { ok: true, user: fields };
}

app.post('/api/telegram-auth', async (req, res) => {
    try {
        if (!supabaseAdmin || !BOT_TOKEN) {
            return res.status(503).json({ error: 'Telegram auth не настроен на сервере' });
        }

        const verification = verifyTelegramAuth(req.body);
        if (!verification.ok) {
            return res.status(401).json({ error: 'Подпись недействительна', reason: verification.reason });
        }

        const tg = verification.user;
        const tgId = String(tg.id);
        const email = `tg_${tgId}@onika.local`;
        const nickname = (tg.username || tg.first_name || `user${tgId}`).slice(0, 12);
        const avatarUrl = tg.photo_url || '';

        const { data: listData, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
            page: 1, perPage: 1000
        });
        if (listErr) throw listErr;

        let authUser = (listData.users || []).find(u => u.email === email);
        let isNewUser = false;

        if (!authUser) {
            const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
                email,
                email_confirm: true,
                user_metadata: {
                    nickname,
                    telegram_id: tgId,
                    telegram_username: tg.username || null,
                    telegram_first_name: tg.first_name || null,
                    telegram_last_name: tg.last_name || null,
                    avatar_url: avatarUrl
                }
            });
            if (createErr) throw createErr;
            authUser = created.user;
            isNewUser = true;
        } else {
            await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
                user_metadata: {
                    ...authUser.user_metadata,
                    nickname,
                    telegram_username: tg.username || null,
                    avatar_url: avatarUrl
                }
            });
        }

        const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
            type: 'magiclink',
            email
        });
        if (linkErr) throw linkErr;

        const url = new URL(linkData.properties.action_link);
        const hashParams = new URLSearchParams(url.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if (!accessToken) return res.status(500).json({ error: 'Не удалось сгенерировать сессию' });

        const { data: existingProfile } = await supabaseAdmin
            .from('users').select('*').eq('id', authUser.id).single();

        if (!existingProfile) {
            await supabaseAdmin.from('users').insert({
                id: authUser.id,
                name: nickname,
                avatar_url: avatarUrl,
                xp: 0, coins: 0,
                episodes_watched: 0, minutes_watched: 0,
                days_streak: 1,
                unlocked_achievements: []
            });
        } else if (avatarUrl && !existingProfile.avatar_url) {
            await supabaseAdmin.from('users').update({ avatar_url: avatarUrl }).eq('id', authUser.id);
        }

        await supabaseAdmin.from('users')
            .update({ telegram_id: tgId, telegram_username: tg.username || null })
            .eq('id', authUser.id);

        const { data: profile } = await supabaseAdmin
            .from('users').select('*').eq('id', authUser.id).single();

        return res.json({
            token: accessToken,
            refresh_token: refreshToken,
            user: profile,
            isNewUser
        });
    } catch (e) {
        console.error('Telegram auth error:', e);
        return res.status(500).json({ error: e.message || 'Внутренняя ошибка' });
    }
});

// ============ ПРОКСИ ============
app.all('*', async (req, res) => {
    const targetUrl = req.query.target;
    if (!targetUrl) return res.status(400).send('Missing target');

    let parsed;
    try { parsed = new URL(targetUrl); } catch { return res.status(400).send('Invalid URL'); }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        return res.status(403).send('Host not allowed: ' + parsed.hostname);
    }

    try {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'OnikaAnime/1.0 (https://t.me/onikaanime)'
        };

        let body;
        if (req.method === 'POST' && req.body) body = JSON.stringify(req.body);

        console.log(`[Proxy] ${req.method} -> ${targetUrl}`);

        const response = await fetch(targetUrl, { method: req.method, headers, body });

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await response.text();
            console.error(`[Proxy] Не JSON (${response.status}): ${text.slice(0, 200)}`);
            return res.status(502).send(`API вернул не JSON: ${text.slice(0, 200)}`);
        }

        if (response.status === 204) return res.status(204).end();

        const data = await response.json();
        if (data.errors) console.error('[Proxy] Ошибки API:', data.errors);

        res.status(response.status).json(data);
    } catch (e) {
        console.error('[Proxy] Критическая ошибка:', e.message);
        res.status(500).send('Proxy Error: ' + e.message);
    }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, tgAuth: !!supabaseAdmin }));

app.listen(PORT, () => {
    console.log(`✅ Proxy running on port ${PORT}`);
    console.log(`   Telegram auth: ${supabaseAdmin ? 'ON' : 'OFF (нет SUPABASE_SERVICE_KEY)'}`);
});
