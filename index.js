// index.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

let proxies = [];
let currentProxyIndex = 0;

function loadProxies() {
  const filePath = path.join(__dirname, "proxies.txt");
  proxies = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map(p => p.trim())
    .filter(Boolean);
  if (!proxies.length) {
    throw new Error("Файл proxies.txt пуст");
  }
}

function getNextProxy() {
  const raw = proxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  return raw.startsWith("http") ? raw : `http://${raw}`;
}

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
];

function getRandomUA() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function fetchTinEye(url, pageNum) {
  let lastError;

  for (let i = 0; i < proxies.length; i++) {
    const proxy = getNextProxy();
    const ua = getRandomUA();

    const agent = new HttpsProxyAgent(proxy);
    const searchUrl = `https://tineye.com/api/v1/result_json/?page=${pageNum}&url=${encodeURIComponent(url)}&tags=stock`;

    try {
      const res = await fetch(searchUrl, {
        agent,
        headers: {
          "User-Agent": ua,
          "Accept": "application/json,text/plain,*/*",
          "Referer": "https://tineye.com/"
        },
        timeout: 15000
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();

    } catch (err) {
      lastError = err;
      console.warn(`Ошибка с прокси ${proxy}: ${err.message}`);
    }
  }

  throw lastError;
}

app.get("/tineye", async (req, res) => {
  const { url, page = 1 } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Нужно передать параметр "url"' });
  }

  try {
    if (!proxies.length) loadProxies();
    const data = await fetchTinEye(url, page);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// для Vercel — экспортируем app
module.exports = app;
