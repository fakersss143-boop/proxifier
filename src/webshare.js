// Fetches and picks proxies from the Webshare API. Caches the pool in a
// module-level variable, which persists for the lifetime of a warm Worker
// isolate (good enough for moderate traffic; for heavier load, cache in a
// Cloudflare KV namespace instead so all isolates share one copy).

let poolCache = [];
let lastRefreshed = 0;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function fetchProxyList(env) {
  let results = [];
  let url = `${env.WEBSHARE_API_BASE}/proxy/list/?mode=direct&page=1&page_size=100`;

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Token ${env.WEBSHARE_API_KEY}` } });
    if (!resp.ok) throw new Error(`Webshare API error: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    results = results.concat(
      (data.results || []).map((p) => ({
        address: p.proxy_address,
        port: p.port,
        username: p.username,
        password: p.password,
        countryCode: p.country_code,
        valid: p.valid,
      }))
    );
    url = data.next || null;
  }
  return results.filter((p) => p.valid !== false);
}

export async function pickProxy(env, { countryCode } = {}) {
  if (Date.now() - lastRefreshed > REFRESH_INTERVAL_MS || poolCache.length === 0) {
    poolCache = await fetchProxyList(env);
    lastRefreshed = Date.now();
  }
  if (poolCache.length === 0) throw new Error("No proxies available in pool");

  let candidates = poolCache;
  if (countryCode) {
    const filtered = poolCache.filter((p) => p.countryCode === countryCode.toUpperCase());
    if (filtered.length > 0) candidates = filtered;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}
