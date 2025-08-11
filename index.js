// index.js
const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch");
const { SocksProxyAgent } = require("socks-proxy-agent");

const app = express();
const PORT = process.env.PORT || 3000;

// Читаем список прокси из файла
let proxies = fs
  .readFileSync("proxies.txt", "utf-8")
  .split("\n")
  .map(p => p.trim())
  .filter(Boolean);

console.log(`Загружено ${proxies.length} прокси из proxies.txt`);

async function fetchWithProxy(url) {
  for (let proxy of proxies) {
    try {
      console.log(`Пробую прокси: ${proxy}`);
      const agent = new SocksProxyAgent(`socks4://${proxy}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 секунд

      const res = await fetch(url, { agent, signal: controller.signal });

      clearTimeout(timeout);

      if (!res.ok) {
        console.log(`Прокси ${proxy} вернул статус ${res.status}`);
        continue;
      }

      const text = await res.text();
      console.log(`✅ Успех через прокси: ${proxy}`);
      return text;

    } catch (err) {
      console.log(`❌ Ошибка на прокси ${proxy}: ${err.message}`);
      continue;
    }
  }

  throw new Error("Нет доступных прокси");
}

app.get("/tineye", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send("Укажите ?url=...");
  }

  try {
    const data = await fetchWithProxy(targetUrl);
    res.send(data);
  } catch (err) {
    res.status(500).send(`Ошибка: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
