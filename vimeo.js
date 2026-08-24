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
      resolve({ status: Number.isNaN(status) ? 0 : status, body: stdout.slice(0, marker) });
    });
  });
}

/** Descarga el HTML del player probando curl primero y axios como fallback. */
async function downloadPlayerHtml(url) {
  let result = await fetchWithCurl(url);
  if (result && result.status === 200 && result.body) return result;
  result = await fetchWithCurl(url); // un reintento rápido ante fallo puntual
  if (result && result.status === 200 && result.body) return result;

  // Fallback: stack Node (puede ser bloqueado por JA3 según la IP/región).
  try {
    const res = await http.get(url, {
      headers: { Accept: 'text/html' },
      validateStatus: null
    });
    return {
      status: res.status,
      body: typeof res.data === 'string' ? res.data : ''
    };
  } catch {
    return null;
  }
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
 * @param {string|number} vimeoId
 * @returns {Promise<{streams: Array<{quality:string,url:string}>,
 *                    subtitles: Array<{url:string,lang:string,label:string}>,
 *                    duration:number|null}>}
 */
async function resolveStreams(vimeoId) {
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
  if (status === 401) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    videoMeta = await getVideoMeta(vimeoId, true);
    ({ status, html } = await fetchPlayerHtml(vimeoId, extractHash(videoMeta)));
  }

  if (status !== 200 || !html) {
    throw new Error(`Player de Vimeo respondió ${status} para ${vimeoId}`);
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

  return { streams, subtitles, duration };
}

module.exports = { resolveStreams };
