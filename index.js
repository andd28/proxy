// index.js — надёжная версия: параллельные (hedged) запросы к нескольким прокси,
// возврат первого валидного JSON, строгая фильтрация "Too simple" и аборты остальных запросов.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxiesPath = path.join(__dirname, 'proxies.txt');

// ===== Конфиг =====
const requestsPerProxy = 20; // сколько УСПЕШНЫХ ответов держим «сессию» на одном прокси
const perProxyTimeoutMs = parseInt(process.env.PROXY_TIMEOUT_MS || '9000', 10);
const proxyConcurrency = Math.max(1, parseInt(process.env.PROXY_CONCURRENCY || '3', 10)); // окно гонки
const userAgent =
  process.env.TINEYE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ===== Загрузка прокси =====
let proxies = [];
try {
  proxies = fs
    .readFileSync(proxiesPath, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Загружено прокси из proxies.txt: ${proxies.length}`);
} catch (e) {
  console.error('Ошибка чтения proxies.txt:', e && e.message);
}

if (proxies.length === 0) {
  console.warn('Внимание! Список прокси пуст.');
}

// Текущее состояние «сессии»
let currentProxyIndex = 0;
let requestCounter = 0;

// ===== Утилиты =====
function normalizeProxyUrl(line) {
  // Поддерживаем явные схемы: socks4://, socks5://, http://, https://.
  // Если схема не указана — считаем socks4://
  if (/^[a-z]+:\/\//i.test(line)) return line;
  return `socks4://${line}`;
}

function createAgent(proxyLine) {
  const url = normalizeProxyUrl(proxyLine);
  // Для http(s) прокси socks-proxy-agent неприменим, но в этой задаче мы работаем с SOCKS.
  // Если потребуется HTTP-прокси — используйте hpagent/https-proxy-agent отдельно.
  return new SocksProxyAgent(url);
}

function switchToNextProxy() {
  if (proxies.length === 0) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
  console.log(`Переключились на прокси #${currentProxyIndex}: ${proxies[currentProxyIndex]}`);
}

function isTooSimple(json) {
  try {
    if (!json) return false;
    const text =
      (typeof json.error === 'string' && json.error) ||
      (typeof json.message === 'string' && json.message) ||
      JSON.stringify(json);
    return String(text).toLowerCase().includes('too simple');
  } catch (_) {
    return false;
  }
}

function isValidTinEyeJson(json) {
  if (!json || typeof json !== 'object') return false;
  if (Array.isArray(json.results)) return true; // типичный ключ
  if (Array.isArray(json.matches)) return true; // встречается у некоторых эндпоинтов
  if (typeof json.total === 'number') return true; // иногда присутствует total
  // допускаем пустые результаты, если есть структурные поля
  if ('results' in json && Array.isArray(json.results)) return true;
  return false;
}

// Выполнить один запрос через заданный прокси-индекс. Возвращает Promise, который
// RESOLVE-тся только при валидном JSON (не "Too simple"), иначе REJECT.
async function fetchViaProxyIndex(url, idx, controller) {
  const proxy = proxies[idx];
  const agent = createAgent(proxy);

  const res = await fetch(url, {
    agent,
    timeout: perProxyTimeoutMs,
    signal: controller.signal,
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      Connection: 'keep-alive',
    },
  });

  if (res.status === 429) {
    throw new Error(`HTTP 429 via ${proxy}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} via ${proxy}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Invalid JSON via ${proxy}: ${e.message || e}`);
  }

  if (isTooSimple(json)) {
    throw new Error(`TinEye Too Simple via ${proxy}`);
  }

  if (!isValidTinEyeJson(json)) {
    throw new Error(`Suspicious JSON (no results/matches) via ${proxy}`);
  }

  // Валидный ответ
  return { idx, json };
}

