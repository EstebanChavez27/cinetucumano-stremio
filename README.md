# cinetucumano-stremio

Add-on de [Stremio](https://www.stremio.com) que integra el catálogo completo de [cinetucumano.com.ar](https://cinetucumano.com.ar) — la plataforma de streaming oficial del cine tucumano — directamente en tu reproductor favorito.

Películas, series y cortos producidos en Tucumán, reproducibles dentro de Stremio con un solo clic.

---

## Características

- **Catálogo completo**: películas, series con temporadas y episodios, documentales, cortometrajes, videoclips y animación.
- **Streams en HLS adaptativo** hasta 1080p, resueltos desde el player de Vimeo.
- **Subtítulos incluidos** cuando el contenido los tiene (español).
- **Metadata rica**: pósters, sinopsis, géneros, elenco, dirección, equipo técnico y año.
- **Búsqueda integrada** en Stremio sobre todo el catálogo.
- **Sin configuración**: no requiere login ni API keys propias.

## Cómo funciona

```
Stremio ──► Add-on (Vercel) ──► API interna de cinetucumano.com.ar
                    │                     (catálogo, metadata, imágenes)
                    └────► player.vimeo.com ──► stream HLS + subtítulos
```

1. **`scraper.js`** consulta los endpoints JSON que la propia web consume (`/api/movies`, `/api/series`, `/api/season`, `/api/episode`, `/api/thumbnail`) con caché en memoria para minimizar requests.
2. **`addon.js`** expone los handlers estándar de Stremio (`catalog`, `meta`, `stream`) mediante `stremio-addon-sdk`.
3. **`vimeo.js`** extrae la configuración del reproductor embebido de Vimeo y devuelve la playlist HLS firmada junto a las pistas de subtítulos disponibles.
4. **`server.js`** sirve todo como Serverless Function de Vercel (o servidor local en desarrollo).

> Nota técnica: el edge de `player.vimeo.com` rechaza el fingerprint TLS de Node.js (JA3), por lo que la descarga del player se hace vía binario `curl` del sistema con fallback a axios. Ambos están disponibles en los runtimes de Vercel.

## Actualizaciones del catálogo

El add-on no almacena nada: cada consulta lee en vivo la API del sitio. Cuando cinetucumano.com.ar agrega o quita contenido, los cambios se reflejan solos en **~10–20 minutos** (tiempo máximo de las capas de caché internas y del CDN).

## Instalación en Stremio

1. Despliega tu propia instancia (ver abajo) o usa una existente.
2. Abre en el navegador o pega en Stremio:

   ```
   https://<tu-deployment>.vercel.app/manifest.json
   ```

3. Acepta e instala. El catálogo aparece en la sección "Add-ons" de Stremio.

## Desarrollo local

Requiere Node.js >= 18.

```bash
git clone https://github.com/tu-usuario/cinetucumano-stremio.git
cd cinetucumano-stremio
npm install
npm start
```

El add-on queda disponible en `http://127.0.0.1:7000/manifest.json`.

## Despliegue en Vercel

```bash
npm i -g vercel
vercel --prod
```

La configuración ya está lista (`vercel.json` enruta todas las peticiones a la función). El manifest público será:

```
https://<tu-proyecto>.vercel.app/manifest.json
```

## Estructura del proyecto

| Archivo | Descripción |
|---|---|
| `addon.js` | Manifest y handlers (`catalog`, `meta`, `stream`) |
| `scraper.js` | Acceso a la API del sitio + caché TTL + fallback HTML |
| `vimeo.js` | Resolución de streams HLS/MP4 y subtítulos de Vimeo |
| `server.js` | Entrada dual: serverless (Vercel) / `serveHTTP` (local) |
| `vercel.json` | Configuración de rutas para Vercel |

### Esquema de IDs internos

Prefijo `ct_` para evitar colisiones con IDs de IMDb:

- Películas: `ct_<vimeoId>` → ej. `ct_1172680712`
- Series: `ct_s_<idFirestore>` → ej. `ct_s_AdBjrQYbxTPcPVDSYo7N`
- Episodios: comparten espacio con películas (`ct_<vimeoId>`)

## Stack

- [Node.js](https://nodejs.org) 18+
- [stremio-addon-sdk](https://github.com/Stremio/addon-sdk)
- [axios](https://github.com/axios/axios)
- [cheerio](https://github.com/cheeriojs/cheerio) (fallback de scraping)

## Aviso

Proyecto independiente sin afiliación oficial con Cine Tucumano / CAAT. Todo el contenido pertenece a sus respectivos autores y se reproduce directamente desde la plataforma oficial cinetucumano.com.ar. Si sos responsable de la plataforma y querés comentar algo sobre este add-on, abrí un issue.
