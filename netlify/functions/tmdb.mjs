// Netlify Function: tiny read-only proxy to TMDB so the API key stays server-side.
// Set TMDB_API_KEY in Netlify → Site configuration → Environment variables.
// Accepts either a v3 API key or a v4 "API Read Access Token" (starts with eyJ).

const ALLOWED = [
  /^\/configuration$/,
  /^\/discover\/movie$/,
  /^\/movie\/\d+$/,
  /^\/search\/movie$/,
  /^\/person\/\d+\/movie_credits$/,
];
const PASS_PARAMS = ['page', 'sort_by', 'language', 'query', 'include_adult', 'append_to_response',
  'vote_count.gte', 'primary_release_date.gte', 'primary_release_date.lte', 'with_original_language'];

export default async (req) => {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED.some((re) => re.test(path))) {
    return json({ error: 'path not allowed' }, 400);
  }
  const key = process.env.TMDB_API_KEY;
  if (!key) return json({ error: 'TMDB_API_KEY is not set' }, 500);

  const target = new URL('https://api.themoviedb.org/3' + path);
  for (const p of PASS_PARAMS) {
    const v = url.searchParams.get(p);
    if (v !== null) target.searchParams.set(p, v.slice(0, 120));
  }
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else target.searchParams.set('api_key', key);

  const res = await fetch(target, { headers });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': res.ok ? 'public, max-age=3600' : 'no-store',
    },
  });
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export const config = { path: '/api/tmdb' };