// Гонка: параллельный запрос по нескольким прокси, возврат первого валидного JSON.
// Остальные запросы — abort.
async function hedgedFetch(url) {
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст или не загружен');
  }

  // Если достигли лимит успешных ответов на текущем — заранее переключимся.
  if (requestCounter >= requestsPerProxy) {
    console.log(`Достигнут лимит ${requestsPerProxy} успешных ответов — меняем прокси`);
    switchToNextProxy();
  }

  const tried = new Set();
  let start = currentProxyIndex;
  let totalRemaining = proxies.length;
  const errorsLog = [];

  // Пока есть непробованные прокси
  while (totalRemaining > 0) {
    // Сформируем батч индексов
    const batchIdxs = [];
    for (let i = 0; i < proxyConcurrency && totalRemaining > 0; i++) {
      // найдём следующий непробованный индекс
      let idx = start;
      let spin = 0;
      while (tried.has(idx) && spin < proxies.length) {
        idx = (idx + 1) % proxies.length;
        spin++;
      }
      if (tried.has(idx)) break; // обошли круг
      batchIdxs.push(idx);
      tried.add(idx);
      totalRemaining--;
      start = (idx + 1) % proxies.length;
    }

    if (batchIdxs.length === 0) break;

    const controllers = batchIdxs.map(() => new AbortController());

    // Строим промисы: success -> resolve({idx,json}), failure -> reject(Error)
    const tasks = batchIdxs.map((idx, k) =>
      fetchViaProxyIndex(url, idx, controllers[k]).catch((err) => {
        errorsLog.push(err && err.message ? err.message : String(err));
        throw err;
      })
    );

    try {
      // Ждём первый успешный
      const { idx, json } = await Promise.any(tasks);

      // Абортим остальные
      controllers.forEach((c, k) => {
        if (batchIdxs[k] !== idx) {
          try {
            c.abort();
          } catch (_) {}
        }
      });

      // Зафиксируем «сессию»: успешный прокси становится текущим, инкрементируем счётчик
      currentProxyIndex = idx;
      requestCounter++;

      return json;
    } catch (aggregate) {
      // Все в батче провалились — продолжаем следующей партией
      const msg = aggregate && aggregate.errors ? aggregate.errors.map((e) => e.message).join(' | ') : String(aggregate);
      console.warn(`Батч ${batchIdxs.join(',')} провалился: ${msg}`);
      // цикл продолжится, если остались непробованные прокси
    }
  }

  const errText =
    'Все прокси вернули ошибки (429/Too simple/timeout/invalid JSON). ' +
    `Попробовано: ${tried.size} из ${proxies.length}. Последние ошибки: ${errorsLog.slice(-5).join(' || ')}`;
  throw new Error(errText);
}

// ===== Vercel handler =====
module.exports = async (req, res) => {
  try {
    const base = `https://${req.headers.host || 'example.com'}`;
    const reqUrl = new URL(req.url, base);
    const page = reqUrl.searchParams.get('page') || '1';
    const imageUrl = reqUrl.searchParams.get('url');
    const tags = reqUrl.searchParams.get('tags');

    if (!imageUrl) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
      return;
    }

    let searchUrl = `https://tineye.com/api/v1/result_json/?page=${encodeURIComponent(page)}&url=${encodeURIComponent(
      imageUrl
    )}`;
    if (tags) {
      searchUrl += `&tags=${encodeURIComponent(tags)}`;
    }

    console.log('TinEye URL:', searchUrl);

    const tineyeJson = await hedgedFetch(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(tineyeJson));
  } catch (err) {
    console.error('Handler error:', err);
    // Если это типичный случай, когда все прокси отстрелялись «Too simple»/таймауты — вернём 502, а не 500
    const message = err && err.message ? err.message : String(err);
    const code = /Все прокси вернули ошибки|Too simple|429|timeout|Invalid JSON|Suspicious JSON/i.test(message)
      ? 502
      : 500;

    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: message }));
  }
};

// ===== Локальный тест =====
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.get('/tineye', module.exports);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server: http://localhost:${port}/tineye`));
}
