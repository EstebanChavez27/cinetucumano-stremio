# cinetucumano-stremio

Add-on de [Stremio](https://www.stremio.com) que integra el catálogo completo de [cinetucumano.com.ar](https://cinetucumano.com.ar) — la plataforma de streaming oficial del cine tucumano — directamente en tu reproductor favorito.

Películas, series y cortos producidos en Tucumán, reproducibles dentro de Stremio con un solo clic.

---

## Características

- **Catálogo completo**: películas, series con temporadas y episodios, documentales, cortometrajes, videoclips y animación.
- **Reproducción HLS adaptativa hasta 1080p dentro del reproductor de Stremio** (ideal para Smart TV), con subtítulos cuando el contenido los tiene.
- **Metadata rica**: pósters, sinopsis, géneros, elenco, dirección, equipo técnico y año.
- **Búsqueda integrada** en Stremio sobre todo el catálogo.
- **Sin configuración**: no requiere login ni API keys propias.

## Reproducción: siempre dentro de Stremio

Vimeo protege su reproductor contra el scraping automatizado (fingerprinting TLS y Cloudflare Turnstile contra IPs de datacenter). Para garantizar la reproducción HLS dentro del reproductor de Stremio desde cualquier hosting, `vimeo.js` resuelve el stream con una **cadena de tres transportes**:

1. **`curl` del sistema** — pasa el filtro TLS; funciona en red residencial y en los runtimes de Vercel.
2. **axios directo** — stack Node; funciona donde el fingerprinting no aplica.
3. **Relay [r.jina.ai](https://jina.ai/reader)** — servicio gratuito con navegador headless cuya infraestructura sí accede al player desde IPs de datacenter. Es lo que hace que Vercel (gratis) funcione siempre.

El primer transporte que devuelve el `playerConfig` gana y queda recordado para las próximas resoluciones (menor latencia). Los streams resueltos se cachean 10 minutos (las URLs firmadas viven ~1 hora), lo que además respeta los rate limits del tier gratuito del relay.

Si absolutamente todo falla, se devuelve un stream externo de emergencia ("Ver en el navegador"), pero el objetivo de diseño es que nunca sea necesario.

Puedes inspeccionar el entorno de red del deployment en cualquier momento:

```
https://<tu-deployment>.vercel.app/debug?v=<vimeoId>
```

## Alojamiento: alternativas gratuitas

Gracias al relay, **cualquier hosting gratuito funciona**, no solo Vercel:

| Opción | Costo | Funciona con Vimeo | Notas |
|---|---|---|---|
| **Vercel** (recomendado) | Gratis | Sí (vía relay) | Config lista en este repo, CDN global, sin mantenimiento |
| Render / Railway / Fly.io / Koyeb | Gratis (con límites) | Sí (vía relay) | Mismas IPs de datacenter: el relay las resuelve igual |
| PC / Raspberry en casa + [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) o Tailscale Funnel | Gratis | Sí (directo, sin relay) | Máxima latencia cero, pero requiere el equipo siempre encendido |

Las plataformas cloud no resuelven el bloqueo de Vimeo por sí solas (todas usan IPs de datacenter); lo que lo resuelve es el relay integrado. Por eso se mantiene Vercel como opción principal: es la que menos mantenimiento exige.

## Cómo funciona

```
Stremio ──► Add-on (Vercel) ──► API interna de cinetucumano.com.ar
                    │                     (catálogo, metadata, imágenes)
                    └────► player.vimeo.com ──► stream HLS + subtítulos
                             (curl → axios → relay r.jina.ai)
```

1. **`scraper.js`** consulta los endpoints JSON que la propia web consume (`/api/movies`, `/api/series`, `/api/season`, `/api/episode`, `/api/thumbnail`) con caché en memoria para minimizar requests.
2. **`addon.js`** expone los handlers estándar de Stremio (`catalog`, `meta`, `stream`) mediante `stremio-addon-sdk`.
3. **`vimeo.js`** extrae la configuración del reproductor embebido de Vimeo (con la cadena de transportes) y devuelve la playlist HLS firmada junto a las pistas de subtítulos disponibles.
4. **`server.js`** sirve todo como Serverless Function de Vercel (o servidor local en desarrollo), incluyendo el ícono en `/logo.png`.

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
| `api/index.js` | Punto de entrada de la Serverless Function de Vercel |
| `addon.js` | Manifest y handlers (`catalog`, `meta`, `stream`) |
| `scraper.js` | Acceso a la API del sitio + caché TTL + fallback HTML |
| `vimeo.js` | Resolución de streams HLS/MP4 y subtítulos de Vimeo |
| `server.js` | Entrada dual: serverless (Vercel) / `serveHTTP` (local) |
| `vercel.json` | Rewrites: todas las rutas apuntan a `/api/index` |
| `assets/logo.png` | Ícono del add-on |
| `scripts/generate-logo.js` | Regenera el ícono a partir de los assets oficiales del sitio |

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
- [r.jina.ai](https://jina.ai/reader) (relay gratuito, sin API key)
- [jimp](https://github.com/jimp-dev/jimp) (devDependency: solo para regenerar el ícono)

## Aviso

Proyecto independiente sin afiliación oficial con Cine Tucumano / CAAT. Todo el contenido pertenece a sus respectivos autores y se reproduce directamente desde la plataforma oficial cinetucumano.com.ar. Si sos responsable de la plataforma y querés comentar algo sobre este add-on, abrí un issue.
