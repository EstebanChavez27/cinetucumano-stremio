/**
 * vimeo.js
 * ---------------------------------------------------------------------------
 * Resolución de streams VIMEO a través del REPRODUCTOR PÚBLICO de Vimeo.
 * SIN API oficial, SIN tokens y SIN externalUrl: se entrega la playlist HLS
 * (.m3u8) o el MP4 progresivo para reproducción NATIVA dentro de Stremio.
 *
 * ── Técnica de evasión del bloqueo 401 (Cloudflare/Turnstile de Vimeo) ──
 *
 * El bloqueo real no es el User-Agent: es la HUELLA TLS (JA3/JA4). El
 * handshake de Node.js (axios/fetch) es reconocible al instante y Vimeo lo
 * rechaza con 401 aunque los headers imiten a Chrome. La cadena de
 * transportes ataca ese problema por capas:
 *
 *   1) curl (binario del sistema): su pila TLS (OpenSSL/ngtcp2) produce una
 *      huella JA3 que NO corresponde a Node y pasa el desafío sin más.
 *      El runtime de Vercel (Amazon Linux) trae curl preinstalado.
 *
 *   2) got-scraping (Apify): librería anti-bot "pura Node". Reordena cipher
 *      suites y extensiones TLS para calcar el Client Hello de Chrome (rota
 *      la huella JA3 de Node), negocia HTTP/2 con settings frames de
 *      navegador y genera un set de headers coherente (UA, sec-ch-ua,
 *      Accept-Encoding) con header-generator. Es el reemplazo directo de
 *      axios como transporte nativo cuando curl no está disponible.
 *
 *   3) axios + spoofing completo de headers: UA de Chrome, Referer/Origin de
 *      cinetucumano.com.ar (el embed está autorizado para ese dominio),
 *      Sec-Fetch-* de iframe. Normalmente recibe 401 por huella, pero queda
 *      como red de seguridad por si cambia el desafío del lado de Vimeo.
 *
 *   4) Relay r.jina.ai (`X-Return-Format: html`): la petición al player la
 *      hace la infraestructura de Jina (IP propia, no Vercel) y devuelve el
 *      HTML crudo con window.playerConfig. Último recurso (~20 req/min).
 *
 * El ganador queda sticky (`preferredTransport`) y cada transporte entra en
 * cooldown individual apenas falla, para no repetir requests inútiles.
 *
 * De `window.playerConfig` se extrae con parseo JSON por balanceo de llaves
 * (robusto, sin regex frágiles):
 *   - request.files.hls.cdns[default_cdn].avc_url -> playlist HLS maestra
 *   - request.files.progressive[]                 -> MP4 directos
 *   - request.text_tracks[]                       -> subtítulos VTT firmados
 *
 * Blindaje adicional:
 *   - Detección explícita de páginas-desafío (Turnstile / "Just a moment"):
 *     un 200 sin playerConfig cuenta como fallo del transporte.
 *   - Caché positiva de streams (10 min; las URLs firmadas viven ~1h).
 *   - Caché negativa de errores (45 s): si todo falló, no se machaca a
 *     Vimeo con reintentos instantáneos (evita agravar el throttle por IP).
 *   - Deduplicación: nunca dos resoluciones iguales en vuelo a la vez.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const scraper = require('./scraper');

const execFileAsync = promisify(execFile);

/* ----------------------------- Configuración ----------------------------- */

const CACHE_TTL = 10 * 60 * 1000;
const FAIL_TTL = 45 * 1000;

// Cooldown por transporte: jina es caro (rate limit), se castiga más tiempo.
const COOLDOWN_MS = {
  curl: 20 * 1000,
  gots: 15 * 1000,
  axios: 15 * 1000,
  jina: 45 * 1000
};

const streamCache = new Map(); // vimeoId -> { value, expires }
const failCache = new Map(); // vimeoId -> { message, expires }
const inFlight = new Map(); // vimeoId -> Promise

let preferredTransport = null;
const transportCooldown = new Map();

function idOf(value) {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Vimeo ID inválido');
  return id;
}

/* ------------------------- Headers de navegador -------------------------- */
/* Referer/Origin de cinetucumano son CRÍTICOS: el video está autorizado     */
/* para embeberse solo en ese dominio y sin ellos Vimeo responde 401 aunque  */
/* el resto de la petición sea perfecta.                                     */

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
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

/* --------------------------- Cadena de transportes ------------------------ */

const TRANSPORT_NAMES = ['curl', 'gots', 'axios', 'jina'];

const RESOLVER_ORDER = (process.env.CT_RESOLVER || 'curl,gots,axios,jina')
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
  transportCooldown.set(transport, Date.now() + (COOLDOWN_MS[transport] || 15000));
}

/** Un body sirve solo si trae playerConfig Y no es una página-desafío. */
const CHALLENGE_MARKERS = [
  '__cf_chl_',
  'challenge-platform',
  'cf-chl',
  'cf-browser-verification',
  'turnstile',
  'just a moment',
  'attention required'
];

function looksLikeChallenge(html) {
  const low = html.slice(0, 40000).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => low.includes(marker));
}

function validPlayer(html) {
  return (
    typeof html === 'string' &&
    html.includes('window.playerConfig') &&
    !looksLikeChallenge(html)
  );
}

/* --- Transporte 1: curl (huella TLS no-Node, pasa JA3 sin esfuerzo) ------ */

