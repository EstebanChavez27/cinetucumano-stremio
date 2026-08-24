# Contexto del Proyecto
Actúa como un desarrollador backend Senior experto en Node.js, web scraping y el ecosistema de Stremio (stremio-addon-sdk). 
El objetivo es construir un Add-on dinámico para Stremio que se alimente exclusivamente de la plataforma web `cinetucumano.com.ar`. El add-on será desplegado en Vercel utilizando Serverless Functions.

# Arquitectura y Reglas de Negocio
1. **Tech Stack:** Node.js, `stremio-addon-sdk`, `axios` (para peticiones HTTP) y `cheerio` (para parsear el DOM de forma rápida y compatible con entornos serverless). No utilices Puppeteer, ya que es pesado para el plan gratuito de Vercel.
2. **Origen de Datos:** Toda la metadata (catálogo y detalles) debe ser extraída haciendo scraping de `cinetucumano.com.ar`.
3. **Manejo de Video:** Los videos están alojados en Vimeo. El ID de la URL en la web de cinetucumano (ej: `cinetucumano.com.ar/movie/1172680712`) corresponde exactamente al ID del video en Vimeo (`1172680712`). Se debe utilizar una librería ligera de extracción de Vimeo o resolución de enlaces HLS/MP4 basada en ese ID.
4. **Estructura del Proyecto:**
   - `server.js` o `index.js`: Punto de entrada que exporta la función para Vercel.
   - `addon.js`: Configuración del manifest y los handlers (catalog, meta, stream) usando `stremio-addon-sdk`.
   - `scraper.js`: Módulo aislado encargado de las peticiones a la web y el parseo con `cheerio`.
   - `vimeo.js`: Módulo encargado de resolver el stream final.

# Tareas a Ejecutar

## Tarea 1: Configuración del Manifest
Crea el `manifest.json` requerido por Stremio.
- **id:** "org.cinetucumano.stremio"
- **name:** "Cine Tucumano"
- **description:** "Catálogo de películas y series de la plataforma web cinetucumano.com.ar"
- **resources:** `["catalog", "meta", "stream"]`
- **types:** `["movie", "series"]`
- **idPrefixes:** `["ct_"]` (para evitar colisiones con IDs de IMDB).

## Tarea 2: Handler de Catálogo (Catalog Handler)
Desarrolla la lógica para responder a la ruta del catálogo.
- Utiliza `axios` y `cheerio` en `scraper.js` para acceder a la página principal o directorio de `cinetucumano.com.ar`.
- Extrae la lista de películas disponibles.
- Mapea los resultados al formato que espera Stremio, construyendo el ID interno (ej: `ct_1172680712`), el título, y el afiche (poster).

## Tarea 3: Handler de Metadatos (Meta Handler)
Desarrolla la lógica para extraer la información detallada de una película o serie.
- Cuando Stremio solicite la metadata de un ID (ej: `ct_1172680712`), el script debe hacer una petición HTTP a `https://cinetucumano.com.ar/movie/1172680712`.
- Utilizando selectores CSS con `cheerio`, extrae los siguientes datos para armar el objeto `meta` de Stremio:
  - Título original.
  - Afiche / Poster (imagen en alta resolución si está disponible).
  - Background (imagen de fondo).
  - Sinopsis (description).
  - Género(s).
  - Elenco (Cast) y Equipo de Producción (Director, Productor, etc.).
  - Año de lanzamiento.

## Tarea 4: Handler de Streams (Stream Handler)
Desarrolla la lógica para la reproducción.
- Extrae el ID numérico de Vimeo del ID de Stremio (quitando el prefijo `ct_`).
- Implementa una función que resuelva el enlace directo del video (`.mp4` o `m3u8`) a partir del ID de Vimeo.
- Retorna el objeto `stream` a Stremio con el título de la calidad y la URL resolvida.

## Tarea 5: Adaptación para Vercel
- Asegúrate de que el servidor no use `serveHTTP` directamente si se detecta un entorno serverless.
- Utiliza la función `getRouter` de `stremio-addon-sdk` para exportar la aplicación adecuadamente para Vercel (`module.exports = function (req, res) { ... }`).
- Crea un archivo `vercel.json` con la configuración de rutas para que todas las peticiones apunten al archivo de entrada.

# Entregables Esperados
Escribe el código fuente completo, modularizado y con comentarios claros en español. Asegúrate de incluir el `package.json` con las dependencias necesarias. Si requieres hacer suposiciones sobre los selectores CSS específicos de la web, indícalos claramente con un comentario tipo `// TODO: Ajustar selector CSS según el DOM real`.