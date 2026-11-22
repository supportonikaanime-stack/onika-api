// OnikaAnime API — Node.js 18+ (native fetch)
// Required environment variables:
//   SUPABASE_URL=https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<secret service-role key>
// Optional:
//   PORT=10000
//   ALLOWED_ORIGINS=https://relaxdev.ru,https://www.relaxdev.ru
// Keep the service-role key only in the server's secret environment variables.

import express from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://relaxdev.ru,https://www.relaxdev.ru')
    .split(',').map(x => x.trim()).filter(Boolean)
);

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb', strict: true }));

// Basic per-IP limit for public API routes (in-memory; resets on redeploy).
const buckets = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 90;
app.use('/api/', (req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let item = buckets.get(key);
  if (!item || now - item.start >= WINDOW_MS) item = { start: now, count: 0 };
  item.count += 1;
  buckets.set(key, item);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start >= WINDOW_MS) buckets.delete(k);
  }
  if (item.count > MAX_REQUESTS) return res.status(429).json({ error: 'Too many requests; retry later' });
  next();
});

// CORS: set ALLOWED_ORIGINS to the exact website origins, comma-separated.
app.use('/api/', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && !allowedOrigins.has(origin) ? 403 : 204);
  next();
});

const allowedFields = new Set([
  'title_en', 'title_ru', 'description', 'rating', 'episodes', 'release_year',
  'status', 'genres', 'screenshots', 'poster_path', 'banner_path'
]);
const numericFields = ['rating', 'episodes', 'release_year'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function getSupabaseConfig() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'Supabase server credentials are not configured');
  let parsed;
  try { parsed = new URL(SUPABASE_URL); } catch { throw httpError(500, 'SUPABASE_URL is invalid'); }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw httpError(500, 'SUPABASE_URL must use HTTPS');
  return parsed.origin;
}

function normalizeRow(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'JSON object required');
  const sid = Number(body.shikimori_id);
  if (!Number.isSafeInteger(sid) || sid <= 0) throw httpError(400, 'Valid positive shikimori_id is required');

  const row = { shikimori_id: sid, source: 'shikimori', fetched_at: new Date().toISOString() };
  for (const key of allowedFields) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value === null) { row[key] = null; continue; }
    if (['title_en', 'title_ru', 'description', 'status', 'poster_path', 'banner_path'].includes(key)) {
      if (typeof value !== 'string') throw httpError(400, `${key} must be a string or null`);
      row[key] = value.slice(0, key === 'description' ? 20000 : 2000);
    } else if (numericFields.includes(key)) {
      if (value === '') { row[key] = null; continue; }
      const n = Number(value);
      if (!Number.isFinite(n)) throw httpError(400, `${key} must be numeric or null`);
      row[key] = n;
    } else if (key === 'genres' || key === 'screenshots') {
      if (!Array.isArray(value)) throw httpError(400, `${key} must be an array or null`);
      row[key] = value.slice(0, key === 'screenshots' ? 50 : 100);
    }
  }
  return row;
}

async function supabaseFetch(path, options = {}) {
  const origin = getSupabaseConfig();
  const response = await fetch(`${origin}/rest/v1/${path}`, {
    ...options,
    signal: AbortSignal.timeout(15_000),
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    console.error('Supabase request failed:', response.status, text.slice(0, 1000));
    throw httpError(502, 'Supabase request failed; inspect server logs');
  }
  return text;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'onika-api' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'onika-api' }));

app.get('/api/anime-catalog', async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').split(',')
      .map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0);
    const uniqueIds = [...new Set(ids)].slice(0, 100);
    if (!uniqueIds.length) return res.json([]);
    const params = new URLSearchParams();
    params.set('select', 'shikimori_id,title_en,title_ru,description,rating,episodes,release_year,status,genres,screenshots,poster_path,banner_path,source,fetched_at');
    params.set('shikimori_id', `in.(${uniqueIds.join(',')})`);
    const text = await supabaseFetch(`anime_catalog?${params.toString()}`);
    res.type('application/json').send(text);
  } catch (err) { next(err); }
});

app.post('/api/anime-catalog', async (req, res, next) => {
  try {
    const row = normalizeRow(req.body);
    const params = new URLSearchParams({ on_conflict: 'shikimori_id' });
    const text = await supabaseFetch(`anime_catalog?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(row)
    });
    res.status(200).type('application/json').send(text || JSON.stringify({ ok: true, shikimori_id: row.shikimori_id }));
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid JSON' });
  const status = Number(err.status) || 500;
  if (status >= 500) console.error('API error:', err?.message || err);
  res.status(status).json({ error: status >= 500 ? (err.message || 'Internal server error') : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Onika API listening on ${PORT}`);
  if (!SUPABASE_URL || !SERVICE_KEY) console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable');
});
