const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/tineye', async (req, res) => {
  const { page = 1, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter' });
  }

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });
    const pageP = await browser.newPage();

    await pageP.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

    await pageP.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const content = await pageP.evaluate(() => document.body.innerText);

    let json;
    try {
      json = JSON.parse(content);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse JSON from TinEye', raw: content });
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
