import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

async function fetchTinEye(url, page = 1, proxy) {
  const agent = proxy ? new HttpsProxyAgent(proxy.startsWith("http") ? proxy : `http://${proxy}`) : null;

  // 1. Получаем куки с обычной страницы поиска
  const initRes = await fetch(`https://tineye.com/search?url=${encodeURIComponent(url)}`, {
    agent,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const cookies = initRes.headers.raw()["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";

  // 2. Делаем запрос к JSON API с этими куками
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
    throw new Error(`HTTP ${apiRes.status}`);
  }

  return apiRes.json();
}
