const axios = require('axios');
const scraper = require('./scraper');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REQ_HEADERS = {
  'User-Agent': BROWSER_UA,
  Referer: 'https://cinetucumano.com.ar/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Mode': 'navigate'
};

async function fetchDirect(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: REQ_HEADERS, signal: ctrl.signal, redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, body, via: 'direct' };
  } catch { return null; } finally { clearTimeout(t); }
}

async function fetchViaJina(url) {
  try {
    const target = url.startsWith('http') ? url : `https://${url}`;
    const res = await axios.get(`https://r.jina.ai/${target}`, {
      timeout: 20000, headers: { 'X-Return-Format': 'html', Accept: 'text/html' }, validateStatus: null
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : '', via: 'jina' };
  } catch { return null; }
}

async function fetchViaAllOrigins(url) {
  try {
    const res = await axios.get(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
      timeout: 15000, headers: { Accept: 'text/html' }, validateStatus: null
    });
    const body = typeof res.data === 'string' ? res.data : '';
    return { status: res.status, body, via: 'allorigins' };
  } catch { return null; }
}

async function fetchViaCorsProxy(url) {
  try {
    const res = await axios.get(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
      timeout: 15000, headers: { Accept: 'text/html' }, validateStatus: null
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : '', via: 'corsproxy' };
  } catch { return null; }
}

const TRANSPORTS = { direct: fetchDirect, jina: fetchViaJina, allorigins: fetchViaAllOrigins, corsproxy: fetchViaCorsProxy };
let transportOrder = (process.env.CT_RESOLVER || 'direct,jina,allorigins,corsproxy').split(',').map(s => s.trim()).filter(Boolean);
let preferredTransport = null;

let jinaQueue = Promise.resolve();
let jinaLastCalledAt = 0;
const JINA_MIN_INTERVAL_MS = parseInt(process.env.JINA_INTERVAL_MS || '800', 10);
function throttledJina(url) {
  const call = () => fetchViaJina(url).then(r => { jinaLastCalledAt = Date.now(); return r; });
  const run = jinaQueue.then(() => {
    const wait = JINA_MIN_INTERVAL_MS - (Date.now() - jinaLastCalledAt);
    return wait > 0 ? new Promise(r => setTimeout(r, wait)).then(call) : call();
  });
  jinaQueue = run.catch(() => {});
  return run;
}

function hasPlayerConfig(r) { return Boolean(r && r.status === 200 && r.body && r.body.includes('window.playerConfig')); }
function hasHlsJson(r) {
  if (!r || r.status !== 200 || !r.body) return false;
  try { const j = JSON.parse(r.body); return Boolean(j && j.request && j.request.files); } catch { return false; }
}
function isUsable(r) { return hasHlsJson(r) || hasPlayerConfig(r); }

let jinaRetries = 0;
const JINA_BACKOFF_MS = parseInt(process.env.JINA_BACKOFF_MS || '1500', 10);

async function downloadPlayerData(urlConfig, urlHtml) {
  const order = preferredTransport ? [preferredTransport, ...transportOrder.filter(t => t !== preferredTransport)] : transportOrder;
  for (const name of order) {
    const fetcher = TRANSPORTS[name];
    if (!fetcher) continue;
    let result = null;
    if (name === 'jina') result = await throttledJina(urlConfig);
    else result = await fetcher(urlConfig);
    if (isUsable(result)) { preferredTransport = name; return result; }
    const fallback = name === 'jina' ? await throttledJina(urlHtml) : await fetcher(urlHtml);
    if (isUsable(fallback)) { preferredTransport = name; return fallback; }
  }
  const orderHasJina = transportOrder.includes('jina') || preferredTransport === 'jina';
  if (orderHasJina && jinaRetries < 2) {
    jinaRetries += 1;
    const delay = JINA_BACKOFF_MS * jinaRetries;
    const retry = await new Promise(resolve => setTimeout(() => resolve(throttledJina(urlConfig)), delay));
    if (isUsable(retry)) { jinaRetries = 0; preferredTransport = 'jina'; return retry; }
    const retry2 = await new Promise(resolve => setTimeout(() => resolve(throttledJina(urlHtml)), delay));
    if (isUsable(retry2)) { jinaRetries = 0; preferredTransport = 'jina'; return retry2; }
    if (jinaRetries >= 2) jinaRetries = 0;
  }
  return null;
}

function extractBalancedJson(text, startIndex) {
  let depth = 0, inString = false, escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return text.slice(startIndex, i + 1); }
  }
  return null;
}

function extractPlayerConfig(html) {
  const idx = html.indexOf('window.playerConfig');
  if (idx === -1) return null;
  const s = html.indexOf('{', idx);
  if (s === -1) return null;
  const raw = extractBalancedJson(html, s);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function parseConfigFromBody(body) {
  if (!body) return null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      if (j.request && j.request.files) return j;
      if (j.video || j.config) return j.request ? j : null;
    } catch {}
  }
  return extractPlayerConfig(body);
}

