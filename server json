import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// CORS и обработка запросов
app.all('*', async (req, res) => {
    // Настройки CORS, чтобы твой сайт на GitHub Pages мог делать запросы
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    // Берем целевой URL из параметра ?target=
    const targetUrl = req.query.target;
    if (!targetUrl) {
        return res.status(400).send('Missing target');
    }

    try {
        // Готовим заголовки для API (Shikimori требует User-Agent)
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'OnikaAnime/1.0 (https://t.me/onikaanime)',
        };

        // Делаем запрос к API (Shikimori / AniLibria)
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            // Передаем тело запроса, если это POST (для GraphQL Shikimori)
            body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (e) {
        res.status(500).send('Proxy Error: ' + e.message);
    }
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
