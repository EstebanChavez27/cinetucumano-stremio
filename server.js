/**
 * server.js
 * ---------------------------------------------------------------------------
 * Punto de entrada único para tres entornos:
 *
 *  - Render.com (producción): servicio web Node PERSISTENTE. Render define
 *    la variable PORT y exige bindear a 0.0.0.0. Ventaja clave frente a las
 *    serverless functions: el proceso vive entre requests, así que las cachés
 *    en memoria (catálogo, streams resueltos, transporte ganador contra el
 *    bloqueo de Vimeo) sobreviven y las respuestas son más rápidas.
 *
 *  - Vercel: exporta el handler ((req,res)) para la Serverless Function sin
 *    escuchar puertos (Vercel inyecta VERCEL=1).
 *
 *  - Local: `npm start` levanta el mismo servidor HTTP (puerto 7000 por
 *    defecto, override con PORT).
 *
 * Configuración sugerida en Render:
 *   Build Command:     npm install
 *   Start Command:     node server.js
 *   Health Check Path: /manifest.json
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
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

/**
 * Manifiesto con logo DINÁMICO: se sirve desde el mismo host que recibe la
 * petición (Render, Vercel o local). Antes estaba hardcodeado a Vercel, lo
 * que generaba manifests mezclados entre deployments. Override opcional con
 * ADDON_PUBLIC_URL.
 */
function manifestHandler(req, res) {
  const explicit = process.env.ADDON_PUBLIC_URL;
  let base;
  if (explicit) {
    base = explicit.replace(/\/$/, '');
  } else {
    const proto = String(
      req.headers['x-forwarded-proto'] || (IS_VERCEL ? 'https' : 'http')
    )
      .split(',')[0]
      .trim();
    const host = String(
      req.headers['x-forwarded-host'] || req.headers.host || ''
    )
      .split(',')[0]
      .trim();
    base = `${proto}://${host}`;
  }
  const logoUrl = `${base}/logo.png`;
  const manifest = { ...addon.manifest, logo: logoUrl, background: logoUrl };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(JSON.stringify(manifest));
}

/** Estado simple del servicio (útil como healthcheck alternativo). */
function statusHandler(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ok: true,
      service: 'cinetucumano-stremio',
      manifest: '/manifest.json'
    })
  );
}

// Cabeceras de caché: alivian la carga sin servir contenido rancio.
// Los streams se cachean poco: sus URLs firmadas expiran en ~1 hora.
function requestHandler(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  // CORS universal: Stremio web/Electron hace fetch del manifest y de los
  // streams desde contexto browser; sin Access-Control-Allow-Origin el
  // cliente falla con "Failed to fetch" aunque el endpoint responda 200.
  // Se fija ANTES del router para cubrir también las rutas custom
  // (/manifest.json, /debug, /logo.png); el router reescribe el mismo
  // header en sus rutas sin duplicarlo.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Range, Origin'
  );
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (urlPath !== '/logo.png') {
    console.log(`[http] ${req.method} ${req.url || urlPath}`);
  }

  if (urlPath === '/') return statusHandler(res);
  if (urlPath === '/manifest.json') return manifestHandler(req, res);
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
  // El router del SDK tiene firma (req, res, next): respondemos 404 si
  // ninguna ruta coincidió.
  return router(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  });
}

module.exports = requestHandler;

/* Arranque del proceso (Render y local). En Vercel NO se escucha puerto. */
if (!IS_VERCEL && !process.env.CT_NO_LISTEN) {
  const port = parseInt(process.env.PORT, 10) || 7000;
  http
    .createServer(requestHandler)
    .listen(port, '0.0.0.0', () => {
      console.log(`[cinetucumano-stremio] escuchando en 0.0.0.0:${port}`);
      console.log('[cinetucumano-stremio] manifest: /manifest.json');
    })
    .on('error', (err) => {
      console.error('[cinetucumano-stremio] error fatal del servidor:', err.message);
      process.exit(1);
    });
}
