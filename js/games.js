// Game definitions, host-side round generators and the solo bot.
import { EMOJI_FILMS } from './content.js';
import { getDetails, personMovies, getMode } from './movies.js';

export const GAMES = {
  emoji: { name: 'Emoji Flick', icon: '🍿', desc: 'Decode the film from three emojis.', images: false },
  higherlower: { name: 'Higher or Lower', icon: '⚖️', desc: 'Older? Longer? Better rated? Pick fast.', images: false },
  chain: { name: 'Actor Chain', icon: '🔗', desc: 'Link films through a shared actor. Run out of time, lose.', images: false },
  blur: { name: 'Blur Reveal', icon: '🌫️', desc: 'A poster slowly sharpens. Buzz in first.', images: true },
  year: { name: 'Year Guess', icon: '📅', desc: 'Closest release year takes the round.', images: false },
  cast: { name: 'Cast Call', icon: '🎭', desc: 'Name the film as its cast is revealed.', images: false },
  zoom: { name: 'Scene Zoom', icon: '🔍', desc: 'A still zooms out. Who spots it first?', images: true },
  plot: { name: 'Plot Twist', icon: '📜', desc: 'Read the synopsis — the title is blacked out.', tmdb: true },
  director: { name: "Director's Cut", icon: '🎬', desc: 'Who directed it? Four names, one is right.', tmdb: true },
  whoswho: { name: "Who's Who", icon: '🪪', desc: 'Name the film from its characters.', tmdb: true },
  timeline: { name: 'Timeline', icon: '🕰️', desc: 'Put four films in release order. One shot.', tmdb: true },
};
export const GAME_IDS = Object.keys(GAMES);

export const WIN_TARGET = 3; // first to 3 rounds
export const MAX_ROUNDS = 7;
export const CHAIN_TURN_MS = 30000;
export const CHAIN_MAX_USES = 3;

