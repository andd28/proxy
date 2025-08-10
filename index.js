const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36',
  // Добавь свои варианты user-agent если хочешь
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

app.get('/tineye', async (req, res) => {
  const { page = 1, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter' });
  }

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const pageP = await browser.newPage();

    const ua = getRandomUserAgent();
    await pageP.setUserAgent(ua);

    // Переходим на страницу
    const response = await pageP.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    if (!response || !response.ok()) {
      // Возвращаем статус ошибки от сервера TinEye
      const statusCode = response ? response.status() : 'no response';
      return res.status(500).json({ error: `Ошибка HTTP: ${statusCode}` });
    }

    // Ждём дополнительно 3 секунды — чтобы всё загрузилось
    await pageP.waitForTimeout(3000);

    // Получаем тело страницы как текст
    const content = await pageP.evaluate(() => document.body.innerText);

    // Пробуем распарсить JSON
    let json;
    try {
      json = JSON.parse(content);
    } catch (e) {
      // При ошибке парсинга делаем скриншот и отсылаем его в base64
      const screenshotBuffer = await pageP.screenshot({ encoding: 'base64', fullPage: true });

      return res.status(500).json({
        error: 'Failed to parse JSON from TinEye',
        parseError: e.toString(),
        rawContent: content,
        screenshotBase64: screenshotBuffer,
      });
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(json);

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(port, () => {
  console.log(`TinEye proxy listening on port ${port}`);
});
