import express from 'express';
import cors from 'cors';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHIKIMORI_API = 'https://shikimori.io/api';
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

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
  if (!Number.isSafeInteger(sid) || sid <= 0) {
    throw new Error('Invalid shikimori_id');
  }
  return sid;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\\[\\[[^\\]]*\\]\\]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function imageUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return value.startsWith('http') ? value : `https://shikimori.io${value}`;
  }
  return value.original || value.preview || value.x96 || null;
}

function toRow(anime, screenshots = []) {
  const id = sidFrom(anime?.id);
  const aired = anime?.aired_on ? String(anime.aired_on).slice(0, 4) : null;
  const images = anime?.image || {};

  return {
    shikimori_id: id,
    title_en: anime?.name || null,
    title_ru: anime?.russian || anime?.name || null,
    description: cleanText(anime?.description) || null,
    rating: anime?.score == null ? null : Number(anime.score),
    episodes: anime?.episodes == null ? null : Number(anime.episodes),
    release_year: aired ? Number(aired) : null,
    status: anime?.status || null,
    genres: Array.isArray(anime?.genres)
      ? anime.genres.map(x => x?.russian || x?.name).filter(Boolean)
      : [],
    screenshots: screenshots.map(imageUrl).filter(Boolean),
    poster_path: imageUrl(images.original || images.preview || images.x96),
    banner_path: null,
    source: 'shikimori',
    fetched_at: new Date().toISOString()
  };
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function readRows(ids) {
  if (!ids.length) return [];
  const query = `anime_catalog?select=*&shikimori_id=in.(${ids.join(',')})`;
  return supabase(query);
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
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'OnikaAnime/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Shikimori ${response.status}`);
  }
  return response.json();
}

function validCatalogPath(path) {
  let url;
  try {
    url = new URL(path, SHIKIMORI_API);
  } catch {
    return false;
  }

  if (url.origin !== SHIKIMORI_API) return false;
  return /^\\/animes(?:\\/\\d+)?(?:\\/screenshots)?$/.test(url.pathname);
}

app.get('/api/anime/:id', async (req, res) => {
  if (!requireConfig(res)) return;

  let id;
  try {
    id = sidFrom(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const rows = await readRows([id]);
    const cached = rows[0];
    const fetchedAt = cached?.fetched_at ? Date.parse(cached.fetched_at) : 0;
    const fresh = Boolean(cached && fetchedAt && Date.now() - fetchedAt < CACHE_TTL_MS);

    if (fresh) return res.json(cached);

    const [anime, screenshots] = await Promise.all([
      shiki(`/animes/${id}`),
      shiki(`/animes/${id}/screenshots`).catch(() => [])
    ]);

    const row = toRow(anime, Array.isArray(screenshots) ? screenshots : []);
    await upsertRows([row]);
    return res.json(row);
  } catch (error) {
    console.error('Anime cache error:', error);

    try {
      const oldRows = await readRows([id]);
      if (oldRows[0]) return res.json({ ...oldRows[0], stale: true });
    } catch (fallbackError) {
      console.error('Stale cache error:', fallbackError);
    }

    return res.status(502).json({ error: 'Anime cache unavailable' });
  }
});

app.get('/api/anime-catalog', async (req, res) => {
  if (!requireConfig(res)) return;

  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter(id => Number.isSafeInteger(id) && id > 0)
    .slice(0, 100);

  try {
    return res.json(await readRows(ids));
  } catch (error) {
    console.error('Catalog cache read error:', error);
    return res.status(502).json({ error: 'Supabase read failed' });
  }
});

app.get('/api/catalog', async (req, res) => {
  if (!requireConfig(res)) return;

  try {
    const rawPath = String(req.query.path || '');
    if (!validCatalogPath(rawPath)) {
      return res.status(400).json({ error: 'Unsupported catalog path' });
    }

    const data = await shiki(rawPath);
    if (Array.isArray(data)) {
      const rows = data
        .filter(item => item?.id)
        .map(item => toRow(item));
      await upsertRows(rows);
    }

    return res.json(data);
  } catch (error) {
    console.error('Catalog proxy error:', error);
    return res.status(502).json({ error: 'Catalog unavailable' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Onika API listening on ${PORT}`);
});
