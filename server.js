import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// CORS и обработка запросов
app.all('*', async (req, res) => {
    // Настройки CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const targetUrl = req.query.target;
    if (!targetUrl) {
        return res.status(400).send('Missing target');
    }

    try {
        // Готовим заголовки
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'OnikaAnime/1.0 (https://t.me/onikaanime)',
        };

        // Для GraphQL всегда передаем тело как строку
        let body = undefined;
        if (req.method === 'POST' && req.body) {
            body = JSON.stringify(req.body);
        }

        // Логируем запрос (поможет при отладке)
        console.log(`[Proxy] ${req.method} -> ${targetUrl}`);
        if (body) console.log(`[Proxy] Body: ${body.slice(0, 200)}...`);

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: body,
        });

        // Проверяем, что вернул сервер
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error(`[Proxy] Ошибка: API вернул не JSON (${response.status}). Ответ: ${text.slice(0, 200)}`);
            return res.status(502).send(`API вернул не JSON: ${text.slice(0, 200)}`);
        }

        const data = await response.json();
        
        // Логируем ответ (для отладки)
        if (data.errors) {
            console.error(`[Proxy] Ошибка от API:`, data.errors);
        }

        res.status(response.status).json(data);
    } catch (e) {
        console.error(`[Proxy] Критическая ошибка:`, e.message);
        res.status(500).send('Proxy Error: ' + e.message);
    }
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
