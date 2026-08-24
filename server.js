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

const { getRouter, serveHTTP } = require('stremio-addon-sdk');
const addon = require('./addon');

const router = getRouter(addon);

const IS_VERCEL = Boolean(process.env.VERCEL);

// Cabeceras de caché en el CDN de Vercel: alivian las cold starts y reducen
// el tráfico hacia cinetucumano.com.ar sin servir contenido rancio.
function withCacheHeaders(handler) {
  return function (req, res) {
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, s-maxage=600, stale-while-revalidate=3600'
    );
    return handler(req, res);
  };
}

if (IS_VERCEL) {
  // Exportamos la función para las Serverless Functions de Vercel.
  module.exports = withCacheHeaders((req, res) => router(req, res));
} else {
  // Desarrollo local: exportamos también por si se requiere integrar
  // en otro servidor, y arrancamos el listener interactivo del SDK
  // (serveHTTP espera el AddonInterface, no el router).
  module.exports = router;
  serveHTTP(addon, { port: process.env.PORT || 7000 });
}
