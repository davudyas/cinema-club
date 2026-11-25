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
};
export const GAME_IDS = Object.keys(GAMES);

export const WIN_TARGET = 3; // first to 3 rounds
export const MAX_ROUNDS = 7;
export const CHAIN_TURN_MS = 30000;
export const CHAIN_MAX_USES = 3;

export const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rand = (a) => a[Math.floor(Math.random() * a.length)];

export function availableGames() {
  // abstract demo art can't be recognised, so image games need real TMDB data
  return GAME_IDS.filter((g) => !(GAMES[g].images && getMode() === 'demo'));
}

function takeFilm(ctx, pred = () => true) {
  const f = ctx.pool.find((m) => !ctx.used.has(m.id) && pred(m));
  if (f) ctx.used.add(f.id);
  return f;
}
function optionsFor(correct, ctx, n = 4) {
  const others = shuffle(ctx.pool.filter((m) => m.title !== correct.title)).slice(0, n - 1).map((m) => m.title);
  const opts = shuffle([correct.title, ...others]);
  return { options: opts, answer: opts.indexOf(correct.title) };
}

// Returns { kind: 'mc'|'pair'|'year', duration, data, answer, reveal }
export async function makeRound(game, ctx) {
  if (game === 'emoji') {
    const left = EMOJI_FILMS.filter((e) => !ctx.usedEmoji.has(e[0]));
    const [title, year, emoji] = rand(left.length ? left : EMOJI_FILMS);
    ctx.usedEmoji.add(title);
    const others = shuffle(EMOJI_FILMS.filter((e) => e[0] !== title)).slice(0, 3).map((e) => e[0]);
    const options = shuffle([title, ...others]);
    return { kind: 'mc', duration: 15000, data: { media: { type: 'emoji', text: emoji }, prompt: 'Which film is this?', options },
      answer: options.indexOf(title), reveal: { title, year } };
  }
  if (game === 'blur' || game === 'zoom') {
    const f = takeFilm(ctx, (m) => (game === 'blur' ? m.poster : m.backdrop));
    const { options, answer } = optionsFor(f, ctx);
    const media = game === 'blur'
      ? { type: 'blur', src: f.poster }
      : { type: 'zoom', src: f.backdrop, fx: 25 + Math.round(Math.random() * 50), fy: 25 + Math.round(Math.random() * 50) };
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
    const variants = shuffle(['older', 'rating', 'runtime']);
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
  if (game === 'year') {
    const f = takeFilm(ctx, (m) => m.year);
    return { kind: 'year', duration: 15000, data: { title: f.title, poster: f.poster, prompt: 'What year did it come out?' },
      answer: f.year, reveal: { title: f.title, year: f.year, poster: f.poster } };
  }
  throw new Error('Unknown game ' + game);
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
      const slow = data.media && ['blur', 'zoom', 'cast'].includes(data.media.type) ? 3500 : 0;
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
