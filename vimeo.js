/**
 * vimeo.js
 * ---------------------------------------------------------------------------
 * Módulo encargado de resolver el stream reproducible a partir del ID de Vimeo.
 *
 * Estrategia:
 *  1. Pedimos al proxy del sitio (/api/vimeo/videos) la metadata del video.
 *     El campo `player_embed_url` trae el hash privado `h` necesario para
 *     acceder al reproductor de videos con privacidad "unlisted".
 *  2. Descargamos el HTML del reproductor (player.vimeo.com/video/<id>?h=<hash>)
 *     y extraemos el objeto global `window.playerConfig`.
 *  3. De ahí salen:
 *       - request.files.progressive[]  -> MP4 directos (si el plan los expone)
 *       - request.files.hls.cdns[*].avc_url -> playlist HLS (m3u8), lo habitual
 *       - request.text_tracks[]        -> subtítulos VTT firmados
 *
 * Nota: las URLs firmadas de Vimeo expiran (~1 hora). Stremio las consume
 * inmediatamente, así que no hay problema; solo conviene no cachear demasiado.
 */

const axios = require('axios');
const { execFile } = require('child_process');
const scraper = require('./scraper');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const http = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': BROWSER_UA,
    Referer: 'https://cinetucumano.com.ar/'
  }
});

/**
 * Descarga una URL usando el binario `curl` del sistema.
 *
 * Por qué curl y no axios: el edge de player.vimeo.com aplica filtrado por
 * huella TLS (JA3) y rechaza con 401 el handshake característico de Node.js,
 * incluso con headers idénticos a un navegador. curl negocia TLS distinto y
 * pasa sin problema. El binario está disponible en Windows 10+, macOS y en
 * las imágenes de runtime de Vercel (@vercel/node sobre Amazon Linux).
 *
 * Devuelve { status, body } o null si curl no está disponible / falla.
 */
