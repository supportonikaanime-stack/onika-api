// OnikaAnime API: сохранение кэша Shikimori в Supabase.
// Node 18+; SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY задаются только в окружении сервера.
import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
app.use(express.json({ limit: '100kb' }));

const allowed = new Set(['title_en','title_ru','description','rating','episodes','release_year','status','genres','screenshots','poster_path','banner_path','source']);
function cleanRecord(body) {
  const sid = Number(body?.shikimori_id);
  if (!Number.isSafeInteger(sid) || sid <= 0) throw Object.assign(new Error('Invalid shikimori_id'), { status: 400 });
  const row = { shikimori_id: sid, fetched_at: new Date().toISOString() };
  for (const key of allowed) if (Object.hasOwn(body, key)) row[key] = body[key];
  if (row.title_en != null && typeof row.title_en !== 'string') throw Object.assign(new Error('title_en must be text'), { status: 400 });
  if (row.title_ru != null && typeof row.title_ru !== 'string') throw Object.assign(new Error('title_ru must be text'), { status: 400 });
  if (row.description != null && typeof row.description !== 'string') row.description = String(row.description);
  for (const key of ['rating','episodes','release_year']) if (row[key] != null && !Number.isFinite(Number(row[key]))) throw Object.assign(new Error(`${key} must be numeric`), { status: 400 });
  for (const key of ['genres','screenshots']) if (row[key] != null && !Array.isArray(row[key])) throw Object.assign(new Error(`${key} must be an array`), { status: 400 });
  row.source = 'shikimori';
  return row;
}

app.get('/api/anime-catalog', async (req, res) => {
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server Supabase credentials are not configured' });
  const ids = String(req.query.ids || '').split(',').map(Number).filter(x => Number.isSafeInteger(x) && x > 0).slice(0, 100);
  if (!ids.length) return res.json([]);
  const url = new URL('/rest/v1/anime_catalog', SUPABASE_URL);
  url.searchParams.set('select','shikimori_id,title_en,title_ru,description,rating,episodes,release_year,status,genres,screenshots,poster_path,banner_path,source,fetched_at');
  url.searchParams.set('shikimori_id', `in.(${ids.join(',')})`);
  try {
    const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: 'Supabase read failed', detail: text.slice(0,500) });
    res.type('application/json').send(text);
  } catch (e) { res.status(502).json({ error: 'Supabase unavailable' }); }
});

app.post('/api/anime-catalog', async (req, res) => {
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server Supabase credentials are not configured' });
  let row;
  try { row = cleanRecord(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/anime_catalog?on_conflict=shikimori_id`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row)
    });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: 'Supabase upsert failed', detail: text.slice(0,1000) });
    res.status(200).type('application/json').send(text || JSON.stringify({ ok: true, shikimori_id: row.shikimori_id }));
  } catch (e) { res.status(502).json({ error: 'Supabase unavailable' }); }
});

app.listen(PORT, () => console.log(`Onika API listening on ${PORT}`));
