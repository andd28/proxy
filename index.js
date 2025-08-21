// index.js — надёжная версия с хедж-запросами и корректной обработкой "Too simple"

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // v2
const { SocksProxyAgent } = require("socks-proxy-agent");

const proxiesPath = path.join(__dirname, "proxies.txt");

// ===== Конфиг =====
const requestsPerProxy = 20;
const perProxyTimeoutMs = parseInt(process.env.PROXY_TIMEOUT_MS || "9000", 10);
const proxyConcurrency = Math.max(1, parseInt(process.env.PROXY_CONCURRENCY || "3", 10));
const userAgent =
  process.env.TINEYE_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ===== Загрузка прокси =====
let proxies = [];
try {
  proxies = fs
    .readFileSync(proxiesPath, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Загружено прокси: ${proxies.length}`);
} catch (e) {
  console.error("Ошибка чтения proxies.txt:", e.message);
}

if (proxies.length === 0) console.warn("⚠️ Список прокси пуст.");

// Текущее состояние
let currentProxyIndex = 0;
let requestCounter = 0;

// ===== Утилиты =====
function normalizeProxy(line) {
  return /^[a-z]+:\/\//i.test(line) ? line : `socks4://${line}`;
}

function createAgent(proxyLine) {
  return new SocksProxyAgent(normalizeProxy(proxyLine));
}

function switchProxy() {
  if (proxies.length === 0) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
  console.log(`➡️ Переключились на прокси #${currentProxyIndex}: ${proxies[currentProxyIndex]}`);
}

function isTooSimple(json) {
  return (
    json &&
    typeof json.error === "string" &&
    json.error.toLowerCase().includes("too simple")
  );
}

function isValidTinEyeJson(json) {
  if (!json || typeof json !== "object") return false;
  if (typeof json.page === "number" && json.query && typeof json.num_matches === "number") return true;
  if (Array.isArray(json.matches) || Array.isArray(json.results)) return true;
  return false;
}

// ===== Один запрос через прокси =====
async function fetchViaProxy(url, idx, controller) {
  const proxy = proxies[idx];
  const agent = createAgent(proxy);

  const res = await fetch(url, {
    agent,
    timeout: perProxyTimeoutMs,
    signal: controller.signal,
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} via ${proxy}`);

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Invalid JSON via ${proxy}: ${e.message}`);
  }

  if (isValidTinEyeJson(json)) return { idx, json };
  if (isTooSimple(json)) return { idx, json };

  throw new Error(`Suspicious JSON via ${proxy}`);
}

// ===== Хедж-запрос (гонка) =====
async function hedgedFetch(url) {
  if (proxies.length === 0) throw new Error("Нет доступных прокси");

  if (requestCounter >= requestsPerProxy) {
    console.log(`🔄 Лимит ${requestsPerProxy} на прокси, переключаемся`);
    switchProxy();
  }

  const tried = new Set();
  let start = currentProxyIndex;
  const errors = [];

  while (tried.size < proxies.length) {
    const batch = [];
    for (let i = 0; i < proxyConcurrency && tried.size < proxies.length; i++) {
      let idx = start;
      let spin = 0;
      while (tried.has(idx) && spin < proxies.length) {
        idx = (idx + 1) % proxies.length;
        spin++;
      }
      if (tried.has(idx)) break;
      batch.push(idx);
      tried.add(idx);
      start = (idx + 1) % proxies.length;
    }

    if (batch.length === 0) break;

    const controllers = batch.map(() => new AbortController());
    const tasks = batch.map((idx, k) =>
      fetchViaProxy(url, idx, controllers[k]).catch((err) => {
        errors.push(err.message);
        throw err;
      })
    );

    try {
      const { idx, json } = await Promise.any(tasks);
      controllers.forEach((c, k) => {
        if (batch[k] !== idx) c.abort();
      });
      currentProxyIndex = idx;
      requestCounter++;
      return json;
    } catch {
      console.warn(`❌ Батч ${batch.join(",")} провалился`);
    }
  }

  throw new Error(`Все прокси упали. Ошибки: ${errors.slice(-5).join(" || ")}`);
}

// ===== Vercel handler =====
module.exports = async (req, res) => {
  try {
    const base = `https://${req.headers.host || "example.com"}`;
    const reqUrl = new URL(req.url, base);
    const page = reqUrl.searchParams.get("page") || "1";
    const imageUrl = reqUrl.searchParams.get("url");
    const tags = reqUrl.searchParams.get("tags");

    if (!imageUrl) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    }

    let searchUrl = `https://tineye.com/api/v1/result_json/?page=${encodeURIComponent(page)}&url=${encodeURIComponent(
      imageUrl
    )}`;
    if (tags) searchUrl += `&tags=${encodeURIComponent(tags)}`;

    console.log("🔍 TinEye URL:", searchUrl);

    const json = await hedgedFetch(searchUrl);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(json));
  } catch (err) {
    console.error("Handler error:", err.message);
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: err.message }));
  }
};

// ===== Локальный тест =====
if (require.main === module) {
  const express = require("express");
  const app = express();
  app.get("/tineye", module.exports);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🚀 Local test: http://localhost:${port}/tineye`));
}
