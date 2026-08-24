/**
 * addon.js
 * ---------------------------------------------------------------------------
 * Configuración del manifest y los handlers (catalog / meta / stream) usando
 * stremio-addon-sdk.
 *
 * Esquema de IDs internos (prefijo "ct_" para no chocar con IMDB):
 *   Película :  ct_<vimeoId>            ej: ct_1172680712
 *   Serie    :  ct_s_<idFirestore>      ej: ct_s_AdBjrQYbxTPcPVDSYo7N
 *   Episodio :  ct_<vimeoId>            (mismo espacio que películas:
 *                                        la resolución de stream es idéntica)
 */

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./scraper');
const vimeo = require('./vimeo');

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

const MANIFEST = {
  id: 'org.cinetucumano.stremio',
  version: '1.0.0',
  name: 'Cine Tucumano',
  description: 'Catálogo de películas y series de la plataforma web cinetucumano.com.ar',
  logo: 'https://cinetucumano.com.ar/logos/cineTucumano_negro.png',
  background: 'https://cinetucumano.com.ar/logos/cineTucumano_negro.png',
  // TODO: confirmar un email real de contacto antes de publicar el add-on.
  contactEmail: 'contacto@cinetucumano.com.ar',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'ct-movies',
      name: 'Cine Tucumano',
      extraSupported: ['search', 'skip']
    },
    {
      type: 'series',
      id: 'ct-series',
      name: 'Series Cine Tucumano',
      extraSupported: ['search', 'skip']
    }
  ],
  idPrefixes: ['ct_']
};

const builder = new addonBuilder(MANIFEST);

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                 */
/* -------------------------------------------------------------------------- */

/** Une géneros y categorías del item en un array único y limpio. */
function genresOf(item) {
  const set = new Set([...(item.genres || []), ...(item.categories || [])]);
  return [...set].filter(Boolean);
}

/** Arma la ficha básica usada tanto en catálogo como en meta. */
function baseMeta(item) {
  return {
    id: `ct_${item.vimeoId}`,
    type: 'movie',
    name: item.title,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: genresOf(item),
    description: item.description || ''
  };
}

/**
 * Enriquece la descripción con el equipo de producción (la web guarda un solo
 * string con "Dirección: X Guion: Y ..."), formateado en líneas.
 */
function descriptionWithCrew(item) {
  const crew = (item.production || [])
    .map((p) => p.name)
    .filter(Boolean)
    .join('\n')
    .replace(/(?=Dirección:|Guion:|Producción:|Fotografía:|Montaje:|Sonido:|Música:)/g, '\n')
    .trim();
  if (!crew) return item.description || '';
  return `${item.description || ''}\n\nEquipo:\n${crew}`.trim();
}