export const shuffle = (a, r = Math.random) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rand = (a, r = Math.random) => a[Math.floor(r() * a.length)];
// seeded RNG for the daily challenge (same rounds for everyone)
export function seededRng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
export function hashString(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export function availableGames() {
  // abstract demo art can't be recognised, so image games need real TMDB data
  return GAME_IDS.filter((g) => !((GAMES[g].images || GAMES[g].tmdb) && getMode() === 'demo'));
}

function takeFilm(ctx, pred = () => true) {
  const f = ctx.pool.find((m) => !ctx.used.has(m.id) && pred(m));
  if (f) ctx.used.add(f.id);
  return f;
}
function optionsFor(correct, ctx, n = 4) {
  const r = ctx.rng || Math.random;
  const others = shuffle(ctx.pool.filter((m) => m.title !== correct.title), r).slice(0, n - 1).map((m) => m.title);
  const opts = shuffle([correct.title, ...others], r);
  return { options: opts, answer: opts.indexOf(correct.title) };
}

// Returns { kind: 'mc'|'pair'|'year', duration, data, answer, reveal }
export async function makeRound(game, ctx) {
  const RNG = ctx.rng || Math.random;
  if (game === 'emoji') {
    const left = EMOJI_FILMS.filter((e) => !ctx.usedEmoji.has(e[0]));
    const [title, year, emoji] = rand(left.length ? left : EMOJI_FILMS, RNG);
    ctx.usedEmoji.add(title);
    const others = shuffle(EMOJI_FILMS.filter((e) => e[0] !== title), RNG).slice(0, 3).map((e) => e[0]);
    const options = shuffle([title, ...others], RNG);
    return { kind: 'mc', duration: 15000, data: { media: { type: 'emoji', text: emoji }, prompt: 'Which film is this?', options },
      answer: options.indexOf(title), reveal: { title, year } };
  }
  if (game === 'blur' || game === 'zoom') {
    const f = takeFilm(ctx, (m) => (game === 'blur' ? m.poster : m.backdrop));
    const { options, answer } = optionsFor(f, ctx);
    const media = game === 'blur'
      ? { type: 'blur', src: f.poster }
      : { type: 'zoom', src: f.backdrop, fx: 25 + Math.round(RNG() * 50), fy: 25 + Math.round(RNG() * 50) };
    return { kind: 'mc', duration: 16000, data: { media, prompt: game === 'blur' ? 'Name this poster' : 'Name this scene', options },
      answer, reveal: { title: f.title, year: f.year, poster: f.poster } };
  }
  if (game === 'cast') {
    for (let tries = 0; tries < 6; tries++) {
      const f = takeFilm(ctx);
      if (!f) break;
      try {
        const d = await getDetails(f.id);
        const names = d.cast.slice(0, 6).map((c) => c.name);
        if (names.length < 4) continue;
        const { options, answer } = optionsFor(f, ctx);
        return { kind: 'mc', duration: 17000, data: { media: { type: 'cast', names: names.reverse() }, prompt: 'Whose cast is this?', options },
          answer, reveal: { title: f.title, year: f.year, poster: f.poster } };
      } catch (e) { /* try another film */ }
    }
    throw new Error('Could not build a Cast Call round');
  }
  if (game === 'higherlower') {
    const variants = shuffle(['older', 'rating', 'runtime'], RNG);
    for (let tries = 0; tries < 8; tries++) {
      const variant = variants[tries % 3];
      const a = takeFilm(ctx), b = takeFilm(ctx);
      if (!a || !b) break;
      let va, vb, fmt, prompt, ok, aWins;
      if (variant === 'older') {
        va = a.date; vb = b.date; ok = a.year !== b.year; aWins = va < vb;
        prompt = 'Which came out first?'; fmt = (v, m) => String(m.year);
      } else if (variant === 'rating') {
        va = a.rating; vb = b.rating; ok = Math.abs(va - vb) >= 0.3; aWins = va > vb;
        prompt = 'Which is rated higher on TMDB?'; fmt = (v) => `★ ${v.toFixed(1)}`;
      } else {
        try {
          const [da, db] = await Promise.all([getDetails(a.id), getDetails(b.id)]);
          va = da.runtime; vb = db.runtime; ok = va && vb && Math.abs(va - vb) >= 8; aWins = va > vb;
        } catch (e) { ok = false; }
        prompt = 'Which one is longer?'; fmt = (v) => `${Math.floor(v / 60)}h ${v % 60}m`;
      }
      if (!ok) continue;
      return { kind: 'pair', duration: 10000,
        data: { prompt, films: [{ title: a.title, poster: a.poster }, { title: b.title, poster: b.poster }], showYear: variant !== 'older',
          years: [a.year, b.year] },
        answer: aWins ? 0 : 1,
        reveal: { title: aWins ? a.title : b.title, values: [fmt(va, a), fmt(vb, b)] } };
    }
    throw new Error('Could not build a Higher or Lower round');
  }
  if (game === 'plot') {
    for (let tries = 0; tries < 8; tries++) {
      const f = takeFilm(ctx);
      if (!f) break;
      let d; try { d = await getDetails(f.id); } catch (e) { continue; }
      if (!d.overview || d.overview.length < 80) continue;
      const { options, answer } = optionsFor(f, ctx);
      return { kind: 'mc', duration: 18000, data: { media: { type: 'plot', text: redact(clip(d.overview, 340), f.title) }, prompt: 'Which film is this?', options },
        answer, reveal: { title: f.title, year: f.year, poster: f.poster } };
    }
    throw new Error('Could not build a Plot Twist round');
  }
  if (game === 'director') {
    ctx.directors = ctx.directors || new Set();
    for (let tries = 0; tries < 8; tries++) {
      const f = takeFilm(ctx);
      if (!f) break;
      let d; try { d = await getDetails(f.id); } catch (e) { continue; }
      const dir = d.directors[0];
      if (!dir) continue;
      if (ctx.directors.size < 8) { // collect other directors from the pool for wrong answers
        const others = await Promise.all(shuffle(ctx.pool.filter((m) => m.id !== f.id), RNG).slice(0, 8).map((m) => getDetails(m.id).catch(() => null)));
        others.forEach((o) => o && o.directors.forEach((n) => ctx.directors.add(n)));
      }
      const wrong = shuffle([...ctx.directors].filter((n) => !d.directors.includes(n)), RNG).slice(0, 3);
      if (wrong.length < 3) continue;
      const options = shuffle([dir, ...wrong], RNG);
      return { kind: 'mc', duration: 12000, data: { media: { type: 'poster', src: f.poster, title: f.title, year: f.year }, prompt: 'Who directed it?', options },
        answer: options.indexOf(dir), reveal: { title: `${dir} directed ${f.title}`, year: f.year, poster: f.poster } };
    }
    throw new Error("Could not build a Director's Cut round");
  }
  if (game === 'whoswho') {
    for (let tries = 0; tries < 8; tries++) {
      const f = takeFilm(ctx);
      if (!f) break;
      let d; try { d = await getDetails(f.id); } catch (e) { continue; }
      const words = titleWords(f.title);
      const chars = [];
      for (const c of d.cast.slice(0, 10)) {
        const ch = c.character.replace(/\s*\((voice|uncredited)\)/gi, '').split(' / ')[0].trim();
        if (!ch || ch.length > 34 || /^(himself|herself|themselves|self|narrator)\b/i.test(ch)) continue;
        if (words.some((w) => new RegExp('\\b' + w + '\\b', 'i').test(ch))) continue; // would give the title away
        if (!chars.includes(ch)) chars.push(ch);
        if (chars.length === 4) break;
      }
      if (chars.length < 3) continue;
      const { options, answer } = optionsFor(f, ctx);
      return { kind: 'mc', duration: 16000, data: { media: { type: 'chars', names: chars.reverse() }, prompt: 'Which film has these characters?', options },
        answer, reveal: { title: f.title, year: f.year, poster: f.poster } };
    }
    throw new Error("Could not build a Who's Who round");
  }
  if (game === 'timeline') {
    const picked = [];
    const years = new Set();
    for (const m of shuffle(ctx.pool, RNG)) {
      if (ctx.used.has(m.id) || !m.year || years.has(m.year)) continue;
      picked.push(m); years.add(m.year);
      if (picked.length === 4) break;
    }
    if (picked.length < 4) throw new Error('Could not build a Timeline round');
    picked.forEach((m) => ctx.used.add(m.id));
    const order = picked.map((m, i) => i).sort((a, b) => picked[a].date.localeCompare(picked[b].date));
    return { kind: 'order', duration: 22000,
      data: { prompt: 'Put them in release order — oldest first', films: picked.map((m) => ({ title: m.title, poster: m.poster })) },
      answer: order,
      reveal: { years: picked.map((m) => m.year), line: order.map((i) => `${picked[i].title} (${picked[i].year})`).join(' → ') } };
  }
  if (game === 'year') {
    const f = takeFilm(ctx, (m) => m.year);
    return { kind: 'year', duration: 15000, data: { title: f.title, poster: f.poster, prompt: 'What year did it come out?' },
      answer: f.year, reveal: { title: f.title, year: f.year, poster: f.poster } };
  }
  throw new Error('Unknown game ' + game);
}

const STOP = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'on', 'to', 'for', 'part', 'vol', 'with', 'from', 'at']);
function titleWords(title) {
  return [...new Set(title.split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()))
    .flatMap((w) => (w.length > 4 && /s$/i.test(w) ? [w, w.slice(0, -1)] : [w])))]
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
function redact(text, title) {
  let out = text;
  for (const w of titleWords(title)) out = out.replace(new RegExp(`\\b${w}('s)?\\b`, 'gi'), '▇▇▇');
  return out;
}
function clip(text, n) {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, cut.lastIndexOf(' '))) + '…';
}

