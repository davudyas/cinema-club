// Movie data: TMDB (via Netlify proxy) with an offline demo fallback.
import { CONFIG } from './config.js';
import { DEMO_FILMS } from './demo-data.js';

const IMG = 'https://image.tmdb.org/t/p/';
const cache = new Map();
let mode = null; // 'tmdb' | 'demo'

export function getMode() { return mode; }
export function setMode(m) { mode = m; }

async function api(path, params = {}) {
  const ck = path + '?' + new URLSearchParams(params);
  if (cache.has(ck)) return cache.get(ck);
  let url;
  if (CONFIG.TMDB_KEY) {
    url = `https://api.themoviedb.org/3${path}?` + new URLSearchParams({ ...params, api_key: CONFIG.TMDB_KEY });
  } else {
    url = `${CONFIG.TMDB_PROXY}?` + new URLSearchParams({ ...params, path });
  }
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error('TMDB ' + r.status);
    return r.json();
  });
  cache.set(ck, p);
  p.catch(() => cache.delete(ck));
  return p;
}

export async function detectMode() {
  if (mode) return mode;
  if (new URLSearchParams(location.search).get('data') === 'demo') return (mode = 'demo');
  try {
    const r = await Promise.race([api('/configuration'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
    mode = r && r.images ? 'tmdb' : 'demo';
  } catch (e) {
    mode = 'demo';
  }
  return mode;
}

// ---------- normalisation ----------
function norm(m) {
  return {
    id: m.id,
    title: m.title,
    year: m.release_date ? +m.release_date.slice(0, 4) : null,
    date: m.release_date || '',
    poster: m.poster_path ? IMG + 'w342' + m.poster_path : null,
    backdrop: m.backdrop_path ? IMG + 'w780' + m.backdrop_path : null,
    rating: Math.round((m.vote_average || 0) * 10) / 10,
    votes: m.vote_count || 0,
  };
}

// ---------- demo ----------
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function art(seed, w, h) {
  let x = hash(String(seed));
  const r = () => ((x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0), (x % 1000) / 1000);
  const hue = Math.floor(r() * 360);
  let shapes = '';
  for (let i = 0; i < 7; i++) {
    const cx = Math.floor(r() * w), cy = Math.floor(r() * h), rad = Math.floor(20 + r() * w * 0.35);
    shapes += `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="hsl(${(hue + i * 47) % 360} 70% ${35 + r() * 35}%)" opacity="0.75"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 80) % 360} 60% 12%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${shapes}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
const DEMO = DEMO_FILMS.map(([title, year, runtime, rating, cast], i) => ({
  id: 900000 + i,
  title, year, date: `${year}-06-01`,
  poster: art(title, 342, 513),
  backdrop: art(title + 'bd', 780, 439),
  rating, votes: 10000,
  runtime,
  cast: cast.split('|').map((name, order) => ({ id: slug(name), name, order })),
}));
const DEMO_BY_ID = new Map(DEMO.map((m) => [m.id, m]));
const strip = ({ runtime, cast, ...rest }) => rest;

// ---------- public API ----------
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export async function getPool() {
  await detectMode();
  if (mode === 'demo') return shuffle(DEMO).map(strip);
  // Well-known films: sorted by vote count, random pages from the top ~400.
  const pages = shuffle([...Array(20)].map((_, i) => i + 1)).slice(0, 3);
  const res = await Promise.all(pages.map((page) =>
    api('/discover/movie', { sort_by: 'vote_count.desc', page, include_adult: 'false', language: 'en-US' }).catch(() => ({ results: [] }))));
  const seen = new Set();
  const out = [];
  for (const r of res) for (const m of r.results || []) {
    if (!seen.has(m.id) && m.poster_path && m.backdrop_path && m.release_date) { seen.add(m.id); out.push(norm(m)); }
  }
  if (out.length < 12) { mode = 'demo'; return shuffle(DEMO).map(strip); }
  return shuffle(out);
}

export async function getDetails(id) {
  if (DEMO_BY_ID.has(id)) {
    const m = DEMO_BY_ID.get(id);
    return { ...strip(m), runtime: m.runtime, cast: m.cast, overview: '', directors: [] };
  }
  const d = await api(`/movie/${id}`, { append_to_response: 'credits', language: 'en-US' });
  return {
    ...norm(d),
    runtime: d.runtime || 0,
    overview: d.overview || '',
    cast: ((d.credits && d.credits.cast) || []).slice(0, 40).map((c) => ({ id: c.id, name: c.name, order: c.order, character: c.character || '' })),
    directors: ((d.credits && d.credits.crew) || []).filter((c) => c.job === 'Director').map((c) => c.name),
  };
}

export async function searchMovies(q) {
  q = q.trim();
  if (q.length < 2) return [];
  if (mode === 'demo') {
    const ql = q.toLowerCase();
    return DEMO.filter((m) => m.title.toLowerCase().includes(ql)).slice(0, 8).map(strip);
  }
  const r = await api('/search/movie', { query: q, include_adult: 'false', language: 'en-US' });
  return (r.results || []).filter((m) => m.release_date).slice(0, 8).map(norm);
}

export async function personMovies(personId) {
  if (mode === 'demo') return DEMO.filter((m) => m.cast.some((c) => c.id === personId)).map(strip);
  const r = await api(`/person/${personId}/movie_credits`, { language: 'en-US' });
  return (r.cast || []).filter((m) => m.release_date && m.vote_count > 500)
    .sort((a, b) => b.vote_count - a.vote_count).slice(0, 20).map(norm);
}

export function preload(urls) {
  return Promise.all(urls.filter(Boolean).map((u) => new Promise((res) => {
    const im = new Image(); im.onload = im.onerror = res; im.src = u;
  })));
}