async function fetchWithCurl(url) {
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sSL',
      '--compressed',
      '--connect-timeout', '10',
      '--max-time', '18',
      '--http1.1',
      '-A', BROWSER_HEADERS['User-Agent'],
      '-e', BROWSER_HEADERS.Referer,
      '-H', `Origin: ${BROWSER_HEADERS.Origin}`,
      '-H', `Accept-Language: ${BROWSER_HEADERS['Accept-Language']}`,
      '-H', `Accept: ${BROWSER_HEADERS.Accept}`,
      url
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 20000, windowsHide: true }
  );
  if (!validPlayer(stdout)) {
    throw new Error('curl: body sin window.playerConfig');
  }
  return stdout;
}

/* --- Transporte 2: got-scraping (falsificación de huella TLS pura Node) -- */
/* El paquete (v4+) es ESM-only: se carga con import() dinámico, que funciona */
/* desde CommonJS. Carga diferida: si faltara el paquete en algún deploy, la  */
/* cadena sigue funcionando en lugar de reventar el módulo entero.            */

let gotsPromise;
function loadGotScraping() {
  if (!gotsPromise) {
    gotsPromise = import('got-scraping')
      .then((m) => m.gotScraping || null)
      .catch(() => null);
  }
  return gotsPromise;
}

async function fetchWithGots(url) {
  const gotScraping = await loadGotScraping();
  if (!gotScraping) throw new Error('got-scraping no disponible');

  const res = await gotScraping({
    url,
    method: 'GET',
    responseType: 'text',
    timeout: { request: 15000 },
    retry: { limit: 0 },
    // header-generator arma el set completo de un Chrome desktop real (UA,
    // sec-ch-ua, sec-fetch, Accept-Encoding coherentes). Solo fijamos lo que
    // depende del dominio emisor para conservar la autorización del embed.
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 124 }],
      devices: ['desktop'],
      operatingSystems: ['windows']
    },
    headers: {
      Referer: BROWSER_HEADERS.Referer,
      Origin: BROWSER_HEADERS.Origin,
      'Accept-Language': BROWSER_HEADERS['Accept-Language']
    }
  });

  const body = typeof res.body === 'string' ? res.body : String(res.body);
  if (res.statusCode !== 200 || !validPlayer(body)) {
    throw new Error(`gots: status ${res.statusCode} sin playerConfig`);
  }
  return body;
}

/* --- Transporte 3: axios (headers de navegador, red de seguridad) -------- */

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

/* --- Transporte 4: relay r.jina.ai (fetch desde infra ajena a Vercel) ---- */

async function fetchWithJina(url) {
  const res = await axios.get(`https://r.jina.ai/${url}`, {
    timeout: 30000,
    headers: {
      ...BROWSER_HEADERS,
      'X-Return-Format': 'html',
      'X-No-Cache': 'true',
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
  gots: fetchWithGots,
  axios: fetchWithAxios,
  jina: fetchWithJina
};

/**
 * Recorre la cadena hasta que un transporte devuelva HTML válido.
 * El primero que gana pasa a ser el preferido (sticky).
 */
async function downloadPlayerHtml(pageUrl) {
  const order = nextTransportOrder();
  let lastError = null;

  for (const transport of order) {
    if (inCooldown(transport)) continue;
    try {
      const html = await TRANSPORT_FN[transport](pageUrl);
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

/* --------------------- URL del player (hash privado h) -------------------- */

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

/* ---------------------- Extracción de playerConfig ------------------------ */

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

/* ------------------------------ API pública ------------------------------- */

async function resolveStreams(vimeoId) {
  const id = idOf(vimeoId);

  const hit = streamCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.value;

  const failed = failCache.get(id);
  if (failed && failed.expires > Date.now()) throw new Error(failed.message);

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
    failCache.delete(id);
    return value;
  })();

  inFlight.set(id, promise);
  try {
    return await promise;
  } catch (err) {
    // Caché negativa corta: Stremio reintenta al instante y machacar a Vimeo
    // durante un throttle por IP solo prolonga el bloqueo.
    failCache.set(id, { message: err.message, expires: Date.now() + FAIL_TTL });
    throw err;
  } finally {
    inFlight.delete(id);
  }
}

/** URL del player público (para diagnóstico y referencia). */
async function getEmbedUrl(vimeoId) {
  return playerPageUrlFor(vimeoId);
}

/**
 * Diagnóstico completo (ruta /debug): prueba TODOS los transportes uno a uno
 * contra el player real e informa estado de cooldowns/cachés.
 */
async function diagnose(vimeoId = '1172680712') {
  const id = idOf(vimeoId); // valida formato antes de tocar nada
  failCache.delete(id);

  const gotsAvailable = Boolean(await loadGotScraping());
  const report = {
    videoId: id,
    resolverOrder: RESOLVER_ORDER.length ? RESOLVER_ORDER : TRANSPORT_NAMES,
    preferredTransport,
    gotsAvailable,
    cooldowns: Object.fromEntries(transportCooldown)
  };
  try {
    const pageUrl = await playerPageUrlFor(id);
    report.pageUrl = pageUrl;

    const transports = {};
    for (const transport of TRANSPORT_NAMES) {
      if (transport === 'gots' && !gotsAvailable) {
        transports.gots = { ok: false, error: 'paquete no instalado' };
        continue;
      }
      try {
        const html = await TRANSPORT_FN[transport](pageUrl);
        transports[transport] = { ok: true, bytes: html.length, hasConfig: validPlayer(html) };
      } catch (err) {
        transports[transport] = { ok: false, error: err.message };
      }
    }
    report.transports = transports;

    const value = await resolveStreams(id);
    report.ok = true;
    report.qualities = value.streams.map((s) => s.quality);
    report.subtitleCount = value.subtitles.length;
    // resolveStreams fija el transporte ganador; lo refrescamos.
    report.preferredTransport = preferredTransport;
  } catch (err) {
    report.ok = false;
    report.error = err.message;
  }
  return report;
}

module.exports = { resolveStreams, getEmbedUrl, diagnose };
