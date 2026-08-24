/**
 * api/index.js
 * ---------------------------------------------------------------------------
 * Punto de entrada para las Serverless Functions de Vercel.
 *
 * Vercel solo construye automáticamente archivos dentro de `api/`, por eso
 * esta fina capa delega en server.js (que ya exporta el router express del
 * add-on cuando detecta entorno serverless).
 */

module.exports = require('../server');
