import express from 'express';
import cors from 'cors';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHIKIMORI_API = 'https://shikimori.io/api';
const CACHE_TTL_MS = 1000  60  60  6;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '100kb' }));

function requireConfig(res) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'Server Supabase credentials are not configured' });
    return false;
  }
  return true;
}

function sidFrom(value) {
  const sid = Number(value);
  if (!Number.isSafeInteger(sid) || sid <= 0) throw new Error('Invalid shikimori_id');
  return sid;
}

function cleanText(value) {
  return String(value || '').replace(/\\[\\[[^\\]]\\]\\]/g, '').replace(/<[^>]>/g, '').trim();
}

function imageUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.startsWith('http') ? value : https://shikimori.io${value};
  return value.original || value.preview || value.x96 || null;
}

function toRow(a, screenshots = []) {
  const id = sidFrom(a?.id);
  const aired = a?.aired_on ? String(a.aired_on).slice(0, 4) : null;
  const images = a?.image || {};
  return {
    shikimori_id: id,
    title_en: a?.name || null,
    title_ru: a?.russian || a?.name || null,
    description: cleanText(a?.description) || null,
    rating: a?.score == null ? null : Number(a.score),
    episodes: a?.episodes == null ? null : Number(a.episodes),
    release_year: aired ? Number(aired) : null,
    status: a?.status || null,
    genres: Array.isArray(a?.genres) ? a.genres.map(x => x?.russian || x?.name).filter(Boolean) : [],
    screenshots: screenshots.map(imageUrl).filter(Boolean),
    poster_path: imageUrl(images.original || images.preview || images.x96),
    banner_path: null,
    source: 'shikimori',
    fetched_at: new Date().toISOString()
  };
}

async function supabase(path, options = {}) {
  const r = await fetch(${SUPABASE_URL}/rest/v1/${path}, {
    ...options,
    headers: { apikey: SERVICE_KEY, Authorization: Bearer ${SERVICE_KEY}, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(Supabase ${r.status}: ${text.slice(0, 500)});
  return text ? JSON.parse(text) : null;
}

async function readRows(ids) {
  if (!ids.length) return [];
  return supabase(anime_catalog?select=&shikimori_id=in.(${ids.join(',')}));
}

async function upsertRows(rows) {
  if (!rows.length) return;
  await supabase('anime_catalog?on_conflict=shikimori_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
}

async function shiki(path) {
  const url = new URL(path, SHIKIMORI_API);
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'OnikaAnime/1.0' } });
  if (!r.ok) throw new Error(Shikimori ${r.status});
  return r.json();
}

function validCatalogPath(path) {
  const u = new URL(path, SHIKIMORI_API);
  if (u.origin !== SHIKIMORI_API) return false;
  return /^\\/animes(?:\\/\\d+)?(?:\\/screenshots)?$/.test(u.pathname);
}

app.get('/api/anime/:id', async (req, res) => {
  if (!requireConfig(res)) return;
  let id;
  try { id = sidFrom(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }
  try {
    const rows = await readRows([id]);
    const cached = rows[0];
    const fresh = cached && Date.now() - Date.parse(cached.fetched_at || 0) < CACHE_TTL_MS;
    if (fresh) return res.json(cached);
    const [anime, screenshots] = await Promise.all([shiki(/animes/${id}), shiki(/animes/${id}/screenshots).catch(() => [])]);
    const row = toRow(anime, Array.isArray(screenshots) ? screenshots : []);
    await upsertRows([row]);
    return res.json(row);
  } catch (e) {
    try { const old = await readRows([id]); if (old[0]) return res.json({ ...old[0], stale: true }); } catch {}
    return res.status(502).json({ error: 'Anime cache unavailable' });
  }
});

app.get('/api/anime-catalog', async (req, res) => {
  if (!requireConfig(res)) return;
  const ids = String(req.query.ids || '').split(',').map(Number).filter(x => Number.isSafeInteger(x) && x > 0).slice(0, 100);
  try { return res.json(await readRows(ids)); } catch { return res.status(502).json({ error: 'Supabase read failed' }); }
});

app.get('/api/catalog', async (req, res) => {
  if (!requireConfig(res)) return;
  try {
    const rawPath = String(req.query.path || '');
    if (!validCatalogPath(rawPath)) return res.status(400).json({ error: 'Unsupported catalog path' });
    const data = await shiki(rawPath);
    if (Array.isArray(data)) await upsertRows(data.filter(x => x?.id).map(x => toRow(x)));
    return res.json(data);
  } catch { return res.status(502).json({ error: 'Catalog unavailable' }); }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(Onika API listening on ${PORT}));
