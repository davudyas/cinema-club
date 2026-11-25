// Cinema Club — configuration
// Supabase is only used for Realtime (presence + broadcast). No tables are needed.
// Swap these for another Supabase project any time (Project Settings → API).
export const CONFIG = {
  SUPABASE_URL: 'https://xqglbmbvzhlwlgexjqqi.supabase.co',
  SUPABASE_KEY: 'sb_publishable_T9OsFlFKa1GiJJwjS7xLRA_xvvQiSiD',

  // Movie data goes through the Netlify function in netlify/functions/tmdb.mjs,
  // which reads the TMDB_API_KEY environment variable (keeps your key private).
  TMDB_PROXY: '/api/tmdb',

  // Optional: paste a TMDB v3 API key here to call TMDB directly from the browser
  // (only if you host somewhere without Netlify Functions). Leave empty otherwise.
  TMDB_KEY: '',

  CHANNEL_PREFIX: 'coldopen',
};
