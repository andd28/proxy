import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

let proxies = [];
let currentProxyIndex = 0;
let requestCount = 0;
const REQUESTS_PER_PROXY = 20;

// Загружаем список прокси при старте
function loadProxies() {
  const filePath = path.join(process.cwd(), "proxies.txt");
  if (!fs.existsSync(filePath)) {
    console.error("Файл proxies.txt не найден!");
    process.exit(1);
  }
  proxies = fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `socks4://${p}`);
  if (proxies.length === 0) {
    console.error("Список прокси пуст!");
    process.exit(1);
  }
}

function getNextProxy() {
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  console.log(`🔄 Переключаемся на прокси: ${proxies[currentProxyIndex]}`);
}

async function fetchWithProxy(url) {
  if (requestCount >= REQUESTS_PER_PROXY) {
    requestCount = 0;
    getNextProxy();
  }

  const proxyUrl = proxies[currentProxyIndex];
  const agent = new SocksProxyAgent(proxyUrl);

  try {
    console.log(`🌍 Запрос через ${proxyUrl} → ${url}`);
    requestCount++;

    const response = await fetch(url, { agent });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (err) {
    console.warn(`⚠️ Ошибка прокси ${proxyUrl}: ${err.message}`);
    getNextProxy();
    return fetchWithProxy(url); // повторяем с новым прокси
  }
}

// API-эндпоинт Vercel
export default async function handler(req, res) {
  if (!proxies.length) loadProxies();

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Укажите ?url=" });
  }

  try {
    const html = await fetchWithProxy(targetUrl);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
