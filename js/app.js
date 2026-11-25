// Cinema Club — main app: screens, matchmaking, host-authoritative game loop, chat.
import { NET_MODE, openChannel, LoopChannel, fileReport } from './net.js';
import { filterText } from './filter.js';
import { sfx, buzz, unlock, soundOn, setSound } from './sound.js';
import * as M from './movies.js';
import { GAMES, GAME_IDS, availableGames, makeRound, chainLink, Bot, shuffle, seededRng, hashString,
  WIN_TARGET, MAX_ROUNDS, CHAIN_TURN_MS, CHAIN_MAX_USES } from './games.js';
import { QUESTION_CARDS, FILM_CARDS, ADJ, NOUN, AVATARS, randomName, randomAvatar } from './content.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const app = $('#app');

// ---------- storage ----------
const store = (() => { try { return NET_MODE === 'local' ? sessionStorage : localStorage; } catch (e) { return null; } })();
function load(k, d) { try { const v = store && store.getItem('coldopen:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function save(k, v) { try { store && store.setItem('coldopen:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

const myId = Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
let profile = load('profile', null);
if (!profile || !profile.name) {
  profile = { name: randomName(), avatar: randomAvatar(), dev: Math.random().toString(36).slice(2, 12), blocks: [] };
  save('profile', profile);
}
profile.blocks = profile.blocks || [];

// ---------- state ----------
const S = {
  screen: 'home',
  lobby: null, lobbyOk: null, online: 0, waiting: 0,
  searching: false, searchSince: 0, pairing: false, pairTimer: null, expect: null,
  room: null, roomCode: null, roomKind: null, // 'match' | 'friends' | 'solo'
  partner: null, partnerGone: false, isHost: false, bot: null,
  game: null, scores: {}, round: null, roundStart: 0, myAnswer: null, myOk: null, locks: {}, result: null,
  chain: null, chainRecvAt: 0, matchEnd: null,
  cards: null, picks: [], chatCards: [], messages: [], typingUntil: 0, rematch: null,
  lastGames: [], soloGame: null,
  searchKind: 'game', film: null, filmPins: [], filmResults: [],
  h: null, // host-only private state
};

// ---------- timers ----------
let uiTimers = [];
function uiLater(ms, fn) { const id = setTimeout(fn, ms); uiTimers.push(id); return id; }
function uiEvery(ms, fn) { const id = setInterval(fn, ms); uiTimers.push(id); return id; }
function clearUi() { uiTimers.forEach((id) => { clearTimeout(id); clearInterval(id); }); uiTimers = []; }
function hLater(ms, fn) { const H = S.h; const id = setTimeout(() => { if (S.h === H && !H.stopped) fn(); }, ms); if (H) H.timers.push(id); return id; }
function hostStop() { if (S.h) { S.h.stopped = true; S.h.timers.forEach(clearTimeout); } S.h = null; if (S.bot) S.bot.stop(); }

// ---------- toast ----------
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

// ---------- views ----------
const me = () => ({ key: myId, name: profile.name, avatar: profile.avatar });
const nameOf = (k) => (k === myId ? 'You' : S.partner && S.partner.key === k ? S.partner.name : 'Someone');

function go(screen) {
  S.screen = screen;
  clearUi();
  app.innerHTML = (VIEWS[screen] || VIEWS.home)();
  app.dataset.screen = screen;
  (AFTER[screen] || (() => {}))();
  updateQueueBar();
  window.scrollTo(0, 0);
}

const logo = () => `<div class="logo"><span class="clap" aria-hidden="true"><i></i></span>Cinema&nbsp;Club</div>`;
const isDark = () => document.documentElement.dataset.theme === 'dark';
const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>';
const themeBtn = () => `<button class="iconbtn" data-act="theme" aria-label="${isDark() ? 'Switch to light mode' : 'Switch to dark mode'}" title="${isDark() ? 'Light mode' : 'Dark mode'}">${isDark() ? SUN : MOON}</button>`;
const soundIcon = () => soundOn()
  ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>'
  : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
const soundBtn = () => `<button class="iconbtn" data-act="sound" aria-label="${soundOn() ? 'Mute sounds' : 'Turn sounds on'}" title="Sound">${soundIcon()}</button>`;
const leaveBtn = () => `<button class="iconbtn leave" data-act="leavematch" aria-label="Leave match and go home" title="Leave match">✕</button>`;
const topRight = (...parts) => `<div class="top-r">${parts.join('')}</div>`;
const FLAG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>';
// report is available whenever you're connected to a real person (not the solo bot)
const reportBtn = () => (S.partner && !['~bot', '~daily'].includes(S.partner.key) ? `<button class="iconbtn report" data-act="report" aria-label="Report ${esc(S.partner.name)}" title="Report">${FLAG}</button>` : '');
const onlinePill = () => `<span class="online" data-online>${onlineText()}</span>`;
const othersOnline = () => Math.max(0, S.online - 1); // never count yourself
function onlineText() {
  if (S.lobbyOk === false && NET_MODE !== 'local') return `<b class="off"></b>offline`;
  if (S.lobbyOk === null && NET_MODE !== 'local') return `<b class="wait"></b>connecting…`;
  const o = othersOnline();
  return o ? `<b></b>${o} other${o === 1 ? '' : 's'} online` : `<b class="idle"></b>just you here`;
}
function waitCountText() {
  const o = othersOnline(), w = S.waitingOthers || 0;
  if (!o) return 'Nobody else is online right now.';
  return `${o} other${o === 1 ? '' : 's'} online · ${w ? `${w} looking for a match` : 'nobody else searching yet'}`;
}
function updateOnline() {
  $$('[data-online]').forEach((el) => (el.innerHTML = onlineText()));
  const w = $('[data-waitcount]');
  if (w) w.textContent = waitCountText();
}
const vsBar = () => `
  <div class="vs">
    <div class="player">${pChip(me(), S.scores[myId])}</div>
    <span class="vs-x">vs</span>
    <div class="player right">${pChip(S.partner || { name: '…', avatar: '🎟️' }, S.partner ? S.scores[S.partner.key] : undefined)}</div>
  </div>`;
function pChip(p, score) {
  const lock = S.screen === 'round' ? `<span class="lock" data-lock="${esc(p.key)}"></span>` : '';
  return `<span class="av">${esc(p.avatar)}</span><span class="pn">${p.key === myId ? 'You' : esc(p.name)}${lock}</span>${score !== undefined ? `<span class="score" data-score="${esc(p.key)}">${score}</span>` : ''}`;
}

// ---------- daily challenge ----------
const DAILY_EPOCH = Date.UTC(2026, 10, 25); // daily #1
const DAILY_GAMES = ['emoji', 'plot', 'whoswho', 'director', 'timeline', 'cast', 'higherlower', 'blur'];
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
function loadDaily() {
  try { const v = localStorage.getItem('cinemaclub:daily'); const st = v ? JSON.parse(v) : null; if (st && st.results) return st; } catch (e) { /* private mode */ }
  return { results: {}, lastPlayed: null, streak: 0 };
}
function saveDaily(st) {
  const keys = Object.keys(st.results).sort();
  keys.slice(0, Math.max(0, keys.length - 40)).forEach((k) => delete st.results[k]);
  try { localStorage.setItem('cinemaclub:daily', JSON.stringify(st)); } catch (e) { /* private mode */ }
}
function dailyInfo() {
  const key = dayKey();
  const n = Math.floor((Date.parse(key) - DAILY_EPOCH) / 864e5) + 1;
  const seed = hashString('cinema-club-daily:' + key);
  const avail = availableGames();
  const games = shuffle(DAILY_GAMES.filter((g) => avail.includes(g)), seededRng(seed ^ 0x9e3779b9)).slice(0, 5);
  const st = loadDaily();
  const yesterday = dayKey(new Date(Date.now() - 864e5));
  const streak = st.lastPlayed === key || st.lastPlayed === yesterday ? st.streak : 0;
  return { key, n, seed, games, today: st.results[key] || null, streak };
}
function nextDailyIn() {
  const now = new Date();
  const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now;
  const h = Math.floor(ms / 36e5), m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}
function dailyCardHtml() {
  const d = dailyInfo();
  const r = d.today;
  return `<button class="daily-card" data-act="daily">
      <span class="dc-ico" aria-hidden="true">📅</span>
      <span class="dc-txt"><b>Daily challenge #${d.n}</b><small>${r ? `${r.grid.join('')} · ${r.score} pts${d.streak > 1 ? ` · 🔥 ${d.streak}` : ''}` : '5 rounds · same for everyone today'}</small></span>
      <span class="go">${r ? 'Results →' : 'Play →'}</span>
    </button>`;
}
const dailyShareText = (d) => `🎬 Cinema Club Daily #${d.n}\n${d.today.grid.join('')} ${d.today.score}/1000${d.streak > 1 ? ` 🔥${d.streak}` : ''}\n${location.origin}`;
const dailyShareHtml = () => `<div class="row share-row"><button class="btn primary" data-act="dailycopy">Copy result</button>${navigator.share ? '<button class="btn" data-act="dailyshare">Share…</button>' : ''}</div>`;

// ---------- footer + about ----------
function footerHtml() {
  return `<footer class="foot">
      <nav><button class="link ${installPrompt ? '' : 'hidden'}" data-act="install">📲 Install app</button><button class="link" data-act="about">About &amp; rules</button><a class="link" href="https://x.com/davudsdiary" target="_blank" rel="noopener">Send feedback on X</a></nav>
      <a class="tmdb" href="https://www.themoviedb.org/" target="_blank" rel="noopener"><img src="assets/tmdb-logo.svg" alt="TMDB" width="92" height="12"><span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span></a>
    </footer>`;
}
function openSheet(inner, label) {
  closeReport();
  const w = document.createElement('div');
  w.id = 'modal';
  w.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">${inner}</div>`;
  document.body.appendChild(w);
  w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-close]')) closeReport(); });
  const c = w.querySelector('[data-close]'); if (c) c.focus();
}
function openAbout() {
  openSheet(`
    <h3>About Cinema Club</h3>
    <p>Cinema Club matches film fans for a quick movie game and a chat — or with someone who just watched the same film. No sign-up: your nickname lives in your browser.</p>
    <h4>House rules</h4>
    <ul>
      <li><b>Be kind.</b> No insults, hate or sexual content. Bad words are blurred automatically.</li>
      <li><b>Keep it anonymous.</b> Don't share personal info — emails, phone numbers and @handles are hidden automatically.</li>
      <li><b>Report &amp; block.</b> Use 🚩 if someone crosses a line. Blocked people won't be matched with you again.</li>
    </ul>
    <h4>Privacy</h4>
    <p>Chats aren't saved anywhere — they disappear when you leave. If you report someone, their recent messages are sent with the report so it can be reviewed. Your name, theme and daily results stay on this device.</p>
    <h4>Get the app</h4>
    <p>Cinema Club works like an app: on Android/Chrome tap <b>📲 Install app</b> in the footer; on iPhone tap <b>Share → Add to Home Screen</b>.</p>
    <h4>Movie data</h4>
    <a class="tmdb big" href="https://www.themoviedb.org/" target="_blank" rel="noopener"><img src="assets/tmdb-logo.svg" alt="TMDB" width="150" height="20"><span>This product uses the TMDB API but is not endorsed or certified by TMDB. Film titles, posters and credits come from The Movie Database.</span></a>
    <div class="row"><a class="btn" href="https://x.com/davudsdiary" target="_blank" rel="noopener">Send feedback</a><button class="btn primary" data-close>Got it</button></div>`, 'About Cinema Club');
}

const VIEWS = {
  home: () => `
    <header class="top">${logo()}${topRight(onlinePill(), soundBtn(), themeBtn())}</header>
    <main class="home">
      <div class="home-l">
      <div class="me-row">
        <button class="me-chip" data-act="editname" title="Choose your name" aria-expanded="false">
          <span class="av" data-myav>${esc(profile.avatar)}</span><span data-myname>${esc(profile.name)}</span><span class="reroll" aria-hidden="true">✎</span>
        </button>
        <button class="iconbtn" data-act="reroll" title="Random name" aria-label="Random name">↻</button>
      </div>
      <form class="name-editor hidden" data-form="name">
        <p class="eyebrow">Pick your look</p>
        <div class="avgrid">${AVATARS.map((a) => `<button type="button" class="avopt ${a === profile.avatar ? 'on' : ''}" data-act="pickav" data-a="${a}" aria-label="Avatar ${a}">${a}</button>`).join('')}</div>
        <div class="namepick">
          <label><span>First word</span><select name="adj" data-adj>${ADJ.map((a) => `<option ${splitName().adj === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
          <label><span>Second word</span><select name="noun" data-noun>${NOUN.map((n) => `<option ${splitName().noun === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        </div>
        <div class="row"><button type="button" class="btn" data-act="editname">Cancel</button><button type="submit" class="btn primary">Save name</button></div>
      </form>
      <h1>Play first.<br><span class="hl">Then talk movies.</span></h1>
      <p class="lede">Meet a film fan, play a two-minute movie game, then talk films. Just finished something? Find someone who watched it too.</p>
      <div class="cta">
        <button class="btn primary big" data-act="match">🎟️ Random match <small>game, then chat</small></button>
        <button class="btn ink big" data-act="filmpick">💬 Talk about a film <small>same film, spoilers OK</small></button>
        <div class="row three">
          <button class="btn small-btn" data-act="solo">🍿 Solo</button>
          <button class="btn small-btn" data-act="create">Create room</button>
          <button class="btn small-btn" data-act="showjoin">Join room</button>
        </div>
        <form class="join hidden" data-form="join">
          <input name="code" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code" />
          <button class="btn primary" type="submit">Join</button>
        </form>
      </div>
      <ol class="how" aria-label="How it works">
        <li><b>1</b><span><strong>Match</strong> with a stranger or a friend</span></li>
        <li><b>2</b><span><strong>Play</strong> a quick movie game</span></li>
        <li><b>3</b><span><strong>Chat</strong> with question cards to start</span></li>
      </ol>
      </div>
      <div class="home-r">
      ${dailyCardHtml()}
      <section class="discussing home-disc ${discussingList().length ? '' : 'hidden'}" data-discussing data-hideempty>${discussingHtml()}</section>
      <section class="strip">
        <div class="strip-head"><span>Now showing</span><span>${GAME_IDS.length} games · tap to practise</span></div>
        <div class="games">
          ${GAME_IDS.map((g) => `
            <button class="game-tile" data-act="practise" data-game="${g}">
              <span class="gi">${GAMES[g].icon}</span>
              <span class="gn">${GAMES[g].name}</span>
              <span class="gd">${GAMES[g].desc}</span>
            </button>`).join('')}
        </div>
      </section>
      </div>
    </main>
    ${footerHtml()}`,

  dailyintro: () => {
    const d = dailyInfo();
    const res = d.today;
    return `
    <header class="top">${logo()}${topRight(themeBtn())}</header>
    <main class="center daily">
      <p class="eyebrow">Daily challenge #${d.n}</p>
      ${res ? `
        <h2>${res.done ? 'You played today’s reel' : 'Today’s reel is used up'}</h2>
        <div class="dgrid">${res.grid.join('')}${'⬛'.repeat(Math.max(0, 5 - res.grid.length))}</div>
        <div class="final">${res.score}<span>/1000</span></div>
        ${dailyShareHtml(d)}
        <p class="muted">Next reel in <b data-countdown-next>${nextDailyIn()}</b></p>`
      : `
        <h2>Five rounds. Same for everyone today.</h2>
        <p class="muted">Get them right and get them fast — up to 200 points a round. One try per day, so make it count.</p>
        <div class="dgames">${d.games.map((g) => `<span>${GAMES[g].icon} ${GAMES[g].name}</span>`).join('')}</div>
        <button class="btn primary big" data-act="dailystart">▶ Start today’s reel</button>`}
      ${d.streak > 1 ? `<p class="streak">🔥 ${d.streak}-day streak</p>` : ''}
      <button class="link" data-act="home">Back home</button>
    </main>`;
  },

  dailyload: () => `
    <header class="top">${logo()}${topRight(leaveBtn())}</header>
    <main class="center"><div class="projector" aria-hidden="true"><span></span><span></span></div><h2>Rolling today’s reel…</h2></main>`,

  filmpick: () => `
    <header class="top">${logo()}${topRight(onlinePill(), leaveBtn())}</header>
    <main class="filmpick">
      <h2>What did you just watch?</h2>
      <p class="muted">Pick the film and we'll find someone who's seen it too. Spoilers allowed — you've both finished it.</p>
      <form class="csearch" data-form="film">
        <input name="q" placeholder="Search a film…" autocomplete="off" data-fq aria-label="Search a film" />
        <div class="cresults" data-fresults></div>
      </form>
      <section class="discussing" data-discussing>${discussingHtml()}</section>
      <section class="popular" data-popular>
        <div class="strip-head"><span>Popular this week</span><span>tap to pick</span></div>
        <div class="pgrid">${popularHtml()}</div>
      </section>
    </main>`,

  filmsearching: () => `
    <header class="top">${logo()}${topRight(onlinePill(), leaveBtn())}</header>
    <main class="center filmwait">
      <div class="filmposter">${S.film.poster ? `<img src="${esc(S.film.poster)}" alt="">` : '<span>🎬</span>'}</div>
      <h2>Looking for someone who watched <em>${esc(S.film.title)}</em>…</h2>
      <p class="muted">You'll show up under “Now discussing” for everyone, so others can join you.</p>
      <p class="elapsed" data-elapsed>0:00</p>
      ${waitPlayHtml()}
      <button class="link" data-act="filmpick">Pick a different film</button>
      <section class="discussing" data-discussing>${discussingHtml()}</section>
    </main>`,

  searching: () => `
    <header class="top">${logo()}${topRight(onlinePill(), leaveBtn())}</header>
    <main class="center">
      <div class="projector" aria-hidden="true"><span></span><span></span></div>
      <h2>Finding your co-star…</h2>
      <p class="muted" data-waitcount>${waitCountText()}</p>
      <p class="elapsed" data-elapsed>0:00</p>
      ${waitPlayHtml()}
      <button class="link" data-act="cancel">Cancel</button>
      <p class="fine">Or <button class="link" data-act="create">create a room</button> and send the link to a friend.</p>
    </main>`,

  connecting: () => `
    <header class="top">${logo()}${topRight(leaveBtn())}</header>
    <main class="center"><div class="projector" aria-hidden="true"><span></span><span></span></div><h2>Match found!</h2><p class="muted">Dimming the lights…</p></main>`,

  roomwait: () => {
    const link = `${location.origin}${location.pathname}?room=${S.roomCode}${NET_MODE === 'local' ? '&net=local' : ''}`;
    return `
    <header class="top">${logo()}${topRight(onlinePill(), leaveBtn())}</header>
    <main class="center">
      <p class="eyebrow">Your private room</p>
      <div class="ticket-code">${[...S.roomCode].map((c) => `<span>${c}</span>`).join('')}</div>
      <p class="muted">Send this code or link to a friend. The game starts as soon as they join.</p>
      <div class="row">
        <button class="btn primary" data-act="copylink" data-link="${esc(link)}">Copy link</button>
        ${navigator.share ? `<button class="btn" data-act="sharelink" data-link="${esc(link)}">Share…</button>` : ''}
      </div>
      <p class="muted pulse">Waiting for your friend…</p>
      <button class="link" data-act="leave">Cancel</button>
    </main>`;
  },

  spin: () => {
    const items = [...GAME_IDS, ...GAME_IDS, ...GAME_IDS, ...GAME_IDS];
    return `
    <header class="top">${logo()}${topRight(reportBtn(), leaveBtn())}</header>
    <main class="center spin">
      ${vsBar()}
      <p class="eyebrow">Tonight's feature</p>
      <div class="reel ${S.game ? '' : 'idle'}"><div class="reel-track">
        ${items.map((g) => `<div class="reel-item"><span>${GAMES[g].icon}</span>${GAMES[g].name}</div>`).join('')}
      </div></div>
      <p class="muted" data-spinnote>Picking a game…</p>
    </main>`;
  },

  round: () => {
    const r = S.round;
    const d = r.data;
    let media = '';
    let input = '';
    if (r.kind === 'mc') {
      const m = d.media;
      if (m.type === 'emoji') media = `<div class="media emoji">${esc(m.text)}</div>`;
      if (m.type === 'blur') media = `<div class="media poster"><img class="blur" src="${esc(m.src)}" alt="Blurred poster" style="--dur:${r.duration}ms"></div>`;
      if (m.type === 'zoom') media = `<div class="media scene"><img class="zoom" src="${esc(m.src)}" alt="Zoomed film still" style="--dur:${r.duration}ms;transform-origin:${m.fx}% ${m.fy}%"></div>`;
      if (m.type === 'cast' || m.type === 'chars') media = `<div class="media cast">${m.names.map((n, i) => `<div class="cast-row" data-ci="${i}"><span>${m.type === 'chars' ? '🪪' : '#' + (m.names.length - i)}</span>${esc(n)}</div>`).join('')}</div>`;
      if (m.type === 'plot') media = `<div class="media plot"><p>${esc(m.text)}</p></div>`;
      if (m.type === 'poster') media = `<div class="media yearcard">${m.src ? `<img src="${esc(m.src)}" alt="">` : ''}<div class="yt">${esc(m.title)}${m.year ? `<small>${m.year}</small>` : ''}</div></div>`;
      input = `<div class="options">${d.options.map((o, i) => `<button class="opt" data-act="answer" data-v="${i}">${esc(o)}</button>`).join('')}</div>`;
    } else if (r.kind === 'pair') {
      media = `<div class="pair">${d.films.map((f, i) => `
        <button class="pcard" data-act="answer" data-v="${i}">
          ${f.poster ? `<img src="${esc(f.poster)}" alt="">` : '<div class="noimg">🎬</div>'}
          <span class="pt">${esc(f.title)}${d.showYear && d.years[i] ? ` <em>(${d.years[i]})</em>` : ''}</span>
          <span class="pv" data-pv="${i}"></span>
        </button>`).join('<span class="or">or</span>')}</div>`;
    } else if (r.kind === 'order') {
      media = `<div class="order">${d.films.map((f, i) => `
        <button class="ocard" data-act="orderpick" data-i="${i}">
          ${f.poster ? `<img src="${esc(f.poster)}" alt="">` : '<div class="noimg">🎬</div>'}
          <span class="pt">${esc(f.title)}</span><span class="onum" data-onum="${i}"></span><span class="oyear" data-oy="${i}"></span>
        </button>`).join('')}</div>`;
      input = `<div class="row order-actions"><button class="btn" data-act="orderreset">Reset</button><button class="btn primary" data-act="orderlock" disabled>Tap all 4 in order</button></div>`;
    } else if (r.kind === 'year') {
      media = `<div class="media yearcard">${d.poster ? `<img src="${esc(d.poster)}" alt="">` : ''}<div class="yt">${esc(d.title)}</div></div>`;
      input = `<div class="yearpick">
        <div class="yrow"><button class="btn round" data-act="ystep" data-d="-1" aria-label="Earlier">−</button><output data-year>2000</output><button class="btn round" data-act="ystep" data-d="1" aria-label="Later">+</button></div>
        <input type="range" min="1920" max="2026" value="2000" data-yrange aria-label="Release year">
        <button class="btn primary" data-act="ylock">Lock in</button></div>`;
    }
    return `
    <header class="top slim">${vsBar()}${reportBtn()}${leaveBtn()}</header>
    <main class="round kind-${r.kind}">
      <div class="round-meta"><span>${GAMES[r.game].icon} ${GAMES[r.game].name}</span><span>${S.roomKind === 'daily' && S.daily ? `Daily #${S.daily.n} · round ${r.n} of ${S.daily.games.length}` : `Round ${r.n} · first to ${WIN_TARGET}`}</span></div>
      <div class="timer"><i style="--dur:${r.duration}ms"></i></div>
      <h3 class="prompt">${esc(d.prompt)}</h3>
      <div class="stage">${media}<div class="countdown" data-countdown>3</div></div>
      ${input}
      <div class="verdict" data-verdict></div>
    </main>`;
  },

  chain: () => `
    <header class="top slim">${vsBar()}${reportBtn()}${leaveBtn()}</header>
    <main class="chain">
      <div class="round-meta"><span>🔗 Actor Chain</span><span>actors can be used ${CHAIN_MAX_USES}×</span></div>
      <div class="timer"><i data-ctimer></i></div>
      <div class="turn" data-turn></div>
      <form class="csearch" data-form="chain">
        <input name="q" placeholder="Type a film that shares an actor…" autocomplete="off" data-cq />
        <div class="cresults" data-cresults></div>
      </form>
      <div class="cfeedback" data-cfb></div>
      <ol class="links" data-links></ol>
      <button class="link" data-act="giveup">Give up</button>
    </main>`,

  matchend: () => {
    const m = S.matchEnd;
    const iWon = m.winner === myId;
    const title = !m.winner ? "It's a draw!" : iWon ? 'You win! 🏆' : `${esc(S.partner.name)} wins`;
    const oppScore = m.scores[S.partner.key] ?? 0;
    return `
    <header class="top">${logo()}${topRight(reportBtn(), leaveBtn())}</header>
    <main class="center end">
      <p class="eyebrow">${GAMES[m.game].icon} ${GAMES[m.game].name}</p>
      <h2 class="big">${title}</h2>
      <div class="final">${m.scores[myId] ?? 0} <span>–</span> ${oppScore}</div>
      <p class="muted">${S.roomKind === 'solo' ? '' : !m.winner ? 'You each pick one question card…' : iWon ? 'Your prize: you pick the questions.' : `${esc(S.partner.name)} is about to pick the questions…`}</p>
    </main>`;
  },

  soloend: () => {
    const m = S.matchEnd;
    const iWon = m.winner === myId;
    return `
    <header class="top">${logo()}${topRight(themeBtn())}</header>
    <main class="center end">
      <p class="eyebrow">${GAMES[m.game].icon} ${GAMES[m.game].name}</p>
      <h2 class="big">${!m.winner ? 'Draw!' : iWon ? 'You beat the Projectionist 🏆' : 'The Projectionist wins 🤖'}</h2>
      <div class="final">${m.scores[myId] ?? 0} <span>–</span> ${m.scores['~bot'] ?? 0}</div>
      <div class="cta">
        <button class="btn primary" data-act="soloagain">Play ${GAMES[m.game].name} again</button>
        <button class="btn gold" data-act="solo">Random game</button>
        <button class="btn" data-act="match">🎟️ Find a real co-star</button>
        <button class="link" data-act="home">Home</button>
      </div>
    </main>`;
  },

  cards: () => {
    const c = S.cards;
    const need = c.picker === 'both' ? 1 : c.picker === myId ? 2 : 0;
    const head = c.picker === 'both' ? 'Draw — pick one question each'
      : need ? 'You won — pick 2 questions' : `${esc(S.partner.name)} is picking 2 questions…`;
    return `
    <header class="top slim">${vsBar()}${reportBtn()}${leaveBtn()}</header>
    <main class="cards">
      <h2>${head}</h2>
      <p class="muted">${need ? 'These will be pinned at the top of your chat.' : 'Get ready to answer them.'}</p>
      <div class="qgrid ${need ? '' : 'readonly'}">
        ${c.cards.map((id) => `<button class="qcard" data-act="pickcard" data-id="${id}" ${need ? '' : 'disabled'}><span class="qn">Q</span>${esc(QUESTION_CARDS[id])}</button>`).join('')}
      </div>
      ${need ? `<button class="btn primary big" data-act="confirmcards" disabled>Pick ${need} card${need > 1 ? 's' : ''}</button>` : '<p class="muted pulse">Waiting…</p>'}
    </main>`;
  },

  chat: () => `
    <header class="top chat-top">
      <div class="who"><span class="av">${esc(S.partner.avatar)}</span><div><b>${esc(S.partner.name)}</b><small data-typing>${S.partnerGone ? 'left the chat' : statusLine()}</small></div></div>
      <div class="chat-actions">
        <button class="btn small gold" data-act="rematch" ${S.partnerGone ? 'disabled' : ''} title="Play a movie game together">🎲<span class="lbl"> ${S.roomKind === 'film' ? 'Play a game' : 'Another game'}</span></button>
        <button class="btn small" data-act="menu" aria-label="More">⋯</button>
        ${reportBtn()}${leaveBtn()}
      </div>
      <div class="menu hidden" data-menu>
        <button data-act="leave">🏠 Leave &amp; go home</button>
        <button data-act="theme">${isDark() ? 'Light mode' : 'Dark mode'}</button>
        <button data-act="sound">Sound: ${soundOn() ? 'on' : 'off'}</button>
        ${S.roomKind !== 'friends' ? '<button data-act="block" class="danger">Block &amp; leave</button>' : ''}
      </div>
    </header>
    <div class="pins">${filmPinsHtml()}${S.chatCards.map((id, i) => askPin(QUESTION_CARDS[id], S.filmPins.length + i + 1)).join('')}</div>
    <div class="banner hidden" data-banner></div>
    <main class="msgs" data-msgs>${S.messages.map(msgHtml).join('')}</main>
    <form class="composer" data-form="chat">
      <input name="text" maxlength="300" placeholder="${S.partnerGone ? 'Chat closed' : S.roomKind === 'film' ? `Talk about ${esc(S.film.title)}…` : 'Say something about movies…'}" autocomplete="off" ${S.partnerGone ? 'disabled' : ''} />
      <button class="btn primary" type="submit" ${S.partnerGone ? 'disabled' : ''} aria-label="Send">➤</button>
    </form>`,

  left: () => `
    <header class="top">${logo()}${topRight(onlinePill(), themeBtn())}</header>
    <main class="center">
      <div class="big-emoji">🚪</div>
      <h2>${esc(S.partner ? S.partner.name : 'Your co-star')} left the theater.</h2>
      <div class="cta">
        ${S.roomKind === 'film' && S.film ? `<button class="btn primary big" data-act="filmagain">💬 Find someone else for ${esc(S.film.title)}</button>` : '<button class="btn primary big" data-act="match">🎟️ Find a new match</button>'}
        <button class="link" data-act="home">Home</button>
      </div>
    </main>`,
};

const AFTER = {
  searching() { startElapsed(); },
  filmsearching() { startElapsed(); },
  filmpick() {
    M.detectMode();
    let tq;
    const q = $('[data-fq]');
    if (window.matchMedia('(pointer:fine)').matches) q.focus();
    q.addEventListener('input', () => {
      clearTimeout(tq);
      tq = setTimeout(async () => {
        const val = q.value;
        const box = $('[data-fresults]');
        if (!box) return;
        if (val.trim().length < 2) { box.innerHTML = ''; return; }
        try {
          await M.detectMode();
          const res = await M.searchMovies(val);
          if (q.value !== val || !$('[data-fresults]')) return;
          S.filmResults = res;
          box.innerHTML = res.length ? res.map((m, i) => `<button type="button" class="cres" data-act="pickfilm" data-i="${i}">${m.poster ? `<img src="${esc(m.poster)}" alt="">` : '<span class="noimg">🎬</span>'}<span>${esc(m.title)} <em>${m.year || ''}</em></span></button>`).join('')
            : '<p class="muted small">No films found</p>';
        } catch (e) { box.innerHTML = '<p class="muted small">Search failed — try again</p>'; }
      }, 280);
    });
    connectLobby().then(updateDiscussing);
    if (!S.popular) M.trending().then((list) => { S.popular = list; }).catch(() => { S.popular = []; }).then(() => { const pg = $('[data-popular] .pgrid'); if (pg) pg.innerHTML = popularHtml(); });
  },
  home() {
    const dm = $('[data-datamode]');
    M.detectMode().then((m) => { if (m === 'demo' && dm) dm.innerHTML = '<br><em>Demo film data — add a TMDB key for real posters & all 7 games.</em>'; });
  },
  spin() {
    if (!S.game) return;
    const track = $('.reel-track');
    const idx = GAME_IDS.length * 3 + GAME_IDS.indexOf(S.game);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      track.style.transform = `translateY(calc(-${idx} * var(--reel-h)))`;
    }));
    uiLater(2450, () => { const n = $('[data-spinnote]'); if (n) n.textContent = GAMES[S.game].desc; $('.reel').classList.add('landed'); });
  },
  round() {
    const r = S.round;
    const imgs = [];
    if (r.data.media && r.data.media.src) imgs.push(r.data.media.src);
    if (r.data.films) r.data.films.forEach((f) => imgs.push(f.poster));
    if (r.data.poster) imgs.push(r.data.poster);
    M.preload(imgs);
    const cd = $('[data-countdown]');
    const left = () => S.roundStart - performance.now();
    let shown = '';
    const tick = () => {
      const l = left();
      if (l > 0) {
        const n = Math.ceil(l / 500) > 2 ? '3' : Math.ceil(l / 500) === 2 ? '2' : '1';
        if (n !== shown) { shown = n; cd.textContent = n; sfx('tick'); }
        return;
      }
      cd.remove();
      sfx('go');
      $('main.round').classList.add('live');
      startCastReveal();
    };
    tick();
    if (left() > 0) {
      const iv = setInterval(() => { if (!$('[data-countdown]')) return clearInterval(iv); tick(); if (left() <= 0) clearInterval(iv); }, 100);
      uiTimers.push(iv);
    }
    if (r.kind === 'year') {
      const range = $('[data-yrange]');
      range.addEventListener('input', () => ($('[data-year]').textContent = range.value));
    }
    updateRound();
  },
  chain() {
    let tq;
    const q = $('[data-cq]');
    q.addEventListener('input', () => {
      clearTimeout(tq);
      tq = setTimeout(async () => {
        const val = q.value;
        const box = $('[data-cresults]');
        if (!box) return;
        if (val.trim().length < 2) { box.innerHTML = ''; return; }
        try {
          const res = await M.searchMovies(val);
          if (q.value !== val || !$('[data-cresults]')) return;
          S.chainResults = res;
          box.innerHTML = res.length ? res.map((m, i) => `<button type="button" class="cres" data-act="chainpick" data-i="${i}">${m.poster ? `<img src="${esc(m.poster)}" alt="">` : '<span class="noimg">🎬</span>'}<span>${esc(m.title)} <em>${m.year || ''}</em></span></button>`).join('')
            : '<p class="muted small">No films found</p>';
        } catch (e) { box.innerHTML = '<p class="muted small">Search failed</p>'; }
      }, 280);
    });
    updateChain();
    uiEvery(200, chainClock);
  },
  chat() {
    const box = $('[data-msgs]');
    box.scrollTop = box.scrollHeight;
    updateBanner();
    let lastTyping = 0;
    $('[data-form="chat"] input').addEventListener('input', () => {
      if (Date.now() - lastTyping > 2000) { lastTyping = Date.now(); send({ t: 'typing' }); }
    });
    uiEvery(1000, updateTyping);
  },
  dailyintro() {
    uiEvery(1000, () => { const el = $('[data-countdown-next]'); if (el) el.textContent = nextDailyIn(); });
  },
  matchend() {
    if (S.roomKind === 'solo') uiLater(2600, () => go('soloend'));
  },
};

function startElapsed() {
  const tick = () => {
    const el = $('[data-elapsed]'); if (!el) return;
    const sec = Math.floor((Date.now() - S.searchSince) / 1000);
    el.textContent = `Searching for ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const wp = $('.waitplay'); if (wp) wp.classList.toggle('nudge', sec >= 10);
  };
  tick(); uiEvery(1000, tick);
}

// ---------- round UI ----------
function startCastReveal() {
  const r = S.round;
  if (!(r.kind === 'mc' && ['cast', 'chars'].includes(r.data.media.type))) return;
  const rows = $$('.cast-row');
  const step = Math.floor((r.duration - 3000) / rows.length);
  rows.forEach((row, i) => uiLater(i * step, () => row.classList.add('on')));
}
function updateRound() {
  if (S.screen !== 'round') return;
  $$('[data-lock]').forEach((el) => {
    const k = el.dataset.lock;
    el.textContent = k in S.locks ? (S.round.kind === 'year' || k !== myId ? ' · locked in' : S.locks[k] ? ' · ✓' : ' · ✗') : '';
  });
  if (S.myAnswer !== null) {
    $$('[data-act="answer"]').forEach((b) => {
      b.disabled = true;
      if (+b.dataset.v === S.myAnswer) b.classList.add('chosen', S.myOk === true ? 'good' : S.myOk === false ? 'bad' : 'pending');
    });
    if (S.round.kind === 'order') {
      $$('[data-act="orderpick"],[data-act="orderreset"],[data-act="orderlock"]').forEach((b) => (b.disabled = true));
      const l = $('[data-act="orderlock"]'); if (l) l.textContent = S.myOk === true ? 'Locked in ✓' : S.myOk === false ? 'Locked in ✗' : 'Locked in';
    }
    if (S.round.kind === 'year') {
      $$('[data-act="ystep"],[data-act="ylock"],[data-yrange]').forEach((b) => (b.disabled = true));
      const l = $('[data-act="ylock"]'); if (l) l.textContent = `Locked: ${S.myAnswer}`;
    }
  }
}
function renderOrder() {
  $$('[data-onum]').forEach((el) => { const pos = S.orderSel.indexOf(+el.dataset.onum); el.textContent = pos >= 0 ? pos + 1 : ''; });
  $$('.ocard').forEach((c) => c.classList.toggle('picked', S.orderSel.includes(+c.dataset.i)));
  const l = $('[data-act="orderlock"]');
  if (l && S.myAnswer === null) { l.disabled = S.orderSel.length !== 4; l.textContent = S.orderSel.length === 4 ? 'Lock in' : `Tap all 4 in order (${S.orderSel.length}/4)`; }
}
function answer(v) {
  if (S.screen !== 'round' || S.myAnswer !== null || S.result) return;
  const elapsed = Math.round(performance.now() - S.roundStart);
  if (elapsed < 0) return; // countdown still running
  S.myAnswer = v;
  updateRound();
  const msg = { t: 'answer', n: S.round.n, value: v, elapsed };
  if (S.isHost) hostAnswer(myId, v, elapsed, S.round.n); else send(msg);
}
function showResult() {
  if (S.screen !== 'round') return;
  const r = S.round, res = S.result;
  $('main.round').classList.add('done');
  const st = $('.stage');
  if (r.kind === 'mc') {
    $$('.opt').forEach((b) => { b.disabled = true; if (+b.dataset.v === res.answer) b.classList.add('correct'); });
    if (r.data.media.type === 'cast') $$('.cast-row').forEach((x) => x.classList.add('on'));
    if (res.reveal.poster && !['blur', 'poster'].includes(r.data.media.type)) st.insertAdjacentHTML('beforeend', `<img class="reveal-poster" src="${esc(res.reveal.poster)}" alt="">`);
  }
  if (r.kind === 'order') {
    $$('.ocard').forEach((c) => { c.disabled = true; const i = +c.dataset.i; const pos = res.answer.indexOf(i);
      const el = $(`[data-onum="${i}"]`); if (el) el.textContent = pos + 1;
      const y = $(`[data-oy="${i}"]`); if (y) y.textContent = res.reveal.years[i];
      if (Array.isArray(S.myAnswer)) c.classList.add(S.myAnswer[pos] === i ? 'good' : 'bad'); });
  }
  if (r.kind === 'pair') {
    $$('.pcard').forEach((b) => { b.disabled = true; if (+b.dataset.v === res.answer) b.classList.add('correct'); });
    res.reveal.values.forEach((v, i) => { const el = $(`[data-pv="${i}"]`); if (el) el.textContent = v; });
  }
  let line;
  if (r.kind === 'year') {
    const parts = Object.entries(res.answers).map(([k, a]) => `${k === myId ? 'You' : esc(S.partner.name)}: <b>${a.value}</b>`);
    line = `Released <b>${res.reveal.year}</b>${parts.length ? ' · ' + parts.join(' · ') : ''}`;
  } else if (r.kind === 'order') {
    line = esc(res.reveal.line);
  } else {
    line = `${esc(res.reveal.title)}${res.reveal.year ? ` <span class="muted">(${res.reveal.year})</span>` : ''}`;
  }
  const who = S.roomKind === 'daily' ? (res.pts ? `✅ +${res.pts} points` : '❌ No points this round')
    : res.winner === myId ? '🎉 Point to you!' : res.winner ? `${esc(S.partner.name)} takes it` : 'No point this round';
  $('[data-verdict]').innerHTML = `<div class="verdict-in ${res.winner === myId ? 'win' : res.winner ? 'lose' : ''}"><b>${who}</b><span>${line}</span></div>`;
  updateScores();
}
function updateScores() {
  $$('[data-score]').forEach((el) => { const v = S.scores[el.dataset.score]; if (v !== undefined && el.textContent !== String(v)) { el.textContent = v; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } });
}

// ---------- chain UI ----------
function updateChain() {
  if (S.screen !== 'chain' || !S.chain) return;
  const st = S.chain;
  const mine = st.turn === myId && !st.over;
  const turn = $('[data-turn]');
  if (st.over) {
    const won = st.loser !== myId;
    turn.innerHTML = `<b>${won ? `⏱️ ${esc(S.partner.name)} ran out of time — you win!` : '⏱️ Time’s up — you lose this one.'}</b>`;
  } else {
    turn.innerHTML = mine ? `<b>Your turn.</b> Name a film that shares an actor with <em>${esc(st.chain[st.chain.length - 1].movie.title)}</em>.`
      : `<b>${esc(S.partner.name)}'s turn…</b> Think of your next link.`;
  }
  turn.className = 'turn ' + (mine ? 'mine' : '');
  const q = $('[data-cq]');
  q.disabled = !mine;
  if (!mine) { q.value = ''; $('[data-cresults]').innerHTML = ''; }
  else if (document.activeElement !== q && window.matchMedia('(pointer:fine)').matches) q.focus();
  const links = st.chain.slice().reverse();
  $('[data-links]').innerHTML = links.map((c, i) => `
    <li class="${i === 0 ? 'latest' : ''}">
      ${c.via ? `<span class="via">via <b>${esc(c.via.name)}</b> <i>${'●'.repeat(st.used[c.via.id] || 1)}${'○'.repeat(Math.max(0, CHAIN_MAX_USES - (st.used[c.via.id] || 1)))}</i></span>` : '<span class="via start">opening film</span>'}
      <div class="link-card">${c.movie.poster ? `<img src="${esc(c.movie.poster)}" alt="">` : '<span class="noimg">🎬</span>'}
      <div><b>${esc(c.movie.title)}</b><small>${c.movie.year || ''}${c.by ? ` · ${c.by === myId ? 'you' : esc(S.partner.name)}` : ''}</small></div></div>
    </li>`).join('');
  chainClock();
}
function chainClock() {
  const st = S.chain; const bar = $('[data-ctimer]');
  if (!st || !bar) return;
  if (st.over) { bar.style.width = '0%'; return; }
  const left = Math.max(0, st.turnMs - (performance.now() - S.chainRecvAt));
  bar.style.width = (left / st.turnMs) * 100 + '%';
  bar.classList.toggle('hot', left < 8000);
  const turn = $('[data-turn]');
  if (turn) turn.dataset.sec = Math.ceil(left / 1000);
}

// ---------- chat UI ----------
function msgHtml(m) {
  if (m.sys) return `<div class="sys">${m.html}</div>`;
  return `<div class="msg ${m.from === myId ? 'mine' : ''}"><p>${esc(m.text)}</p></div>`;
}
function pushMsg(m) {
  S.messages.push(m);
  if (S.messages.length > 300) S.messages.shift();
  if (S.screen === 'chat') {
    const box = $('[data-msgs]');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.insertAdjacentHTML('beforeend', msgHtml(m));
    if (nearBottom || m.from === myId) box.scrollTop = box.scrollHeight;
  }
}
const sys = (html) => pushMsg({ sys: true, html });
function statusLine() {
  if (S.roomKind === 'friends') return 'in your room';
  if (S.roomKind === 'film' && S.film) return `also watched ${S.film.title}`;
  return 'online';
}
function askPin(q, n) {
  const asked = S.asked && S.asked.has(q);
  return `<button class="pin ask ${asked ? 'asked' : ''}" data-act="ask" data-q="${esc(q)}" ${S.partnerGone ? 'disabled' : ''}><span class="qn">Q${n} · ${asked ? 'asked ✓' : 'tap to ask'}</span>${esc(q)}</button>`;
}
function waitPlayHtml() {
  return `<div class="waitplay">
      <b>Nobody here yet? Don't just stare at the screen.</b>
      <span>Play the Projectionist while you wait. We'll pull you into a real match the moment someone joins.</span>
      <button class="btn gold" data-act="waitplay">🍿 Play while I wait</button>
    </div>`;
}
function popularHtml() {
  if (!S.popular) return '<p class="muted small">Loading…</p>';
  if (!S.popular.length) return '<p class="muted small">Couldn\'t load popular films — search instead.</p>';
  const waiting = new Map(discussingList().map((e) => [String(e.film.id), e.n]));
  return S.popular.map((m, i) => `<button class="pop" data-act="pickpop" data-i="${i}">
      ${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy">` : '<span class="noimg">🎬</span>'}
      ${waiting.has(String(m.id)) ? `<span class="live">● ${waiting.get(String(m.id))} waiting</span>` : ''}
      <span class="pt">${esc(m.title)}</span>
    </button>`).join('');
}
function updateQueueBar() {
  let bar = $('#queuebar');
  const show = S.searching && S.roomKind === 'solo';
  if (!show) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'queuebar'; document.body.appendChild(bar); }
  const what = S.searchKind === 'film' && S.film ? `someone who watched ${esc(S.film.title)}` : 'a co-star';
  bar.innerHTML = `<span class="dot"></span><span>Still looking for ${what}…</span><button data-qb="stop">Stop</button>`;
}
function filmPinsHtml() {
  if (S.roomKind !== 'film' || !S.film) return '';
  const f = S.film;
  return `<div class="pin film">${f.poster ? `<img src="${esc(f.poster)}" alt="">` : ''}<div><span class="qn">Now discussing</span><b>${esc(f.title)}</b>${f.year ? ` <span class="yr">${f.year}</span>` : ''}<small>Spoilers allowed</small></div></div>`
    + S.filmPins.map((q, i) => askPin(q, i + 1)).join('');
}
// films other people are waiting to talk about (from lobby presence)
function discussingList() {
  if (!S.lobby) return [];
  const by = new Map();
  for (const p of S.lobby.peers()) {
    if (p.key === myId || p.mode !== 'waiting' || p.kind !== 'film' || !p.film || !p.film.id) continue;
    const e = by.get(p.film.id) || { film: p.film, n: 0 };
    e.n++; by.set(p.film.id, e);
  }
  return [...by.values()].sort((a, b) => b.n - a.n).slice(0, 8);
}
function discussingHtml() {
  const list = discussingList();
  const mine = S.film && S.searching && S.searchKind === 'film' ? S.film.id : null;
  const rows = list.filter((e) => e.film.id !== mine);
  return `<div class="strip-head"><span>Now discussing</span><span>${rows.length ? 'tap to join' : 'live'}</span></div>`
    + (rows.length ? rows.map((e) => `<button class="disc" data-act="joinfilm" data-id="${esc(e.film.id)}">${e.film.poster ? `<img src="${esc(e.film.poster)}" alt="">` : '<span class="noimg">🎬</span>'}<span><b>${esc(e.film.title)}</b> <em>${esc(e.film.year || '')}</em><small>${e.n} waiting to talk</small></span><span class="go">Join →</span></button>`).join('')
      : `<p class="muted small">${S.screen === 'filmsearching' || (S.searching && S.searchKind === 'film') ? 'No other films are being discussed right now.' : 'Nobody else is waiting right now. Pick your film and you\'ll be first in line.'}</p>`);
}
function updateDiscussing() {
  const el = $('[data-discussing]');
  if (!el) return;
  el.innerHTML = discussingHtml();
  if ('hideempty' in el.dataset) el.classList.toggle('hidden', !discussingList().length);
  const pg = $('[data-popular] .pgrid'); if (pg && S.popular) pg.innerHTML = popularHtml();
}
function splitName() {
  const adj = ADJ.find((a) => profile.name.startsWith(a + ' ')) || ADJ[0];
  const noun = NOUN.find((n) => profile.name === `${adj} ${n}`) || NOUN[0];
  return { adj, noun };
}
function seededPick(arr, seed, n) {
  let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; const j = h % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
function updateTyping() {
  const el = $('[data-typing]');
  if (!el || S.partnerGone) return;
  el.textContent = Date.now() < S.typingUntil ? 'typing…' : statusLine();
}
function updateBanner() {
  const b = $('[data-banner]');
  if (!b) return;
  if (S.rematch === 'in') {
    b.innerHTML = `<span>🎲 ${esc(S.partner.name)} wants to play a movie game</span><button class="btn small primary" data-act="rematchyes">Let's go</button><button class="btn small" data-act="rematchno">Not now</button>`;
    b.classList.remove('hidden');
  } else if (S.rematch === 'out') {
    b.innerHTML = `<span class="pulse">Waiting for ${esc(S.partner.name)} to accept…</span>`;
    b.classList.remove('hidden');
  } else if (S.partnerGone) {
    b.innerHTML = `<span>${esc(S.partner.name)} left.</span><button class="btn small primary" data-act="${S.roomKind === 'film' ? 'filmagain' : 'match'}">New match</button><button class="btn small" data-act="home">Home</button>`;
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}
function cleanText(t) {
  return filterText(t.replace(/\s+/g, ' ').trim().slice(0, 300))
    .replace(/\b((https?:\/\/|www\.)\S+|\S+\.(com|net|org|de|io|app|me|ly|gg)(\/\S*)?)\b/gi, '[link removed]');
}

// ---------- networking ----------
function send(m) { m.from = myId; if (S.room) S.room.send(m); }
function bcast(m) { send(m); const c = JSON.parse(JSON.stringify(m)); setTimeout(() => handle(c), 0); }

async function connectLobby() {
  if (S.lobby) return;
  const ch = openChannel('lobby', myId);
  S.lobby = ch;
  ch.onSync((peers) => {
    S.online = peers.length;
    S.waiting = peers.filter((p) => p.mode === 'waiting').length;
    S.waitingOthers = peers.filter((p) => p.mode === 'waiting' && p.key !== myId && (p.kind || 'game') === S.searchKind).length;
    updateOnline();
    updateDiscussing();
    if (S.searching && !S.pairing) tryPair(peers);
  });
  try {
    await ch.ready;
    S.lobbyOk = true;
    await trackLobby();
  } catch (e) {
    console.warn('Lobby unavailable', e);
    S.lobbyOk = false; S.lobby = null;
  }
  updateOnline();
}
function trackLobby() {
  if (!S.lobby || S.lobbyOk === false) return;
  return S.lobby.track({
    mode: S.searching ? 'waiting' : 'idle', since: S.searchSince, kind: S.searchKind,
    film: S.searching && S.searchKind === 'film' && S.film ? { id: S.film.id, title: S.film.title, year: S.film.year, poster: S.film.poster } : null,
    name: profile.name, avatar: profile.avatar, dev: profile.dev, blocks: profile.blocks.slice(-50),
  });
}
const compatible = (a, b) => !(a.blocks || []).includes(b.dev) && !(b.blocks || []).includes(a.dev) && (NET_MODE === 'local' || a.dev !== b.dev);
function tryPair(peers) {
  const sameQueue = (p) => (p.kind || 'game') === S.searchKind && (S.searchKind !== 'film' || (p.film && S.film && p.film.id === S.film.id));
  const w = peers.filter((p) => p.mode === 'waiting' && sameQueue(p)).sort((a, b) => (a.since - b.since) || (a.key < b.key ? -1 : 1));
  const used = new Set();
  let partner = null;
  for (let i = 0; i < w.length && !partner; i++) {
    if (used.has(w[i].key)) continue;
    for (let j = i + 1; j < w.length; j++) {
      if (used.has(w[j].key) || !compatible(w[i], w[j])) continue;
      used.add(w[i].key); used.add(w[j].key);
      if (w[i].key === myId) partner = w[j]; else if (w[j].key === myId) partner = w[i];
      break;
    }
  }
  if (!partner) return;
  S.pairing = true;
  const film = S.searchKind === 'film';
  joinRoom((film ? 'f-' : 'm-') + [myId, partner.key].sort().join('-'), film ? 'film' : 'match', partner.key);
}
async function startSearch() {
  if (NET_MODE !== 'local' && S.lobbyOk === false) { toast('Matchmaking is offline right now — try a room or solo'); return; }
  await leaveRoom();
  S.searching = true; S.searchSince = Date.now(); S.pairing = false; S.searchKind = 'game';
  go('searching');
  await connectLobby();
  await trackLobby();
  if (S.lobby) setTimeout(() => S.searching && !S.pairing && tryPair(S.lobby.peers()), 300);
}
function stopSearch() { S.searching = false; S.pairing = false; clearTimeout(S.pairTimer); trackLobby(); }
async function startFilmSearch(film) {
  if (NET_MODE !== 'local' && S.lobbyOk === false) { toast('Matchmaking is offline right now — try again soon'); return; }
  await leaveRoom();
  resetMatch();
  S.film = film; S.searchKind = 'film';
  S.searching = true; S.searchSince = Date.now(); S.pairing = false;
  go('filmsearching');
  await connectLobby();
  await trackLobby();
  if (S.lobby) setTimeout(() => S.searching && !S.pairing && tryPair(S.lobby.peers()), 300);
}

function resetMatch() {
  hostStop();
  Object.assign(S, { partner: null, partnerGone: false, isHost: false, bot: null, game: null, scores: {}, round: null, result: null,
    chain: null, matchEnd: null, cards: null, picks: [], chatCards: [], filmPins: [], messages: [], rematch: null, typingUntil: 0, asked: new Set() });
}
async function leaveRoom(silent) {
  clearTimeout(S.pairTimer);
  hostStop();
  const ch = S.room;
  S.room = null;
  if (ch) { if (!silent) { try { ch.send({ t: 'bye', from: myId }); } catch (e) { /* closed */ } } await ch.leave(); }
}
async function joinRoom(code, kind, expectKey) {
  if (S.roomKind === 'solo' && S.searching) toast('🎟️ Match found — switching you over!');
  await leaveRoom(true);
  resetMatch();
  S.roomCode = code; S.roomKind = kind; S.expect = expectKey || null;
  if (kind === 'match' || kind === 'film') { S.searching = false; trackLobby(); }
  const ch = openChannel('room-' + code, myId);
  S.room = ch;
  ch.onSync((peers) => onRoomPeers(ch, peers));
  ch.onMsg((m) => { if (ch === S.room && m && m.from !== myId) handle(m); });
  go(kind === 'friends' ? 'roomwait' : 'connecting');
  try { await ch.ready; } catch (e) { toast('Could not connect — check your connection'); S.room = null; return go('home'); }
  if (ch !== S.room) return;
  await ch.track({ name: profile.name, avatar: profile.avatar, dev: profile.dev, joined: Date.now() });
  if (kind === 'match' || kind === 'film') {
    S.pairTimer = setTimeout(async () => {
      if (ch === S.room && !S.partner) { // partner never showed up — back to the queue
        await leaveRoom(true);
        S.pairing = false; S.searching = true; go(kind === 'film' ? 'filmsearching' : 'searching'); trackLobby();
      }
    }, 8000);
  }
}
function onRoomPeers(ch, peers) {
  if (ch !== S.room) return;
  const others = peers.filter((p) => p.key !== myId);
  if (!S.partner) {
    if (!others.length) return;
    if (S.roomKind === 'friends' && others.length > 1) {
      const meP = peers.find((p) => p.key === myId);
      const firstTwo = peers.slice().sort((a, b) => a.joined - b.joined).slice(0, 2).map((p) => p.key);
      if (meP && !firstTwo.includes(myId)) { toast('That room is already full'); leaveRoom(true).then(() => go('home')); return; }
    }
    const p = S.expect ? others.find((o) => o.key === S.expect) : others.sort((a, b) => a.joined - b.joined)[0];
    if (!p) return;
    S.partner = { key: p.key, name: p.name, avatar: p.avatar, dev: p.dev };
    S.isHost = myId < p.key;
    S.scores = { [myId]: 0, [p.key]: 0 };
    sfx('match'); buzz([80, 50, 80]);
    clearTimeout(S.pairTimer); S.pairing = false;
    if (S.roomKind === 'friends') history.replaceState(null, '', location.pathname + (NET_MODE === 'local' ? '?net=local' : ''));
    if (S.roomKind === 'film') {
      S.filmPins = seededPick(FILM_CARDS, S.roomCode, 3);
      sys(`You and <b>${esc(p.name)}</b> both just watched <b>${esc(S.film.title)}</b>. Spoilers allowed — go! 🍿`);
      sys('Want a break from talking? Tap 🎲 to play a movie game together.');
      go('chat');
      return;
    }
    go('spin');
    if (S.isHost) hLaterStart(() => hostStartMatch());
  } else if (!others.some((o) => o.key === S.partner.key)) {
    partnerLeft();
  }
}
function hLaterStart(fn) { setTimeout(() => { if (S.partner && !S.partnerGone) fn(); }, 900); }

function partnerLeft() {
  if (S.partnerGone || !S.partner) return;
  S.partnerGone = true;
  hostStop();
  if (S.screen === 'chat') {
    sys(`${esc(S.partner.name)} left the chat.`);
    go('chat');
  } else go('left');
}

function startSolo(game) {
  leaveRoom(true);
  if (!S.searching) stopSearch(); // when waiting in a queue we stay in it and get pulled out on a match
  resetMatch();
  S.roomKind = 'solo'; S.roomCode = null; S.soloGame = game || null;
  const ch = new LoopChannel(myId, { name: 'The Projectionist', avatar: '🤖' });
  S.room = ch;
  S.partner = { key: '~bot', name: 'The Projectionist', avatar: '🤖' };
  S.isHost = true;
  S.scores = { [myId]: 0, '~bot': 0 };
  S.bot = new Bot(ch, () => S.h && S.h.secret);
  ch.bot = S.bot;
  ch.onMsg((m) => { if (ch === S.room) handle(m); });
  ch.track({ name: profile.name, avatar: profile.avatar });
  go('spin');
  setTimeout(() => { if (S.room === ch) hostStartMatch(game); }, 700);
}

// ---------- message handling (everyone) ----------
function handle(m) {
  if (!m || !m.t) return;
  switch (m.t) {
    case 'spin':
      S.game = m.game; S.scores = m.scores; S.rematch = null; S.matchEnd = null; S.chain = null;
      S.lastGames.push(m.game);
      if (m.mode) M.setMode(m.mode);
      go('spin');
      break;
    case 'round':
      S.round = m; S.myAnswer = null; S.myOk = null; S.locks = {}; S.result = null; S.scores = m.scores; S.orderSel = [];
      S.roundStart = performance.now() + (m.delay || 0);
      go('round');
      break;
    case 'lock':
      if (!S.round || m.n !== S.round.n) return;
      S.locks[m.who] = m.ok;
      if (m.who === myId) {
        S.myOk = m.ok;
        if (m.ok === true) { sfx('correct'); buzz(25); } else if (m.ok === false) { sfx('wrong'); buzz([50, 40, 50]); } else sfx('pop');
      }
      updateRound();
      break;
    case 'result':
      if (!S.round || m.n !== S.round.n) return;
      S.result = m; S.scores = m.scores;
      if (m.winner === myId) sfx('point');
      showResult();
      break;
    case 'match_end':
      S.matchEnd = m; S.scores = m.scores;
      if (m.winner === myId) { sfx('win'); buzz([60, 40, 60, 40, 140]); } else if (m.winner) sfx('lose'); else sfx('point');
      go('matchend');
      if (S.isHost && S.roomKind !== 'solo') hLater(2800, hostOfferCards);
      break;
    case 'chain':
      if (!m.state.over && m.state.turn === myId && (!S.chain || S.chain.turn !== myId || S.chain.seq !== m.state.seq)) { sfx('turn'); buzz(40); }
      if (m.state.chain.length > 1 && !m.state.over && m.state.chain[m.state.chain.length - 1].by === myId && (!S.chain || S.chain.chain.length < m.state.chain.length)) sfx('correct');
      S.chain = m.state; S.chainRecvAt = performance.now(); S.scores = m.scores || S.scores;
      if (S.screen !== 'chain') go('chain'); else { updateChain(); updateScores(); }
      if (m.state.chain.length > 1 && !m.state.over) { const fb = $('[data-cfb]'); if (fb) { const l = m.state.chain[m.state.chain.length - 1]; fb.innerHTML = `<span class="ok">✓ ${esc(l.movie.title)} via ${esc(l.via.name)}</span>`; } }
      break;
    case 'chain_reject':
      if (m.who === myId) {
        sfx('wrong');
        const fb = $('[data-cfb]');
        if (fb) fb.innerHTML = `<span class="no">✗ ${esc(m.title || '')}${m.title ? ': ' : ''}${esc(m.reason)}</span>`;
        const q = $('[data-cq]'); if (q) { q.disabled = false; q.select(); }
      }
      break;
    case 'cards_offer':
      S.cards = m; S.picks = [];
      go('cards');
      break;
    case 'cards_done':
      S.chatCards.push(...m.cards);
      if (!S.messages.length) sys(`You're chatting with <b>${esc(S.partner.name)}</b>. Start with a question card ☝️`);
      else sys('New question cards pinned ☝️');
      go('chat');
      break;
    case 'chat':
      if (m.from === myId) return;
      S.typingUntil = 0;
      sfx('pop');
      pushMsg({ from: m.from, text: cleanText(String(m.text || '')), raw: String(m.text || '').slice(0, 300) });
      updateTyping();
      break;
    case 'typing':
      S.typingUntil = Date.now() + 3000; updateTyping();
      break;
    case 'rematch_req':
      if (S.rematch === 'out') { acceptRematch(); break; } // both asked at once
      S.rematch = 'in'; updateBanner(); sfx('turn');
      break;
    case 'rematch_no':
      S.rematch = null; updateBanner(); toast(`${S.partner.name} wants to keep chatting`);
      break;
    case 'bye':
      partnerLeft();
      break;
    // host-only
    case 'answer': if (S.isHost) hostAnswer(m.from, m.value, m.elapsed, m.n); break;
    case 'chain_try': if (S.isHost) hostChainTry(m.from, m.movie); break;
    case 'chain_giveup': if (S.isHost && S.h && S.h.chain && S.h.chain.turn === m.from) hostChainTimeout(S.h.chain.seq); break;
    case 'card_pick': if (S.isHost) hostCardPick(m.from, m.ids); break;
    case 'rematch_ok': if (S.isHost) hostStartMatch(); break;
    default: break;
  }
}

// ---------- host logic ----------
async function hostStartMatch(forced) {
  hostStop();
  if (!S.partner || S.partnerGone) return;
  const H = (S.h = { timers: [], stopped: false, n: 0, secret: null });
  const scores = { [myId]: 0, [S.partner.key]: 0 };
  await M.detectMode();
  if (S.h !== H) return;
  const avail = availableGames();
  forced = forced || window.__force; // test hook
  const fresh = avail.filter((g) => !S.lastGames.slice(-2).includes(g));
  const game = forced && avail.includes(forced) ? forced : rand(fresh.length ? fresh : avail);
  H.game = game; H.scores = scores;
  bcast({ t: 'spin', game, scores, mode: M.getMode() });
  const t0 = Date.now();
  let pool = [];
  try { pool = await M.getPool(); } catch (e) { console.error(e); }
  if (S.h !== H) return;
  H.ctx = { pool, used: new Set(), usedEmoji: new Set() };
  hLater(Math.max(0, 3200 - (Date.now() - t0)), () => (game === 'chain' ? hostChainStart() : hostNextRound()));
}
async function hostNextRound() {
  const H = S.h;
  H.n++;
  let r;
  if (H.daily) {
    const it = H.daily.rounds[H.n - 1];
    if (!it) return hostEndDaily();
    H.game = it.game; r = it.r;
  } else {
    try { r = await makeRound(H.game, H.ctx); } catch (e) { console.error(e); toast('Could not load the next round'); return hostEndMatch(); }
  }
  if (S.h !== H) return;
  H.round = r; H.answers = {}; H.resolved = false; H.grace = null;
  H.secret = { n: H.n, answer: r.answer };
  const delay = 1500;
  bcast({ t: 'round', n: H.n, game: H.game, kind: r.kind, data: r.data, duration: r.duration, delay, scores: { ...H.scores } });
  const n = H.n;
  hLater(delay + r.duration + 900, () => hostResolve(n));
}
function hostAnswer(who, value, elapsed, n) {
  const H = S.h;
  if (!H || !H.round || H.resolved || n !== H.n || H.answers[who] || !(who in H.scores)) return;
  const r = H.round;
  let v, ok;
  if (r.kind === 'order') {
    if (!Array.isArray(value) || value.length !== 4) return;
    v = value.map(Number);
    if (new Set(v).size !== 4 || v.some((x) => !(x >= 0 && x < 4))) return;
    ok = v.every((x, i) => x === r.answer[i]);
  } else {
    v = Number(value);
    if (!Number.isFinite(v)) return;
    ok = r.kind === 'year' ? null : v === r.answer;
  }
  H.answers[who] = { value: v, elapsed: Math.max(0, Number(elapsed) || 0), ok };
  bcast({ t: 'lock', n, who, ok });
  if (Object.keys(H.scores).every((k) => H.answers[k])) return hostResolve();
  if (ok && !H.grace) H.grace = hLater(700, () => hostResolve(n));
}
function hostResolve(n) {
  const H = S.h;
  if (!H || H.resolved || (n !== undefined && n !== H.n)) return; // ignore timers left over from an earlier round
  H.resolved = true;
  const r = H.round;
  if (H.daily) {
    const a = H.answers[myId];
    const pts = a && a.ok ? 100 + Math.round(100 * Math.max(0, 1 - a.elapsed / r.duration)) : 0;
    H.daily.points += pts;
    H.daily.grid.push(a ? (a.ok ? '🟩' : '🟥') : '⬛');
    H.scores[myId] = H.daily.points;
    const last = H.n >= H.daily.rounds.length;
    saveDailyProgress(H.daily, last);
    bcast({ t: 'result', n: H.n, winner: pts ? myId : null, pts, answer: r.answer, reveal: r.reveal, answers: H.answers, scores: { ...H.scores } });
    hLater(3200, last ? hostEndDaily : hostNextRound);
    return;
  }
  const ents = Object.entries(H.answers);
  let winner = null;
  if (r.kind === 'year') {
    const c = ents.map(([k, a]) => ({ k, d: Math.abs(a.value - r.answer), e: a.elapsed })).sort((x, y) => x.d - y.d || x.e - y.e);
    if (c.length && !(c.length > 1 && c[0].d === c[1].d && c[0].e === c[1].e)) winner = c[0].k;
  } else {
    const c = ents.filter(([, a]) => a.ok).sort((x, y) => x[1].elapsed - y[1].elapsed);
    if (c.length) winner = c[0][0];
  }
  if (winner) H.scores[winner]++;
  bcast({ t: 'result', n: H.n, winner, answer: r.answer, reveal: r.reveal, answers: H.answers, scores: { ...H.scores } });
  const done = Object.values(H.scores).some((s) => s >= WIN_TARGET) || H.n >= MAX_ROUNDS;
  hLater(3400, done ? hostEndMatch : hostNextRound);
}
function saveDailyProgress(dl, done) {
  const st = loadDaily();
  st.results[S.daily.key] = { score: dl.points, grid: dl.grid.slice(), done };
  saveDaily(st);
}
function hostEndDaily() {
  hostStop();
  if (S.h && S.h.daily) saveDailyProgress(S.h.daily, true);
  const room = S.room; S.room = null; if (room) room.leave();
  S.roomKind = null; S.partner = null;
  sfx('win');
  go('dailyintro');
}
async function startDaily() {
  const d = dailyInfo();
  if (d.today) return go('dailyintro');
  stopSearch(); await leaveRoom(true); resetMatch();
  // one try per day: the attempt is recorded the moment it starts
  const st = loadDaily();
  const yesterday = dayKey(new Date(Date.now() - 864e5));
  st.streak = st.lastPlayed === yesterday ? st.streak + 1 : st.lastPlayed === d.key ? st.streak : 1;
  st.lastPlayed = d.key;
  st.results[d.key] = { score: 0, grid: [], done: false };
  saveDaily(st);
  S.roomKind = 'daily'; S.daily = d;
  const ch = new LoopChannel(myId, { name: `Daily #${d.n}`, avatar: '📅' });
  S.room = ch;
  ch.onMsg((m) => { if (ch === S.room) handle(m); });
  S.partner = { key: '~daily', name: `Daily #${d.n}`, avatar: '📅' };
  S.isHost = true;
  S.scores = { [myId]: 0 };
  go('dailyload');
  hostStop();
  const H = (S.h = { timers: [], stopped: false, n: 0, secret: null, daily: { rounds: [], points: 0, grid: [] } });
  H.scores = { [myId]: 0 };
  const rng = seededRng(d.seed);
  let pool = [];
  try { pool = await M.getDailyPool(rng); } catch (e) { console.error(e); }
  H.ctx = { pool, used: new Set(), usedEmoji: new Set(), rng };
  for (const g of d.games) {
    try { H.daily.rounds.push({ game: g, r: await makeRound(g, H.ctx) }); } catch (e) { console.error('daily round failed', g, e); }
    if (S.h !== H) return;
  }
  if (!H.daily.rounds.length) { toast('Could not load today’s reel — try again later'); const s2 = loadDaily(); delete s2.results[d.key]; saveDaily(s2); return go('home'); }
  hostNextRound();
}
function hostEndMatch() {
  const H = S.h;
  if (!H) return;
  const [a, b] = Object.keys(H.scores);
  const winner = H.scores[a] === H.scores[b] ? null : H.scores[a] > H.scores[b] ? a : b;
  bcast({ t: 'match_end', game: H.game, scores: { ...H.scores }, winner });
}
function hostOfferCards() {
  const H = S.h;
  if (!H || S.partnerGone) return;
  const used = new Set(S.chatCards);
  const cards = shuffle(QUESTION_CARDS.map((_, i) => i).filter((i) => !used.has(i))).slice(0, 6);
  const winner = S.matchEnd && S.matchEnd.winner;
  H.offer = cards;
  H.need = winner ? { [winner]: 2 } : { [myId]: 1, [S.partner.key]: 1 };
  H.picks = {};
  bcast({ t: 'cards_offer', cards, picker: winner || 'both' });
}
function hostCardPick(who, ids) {
  const H = S.h;
  if (!H || !H.need || !H.need[who] || H.picks[who] || !Array.isArray(ids)) return;
  const valid = [...new Set(ids.map(Number))].filter((i) => H.offer.includes(i)).slice(0, H.need[who]);
  if (valid.length !== H.need[who]) return;
  H.picks[who] = valid;
  if (Object.keys(H.need).every((k) => H.picks[k])) {
    const cards = Object.keys(H.need).flatMap((k) => H.picks[k]);
    H.need = null;
    bcast({ t: 'cards_done', cards });
  }
}

// Actor chain (host)
async function hostChainStart() {
  const H = S.h;
  let start = null;
  for (const f of H.ctx.pool.slice(0, 10)) {
    try { const d = await M.getDetails(f.id); if (d.cast.length >= 5) { start = f; break; } } catch (e) { /* next */ }
  }
  if (S.h !== H) return;
  if (!start) { toast('Could not load films'); return hostEndMatch(); }
  H.chain = {
    chain: [{ movie: { id: start.id, title: start.title, year: start.year, poster: start.poster }, via: null, by: null }],
    turn: Math.random() < 0.5 ? myId : S.partner.key, used: {}, turnMs: CHAIN_TURN_MS, over: false, seq: 0, loser: null,
  };
  hostChainBroadcast();
}
function hostChainBroadcast() {
  const H = S.h;
  H.chain.seq++;
  const seq = H.chain.seq;
  bcast({ t: 'chain', state: H.chain, scores: { ...H.scores } });
  if (!H.chain.over) hLater(H.chain.turnMs + 1200, () => hostChainTimeout(seq));
}
function hostChainTimeout(seq) {
  const H = S.h;
  if (!H || !H.chain || H.chain.seq !== seq || H.chain.over) return;
  const loser = H.chain.turn;
  const winner = loser === myId ? S.partner.key : myId;
  H.chain.over = true; H.chain.loser = loser;
  H.scores[winner] = 1;
  hostChainBroadcast();
  hLater(3000, hostEndMatch);
}
async function hostChainTry(who, movie) {
  const H = S.h;
  if (!H || !H.chain || H.chain.over || H.chain.turn !== who || H.chainBusy) return;
  if (!movie || !movie.id) return;
  if (H.chain.chain.some((c) => c.movie.id === movie.id)) { bcast({ t: 'chain_reject', who, title: movie.title, reason: 'already in the chain' }); return; }
  H.chainBusy = true;
  const seq = H.chain.seq;
  let res;
  try { res = await chainLink(H.chain.chain[H.chain.chain.length - 1].movie.id, movie, H.chain.used); } catch (e) { res = { ok: false, reason: 'could not check that film' }; }
  H.chainBusy = false;
  if (S.h !== H || H.chain.seq !== seq || H.chain.over) return;
  if (!res.ok) { bcast({ t: 'chain_reject', who, title: movie.title, reason: res.reason }); return; }
  H.chain.used[res.via.id] = (H.chain.used[res.via.id] || 0) + 1;
  H.chain.chain.push({ movie: res.movie, via: res.via, by: who });
  H.chain.turn = who === myId ? S.partner.key : myId;
  H.chain.turnMs = Math.max(15000, CHAIN_TURN_MS - (H.chain.chain.length - 1) * 1000);
  hostChainBroadcast();
}

// ---------- rematch ----------
function acceptRematch() {
  S.rematch = null;
  if (S.isHost) hostStartMatch(); else send({ t: 'rematch_ok' });
}

// ---------- report ----------
const REPORT_REASONS = ['Harassment or insults', 'Sexual content', 'Hate speech', 'Spam or scam', 'Seems to be under 18', 'Something else'];
function openReport() {
  if (!S.partner || S.partner.key === '~bot' || $('#modal')) return;
  const p = S.partner;
  const wrap = document.createElement('div');
  wrap.id = 'modal';
  wrap.innerHTML = `
    <form class="sheet" data-report role="dialog" aria-modal="true" aria-labelledby="rep-h">
      <h3 id="rep-h">Report ${esc(p.avatar)} ${esc(p.name)}</h3>
      <p class="muted small">What happened? Reports are reviewed by the Cinema Club team. Your recent chat with this person is attached.</p>
      <div class="reasons">${REPORT_REASONS.map((r, i) => `<label class="reason"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? '' : ''}><span>${esc(r)}</span></label>`).join('')}</div>
      <textarea name="details" maxlength="500" rows="3" placeholder="Anything else we should know? (optional)"></textarea>
      <label class="check"><input type="checkbox" name="block" checked><span>Also block &amp; leave — you won't be matched again</span></label>
      <div class="row"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" disabled>Send report</button></div>
    </form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form');
  form.addEventListener('change', () => { form.querySelector('[type=submit]').disabled = !form.reason.value; });
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) closeReport(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    const theirs = S.messages.filter((m) => !m.sys && m.from === p.key).slice(-15).map((m) => `${p.name}: ${m.raw || m.text}`);
    const mine = S.messages.filter((m) => !m.sys && m.from === myId).slice(-5).map((m) => `reporter: ${m.text}`);
    const context = [`room: ${S.roomKind}${S.film ? ` · film: ${S.film.title}` : ''}${S.game ? ` · game: ${S.game}` : ''}`, ...theirs, ...mine].join('\n').slice(0, 4000);
    try {
      await fileReport({
        reason: form.reason.value, details: form.details.value.trim().slice(0, 500) || null,
        reported_name: String(p.name || '').slice(0, 60), reported_device: String(p.dev || '').slice(0, 40),
        reporter_name: profile.name.slice(0, 60), reporter_device: profile.dev.slice(0, 40),
        room: String(S.roomCode || '').slice(0, 80), context,
      });
      const block = form.block.checked;
      closeReport();
      if (block) ACT.block(); else toast('Thanks — your report was sent');
      if (block) toast('Report sent. Blocked — you won’t be matched again');
    } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'Send report';
      toast('Could not send the report — try again');
    }
  });
  setTimeout(() => { const first = form.querySelector('input[name=reason]'); if (first) first.focus(); }, 30);
}
function closeReport() { const m = $('#modal'); if (m) m.remove(); }

// ---------- actions ----------
const ACT = {
  reroll() { profile.name = randomName(); profile.avatar = randomAvatar(); save('profile', profile); trackLobby(); go('home'); },
  editname() {
    const f = $('[data-form="name"]');
    const open = f.classList.toggle('hidden') === false;
    $('[data-act="editname"].me-chip').setAttribute('aria-expanded', String(open));
    if (!open) { $('[data-myav]').textContent = profile.avatar; $('[data-myname]').textContent = profile.name; }
    else S.draftAv = profile.avatar;
  },
  pickav(el) {
    S.draftAv = el.dataset.a;
    $$('.avopt').forEach((b) => b.classList.toggle('on', b === el));
    $('[data-myav]').textContent = S.draftAv;
  },
  orderpick(el) {
    if (S.myAnswer !== null) return;
    const i = +el.dataset.i;
    if (S.orderSel.includes(i)) S.orderSel = S.orderSel.filter((x) => x !== i);
    else if (S.orderSel.length < 4) S.orderSel.push(i);
    renderOrder();
  },
  orderreset() { S.orderSel = []; renderOrder(); },
  orderlock() { if (S.orderSel.length === 4) answer(S.orderSel.slice()); },
  report() { openReport(); },
  async install(el) {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (e) { /* dismissed */ }
    installPrompt = null; el.classList.add('hidden');
  },
  waitplay() { startSolo(); },
  pickpop(el) {
    const m = S.popular && S.popular[+el.dataset.i];
    if (m) startFilmSearch({ id: m.id, title: m.title, year: m.year, poster: m.poster });
  },
  ask(el) {
    if (S.partnerGone || !S.room) return;
    if (Date.now() - lastSend < 400) return;
    lastSend = Date.now();
    const text = cleanText(el.dataset.q);
    pushMsg({ from: myId, text });
    send({ t: 'chat', text, ts: Date.now() });
    S.asked.add(el.dataset.q);
    el.classList.add('asked');
    const qn = el.querySelector('.qn'); if (qn) qn.textContent = qn.textContent.replace('tap to ask', 'asked ✓');
  },
  sound() {
    setSound(!soundOn());
    $$('[data-act="sound"]').forEach((b) => { b.innerHTML = b.closest('[data-menu]') ? `Sound: ${soundOn() ? 'on' : 'off'}` : soundIcon(); b.setAttribute('aria-label', soundOn() ? 'Mute sounds' : 'Turn sounds on'); });
    toast(soundOn() ? 'Sound on 🔊' : 'Sound off');
  },
  about() { openAbout(); },
  daily() { go('dailyintro'); },
  dailystart() { startDaily(); },
  async dailycopy() {
    const t = dailyShareText(dailyInfo());
    try { await navigator.clipboard.writeText(t); toast('Result copied — paste it anywhere'); } catch (e) { prompt('Copy your result:', t); }
  },
  dailyshare() { navigator.share({ text: dailyShareText(dailyInfo()) }).catch(() => {}); },
  match() { startSearch(); },
  filmpick() { stopSearch(); leaveRoom(); go('filmpick'); },
  pickfilm(el) {
    const m = S.filmResults[+el.dataset.i];
    if (m) startFilmSearch({ id: m.id, title: m.title, year: m.year, poster: m.poster });
  },
  joinfilm(el) {
    const e = discussingList().find((x) => String(x.film.id) === el.dataset.id);
    if (e) startFilmSearch(e.film);
  },
  filmagain() { if (S.film) startFilmSearch(S.film); else go('filmpick'); },
  cancel() { stopSearch(); go('home'); },
  solo() { startSolo(); },
  practise(el) {
    const g = el.dataset.game;
    if (GAMES[g].images && M.getMode() === 'demo') { toast(`${GAMES[g].name} needs real posters — add a TMDB key`); return; }
    startSolo(g);
  },
  soloagain() { startSolo(S.matchEnd ? S.matchEnd.game : null); },
  home() { leaveRoom(); stopSearch(); resetMatch(); go('home'); },
  create() {
    stopSearch();
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = [...Array(4)].map(() => abc[Math.floor(Math.random() * abc.length)]).join('');
    joinRoom(code, 'friends');
  },
  showjoin() { const f = $('[data-form="join"]'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.code.focus(); },
  async copylink(el) {
    try { await navigator.clipboard.writeText(el.dataset.link); toast('Link copied — send it to a friend'); }
    catch (e) { prompt('Copy this link:', el.dataset.link); }
  },
  sharelink(el) { navigator.share({ title: 'Cinema Club', text: 'Play a movie game with me, then we talk films 🎬', url: el.dataset.link }).catch(() => {}); },
  leave() { leaveRoom(); resetMatch(); go('home'); },
  leavematch(el) {
    // two taps so nobody leaves by accident
    if (!el.classList.contains('armed')) {
      el.classList.add('armed'); el.textContent = 'Leave?';
      setTimeout(() => { if (el.isConnected) { el.classList.remove('armed'); el.textContent = '✕'; } }, 3000);
      return;
    }
    if (S.roomKind === 'solo' && S.searching) { // playing while waiting: go back to the queue
      leaveRoom(true); resetMatch(); S.roomKind = null;
      go(S.searchKind === 'film' ? 'filmsearching' : 'searching');
      toast('Back in the queue');
      return;
    }
    const solo = S.roomKind === 'solo' || S.roomKind === 'daily';
    if (S.roomKind === 'daily' && S.h && S.h.daily) saveDailyProgress(S.h.daily, true);
    const waiting = ['searching', 'roomwait', 'connecting', 'filmpick', 'filmsearching'].includes(S.screen);
    stopSearch(); leaveRoom(); resetMatch(); go('home');
    toast(waiting ? 'Back home' : solo ? 'Game ended' : 'You left the match');
  },
  theme() {
    const t = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('cinemaclub:theme', t); } catch (e) { /* private mode */ }
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#121014' : '#F4EEE2';
    $$('[data-act="theme"]').forEach((b) => { if (b.closest('[data-menu]')) b.textContent = t === 'dark' ? 'Light mode' : 'Dark mode'; else b.innerHTML = t === 'dark' ? SUN : MOON; b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); });
  },
  block() {
    if (S.partner && S.partner.dev && !profile.blocks.includes(S.partner.dev)) { profile.blocks.push(S.partner.dev); save('profile', profile); }
    toast("Blocked — you won't be matched again");
    leaveRoom(); resetMatch(); go('home'); trackLobby();
  },
  menu() { $('[data-menu]').classList.toggle('hidden'); },
  answer(el) { answer(+el.dataset.v); },
  ystep(el) { const r = $('[data-yrange]'); r.value = Math.min(2026, Math.max(1920, +r.value + +el.dataset.d)); $('[data-year]').textContent = r.value; },
  ylock() { answer(+$('[data-yrange]').value); },
  chainpick(el) {
    const m = S.chainResults && S.chainResults[+el.dataset.i];
    if (!m || !S.chain || S.chain.turn !== myId) return;
    $('[data-cresults]').innerHTML = '';
    $('[data-cq]').value = m.title;
    $('[data-cq]').disabled = true;
    $('[data-cfb]').innerHTML = '<span class="pulse">Checking the credits…</span>';
    const movie = { id: m.id, title: m.title, year: m.year, poster: m.poster };
    if (S.isHost) hostChainTry(myId, movie); else send({ t: 'chain_try', movie });
  },
  giveup() {
    if (!S.chain || S.chain.over || S.chain.turn !== myId) { toast('You can give up on your own turn'); return; }
    if (S.isHost) hostChainTimeout(S.h.chain.seq); else send({ t: 'chain_giveup' });
  },
  pickcard(el) {
    const id = +el.dataset.id;
    const need = S.cards.picker === 'both' ? 1 : 2;
    if (S.picks.includes(id)) S.picks = S.picks.filter((x) => x !== id);
    else { S.picks.push(id); if (S.picks.length > need) S.picks.shift(); }
    $$('.qcard').forEach((c) => c.classList.toggle('sel', S.picks.includes(+c.dataset.id)));
    const b = $('[data-act="confirmcards"]');
    b.disabled = S.picks.length !== need;
    b.textContent = S.picks.length === need ? 'Start chatting →' : `Pick ${need - S.picks.length} more`;
  },
  confirmcards(el) {
    el.disabled = true; el.textContent = 'Waiting…';
    $$('.qcard').forEach((c) => (c.disabled = true));
    if (S.isHost) hostCardPick(myId, S.picks); else send({ t: 'card_pick', ids: S.picks });
  },
  rematch() {
    if (S.partnerGone) return;
    if (S.rematch === 'in') return acceptRematch();
    S.rematch = 'out'; send({ t: 'rematch_req' }); updateBanner();
  },
  rematchyes() { acceptRematch(); },
  rematchno() { S.rematch = null; send({ t: 'rematch_no' }); updateBanner(); },
};

let lastSend = 0;
app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.dataset.act !== 'menu' && !el.closest('[data-menu]')) { const mn = $('[data-menu]'); if (mn) mn.classList.add('hidden'); }
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
app.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.dataset.form === 'join') {
    const code = f.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { toast('Room codes have 4 characters'); return; }
    stopSearch();
    joinRoom(code, 'friends');
  }
  if (f.dataset.form === 'chat') {
    const text = cleanText(f.text.value);
    if (!text || S.partnerGone) return;
    if (Date.now() - lastSend < 400) return;
    lastSend = Date.now();
    f.text.value = '';
    pushMsg({ from: myId, text });
    send({ t: 'chat', text, ts: Date.now() });
  }
  if (f.dataset.form === 'name') {
    profile.name = `${f.adj.value} ${f.noun.value}`;
    profile.avatar = S.draftAv || profile.avatar;
    save('profile', profile);
    trackLobby();
    toast(`You're now ${profile.avatar} ${profile.name}`);
    go('home');
    return;
  }
  if (f.dataset.form === 'film') {
    const first = $('[data-fresults] .cres');
    if (first) first.click();
  }
  if (f.dataset.form === 'chain') {
    const first = $('.cres');
    if (first) first.click();
  }
});
app.addEventListener('change', (e) => {
  const f = e.target.closest('[data-form="name"]');
  if (f) $('[data-myname]').textContent = `${f.adj.value} ${f.noun.value}`;
});
document.addEventListener('pointerdown', unlock, { passive: true });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-qb="stop"]')) { stopSearch(); updateQueueBar(); toast('Stopped searching — enjoy the game'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal')) closeReport();
  if (S.screen === 'round' && S.round && !['year', 'order'].includes(S.round.kind) && /^[1-4]$/.test(e.key) && document.activeElement.tagName !== 'INPUT') {
    const v = +e.key - 1;
    if ($(`[data-act="answer"][data-v="${v}"]`)) answer(v);
  }
});
window.addEventListener('pagehide', () => { if (S.room) try { S.room.send({ t: 'bye', from: myId }); } catch (e) { /* closing */ } });

// ---------- installable app ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; const b = $('[data-act="install"]'); if (b) b.classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Cinema Club is on your home screen 🎬'); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- boot ----------
(function boot() {
  const room = new URLSearchParams(location.search).get('room');
  M.detectMode();
  connectLobby();
  if (room && /^[A-Z0-9]{4}$/i.test(room)) joinRoom(room.toUpperCase(), 'friends');
  else go('home');
  window.__coldopen = { S, myId }; // handy for debugging
})();
