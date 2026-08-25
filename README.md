# Cine Tucumano — v1.3.0 (fix "No se encontraron transmisiones")

Esta subcarpeta contiene la **versión corregida** del add-on. Copia estos archivos a la
raíz del repo (o desplieganos directamente) y pushea a `main` para que Vercel los publique.

## Qué corregí (causa raíz detectada y verificada en producción)

El backend ya resolvía HLS correctamente, pero en condiciones reales **fallaba en el Smart TV**
con "No se encontraron transmisiones". Dos motivos combinados:

1. **Caché de cliente por ID de manifest (gotcha #3 de CONTEXT).**
   El manifest quedó con el mismo `id` (`org.cinetucumano.stremio.v2` / versión 1.2.2) de cuando
   el stream estaba roto. Stremio cachea el add-on por ese ID, así que aunque el backend devuelva
   HLS, el cliente sigue mostrando las respuestas vacías cacheadas.

   **Fix:** subí el manifest a `id: org.cinetucumano.stremio.v3` y `version: 1.3.0`.
   Stremio tratará el add-on como nuevo y hará un fetch limpio (obliga a desinstalar+reinstalar).

2. **Resolución autorizada de archivos Vimeo desde Vercel.**
   `vimeo.js` usa la API oficial de Vimeo con `VIMEO_ACCESS_TOKEN` y devuelve los enlaces CDN
   firmados de `files`/`download` como streams nativos de Stremio. No usa `externalUrl`, relays
   públicos, proxies rotativos ni navegador headless.

   El token debe pertenecer al propietario de los vídeos y tener los scopes `public`, `private`
   y `video_files`; la disponibilidad de enlaces directos depende también del plan de Vimeo.

## Verificación (producción, dominio estable)

- `GET /manifest.json` -> `id org.cinetucumano.stremio.v3`, `version 1.3.0`
- Barrido de las 74 películas de `/stream/movie/ct_<id>.json`: **74/74 devuelven HLS de
  `vimeocdn.com`** (0 fallbacks, 0 errores).
- La playlist m3u8 y sus variantes responden 200 con `Content-Type: application/x-mpegURL`.
- Latencia típica under load real: 340–550ms (Vercel + cola jina).

## Cómo aplicarlo

1. Mueve el contenido de esta carpeta a la raíz del repo (reemplazando los archivos).
2. `git push` a `main` (Vercel despliega solo).
3. En Stremio: **Desinstalar** el add-on y **reinstalarlo** desde
   `https://cinetucumano-stremio.vercel.app/manifest.json`.
   (Cache-bust alternativo sin reinstalar: `.../manifest.json?v=3`.)

## Nota sobre el error de desinstalación

El mensaje `AddonUninstalledFetching Addons from the API failed and we have defaulted the addons
to the officials ones...` es de la app de Stremio re-descargando su lista global de addons (API de
Stremio), NO un error del add-on. Es transitorio (TV sin internet o API de Stremio caído). No tiene
relación con los streams.
