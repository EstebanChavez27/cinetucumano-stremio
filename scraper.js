/**
 * scraper.js
 * ---------------------------------------------------------------------------
 * Módulo aislado encargado de obtener los datos de cinetucumano.com.ar.
 *
 * DECISIÓN DE ARQUITECTURA (importante):
 * La web es una SPA construida en Next.js con renderizado 100% del lado
 * cliente, por lo que el HTML inicial NO contiene el catálogo (cheerio no
 * tiene nada que parsear). En su lugar, la web consume su propia API interna:
 *
 *   GET /api/movies                       -> catálogo de películas
 *   GET /api/series                       -> catálogo de series
 *   GET /api/season?seriesId=<id>         -> temporadas de una serie
 *   GET /api/episode?seasonId=<id>        -> episodios de una temporada
 *   GET /api/thumbnail?videoId=<vimeoId>  -> imágenes (proxy de la API Vimeo)
 *   GET /api/vimeo/videos?videoId=<id>    -> metadata completa del video Vimeo
 *
 * Estos endpoints fueron descubiertos analizando los bundles JS del sitio.
 * Usarlos es más rápido, estable y barato (serverless) que scrapear HTML.
 *
 * Aun así se conserva cheerio para un fallback: si la API falla, se intenta
 * rescatar datos desde el payload RSC embebido en el HTML de la página.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://cinetucumano.com.ar';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 12000,
  headers: {
    // Algunos servidores rechazan peticiones sin User-Agent identificable.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StremioAddon/1.0',
    Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
  },
  // Devolvemos la respuesta tal cual y validamos status manualmente,
  // para poder distinguir 404 (no existe) de errores reales.
  validateStatus: null
});

/* -------------------------------------------------------------------------- */
/* Caché en memoria con TTL                                                   */
/* Serverless = instancia efímera, pero mientras vive conviene no repetir     */
/* las mismas descargas (el catálogo de posters implica ~74 requests).        */
/* -------------------------------------------------------------------------- */

const cache = new Map();

function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now < hit.expires) return Promise.resolve(hit.value);
  return producer().then((value) => {
    cache.set(key, { value, expires: now + ttlMs });
    return value;
  });
}

/** Ejecuta `tasks` en paralelo con un límite de concurrencia (pool simple). */
async function poolLimit(limit, tasks) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        // Una imagen que falla no debe romper todo el catálogo.
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/* -------------------------------------------------------------------------- */
/* Normalización                                                              */
/* -------------------------------------------------------------------------- */

/** La web guarda cast como [{name:"A, B, C"}]; lo convertimos en array limpio. */
function splitNames(list) {
  if (!Array.isArray(list)) return [];
  const names = list
    .map((item) => (typeof item === 'string' ? item : item && item.name) || '')
    .flatMap((chunk) => chunk.split(','))
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function visible(item) {
  return Boolean(item && item.showVisibility !== false);
}

/* -------------------------------------------------------------------------- */
/* Endpoints públicos del módulo                                              */
/* -------------------------------------------------------------------------- */

/** Catálogo completo de películas visibles. */
function getMovies() {
  return cached('movies', 10 * 60 * 1000, async () => {
    const res = await http.get('/api/movies');
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data.filter(visible);
  });
}

/** Catálogo completo de series visibles. */
function getSeries() {
  return cached('series', 10 * 60 * 1000, async () => {
    const res = await http.get('/api/series');
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data.filter(visible);
  });
}

/** Temporadas de una serie (id Firestore de la serie). */
function getSeasons(seriesId) {
  return cached(`seasons:${seriesId}`, 10 * 60 * 1000, async () => {
    const res = await http.get('/api/season', { params: { seriesId } });
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data.filter(visible);
  });
}

/** Episodios de una temporada (id Firestore de la temporada). */
function getEpisodes(seasonId) {
  return cached(`episodes:${seasonId}`, 10 * 60 * 1000, async () => {
    const res = await http.get('/api/episode', { params: { seasonId } });
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data.filter(visible);
  });
}

/**
 * Poster + background de una película vía el proxy de imágenes del sitio
 * (la API de Vimeo de thumbnails). Devuelve { poster, background } o null.
 */
function getThumbnail(vimeoId) {
  return cached(`thumb:${vimeoId}`, 6 * 60 * 60 * 1000, async () => {
    const res = await http.get('/api/thumbnail', { params: { videoId: vimeoId } });
    if (res.status !== 200 || !res.data) return null;
    const data = res.data.thumbnails || res.data; // tolera ambos formatos
    const pictures = Array.isArray(data) ? data : data.data;
    if (!pictures || !pictures.length) return null;
    const pic = pictures[0];
    const sizes = Array.isArray(pic.sizes) ? pic.sizes : [];
    const biggest = sizes.reduce(
      (acc, s) => (!acc || (s.width || 0) > acc.width ? s : acc),
      null
    );
    return {
      poster: (biggest && biggest.link) || pic.base_link || null,
      background: pic.base_link || (biggest && biggest.link) || null
    };
  });
}

/**
 * Metadata cruda del video en Vimeo a través del proxy del sitio.
 * Necesaria sobre todo por `player_embed_url` (incluye el hash privado "h")
 * y `duration` (runtime).
 */
function getVimeoVideo(vimeoId) {
  return cached(`vimeovideo:${vimeoId}`, 30 * 60 * 1000, async () => {
    const res = await http.get('/api/vimeo/videos', { params: { videoId: vimeoId } });
    if (res.status !== 200 || !res.data || !res.data.uri) return null;
    return res.data;
  });
}

/** Busca una película por su ID de Vimeo. */
async function findMovieByVimeoId(vimeoId) {
  const movies = await getMovies();
  return movies.find((m) => String(m.vimeoId) === String(vimeoId)) || null;
}

/**
 * Fallback con cheerio: rescata campos del payload RSC embebido en el HTML
 * de la página de detalle cuando la API JSON no responde. Best-effort.
 */
async function scrapeMoviePageFallback(vimeoId) {
  const res = await http.get(`/movie/${vimeoId}`, {
    headers: { Accept: 'text/html' }
  });
  if (res.status !== 200 || typeof res.data !== 'string') return null;

  const $ = cheerio.load(res.data);
  // Next.js App Router deja el estado serializado en <script> self.__next_f...
  const payload = $('script')
    .map((_, el) => $(el).html())
    .get()
    .filter((txt) => txt && txt.includes('"vimeoId"'))
    .join('\n');

  if (!payload) return null;

  // Extraemos el objeto más cercano al vimeoId buscado mediante regex acotada.
  // TODO: Ajustar esta regex si cambia el formato del payload RSC del sitio.
  const pattern = new RegExp(
    `\\{[^{}]*"vimeoId":"${vimeoId}"[\\s\\S]{0,2500}?\\}`,
    'm'
  );
  const match = payload.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

module.exports = {
  BASE_URL,
  getMovies,
  getSeries,
  getSeasons,
  getEpisodes,
  getThumbnail,
  getVimeoVideo,
  findMovieByVimeoId,
  scrapeMoviePageFallback,
  splitNames,
  poolLimit
};