/** Poster/background de una película, con fallback silencioso. */
async function posterFor(vimeoId) {
  try {
    return await scraper.getThumbnail(vimeoId);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Handler de Catálogo                                                        */
/* -------------------------------------------------------------------------- */

builder.defineCatalogHandler(async (args) => {
  const { type, extra = {} } = args;
  const search = (extra.search || '').toLowerCase().trim();

  if (type === 'series') {
    let seriesList = await scraper.getSeries();
    if (search) seriesList = seriesList.filter((s) => s.title && s.title.toLowerCase().includes(search));
    const metas = seriesList.map((serie) => ({
      id: `ct_s_${serie.id}`,
      type: 'series',
      name: serie.title,
      poster: serie.thumbnailUrl || undefined,
      posterShape: 'regular',
      releaseInfo: serie.year ? String(serie.year) : undefined,
      genres: genresOf(serie),
      description: serie.description || ''
    }));
    return { metas };
  }

  // type === 'movie'
  let movies = await scraper.getMovies();
  if (search) movies = movies.filter((m) => m.title && m.title.toLowerCase().includes(search));

  // Los posters requieren una llamada por película al proxy de imágenes;
  // las pedimos en paralelo con concurrencia limitada para no saturar.
  const thumbs = await scraper.poolLimit(
    10,
    movies.map((m) => () => posterFor(m.vimeoId))
  );

  const metas = movies.map((movie, i) => ({
    ...baseMeta(movie),
    poster: (thumbs[i] && thumbs[i].poster) || undefined,
    posterShape: 'regular'
  }));

  return { metas };
});

/* -------------------------------------------------------------------------- */
/* Handler de Metadatos                                                       */
/* -------------------------------------------------------------------------- */

builder.defineMetaHandler(async (args) => {
  const { type, id } = args;

  /* ------------------------------- SERIES -------------------------------- */
  if (type === 'series') {
    // Formato esperado: ct_s_<idFirestore>
    const firestoreId = id.replace(/^ct_s_/, '');
    const seriesList = await scraper.getSeries();
    const serie = seriesList.find((s) => s.id === firestoreId);
    if (!serie) return Promise.resolve({ meta: null });

    // Temporadas -> episodios (con orden estable).
    const seasons = await scraper.getSeasons(firestoreId);
    seasons.sort((a, b) => (a.order || 0) - (b.order || 0));

    const videos = [];
    for (let sIndex = 0; sIndex < seasons.length; sIndex++) {
      const season = seasons[sIndex];
      const episodes = await scraper.getEpisodes(season.id);
      episodes
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .forEach((ep, eIndex) => {
          videos.push({
            id: `ct_${ep.videoId}`, // la resolución de stream es la misma que una peli
            title: ep.title || `Episodio ${eIndex + 1}`,
            season: season.order || sIndex + 1,
            episode: ep.order || eIndex + 1,
            thumbnail: serie.thumbnailUrl || undefined,
            overview: ep.description || undefined
          });
        });
    }

    return Promise.resolve({
      meta: {
        id,
        type: 'series',
        name: serie.title,
        poster: serie.thumbnailUrl || undefined,
        background: serie.thumbnailUrl || undefined,
        releaseInfo: serie.year ? String(serie.year) : undefined,
        genres: genresOf(serie),
        cast: scraper.splitNames(serie.cast),
        director: scraper.splitNames(serie.directors),
        description: descriptionWithCrew(serie),
        videos
      }
    });
  }

  /* ------------------------------ PELÍCULAS ------------------------------ */
  const vimeoId = id.replace(/^ct_/, '');
  let movie = await scraper.findMovieByVimeoId(vimeoId);

  // Fallback best-effort scrapeando el HTML si la API falló.
  // TODO: Ajustar según evolucione el payload RSC del sitio.
  if (!movie) movie = await scraper.scrapeMoviePageFallback(vimeoId).catch(() => null);

  if (!movie) return Promise.resolve({ meta: null });

  const [thumb, videoMeta] = await Promise.all([
    posterFor(vimeoId),
    scraper.getVimeoVideo(vimeoId).catch(() => null)
  ]);

  const runtimeSeconds = videoMeta && videoMeta.duration;
  const meta = {
    ...baseMeta({ ...movie, vimeoId }),
    poster: (thumb && thumb.poster) || undefined,
    background: (thumb && thumb.background) || undefined,
    runtime: runtimeSeconds ? `${Math.round(runtimeSeconds / 60)} min` : undefined,
    cast: scraper.splitNames(movie.cast),
    director: scraper.splitNames(movie.directors),
    description: descriptionWithCrew(movie)
  };

  return Promise.resolve({ meta });
});

/* -------------------------------------------------------------------------- */
/* Handler de Streams                                                         */
/* -------------------------------------------------------------------------- */

builder.defineStreamHandler(async (args) => {
  const { type, id } = args;

  // El ID siempre termina siendo ct_<vimeoId> (películas y episodios).
  if (!id.startsWith('ct_') || id.startsWith('ct_s_')) return { streams: [] };
  const vimeoId = id.replace(/^ct_/, '');

  try {
    const { streams, subtitles } = await vimeo.resolveStreams(vimeoId);

    const stremioStreams = streams.map((stream, index) => ({
      title: 'Cine Tucumano',
      name: stream.quality,
      description: `${type === 'series' ? 'Episodio' : 'Película'} vía cinetucumano.com.ar`,
      url: stream.url,
      behaviorHints: index > 0 ? { notWebReady: true } : undefined,
      subtitles: subtitles.length ? subtitles : undefined
    }));

    return { streams: stremioStreams };
  } catch (err) {
    console.error(`[stream] Error resolviendo ${id}:`, err.message);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