async function getVideoMeta(vimeoId, fresh = false) {
  const meta = await scraper.getVimeoVideo(vimeoId);
  if (!fresh || !meta || !meta.player_embed_url) return meta;
  const res = await axios.get(`${scraper.BASE_URL}/api/vimeo/videos`, {
    params: { videoId: vimeoId }, headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' }, timeout: 12000, validateStatus: null
  });
  return res.status === 200 && res.data && res.data.uri ? res.data : meta;
}

const streamCache = new Map();
const STREAM_CACHE_TTL = 10 * 60 * 1000;

async function resolveStreams(vimeoId) {
  const cached = streamCache.get(String(vimeoId));
  if (cached && Date.now() < cached.expires) return cached.value;

  let videoMeta = await getVideoMeta(vimeoId);
  const extractHash = (meta) => { try { return meta && meta.player_embed_url ? new URL(meta.player_embed_url).searchParams.get('h') : null; } catch { return null; } };

  const buildUrls = (hash) => {
    const h = hash ? `?h=${hash}` : '';
    return {
      config: `https://player.vimeo.com/video/${vimeoId}/config${h}`,
      html: `https://player.vimeo.com/video/${vimeoId}${h}`
    };
  };

  let { config: urlConfig, html: urlHtml } = buildUrls(extractHash(videoMeta));
  let result = await downloadPlayerData(urlConfig, urlHtml);

  if (!isUsable(result)) {
    await new Promise(r => setTimeout(r, 800));
    videoMeta = await getVideoMeta(vimeoId, true);
    ({ config: urlConfig, html: urlHtml } = buildUrls(extractHash(videoMeta)));
    result = await downloadPlayerData(urlConfig, urlHtml);
  }

  if (!result || !isUsable(result)) throw new Error(`Player Vimeo bloqueado (401/Turnstile) para ${vimeoId} - relays agotados`);

  const config = parseConfigFromBody(result.body);
  const req = config && config.request;
  const files = (req && req.files) || {};
  const streams = [];
  const progressive = Array.isArray(files.progressive) ? files.progressive : [];
  for (const f of progressive.sort((a, b) => (b.width || 0) - (a.width || 0))) streams.push({ quality: `${f.height || '?'}p`, url: f.url });
  if (!streams.length && files.hls && files.hls.cdns) {
    const cdns = files.hls.cdns;
    const cdnKey = (files.hls.default_cdn && cdns[files.hls.default_cdn] && files.hls.default_cdn) || Object.keys(cdns)[0];
    const hlsUrl = cdns[cdnKey] && (cdns[cdnKey].avc_url || cdns[cdnKey].url);
    if (hlsUrl) streams.push({ quality: config.video && config.video.height ? `${config.video.height}p` : 'HLS', url: hlsUrl });
  }
  if (files.hls && files.hls.cdns && !streams.length) {
    const alt = files.dash || files.dash_cdns;
    if (alt) throw new Error(`Solo DASH disponible para ${vimeoId}`);
  }
  const subtitles = ((req && req.text_tracks) || []).map(t => ({ url: t.url, lang: t.lang || 'es', label: t.label || 'Subtitulos' }));
  const duration = (config && config.video && config.video.duration) || (videoMeta && videoMeta.duration) || null;
  if (!streams.length) throw new Error(`No se pudo resolver stream para ${vimeoId}`);
  const value = { streams, subtitles, duration };
  streamCache.set(String(vimeoId), { value, expires: Date.now() + STREAM_CACHE_TTL });
  return value;
}

async function getEmbedUrl(vimeoId) {
  try { const meta = await getVideoMeta(vimeoId, true); if (meta && meta.player_embed_url) return meta.player_embed_url; } catch {}
  return `https://player.vimeo.com/video/${vimeoId}`;
}

async function diagnose(vimeoId = '1172680712') {
  const out = {};
  const meta = await getVideoMeta(vimeoId, true).catch(e => ({ error: e.message }));
  let playerUrl = `https://player.vimeo.com/video/${vimeoId}`;
  if (meta && meta.player_embed_url) { out.siteApi = { ok: true, hash: new URL(meta.player_embed_url).searchParams.get('h') }; playerUrl = meta.player_embed_url; } else out.siteApi = { ok: false, detail: meta };
  const configUrl = playerUrl.includes('/config') ? playerUrl : playerUrl.replace('/video/', '/video/').split('?')[0] + '/config' + (playerUrl.includes('?') ? '?' + playerUrl.split('?')[1] : '');
  for (const [name, fn] of Object.entries(TRANSPORTS)) {
    const t0 = Date.now();
    const r = name === 'jina' ? await fetchViaJina(playerUrl) : await fn(playerUrl);
    out[`playerVia_${name}`] = { status: r ? r.status : null, ms: Date.now() - t0, hasConfig: Boolean(r && r.body && r.body.includes('window.playerConfig')), hasHlsJson: hasHlsJson(r) };
  }
  out.transportOrder = transportOrder; out.preferredTransport = preferredTransport; out.playerUrl = playerUrl; out.configUrl = configUrl;
  return out;
}

module.exports = { resolveStreams, getEmbedUrl, diagnose };
