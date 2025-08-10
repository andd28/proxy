import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
const port = process.env.PORT || 3000;

let proxies = [];
let currentProxyIndex = 0;

function loadProxies() {
  const proxiesPath = path.resolve("./proxies.txt");
  proxies = fs.readFileSync(proxiesPath, "utf-8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (proxies.length === 0) {
    throw new Error("Список прокси пуст");
  }
}

function getNextProxy() {
  const proxy = proxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  return proxy;
}

async function fetchWithProxy(url) {
  const proxy = getNextProxy();
  const agent = new HttpsProxyAgent(proxy.startsWith("http") ? proxy : `http://${proxy}`);

  const res = await fetch(url, {
    agent,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    timeout: 20000
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

app.get("/tineye", async (req, res) => {
  try {
    if (proxies.length === 0) loadProxies();

    const { page = 1, url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing "url" parameter' });

    const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}&tags=stock`;
    const data = await fetchWithProxy(searchUrl);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
