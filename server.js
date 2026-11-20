import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;
const FANART_API_KEY = process.env.FANART_API_KEY;
const FANART_BASE_URL = 'https://webservice.fanart.tv/v3';

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

const ALLOWED_HOSTS = new Set([
  'graphql.anilist.co',
  'shikimori.io',
  'aniliberty.top',
  'webservice.fanart.tv'
]);

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

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.start > RATE_WINDOW * 2) rateBuckets.delete(ip);
  }
}, RATE_WINDOW).unref?.();

// Cache artwork responses for 6 hours.
const artworkCache = new Map();
const ARTWORK_TTL = 6 * 60 * 60 * 1000;

function getCached(key) {
  const entry = artworkCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    artworkCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  artworkCache.set(key, { value, expiresAt: Date.now() + ARTWORK_TTL });
  if (artworkCache.size > 2000) {
    const oldestKey = artworkCache.keys().next().value;
    if (oldestKey) artworkCache.delete(oldestKey);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    timeout: 15000,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'OnikaAnime/1.0',
      ...options.headers
    }
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    const error = new Error(`Upstream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function firstImage(items = []) {
  const item = items.find(x => x && typeof x.url === 'string' && /^https:\/\//i.test(x.url));
  return item?.url || null;
}

// This route is served by the same Express app as the generic proxy.
app.get('/api/anime-images', rateLimit, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const shikimoriId = String(req.query.shikimoriId || '').trim();
  if (!/^\d+$/.test(shikimoriId)) {
    return res.status(400).json({ error: 'shikimoriId must be a numeric ID' });
  }
  if (!FANART_API_KEY) {
    return res.status(503).json({ error: 'Fanart.tv is not configured on the server' });
  }

  const cacheKey = `artwork:${shikimoriId}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Shikimori's external-ID endpoint may expose a TVDB ID, depending on the record.
    const shikiUrl = `https://shikimori.io/api/animes/${encodeURIComponent(shikimoriId)}`;
    const shiki = await fetchJson(shikiUrl, {
      headers: { 'User-Agent': 'OnikaAnime/1.0 (artwork lookup)' }
    });
    const tvdbId = shiki?.external_links?.find(link => /thetvdb\.com/i.test(link?.url || ''))?.url?.match(/\/(\d+)(?:\/|$)/)?.[1]
      || shiki?.tvdb_id
      || null;

    if (!tvdbId) {
      const result = { poster: null, backdrop: null, source: null, reason: 'No TVDB ID available for this Shikimori entry' };
      setCached(cacheKey, result);
      return res.json(result);
    }

    const fanartUrl = `${FANART_BASE_URL}/tv/${encodeURIComponent(tvdbId)}?api_key=${encodeURIComponent(FANART_API_KEY)}`;
    const fanart = await fetchJson(fanartUrl);
    const result = {
      poster: firstImage(fanart.tvposter),
      backdrop: firstImage(fanart.showbackground),
      source: 'fanart.tv',
      tvdbId
    };
    setCached(cacheKey, result);
    return res.json(result);
  } catch (error) {
    console.error('[Artwork] lookup failed:', error.message);
    const status = error.status === 429 ? 429 : 502;
    return res.status(status).json({ error: 'Artwork lookup failed' });
  }
});

// Generic HTTPS proxy. Keep a strict host allowlist; never accept arbitrary hosts.
app.all('*', rateLimit, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const targetUrl = req.query.target;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing target' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Bad URL' });
  }
  if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'Only HTTPS allowed' });
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return res.status(403).json({ error: 'Host not allowed' });

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'OnikaAnime/1.0 (https://t.me/onikaanime)'
      },
      timeout: 15000
    };
    if (req.method === 'POST' && req.body && Object.keys(req.body).length) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    console.log(`[Proxy] ${req.method} -> ${parsed.hostname}${parsed.pathname}`);
    const response = await fetch(targetUrl, fetchOptions);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[Proxy] Non-JSON from ${parsed.hostname} (${response.status}):`, text.slice(0, 200));
      return res.status(502).json({ error: 'Upstream returned non-JSON', status: response.status });
    }
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    return res.status(502).json({ error: 'Proxy request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
