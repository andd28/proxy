import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

let proxies = [];
let currentProxyIndex = 0;

// Загружаем список прокси
function loadProxies() {
  const proxiesPath = path.resolve("./proxies.txt");
  proxies = fs.readFileSync(proxiesPath, "utf-8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (proxies.length === 0) throw new Error("Список прокси пуст");
}

// Берём следующий прокси по кругу
function getNextProxy() {
  const proxy = proxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  return proxy.startsWith("http") ? proxy : `http://${proxy}`;
}

// Запрос с куками
async function fetchTinEye(url, page = 1) {
  const proxy = getNextProxy();
  const agent = new HttpsProxyAgent(proxy);

  // 1. Получаем куки
  const initRes = await fetch(`https://tineye.com/search?url=${encodeURIComponent(url)}`, {
    agent,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!initRes.ok) {
    throw new Error(`Init request failed: ${initRes.status}`);
  }

  const cookies = initRes.headers.raw()["set-cookie"]
    ?.map(c => c.split(";")[0])
    .join("; ") || "";

  // 2. Запрашиваем JSON API с этими куками
  const apiRes = await fetch(
    `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}&tags=stock`,
    {
      agent,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookies,
        "Referer": "https://tineye.com/"
      }
    }
  );

  if (!apiRes.ok) {
    throw new Error(`API request failed: ${apiRes.status}`);
  }

  return apiRes.json();
}

// Маршрут
app.get("/tineye", async (req, res) => {
  try {
    if (proxies.length === 0) loadProxies();

    const { page = 1, url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing "url" parameter' });

    const data = await fetchTinEye(url, page);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Экспорт для Vercel
export default app;
