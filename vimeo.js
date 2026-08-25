/**
 * Resolución de streams Vimeo mediante la API oficial.
 * Requiere VIMEO_ACCESS_TOKEN del propietario, con scopes public, private y video_files.
 */
const axios = require('axios');

const TOKEN = process.env.VIMEO_ACCESS_TOKEN;
const streamCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function idOf(value) {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Vimeo ID inválido');
  return id;
}

function client() {
  if (!TOKEN) throw new Error('Falta VIMEO_ACCESS_TOKEN en las variables de entorno');
  return axios.create({
    baseURL: 'https://api.vimeo.com',
    timeout: 12000,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.vimeo.*+json;version=3.4'
    },
    validateStatus: null
  });
}

function apiError(res, id) {
  if (!res) return new Error(`Vimeo no respondió para ${id}`);
  if (res.status === 401 || res.status === 403) {
    return new Error(`Vimeo rechazó la API para ${id} (${res.status}); revisá el token y video_files`);
  }
  return new Error(`Vimeo API respondió ${res.status} para ${id}`);
}

const array = (value) => Array.isArray(value) ? value : [];

function playableFiles(video) {
  const files = [
    ...array(video.files),
    ...array(video.download),
    ...array(video.play && video.play.progressive)
  ];
  const unique = new Map();
  for (const file of files) {
    const url = file && (file.link || file.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const type = String(file.type || '').toLowerCase();
    const quality = String(file.quality || file.rendition || '').toLowerCase();
    const hls = quality === 'hls' || type.includes('mpegurl') || /\.m3u8(?:\?|$)/i.test(url);
    const mp4 = type === 'video/mp4' || /\.mp4(?:\?|$)/i.test(url);
    if (!hls && !mp4) continue;
    const item = {
      quality: hls ? 'HLS' : (file.height ? `${file.height}p` : (file.quality || 'MP4')),
      url, hls, height: Number(file.height) || 0
    };
    if (!unique.has(url) || (hls && !unique.get(url).hls)) unique.set(url, item);
  }
  return [...unique.values()].sort((a, b) => {
    if (a.hls !== b.hls) return a.hls ? -1 : 1;
    return b.height - a.height;
  });
}

function textTracks(video) {
  return array(video.texttracks || video.text_tracks).map((track, i) => {
    const url = track && (track.link || track.url);
    return url ? { id: `ct-sub-${i}`, url, lang: track.lang || 'es', label: track.name || track.label || 'Subtítulos' } : null;
  }).filter(Boolean);
}

async function getVideo(vimeoId) {
  const id = idOf(vimeoId);
  const res = await client().get(`/videos/${id}`, { params: { fields: 'uri,duration,files,download,play,texttracks' } });
  if (res.status !== 200 || !res.data || !res.data.uri) throw apiError(res, id);
  return res.data;
}

async function resolveStreams(vimeoId) {
  const id = idOf(vimeoId);
  const hit = streamCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.value;
  const video = await getVideo(id);
  const files = playableFiles(video);
  if (!files.length) throw new Error(`Vimeo no entregó archivos reproducibles para ${id}; revisá plan, scopes y permisos`);
  const value = {
    streams: files.map(({ quality, url }) => ({ quality, url })),
    subtitles: textTracks(video),
    duration: video.duration || null
  };
  streamCache.set(id, { value, expires: Date.now() + CACHE_TTL });
  return value;
}

async function getEmbedUrl(vimeoId) {
  return `https://player.vimeo.com/video/${idOf(vimeoId)}`;
}

async function diagnose(vimeoId = '1172680712') {
  const report = { apiConfigured: Boolean(TOKEN), videoId: String(vimeoId) };
  if (!TOKEN) return { ...report, ok: false, error: 'VIMEO_ACCESS_TOKEN no configurado' };
  try {
    const files = playableFiles(await getVideo(vimeoId));
    return { ...report, ok: true, status: 200, fileCount: files.length, qualities: files.map((f) => f.quality) };
  } catch (error) {
    return { ...report, ok: false, error: error.message };
  }
}

module.exports = { resolveStreams, getEmbedUrl, diagnose };
