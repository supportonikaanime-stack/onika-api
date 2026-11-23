// OnikaAnime API — RelaxDev PostgreSQL
// DATABASE_URL is provided by RelaxDev. Keep it server-side only.
import express from 'express';
import pg from 'pg';
const { Pool } = pg;
const app = express();
const PORT = Number(process.env['PORT']) || 8080;
const DATABASE_URL = process.env['DATABASE_URL'] || '';
const allowedOrigins = new Set((process.env['ALLOWED_ORIGINS'] || 'https://relaxdev.ru,https://www.relaxdev.ru').split(',').map(x=>x.trim()).filter(Boolean));
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({limit:'100kb'}));
app.use('/api/', (req,res,next)=>{const origin=req.headers.origin;if(origin&&allowedOrigins.has(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}if(req.method==='OPTIONS')return res.sendStatus(origin&&!allowedOrigins.has(origin)?403:204);next();});
const limits=new Map();
app.use('/api/',(req,res,next)=>{const now=Date.now(),key=req.ip||'unknown';let x=limits.get(key);if(!x||now-x.start>60000)x={start:now,count:0};x.count++;limits.set(key,x);if(x.count>90)return res.status(429).json({error:'Too many requests'});next();});
let pool;
function db(){if(!pool){if(!DATABASE_URL)throw Object.assign(new Error('DATABASE_URL is not configured'),{status:503});pool=new Pool({connectionString:DATABASE_URL,ssl:false,max:10,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});}return pool;}
const columns=['title_en','title_ru','description','rating','episodes','release_year','status','genres','screenshots','poster_path','banner_path'];
function validate(body){if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('JSON object required'),{status:400});const id=Number(body.shikimori_id);if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Valid positive shikimori_id required'),{status:400});const r={shikimori_id:id};for(const k of columns){if(!(k in body))continue;let v=body[k];if(v===null){r[k]=null;continue;}if(['title_en','title_ru','description','status','poster_path','banner_path'].includes(k)){if(typeof v!=='string')throw Object.assign(new Error(`${k} must be a string or null`),{status:400});r[k]=v.slice(0,k==='description'?20000:2000);}else if(['rating','episodes','release_year'].includes(k)){if(v===''){r[k]=null;continue;}const n=Number(v);if(!Number.isFinite(n))throw Object.assign(new Error(`${k} must be numeric or null`),{status:400});r[k]=n;}else if(['genres','screenshots'].includes(k)){if(!Array.isArray(v))throw Object.assign(new Error(`${k} must be an array or null`),{status:400});r[k]=JSON.stringify(v.slice(0,k==='genres'?100:50));}}return r;}
async function init(){await db().query(`CREATE TABLE IF NOT EXISTS anime_catalog (shikimori_id BIGINT PRIMARY KEY, title_en TEXT, title_ru TEXT, description TEXT, rating DOUBLE PRECISION, episodes INTEGER, release_year INTEGER, status TEXT, genres JSONB, screenshots JSONB, poster_path TEXT, banner_path TEXT, source TEXT NOT NULL DEFAULT 'shikimori', fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);}
app.get('/',(_q,r)=>r.json({ok:true,service:'onika-api',health:'/health'}));
app.get('/health',(_q,r)=>r.json({ok:true,service:'onika-api'}));
app.get('/api/health',(_q,r)=>r.json({ok:true,service:'onika-api'}));
app.get('/api/anime-catalog',async(req,res,next)=>{try{const ids=String(req.query.ids||'').split(',').map(x=>Number(x.trim())).filter(x=>Number.isSafeInteger(x)&&x>0).slice(0,100);if(!ids.length)return res.json([]);const {rows}=await db().query('SELECT shikimori_id,title_en,title_ru,description,rating,episodes,release_year,status,genres,screenshots,poster_path,banner_path,source,fetched_at FROM anime_catalog WHERE shikimori_id = ANY($1::bigint[])',[ids]);res.json(rows);}catch(e){next(e);}});
app.post('/api/anime-catalog',async(req,res,next)=>{try{const row=validate(req.body);const keys=Object.keys(row);const vals=keys.map(k=>row[k]);const jsonCols=new Set(['genres','screenshots']);const placeholders=keys.map((k,i)=>`$${i+1}${jsonCols.has(k)?'::jsonb':''}`);const update=keys.filter(k=>k!=='shikimori_id').map(k=>`${k}=EXCLUDED.${k}`).concat(["source='shikimori'","fetched_at=NOW()","updated_at=NOW()"]).join(',');const sql=`INSERT INTO anime_catalog (${keys.join(',')}) VALUES (${placeholders.join(',')}) ON CONFLICT (shikimori_id) DO UPDATE SET ${update} RETURNING *`;const {rows}=await db().query(sql,vals);res.json(rows[0]);}catch(e){next(e);}});
app.use((e,_q,res,_n)=>{const status=Number(e.status)||500;if(status>=500)console.error('API error:',e.message);res.status(status).json({error:status>=500?'Database/API error':e.message});});
init().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`Onika API listening on ${PORT}; PostgreSQL ready`))).catch(e=>{console.error('Database initialization failed:',e.message);process.exit(1);});