// ---------- Actor chain helpers (host) ----------
export async function chainLink(prevId, cand, usedActors) {
  const [p, c] = await Promise.all([getDetails(prevId), getDetails(cand.id)]);
  const prevIds = new Map(p.cast.map((x) => [x.id, x]));
  const shared = c.cast.filter((x) => prevIds.has(x.id));
  if (!shared.length) return { ok: false, reason: `No shared actor with ${p.title}` };
  const usable = shared.filter((x) => (usedActors[x.id] || 0) < CHAIN_MAX_USES);
  if (!usable.length) return { ok: false, reason: `${shared[0].name} has already been used ${CHAIN_MAX_USES}×` };
  const best = usable.sort((x, y) => (x.order + (prevIds.get(x.id).order)) - (y.order + prevIds.get(y.id).order))[0];
  return { ok: true, via: { id: best.id, name: best.name }, movie: { id: c.id, title: c.title, year: c.year, poster: c.poster } };
}

// ---------- Solo bot ----------
export class Bot {
  constructor(chan, peek) {
    this.chan = chan; // LoopChannel
    this.peek = peek; // () => current round secret ({ answer, n })
    this.skill = 0.62;
    this.timers = [];
  }
  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  stop() { this.timers.forEach(clearTimeout); this.timers = []; }
  receive(msg) {
    if (msg.t === 'round') {
      const sec = this.peek();
      if (!sec || sec.n !== msg.n) return;
      const { kind, data } = msg;
      const base = msg.delay || 0;
      if (kind === 'year') {
        const g = Math.round(sec.answer + (Math.random() - 0.5) * 2 * (2 + Math.random() * 9));
        const t = 3500 + Math.random() * 7000;
        this.later(base + t, () => this.chan.botSend({ t: 'answer', n: msg.n, value: Math.min(2026, g), elapsed: Math.round(t) }));
        return;
      }
      if (kind === 'order') {
        const t = 7000 + Math.random() * 9000;
        const v = Math.random() < this.skill ? sec.answer : shuffle(sec.answer);
        if (t < msg.duration) this.later(base + t, () => this.chan.botSend({ t: 'answer', n: msg.n, value: v, elapsed: Math.round(t) }));
        return;
      }
      const slow = data.media && ['blur', 'zoom', 'cast', 'chars', 'plot'].includes(data.media.type) ? 3500 : 0;
      const t = 2200 + slow + Math.random() * 7000;
      const count = kind === 'pair' ? 2 : data.options.length;
      const correct = Math.random() < this.skill;
      let v = sec.answer;
      if (!correct) { do { v = Math.floor(Math.random() * count); } while (v === sec.answer && count > 1); }
      if (t < msg.duration) this.later(base + t, () => this.chan.botSend({ t: 'answer', n: msg.n, value: v, elapsed: Math.round(t) }));
    }
    if (msg.t === 'chain' && msg.state.turn === '~bot' && !msg.state.over) {
      const st = msg.state;
      const len = st.chain.length;
      const giveUp = Math.random() < Math.min(0.85, 0.08 + len * 0.1);
      if (giveUp) return; // just let the clock run out
      const t = 4000 + Math.random() * 9000;
      this.later(t, async () => {
        try {
          const last = st.chain[st.chain.length - 1].movie;
          const d = await getDetails(last.id);
          const usedIds = new Set(st.chain.map((c) => c.movie.id));
          for (const actor of shuffle(d.cast.slice(0, 8))) {
            if ((st.used[actor.id] || 0) >= CHAIN_MAX_USES) continue;
            const films = (await personMovies(actor.id)).filter((m) => !usedIds.has(m.id));
            if (films.length) {
              this.chan.botSend({ t: 'chain_try', movie: films[Math.floor(Math.random() * Math.min(5, films.length))] });
              return;
            }
          }
        } catch (e) { /* bot gives up */ }
      });
    }
  }
}
