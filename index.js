const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const port = process.env.PORT || 3000;

const BRIGHTDATA_USERNAME = 'bgawesom@gmail.com';
const BRIGHTDATA_API_KEY = '5c5b53aa79e568b7097c11310970d888ecc19caad1d9b5c5075ea1044890a062';

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36",
  // остальные user-agent
];

const badUserAgents = new Set();

function getRandomUserAgent() {
  const available = userAgents.filter(ua => !badUserAgents.has(ua));
  if (available.length === 0) {
    badUserAgents.clear();
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
  return available[Math.floor(Math.random() * available.length)];
}

async function fetchWithRetry(searchUrl, maxRetries = 5) {
  let browser;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const userAgent = getRandomUserAgent();

    try {
      // Сессия для прокси
      const sessionId = Math.floor(Math.random() * 10000);

      // Только хост и порт в proxy-server (без логина и пароля)
      const proxyHost = 'zproxy.lum-superproxy.io:22225';

      browser = await puppeteer.launch({
        args: [...chromium.args, `--proxy-server=${proxyHost}`],
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const page = await browser.newPage();
      await page.setUserAgent(userAgent);

      // Аутентификация на прокси
      await page.authenticate({
        username: `${BRIGHTDATA_USERNAME}-session-${sessionId}`,
        password: BRIGHTDATA_API_KEY,
      });

      const response = await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      if (!response || !response.ok()) {
        throw new Error(`HTTP status ${response ? response.status() : 'no response'}`);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      const content = await page.evaluate(() => document.body.innerText);

      let json;
      try {
        json = JSON.parse(content);
      } catch {
        throw new Error('Не удалось распарсить JSON от TinEye');
      }

      await browser.close();
      return json;

    } catch (err) {
      lastError = err;
      badUserAgents.add(userAgent);

      if (browser) {
        await browser.close();
      }

      console.warn(`Попытка ${attempt} не удалась с user-agent ${userAgent}: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  throw lastError;
}

app.get('/tineye', async (req, res) => {
  const { page = 1, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Отсутствует параметр "url"' });
  }

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}&tags=stock`;

  try {
    const result = await fetchWithRetry(searchUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

app.listen(port, () => {
  console.log(`TinEye proxy listening on port ${port}`);
});
