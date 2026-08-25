/**
 * vimeo.js
 * ---------------------------------------------------------------------------
 * Resolución de streams VIMEO a través del REPRODUCTOR PÚBLICO de Vimeo,
 * NO la API oficial (no somos dueños del contenido y no hay token posible).
 *
 * Técnica de evasión implementada:
 *
 *  1) `window.playerConfig`:
 *     El player embebido de Vimeo inyecta en su HTML el objeto JSON
 *     `window.playerConfig` con las URLs firmadas de las piezas
 *     (HLS `avc_url`, MP4s progressive, subtítulos VTT). Lo extraemos
 *     parseando JSON por balanceo de llaves (robusto, sin regex).
 *
 *  2) Disfraz de navegador legítimo:
 *       - User-Agent de Chrome reciente + idioma es-AR (zona Argentina).
 *       - Referer y Origin apuntando a cinetucumano.com.ar (confianza cross-site).
 *       - Headers Sec-Fetch-* simulando una navegación real de iframe.
 *       - Accept completo de `text/html`.
 *
 *  3) Cadena de transportes para saltar el bloqueo TLS/401 de Vimeo:
 *       a) curl (binario del sistema): su pila TLS/OpenSSL + HTTP/1.1 pasa la
 *          huella JA3 que el handshake de Node/axios NO pasa.
 *       b) axios con headers de navegador: suele fallar con 401 por la huella,
 *          pero se conserva por si cambia el desafío del lado de Vimeo.
 *       c) Relay r.jina.ai (`X-Return-Format: html`): Vercel normalmente no
 *          trae curl; el relay devuelve el HTML crudo con playerConfig sin que
 *          Vimeo bloquee la petición (infraestructura de tercero).
 *     El transporte ganador queda "preferred" (sticky) para las siguientes
 *     consultas y entra en "cooldown" en cuanto falla, para no repetir
 *     request inútiles.
 *
 *  4) Caché en memoria + deduplicación de requests en vuelo: las URLs firmadas
 *     viven ~1h y el relay tiene un límite (~20 req/min), así que se reutilizan
 *     resoluciones y nunca se lanzan dos peticiones iguales en paralelo.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const scraper = require('./scraper');

const execFileAsync = promisify(execFile);

const CACHE_TTL = 10 * 60 * 1000;
const TRANSPORT_COOLDOWN_MS = 15 * 1000;
const streamCache = new Map();
const inFlight = new Map();

let preferredTransport = null;
const transportCooldown = new Map();

function idOf(value) {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Vimeo ID inválido');
  return id;
}

/* ------------------------- Headers de navegador ------------------------- */

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://cinetucumano.com.ar/',
  Origin: 'https://cinetucumano.com.ar',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1'
};

const TRANSPORT_NAMES = ['curl', 'axios', 'jina'];

const RESOLVER_ORDER = (process.env.CT_RESOLVER || 'curl,axios,jina')
  .split(',')
  .map((t) => t.trim().toLowerCase())
  .filter((t) => TRANSPORT_NAMES.includes(t));

function nextTransportOrder() {
  if (!RESOLVER_ORDER.length) return TRANSPORT_NAMES;
  const order = [...RESOLVER_ORDER];
  if (preferredTransport && order[0] !== preferredTransport) {
    const idx = order.indexOf(preferredTransport);
    if (idx > 0) {
      order.splice(idx, 1);
      order.unshift(preferredTransport);
    }
  }
  return order;
}

function inCooldown(transport) {
  const until = transportCooldown.get(transport);
  return Boolean(until && until > Date.now());
}

function markCooldown(transport) {
  transportCooldown.set(transport, Date.now() + TRANSPORT_COOLDOWN_MS);
}

/* ------------------------- Transportes de descarga ------------------------- */

function validPlayer(html) {
  return typeof html === 'string' && html.includes('window.playerConfig');
}

async function fetchWithCurl(url) {
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sSL',
      '--compressed',
      '--connect-timeout', '10',
      '--max-time', '20',
      '--http1.1',
      '-A', BROWSER_HEADERS['User-Agent'],
      '-e', BROWSER_HEADERS.Referer,
      '-H', `Origin: ${BROWSER_HEADERS.Origin}`,
      '-H', `Accept-Language: ${BROWSER_HEADERS['Accept-Language']}`,
      '-H', `Accept: ${BROWSER_HEADERS.Accept}`,
      url
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 22000, windowsHide: true }
  );
  if (!validPlayer(stdout)) {
    throw new Error('curl: body sin window.playerConfig');
  }
  return stdout;
}

async function fetchWithAxios(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: { ...BROWSER_HEADERS },
    validateStatus: null
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.status !== 200 || !validPlayer(body)) {
    throw new Error(`axios: status ${res.status} sin playerConfig`);
  }
  return body;
}

