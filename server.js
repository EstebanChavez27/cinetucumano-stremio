/**
 * server.js
 * ---------------------------------------------------------------------------
 * Punto de entrada compatible con dos entornos:
 *
 *  - Local:  `npm start` levanta el add-on con serveHTTP (modo desarrollo).
 *  - Vercel: exporta la función serverless que Vercel invocará por cada
 *            request. `getRouter()` devuelve una app express, que es
 *            directamente invocable como (req, res) => {...}.
 */

const fs = require('fs');
const path = require('path');
const { getRouter, serveHTTP } = require('stremio-addon-sdk');
const addon = require('./addon');
const vimeo = require('./vimeo');

const router = getRouter(addon);

const IS_VERCEL = Boolean(process.env.VERCEL);
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');

/** Sirve el ícono del add-on (assets/logo.png) con caché larga. */
function logoHandler(req, res) {
  try {
    const img = fs.readFileSync(LOGO_PATH);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.end(img);
  } catch {
    res.statusCode = 404;
    res.end('logo no encontrado');
  }
}

/** Ruta de diagnóstico: /debug?v=<vimeoId> (por defecto 1172680712). */
function debugHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const params = new URL(req.url, 'http://x').searchParams;
  const vimeoId = params.get('v') || '1172680712';
  vimeo
    .diagnose(vimeoId)
    .then((report) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    });
}

// Cabeceras de caché en el CDN de Vercel: alivian las cold starts y reducen
// el tráfico hacia cinetucumano.com.ar sin servir contenido rancio.
// Los streams se cachean menos: sus URLs firmadas expiran en ~1 hora y durante
// una incidencia no queremos servir respuestas vacías rancias.
function withCacheHeaders(handler) {
  return function (req, res) {
    const urlPath = (req.url || '').split('?')[0];
    if (urlPath === '/debug') return debugHandler(req, res);
    if (urlPath === '/logo.png') return logoHandler(req, res);
    if (urlPath.startsWith('/stream/')) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    } else {
      res.setHeader(
        'Cache-Control',
        'public, max-age=300, s-maxage=600, stale-while-revalidate=3600'
      );
    }
    return handler(req, res);
  };
}

if (IS_VERCEL) {
  // Exportamos la función para las Serverless Functions de Vercel.
  // El router del SDK tiene firma (req, res, next): le pasamos un
  // callback final que responde 404 si ninguna ruta coincidió.
  module.exports = withCacheHeaders((req, res) => {
    router(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });
} else {
  // Desarrollo local: exportamos también por si se requiere integrar
  // en otro servidor, y arrancamos el listener interactivo del SDK
  // (serveHTTP espera el AddonInterface, no el router).
  module.exports = router;
  serveHTTP(addon, { port: process.env.PORT || 7000 });
}