function fetchWithCurl(url) {
  return new Promise((resolve) => {
    const args = [
      '-s', '--compressed', '-L', '-m', '20',
      '-A', BROWSER_UA,
      '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.8',
      url,
      '-o', '-',
      '-w', '\n__CT_STATUS__%{http_code}'
    ];
    execFile('curl', args, { timeout: 25000, maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => {
      if (err || typeof stdout !== 'string') return resolve(null);
      const marker = stdout.lastIndexOf('\n__CT_STATUS__');
      if (marker === -1) return resolve(null);
      const status = parseInt(stdout.slice(marker + 14).trim(), 10);
      resolve({ status: Number.isNaN(status) ? 0 : status, body: stdout.slice(0, marker), via: 'curl' });
    });
  });
}

/** Descarga directa con axios (stack TLS de Node). */
async function fetchWithAxios(url) {
  try {
    const res = await http.get(url, {
      headers: { Accept: 'text/html' },
      validateStatus: null
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : '', via: 'axios' };
  } catch {
    return null;
  }
}

/**
 * Descarga vía r.jina.ai (relay gratuito con navegador headless).
 *
 * Vimeo bloquea las IPs de datacenter (Vercel, AWS, etc.) con Cloudflare
 * Turnstile, pero la infraestructura de r.jina.ai sí logra renderizar el
 * player. Con el header X-Return-Format: html devuelve el HTML crudo con
 * window.playerConfig incluido. Sin API key: ~20 req/minuto en el tier free.
 */
async function fetchWithJina(url) {
  try {
    const res = await axios.get(`https://r.jina.ai/${url}`, {
      timeout: 30000,
      headers: { 'X-Return-Format': 'html', Accept: 'text/html' },
      validateStatus: null
    });
    return {
      status: res.status,
      body: typeof res.data === 'string' ? res.data : '',
      via: 'jina'
    };
  } catch {
    return null;
  }
}

const TRANSPORTS = { curl: fetchWithCurl, axios: fetchWithAxios, jina: fetchWithJina };

// Orden de prueba de transportes. CT_RESOLVER permite forzar uno
// (útil para diagnóstico: CT_RESOLVER=jina npm start).
let transportOrder = (process.env.CT_RESOLVER || 'curl,axios,jina').split(',');

// Memoria del transporte que funcionó la última vez: en un mismo entorno
// (ej. Vercel) el ganador siempre será el mismo, así que lo probamos primero
// y ahorramos segundos de latencia en cada resolución.
let preferredTransport = null;

/**
 * Descarga el HTML del player probando los transportes en orden hasta
 * obtener uno que traiga window.playerConfig (un 200 sin config no sirve:
 * puede ser la página del desafío Turnstile).
 */
async function downloadPlayerHtml(url) {
  const order = preferredTransport
    ? [preferredTransport, ...transportOrder.filter((t) => t !== preferredTransport)]
    : transportOrder;

  for (const name of order) {
    const fetcher = TRANSPORTS[name];
    if (!fetcher) continue;
    const result = await fetcher(url);
    if (result && result.status === 200 && result.body && result.body.includes('window.playerConfig')) {
      preferredTransport = name;
      return result;
    }
  }
  return null;
}

/**
 * Extrae un objeto JSON balanceando llaves, sin depender de regex frágiles.
 * Recorre el texto desde `startIndex` respetando strings y escapes.
 */
function extractBalancedJson(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

/** Parsea `window.playerConfig = {...}` desde el HTML del player. */
function extractPlayerConfig(html) {
  const marker = 'window.playerConfig';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const jsonStart = html.indexOf('{', markerIndex);
  if (jsonStart === -1) return null;
  const raw = extractBalancedJson(html, jsonStart);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Obtiene la metadata del video (con hash "h") desde el proxy del sitio.
 * Si `fresh` es true, fuerza una petición nueva: útil cuando el hash
 * cacheado por el sitio expiró (el player responde 401).
 */
async function getVideoMeta(vimeoId, fresh = false) {
  const meta = await scraper.getVimeoVideo(vimeoId);
  if (!fresh || !meta || !meta.player_embed_url) return meta;
  // Reintenta saltando cualquier caché intermedia para obtener un "h" vigente.
  const res = await axios.get(`${scraper.BASE_URL}/api/vimeo/videos`, {
    params: { videoId: vimeoId },
    headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
    timeout: 12000,
    validateStatus: null
  });
  return res.status === 200 && res.data && res.data.uri ? res.data : meta;
}

/** Descarga el HTML del reproductor embebido de Vimeo. */
async function fetchPlayerHtml(vimeoId, hash) {
  const playerUrl = new URL(`https://player.vimeo.com/video/${vimeoId}`);
  if (hash) playerUrl.searchParams.set('h', hash);
  const result = await downloadPlayerHtml(playerUrl.toString());
  return { status: result ? result.status : 0, html: result ? result.body : '' };
}

/**
 * Resuelve los streams de un video de Vimeo.
 * Con caché de 10 minutos: las URLs firmadas viven ~1 hora, así que reusar
 * una resolución reciente es seguro y evita golpear dos veces el relay
 * (importante por los rate limits del tier gratuito de r.jina.ai).
 * @param {string|number} vimeoId
 * @returns {Promise<{streams: Array<{quality:string,url:string}>,
 *                    subtitles: Array<{url:string,lang:string,label:string}>,
 *                    duration:number|null}>}
 */
const streamCache = new Map();
const STREAM_CACHE_TTL = 10 * 60 * 1000;

async function resolveStreams(vimeoId) {
  const cached = streamCache.get(vimeoId);
  if (cached && Date.now() < cached.expires) return cached.value;

  let videoMeta = await getVideoMeta(vimeoId);

  const extractHash = (meta) => {
    try {
      return meta && meta.player_embed_url
        ? new URL(meta.player_embed_url).searchParams.get('h')
        : null;
    } catch {
      return null;
    }
  };

  // Primer intento con el hash provisto por el sitio.
  let { status, html } = await fetchPlayerHtml(vimeoId, extractHash(videoMeta));

  // Si el hash está vencido o Vimeo aplica throttling transitorio responde
  // 401: esperamos brevemente, pedimos metadata fresca (sin caché) y
  // reintentamos una única vez.
  if (status !== 200 || !html) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    videoMeta = await getVideoMeta(vimeoId, true);
    ({ status, html } = await fetchPlayerHtml(vimeoId, extractHash(videoMeta)));
  }

  if (status !== 200 || !html) {
    throw new Error(`Player de Vimeo inaccesible (${status}) para ${vimeoId}`);
  }

  const config = extractPlayerConfig(html);
  const req = config && config.request;
  const files = (req && req.files) || {};

  const streams = [];

  // 3a) MP4 progresivos: preferidos si existen (compatibilidad total).
  const progressive = Array.isArray(files.progressive) ? files.progressive : [];
  for (const file of progressive.sort((a, b) => (b.width || 0) - (a.width || 0))) {
    streams.push({
      quality: `${file.height || '?'}p`,
      url: file.url
    });
  }

  // 3b) HLS adaptativo: es lo normal en Vimeo hoy (separate_av).
  if (!streams.length && files.hls && files.hls.cdns) {
    const cdns = files.hls.cdns;
    const cdnKey =
      (files.hls.default_cdn && cdns[files.hls.default_cdn] && files.hls.default_cdn) ||
      Object.keys(cdns)[0];
    const hlsUrl = cdns[cdnKey] && (cdns[cdnKey].avc_url || cdns[cdnKey].url);
    if (hlsUrl) {
      streams.push({
        quality: config.video && config.video.height ? `${config.video.height}p` : 'HLS',
        url: hlsUrl
      });
    }
  }

  // 3c) Subtítulos firmados incluidos en la config del player.
  const subtitles = ((req && req.text_tracks) || []).map((track) => ({
    url: track.url,
    lang: track.lang || 'es',
    label: track.label || 'Subtítulos'
  }));

  const duration =
    (config && config.video && config.video.duration) ||
    (videoMeta && videoMeta.duration) ||
    null;

  if (!streams.length) throw new Error(`No se pudo resolver stream para ${vimeoId}`);

  const value = { streams, subtitles, duration };
  streamCache.set(vimeoId, { value, expires: Date.now() + STREAM_CACHE_TTL });
  return value;
}

/**
 * URL de reproducción externa (player embebido de Vimeo).
 * Se usa como fallback cuando la resolución server-side falla: Vimeo aplica
 * Cloudflare Turnstile contra IPs de datacenter (como las de Vercel), pero
 * desde el navegador del usuario funciona siempre. El hash "h" es estable;
 * lo efímero son solo las firmas CDN, que el player renueva por su cuenta.
 */
async function getEmbedUrl(vimeoId) {
  try {
    const meta = await getVideoMeta(vimeoId, true);
    if (meta && meta.player_embed_url) return meta.player_embed_url;
  } catch {
    /* caemos al URL genérico */
  }
  return `https://player.vimeo.com/video/${vimeoId}`;
}

/** Verifica si el binario curl está disponible y devuelve su versión. */
function checkCurl() {
  return new Promise((resolve) => {
    execFile('curl', ['--version'], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? { available: false } : { available: true, version: String(stdout).split('\n')[0] });
    });
  });
}

/**
 * Diagnóstico paso a paso del entorno de red (usado por la ruta /debug).
 * Permite ver desde el deployment real qué bloquea la resolución.
 */
async function diagnose(vimeoId = '1172680712') {
  const out = {};

  out.curl = await checkCurl();

  const meta = await getVideoMeta(vimeoId, true).catch((e) => ({ error: e.message }));
  let playerUrl = `https://player.vimeo.com/video/${vimeoId}`;
  if (meta && meta.player_embed_url) {
    out.siteApi = { ok: true, hash: new URL(meta.player_embed_url).searchParams.get('h') };
    playerUrl = meta.player_embed_url;
  } else {
    out.siteApi = { ok: false, detail: meta };
  }

  const t0 = Date.now();
  const viaCurl = await fetchWithCurl(playerUrl);
  out.playerViaCurl = {
    status: viaCurl ? viaCurl.status : null,
    ms: Date.now() - t0,
    hasConfig: Boolean(viaCurl && viaCurl.body && viaCurl.body.includes('window.playerConfig'))
  };

  const t1 = Date.now();
  try {
    const res = await http.get(playerUrl, {
      headers: { Accept: 'text/html' },
      validateStatus: null
    });
    out.playerViaAxios = { status: res.status, ms: Date.now() - t1 };
  } catch (err) {
    out.playerViaAxios = { error: err.message };
  }

  const t2 = Date.now();
  const viaJina = await fetchWithJina(playerUrl);
  out.playerViaJina = {
    status: viaJina ? viaJina.status : null,
    ms: Date.now() - t2,
    hasConfig: Boolean(viaJina && viaJina.body && viaJina.body.includes('window.playerConfig'))
  };
  out.transportOrder = transportOrder;
  out.preferredTransport = preferredTransport;

  out.playerUrl = playerUrl;
  return out;
}

module.exports = { resolveStreams, getEmbedUrl, diagnose };