async function fetchWithJina(url) {
  const res = await axios.get(`https://r.jina.ai/${url}`, {
    timeout: 30000,
    headers: {
      ...BROWSER_HEADERS,
      'X-Return-Format': 'html',
      Accept: 'text/html,*/*'
    },
    validateStatus: null
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.status !== 200 || !validPlayer(body)) {
    throw new Error(`jina: status ${res.status} sin playerConfig`);
  }
  return body;
}

const TRANSPORT_FN = {
  curl: fetchWithCurl,
  axios: fetchWithAxios,
  jina: fetchWithJina
};

async function downloadPlayerHtml(pageUrl) {
  const order = nextTransportOrder();
  let lastError = null;

  for (const transport of order) {
    if (inCooldown(transport)) continue;
    try {
      const fn = TRANSPORT_FN[transport];
      const html = await fn(pageUrl);
      preferredTransport = transport;
      return { html, transport };
    } catch (err) {
      lastError = err;
      markCooldown(transport);
    }
  }
  throw new Error(
    `Todos los transportes fallaron: ${lastError ? lastError.message : 'sin datos'}`
  );
}

/* ------------------------- URL del player (hash h) ------------------------- */

/**
 * El video es privado y necesita el hash `h` que la web guarda en
 * `player_embed_url`. Lo obtenemos del proxy del propio sitio (scraper cache).
 * Si no está, generamos la URL pública sin hash (solo válida para videos
 * públicos, pero mejor que nada).
 */
async function playerPageUrlFor(vimeoId) {
  const id = idOf(vimeoId);
  try {
    const meta = await scraper.getVimeoVideo(id);
    const candidates = [meta && meta.player_embed_url, meta && meta.embed_url];
    for (const candidate of candidates) {
      if (
        typeof candidate === 'string' &&
        candidate.includes(`/video/${id}`) &&
        candidate.startsWith('http')
      ) {
        return candidate;
      }
    }
  } catch {
    // seguimos con la URL canónica sin hash
  }
  return `https://player.vimeo.com/video/${id}`;
}

/* ------------------------- Extracción de playerConfig ------------------------- */

/**
 * Extrae el objeto JSON `window.playerConfig = {...}` sin usar regex.
 * Encuentra el primer `{` tras el marcador y balancea llaves y strings
 * hasta que se cierra la llave de apertura.
 */
function parsePlayerConfig(config) {
  const marker = 'window.playerConfig';
  const start = config.indexOf(marker);
  if (start === -1) return null;
  const open = config.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < config.length; i++) {
    const ch = config[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch !== '}') continue;
    depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(config.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** HLS del cdn por defecto (o del primer cdn con contenido). */
function hlsUrl(files) {
  const hls = files && files.hls;
  if (!hls || !hls.cdns) return null;
  const cdns = hls.cdns;
  const main = cdns[hls.default_cdn] || Object.values(cdns)[0];
  if (!main) return null;
  return main.avc_url || main.hlsv2 || main.hlsv1 || null;
}

function extractStreams(playerConfig) {
  const files = (playerConfig.request && playerConfig.request.files) || {};
  const out = [];

  const hls = hlsUrl(files);
  if (hls) out.push({ url: hls, hls: true, quality: 'HLS' });

  // Si el cdn por defecto no trajo avc_url/hls, probamos el resto de CDNs.
  if (files.hls && files.hls.cdns) {
    for (const cdn of Object.values(files.hls.cdns)) {
      const alt = cdn && (cdn.avc_url || cdn.hlsv2 || cdn.hlsv1);
      if (alt && !out.some((s) => s.url === alt)) {
        out.push({ url: alt, hls: true, quality: 'HLS' });
      }
    }
  }

  for (const p of Array.isArray(files.progressive) ? files.progressive : []) {
    if (p && p.url && !out.some((s) => s.url === p.url)) {
      const quality = p.quality || (p.height ? `${p.height}p` : 'MP4');
      out.push({ url: p.url, hls: false, quality });
    }
  }

  return out;
}

function extractSubtitles(playerConfig) {
  const tracks = Array.isArray(playerConfig.request && playerConfig.request.text_tracks)
    ? playerConfig.request.text_tracks
    : [];
  return tracks
    .map((t, i) => {
      const url = t && (t.url || (t.links && t.links[0] && t.links[0].url));
      if (!url) return null;
      return {
        id: `ct-sub-${i}`,
        url,
        lang: t.lang || 'es',
        label: t.name || t.label || 'Subtítulos'
      };
    })
    .filter(Boolean);
}

/* ------------------------- API pública ------------------------- */

async function resolveStreams(vimeoId) {
  const id = idOf(vimeoId);

  const hit = streamCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inFlight.has(id)) return inFlight.get(id);

  const promise = (async () => {
    const pageUrl = await playerPageUrlFor(id);
    const config = parsePlayerConfig((await downloadPlayerHtml(pageUrl)).html);
    if (!config) {
      throw new Error(`${id}: playerConfig no encontrado (desafío de Vimeo/Cloudflare)`);
    }

    const streams = extractStreams(config);
    if (!streams.length) {
      throw new Error(`${id}: playerConfig sin archivos reproducibles`);
    }

    const value = {
      streams: streams.map((f) => ({ quality: f.quality, url: f.url })),
      subtitles: extractSubtitles(config),
      duration: config.video ? config.video.duration : null
    };
    streamCache.set(id, { value, expires: Date.now() + CACHE_TTL });
    return value;
  })();

  inFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(id);
  }
}

/** URL del player público (para diagnóstico y referencia). */
async function getEmbedUrl(vimeoId) {
  return playerPageUrlFor(vimeoId);
}

async function diagnose(vimeoId = '1172680712') {
  const report = {
    videoId: String(vimeoId),
    preferredTransport,
    cooldowns: Object.fromEntries(transportCooldown)
  };
  try {
    const pageUrl = await playerPageUrlFor(vimeoId);
    report.pageUrl = pageUrl;

    const transports = {};
    for (const transport of TRANSPORT_NAMES) {
      try {
        const html = await TRANSPORT_FN[transport](pageUrl);
        transports[transport] = { ok: true, bytes: html.length, hasConfig: validPlayer(html) };
      } catch (err) {
        transports[transport] = { ok: false, error: err.message };
      }
    }
    report.transports = transports;

    const value = await resolveStreams(vimeoId);
    report.ok = true;
    report.qualities = value.streams.map((s) => s.quality);
    report.subtitleCount = value.subtitles.length;
  } catch (err) {
    report.ok = false;
    report.error = err.message;
  }
  return report;
}

module.exports = { resolveStreams, getEmbedUrl, diagnose };