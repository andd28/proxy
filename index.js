const fs = require('fs');
const puppeteer = require('puppeteer');

let proxies = [];
let proxyIndex = 0;
let requestCount = 0;
const REQUESTS_PER_PROXY = 10;

function loadProxies() {
    proxies = fs.readFileSync('proxies.txt', 'utf-8')
        .split('\n')
        .map(p => p.trim())
        .filter(Boolean);
}

function getNextProxy() {
    if (proxyIndex >= proxies.length) proxyIndex = 0;
    const proxy = proxies[proxyIndex];
    proxyIndex++;
    return proxy;
}

async function fetchWithProxy(url, proxy) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [`--proxy-server=${proxy}`, '--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // Быстрая проверка, что прокси живой
        try {
            await page.goto('https://example.com', { timeout: 8000 });
        } catch (err) {
            throw new Error(`Прокси ${proxy} не отвечает`);
        }

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        const content = await page.evaluate(() => document.body.innerText);

        return JSON.parse(content);
    } finally {
        if (browser) await browser.close();
    }
}

async function fetchTinEye(urls) {
    loadProxies();
    let results = [];

    for (let i = 0; i < urls.length; i++) {
        if (requestCount % REQUESTS_PER_PROXY === 0 || requestCount === 0) {
            let proxyWorking = false;
            let proxy;
            while (!proxyWorking) {
                proxy = getNextProxy();
                try {
                    console.log(`Пробую прокси: ${proxy}`);
                    // Тестируем на 1 простой запрос
                    await fetchWithProxy('https://example.com', proxy);
                    proxyWorking = true;
                } catch (err) {
                    console.log(`Прокси ${proxy} не работает: ${err.message}`);
                }
            }
            currentProxy = proxy;
        }

        try {
            console.log(`Запрос ${i + 1} через прокси ${currentProxy}`);
            const data = await fetchWithProxy(urls[i], currentProxy);
            results.push({ url: urls[i], data });
        } catch (err) {
            console.log(`Ошибка при запросе ${urls[i]}: ${err.message}`);
        }

        requestCount++;
    }

    return results;
}

// Обработчик Vercel
module.exports = async (req, res) => {
    const { urls } = req.query;
    if (!urls) {
        res.status(400).send({ error: 'Не переданы ссылки' });
        return;
    }

    const urlList = Array.isArray(urls) ? urls : urls.split(',');
    try {
        const data = await fetchTinEye(urlList);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).send({ error: err.message });
    }
};
