// OnikaAnime API: only a safe Shikimori proxy. No catalog cache and no Supabase writes.
import express from 'express';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = Number(process.env['PORT'] || 10000);
const ALLOWED_ORIGINS = String(process.env['ALLOWED_ORIGINS'] || '*').split(',').map(x => x.trim()).filter(Boolean);
const ALLOWED_HOSTS = new Set(['shikimori.io', 'www.shikimori.io']);

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept,Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'onika-api', catalogCache: false }));

app.get('/', async (req, res) => {
  const target = String(req.query.target || '');
  if (!target) return res.status(400).json({ error: 'target is required', hint: 'Use /?target=https%3A%2F%2Fshikimori.io%2Fapi%2Fanimes' });
  let url;
  try { url = new URL(target); } catch { return res.status(400).json({ error: 'Invalid target URL' }); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return res.status(403).json({ error: 'Host is not allowed' });
  if (!url.pathname.startsWith('/api/')) return res.status(403).json({ error: 'Only Shikimori API paths are allowed' });
  try {
    const upstream = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'OnikaAnime/1.0' } });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (e) { res.status(502).json({ error: 'Shikimori unavailable' }); }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`Onika API listening on ${PORT}; catalog cache disabled`));
