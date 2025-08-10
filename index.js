const fs = require('fs');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

let proxies = [];
let proxyIndex = 0;
let requestCount = 0;
const REQUESTS_PER_PROXY = 10;
let currentProxy = null;

function loadProxies() {
    if (proxies.length === 0) {
        proxies = fs.readFileSync('proxies.txt', 'utf-8')
            .split('\n')
            .map(p => p.trim())
            .filter(Boolean);
    }
}

function getNextProxy() {
    if (proxyIndex >= proxies.length) proxyIndex = 0;
    return proxies[proxyIndex++];
}

async function launchBrowser(proxy) {
    const executablePath = await chromium.executablePath;
    return puppeteer.launch({
        args: [...chromium.args, `--proxy-server=${proxy}`],
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless
    });
}

async function testProxy(proxy) {
    let browser;
    try {
        browser = await launchBrowser(proxy);
        const page = await browser.newPage();
        await page.goto('https://example.com', { timeout: 8000, waitUntil: 'domcontentloaded' });
        return true;
    } catch (e) {
        return false;
    } finally {
        if (browser) await browser.close();
    }
}

async function fetchTinEyeJSON(tinEyeUrl) {
    if (!currentProxy || requestCount % REQUESTS_PER_PROXY === 0) {
        let workingProxy = null;
        while (!workingProxy) {
            const proxy = getNextProxy();
            console.log(`Проверяю прокси: ${proxy}`);
            if (await testProxy(proxy)) {
                console.log(`Прокси ${proxy} работает`);
                workingProxy = proxy;
            } else {
                console.log(`Прокси ${proxy} не отвечает`);
            }
        }
        currentProxy = workingProxy;
    }

    requestCount++;

    let browser;
    try {
        browser = await launchBrowser(currentProxy);
        const page = await browser.newPage();
        await page.goto(tinEyeUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        const content = await page.evaluate(() => document.body.innerText);
        return JSON.parse(content);
    } finally {
        if (browser) await browser.close();
    }
}

// Обработчик для Vercel
module.exports = async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        res.status(400).json({ error: 'Не указан параметр url' });
        return;
    }

    try {
        loadProxies();
        const data = await fetchTinEyeJSON(targetUrl);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
