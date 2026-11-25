// Cinema Club — main app: screens, matchmaking, host-authoritative game loop, chat.
import { NET_MODE, openChannel, LoopChannel } from './net.js';
import * as M from './movies.js';
import { GAMES, GAME_IDS, availableGames, makeRound, chainLink, Bot, shuffle,
  WIN_TARGET, MAX_ROUNDS, CHAIN_TURN_MS, CHAIN_MAX_USES } from './games.js';
import { QUESTION_CARDS, randomName, randomAvatar } from './content.js';

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
  window.scrollTo(0, 0);
}

const logo = () => `<div class="logo"><span class="clap" aria-hidden="true"><i></i></span>Cinema&nbsp;Club</div>`;
const isDark = () => document.documentElement.dataset.theme === 'dark';
const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>';
const themeBtn = () => `<button class="iconbtn" data-act="theme" aria-label="${isDark() ? 'Switch to light mode' : 'Switch to dark mode'}" title="${isDark() ? 'Light mode' : 'Dark mode'}">${isDark() ? SUN : MOON}</button>`;
const leaveBtn = () => `<button class="iconbtn leave" data-act="leavematch" aria-label="Leave match and go home" title="Leave match">✕</button>`;
const topRight = (...parts) => `<div class="top-r">${parts.join('')}</div>`;
const onlinePill = () => `<span class="online" data-online>${onlineText()}</span>`;
function onlineText() {
  if (NET_MODE === 'local') return `<b></b>${S.online} online (local test)`;
  if (S.lobbyOk === false) return `<b class="off"></b>offline`;
  if (S.lobbyOk === null) return `<b class="wait"></b>connecting…`;
  return `<b></b>${S.online} online`;
}
function updateOnline() {
  $$('[data-online]').forEach((el) => (el.innerHTML = onlineText()));
  const w = $('[data-waitcount]');
  if (w) w.textContent = `${S.online} online · ${S.waiting} looking for a match`;
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

const VIEWS = {
  home: () => `
    <header class="top">${logo()}${topRight(onlinePill(), themeBtn())}</header>
    <main class="home">
      <button class="me-chip" data-act="reroll" title="New nickname">
        <span class="av">${esc(profile.avatar)}</span><span>${esc(profile.name)}</span><span class="reroll" aria-hidden="true">↻</span>
      </button>
      <h1>Play first.<br><span class="hl">Then talk movies.</span></h1>
      <p class="lede">Get matched with a random film fan, play a quick movie mini-game, and the winner picks two question cards to get the conversation rolling.</p>
      <div class="cta">
        <button class="btn primary big" data-act="match">🎟️ Random match</button>
        <button class="btn gold" data-act="solo">🍿 Play solo vs. the Projectionist</button>
        <div class="row">
          <button class="btn" data-act="create">Create room</button>
          <button class="btn" data-act="showjoin">Join room</button>
        </div>
        <form class="join hidden" data-form="join">
          <input name="code" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code" />
          <button class="btn primary" type="submit">Join</button>
        </form>
      </div>
      <section class="strip">
        <div class="strip-head"><span>Now showing</span><span>${GAME_IDS.length} mini-games · tap to practise</span></div>
        <div class="games">
          ${GAME_IDS.map((g) => `
            <button class="game-tile" data-act="practise" data-game="${g}">
              <span class="gi">${GAMES[g].icon}</span>
              <span class="gn">${GAMES[g].name}</span>
              <span class="gd">${GAMES[g].desc}</span>
            </button>`).join('')}
        </div>
      </section>
      <p class="fine">Be kind. Don't share personal info. You can leave or block anyone, anytime.<span data-datamode></span></p>
    </main>`,

  searching: () => `
    <header class="top">${logo()}${topRight(onlinePill(), leaveBtn())}</header>
    <main class="center">
      <div class="projector" aria-hidden="true"><span></span><span></span></div>
      <h2>Finding your co-star…</h2>
      <p class="muted" data-waitcount>${S.online} online · ${S.waiting} looking for a match</p>
      <button class="btn" data-act="cancel">Cancel</button>
      <p class="fine">Nobody around? <button class="link" data-act="create">Create a room</button> and send the link to a friend, or <button class="link" data-act="solo">play solo</button>.</p>
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
    <header class="top">${logo()}${topRight(leaveBtn())}</header>
    <main class="center spin">
      ${vsBar()}
      <p class="eyebrow">Tonight's feature</p>
      <div class="reel ${S.game ? '' : 'idle'}"><div class="reel-track">
        ${items.map((g) => `<div class="reel-item"><span>${GAMES[g].icon}</span>${GAMES[g].name}</div>`).join('')}
      </div></div>
      <p class="muted" data-spinnote>${S.game ? esc(GAMES[S.game].desc) : 'Picking a game…'}</p>
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
      if (m.type === 'cast') media = `<div class="media cast">${m.names.map((n, i) => `<div class="cast-row" data-ci="${i}"><span>#${m.names.length - i}</span>${esc(n)}</div>`).join('')}</div>`;
      input = `<div class="options">${d.options.map((o, i) => `<button class="opt" data-act="answer" data-v="${i}">${esc(o)}</button>`).join('')}</div>`;
    } else if (r.kind === 'pair') {
      media = `<div class="pair">${d.films.map((f, i) => `
        <button class="pcard" data-act="answer" data-v="${i}">
          ${f.poster ? `<img src="${esc(f.poster)}" alt="">` : '<div class="noimg">🎬</div>'}
          <span class="pt">${esc(f.title)}${d.showYear && d.years[i] ? ` <em>(${d.years[i]})</em>` : ''}</span>
          <span class="pv" data-pv="${i}"></span>
        </button>`).join('<span class="or">or</span>')}</div>`;
    } else if (r.kind === 'year') {
      media = `<div class="media yearcard">${d.poster ? `<img src="${esc(d.poster)}" alt="">` : ''}<div class="yt">${esc(d.title)}</div></div>`;
      input = `<div class="yearpick">
        <div class="yrow"><button class="btn round" data-act="ystep" data-d="-1" aria-label="Earlier">−</button><output data-year>2000</output><button class="btn round" data-act="ystep" data-d="1" aria-label="Later">+</button></div>
        <input type="range" min="1920" max="2026" value="2000" data-yrange aria-label="Release year">
        <button class="btn primary" data-act="ylock">Lock in</button></div>`;
    }
    return `
    <header class="top slim">${vsBar()}${leaveBtn()}</header>
    <main class="round kind-${r.kind}">
      <div class="round-meta"><span>${GAMES[r.game].icon} ${GAMES[r.game].name}</span><span>Round ${r.n} · first to ${WIN_TARGET}</span></div>
      <div class="timer"><i style="--dur:${r.duration}ms"></i></div>
      <h3 class="prompt">${esc(d.prompt)}</h3>
      <div class="stage">${media}<div class="countdown" data-countdown>3</div></div>
      ${input}
      <div class="verdict" data-verdict></div>
    </main>`;
  },

  chain: () => `
    <header class="top slim">${vsBar()}${leaveBtn()}</header>
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
    <header class="top">${logo()}${topRight(leaveBtn())}</header>
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
    <header class="top slim">${vsBar()}${leaveBtn()}</header>
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
      <div class="who"><span class="av">${esc(S.partner.avatar)}</span><div><b>${esc(S.partner.name)}</b><small data-typing>${S.partnerGone ? 'left the chat' : S.roomKind === 'friends' ? 'in your room' : 'matched just now'}</small></div></div>
      <div class="chat-actions">
        <button class="btn small gold" data-act="rematch" ${S.partnerGone ? 'disabled' : ''} title="Play another game">🎲<span class="lbl"> Another game</span></button>
        <button class="btn small" data-act="menu" aria-label="More">⋯</button>
        ${leaveBtn()}
      </div>
      <div class="menu hidden" data-menu>
        <button data-act="leave">🏠 Leave &amp; go home</button>
        <button data-act="theme">${isDark() ? 'Light mode' : 'Dark mode'}</button>
        ${S.roomKind === 'match' ? '<button data-act="block" class="danger">Block &amp; leave</button>' : ''}
      </div>
    </header>
    <div class="pins">${S.chatCards.map((id, i) => `<div class="pin"><span class="qn">Q${i + 1}</span>${esc(QUESTION_CARDS[id])}</div>`).join('')}</div>
    <div class="banner hidden" data-banner></div>
    <main class="msgs" data-msgs>${S.messages.map(msgHtml).join('')}</main>
    <form class="composer" data-form="chat">
      <input name="text" maxlength="300" placeholder="${S.partnerGone ? 'Chat closed' : 'Say something about movies…'}" autocomplete="off" ${S.partnerGone ? 'disabled' : ''} />
      <button class="btn primary" type="submit" ${S.partnerGone ? 'disabled' : ''} aria-label="Send">➤</button>
    </form>`,

  left: () => `
    <header class="top">${logo()}${topRight(onlinePill(), themeBtn())}</header>
    <main class="center">
      <div class="big-emoji">🚪</div>
      <h2>${esc(S.partner ? S.partner.name : 'Your co-star')} left the theater.</h2>
      <div class="cta">
        <button class="btn primary big" data-act="match">🎟️ Find a new match</button>
        <button class="link" data-act="home">Home</button>
      </div>
    </main>`,
};

const AFTER = {
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
    const tick = () => {
      const l = left();
      if (l > 0) { cd.textContent = Math.ceil(l / 500) > 2 ? '3' : Math.ceil(l / 500) === 2 ? '2' : '1'; return; }
      cd.remove();
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
  matchend() {
    if (S.roomKind === 'solo') uiLater(2600, () => go('soloend'));
  },
};

// ---------- round UI ----------
function startCastReveal() {
  const r = S.round;
  if (!(r.kind === 'mc' && r.data.media.type === 'cast')) return;
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
    if (S.round.kind === 'year') {
      $$('[data-act="ystep"],[data-act="ylock"],[data-yrange]').forEach((b) => (b.disabled = true));
      const l = $('[data-act="ylock"]'); if (l) l.textContent = `Locked: ${S.myAnswer}`;
    }
  }
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
    if (res.reveal.poster && r.data.media.type !== 'blur') st.insertAdjacentHTML('beforeend', `<img class="reveal-poster" src="${esc(res.reveal.poster)}" alt="">`);
  }
  if (r.kind === 'pair') {
    $$('.pcard').forEach((b) => { b.disabled = true; if (+b.dataset.v === res.answer) b.classList.add('correct'); });
    res.reveal.values.forEach((v, i) => { const el = $(`[data-pv="${i}"]`); if (el) el.textContent = v; });
  }
  let line;
  if (r.kind === 'year') {
    const parts = Object.entries(res.answers).map(([k, a]) => `${k === myId ? 'You' : esc(S.partner.name)}: <b>${a.value}</b>`);
    line = `Released <b>${res.reveal.year}</b>${parts.length ? ' · ' + parts.join(' · ') : ''}`;
  } else {
    line = `${esc(res.reveal.title)}${res.reveal.year ? ` <span class="muted">(${res.reveal.year})</span>` : ''}`;
  }
  const who = res.winner === myId ? '🎉 Point to you!' : res.winner ? `${esc(S.partner.name)} takes it` : 'No point this round';
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
function updateTyping() {
  const el = $('[data-typing]');
  if (!el || S.partnerGone) return;
  el.textContent = Date.now() < S.typingUntil ? 'typing…' : S.roomKind === 'friends' ? 'in your room' : 'online';
}
function updateBanner() {
  const b = $('[data-banner]');
  if (!b) return;
  if (S.rematch === 'in') {
    b.innerHTML = `<span>🎲 ${esc(S.partner.name)} wants to play another game</span><button class="btn small primary" data-act="rematchyes">Let's go</button><button class="btn small" data-act="rematchno">Not now</button>`;
    b.classList.remove('hidden');
  } else if (S.rematch === 'out') {
    b.innerHTML = `<span class="pulse">Waiting for ${esc(S.partner.name)} to accept…</span>`;
    b.classList.remove('hidden');
  } else if (S.partnerGone) {
    b.innerHTML = `<span>${esc(S.partner.name)} left.</span><button class="btn small primary" data-act="match">New match</button><button class="btn small" data-act="home">Home</button>`;
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}
function cleanText(t) {
  return t.replace(/\s+/g, ' ').trim().slice(0, 300)
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
    updateOnline();
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
    mode: S.searching ? 'waiting' : 'idle', since: S.searchSince,
    name: profile.name, avatar: profile.avatar, dev: profile.dev, blocks: profile.blocks.slice(-50),
  });
}
const compatible = (a, b) => !(a.blocks || []).includes(b.dev) && !(b.blocks || []).includes(a.dev) && (NET_MODE === 'local' || a.dev !== b.dev);
function tryPair(peers) {
  const w = peers.filter((p) => p.mode === 'waiting').sort((a, b) => (a.since - b.since) || (a.key < b.key ? -1 : 1));
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
  joinRoom('m-' + [myId, partner.key].sort().join('-'), 'match', partner.key);
}
async function startSearch() {
  if (NET_MODE !== 'local' && S.lobbyOk === false) { toast('Matchmaking is offline right now — try a room or solo'); return; }
  await leaveRoom();
  S.searching = true; S.searchSince = Date.now(); S.pairing = false;
  go('searching');
  await connectLobby();
  await trackLobby();
  if (S.lobby) setTimeout(() => S.searching && !S.pairing && tryPair(S.lobby.peers()), 300);
}
function stopSearch() { S.searching = false; S.pairing = false; clearTimeout(S.pairTimer); trackLobby(); }

function resetMatch() {
  hostStop();
  Object.assign(S, { partner: null, partnerGone: false, isHost: false, bot: null, game: null, scores: {}, round: null, result: null,
    chain: null, matchEnd: null, cards: null, picks: [], chatCards: [], messages: [], rematch: null, typingUntil: 0 });
}
async function leaveRoom(silent) {
  clearTimeout(S.pairTimer);
  hostStop();
  const ch = S.room;
  S.room = null;
  if (ch) { if (!silent) { try { ch.send({ t: 'bye', from: myId }); } catch (e) { /* closed */ } } await ch.leave(); }
}
async function joinRoom(code, kind, expectKey) {
  await leaveRoom(true);
  resetMatch();
  S.roomCode = code; S.roomKind = kind; S.expect = expectKey || null;
  if (kind === 'match') { S.searching = false; trackLobby(); }
  const ch = openChannel('room-' + code, myId);
  S.room = ch;
  ch.onSync((peers) => onRoomPeers(ch, peers));
  ch.onMsg((m) => { if (ch === S.room && m && m.from !== myId) handle(m); });
  go(kind === 'friends' ? 'roomwait' : 'connecting');
  try { await ch.ready; } catch (e) { toast('Could not connect — check your connection'); S.room = null; return go('home'); }
  if (ch !== S.room) return;
  await ch.track({ name: profile.name, avatar: profile.avatar, dev: profile.dev, joined: Date.now() });
  if (kind === 'match') {
    S.pairTimer = setTimeout(async () => {
      if (ch === S.room && !S.partner) { // partner never showed up — back to the queue
        await leaveRoom(true);
        S.pairing = false; S.searching = true; go('searching'); trackLobby();
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
    clearTimeout(S.pairTimer); S.pairing = false;
    if (S.roomKind === 'friends') history.replaceState(null, '', location.pathname + (NET_MODE === 'local' ? '?net=local' : ''));
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
  stopSearch();
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
      S.round = m; S.myAnswer = null; S.myOk = null; S.locks = {}; S.result = null; S.scores = m.scores;
      S.roundStart = performance.now() + (m.delay || 0);
      go('round');
      break;
    case 'lock':
      if (!S.round || m.n !== S.round.n) return;
      S.locks[m.who] = m.ok;
      if (m.who === myId) S.myOk = m.ok;
      updateRound();
      break;
    case 'result':
      if (!S.round || m.n !== S.round.n) return;
      S.result = m; S.scores = m.scores;
      showResult();
      break;
    case 'match_end':
      S.matchEnd = m; S.scores = m.scores;
      go('matchend');
      if (S.isHost && S.roomKind !== 'solo') hLater(2800, hostOfferCards);
      break;
    case 'chain':
      S.chain = m.state; S.chainRecvAt = performance.now(); S.scores = m.scores || S.scores;
      if (S.screen !== 'chain') go('chain'); else { updateChain(); updateScores(); }
      if (m.state.chain.length > 1 && !m.state.over) { const fb = $('[data-cfb]'); if (fb) { const l = m.state.chain[m.state.chain.length - 1]; fb.innerHTML = `<span class="ok">✓ ${esc(l.movie.title)} via ${esc(l.via.name)}</span>`; } }
      break;
    case 'chain_reject':
      if (m.who === myId) {
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
      pushMsg({ from: m.from, text: cleanText(String(m.text || '')) });
      updateTyping();
      break;
    case 'typing':
      S.typingUntil = Date.now() + 3000; updateTyping();
      break;
    case 'rematch_req':
      if (S.rematch === 'out') { acceptRematch(); break; } // both asked at once
      S.rematch = 'in'; updateBanner();
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
  try { r = await makeRound(H.game, H.ctx); } catch (e) { console.error(e); toast('Could not load the next round'); return hostEndMatch(); }
  if (S.h !== H) return;
  H.round = r; H.answers = {}; H.resolved = false; H.grace = null;
  H.secret = { n: H.n, answer: r.answer };
  const delay = 1500;
  bcast({ t: 'round', n: H.n, game: H.game, kind: r.kind, data: r.data, duration: r.duration, delay, scores: { ...H.scores } });
  hLater(delay + r.duration + 900, hostResolve);
}
function hostAnswer(who, value, elapsed, n) {
  const H = S.h;
  if (!H || !H.round || H.resolved || n !== H.n || H.answers[who] || !(who in H.scores)) return;
  const r = H.round;
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  const ok = r.kind === 'year' ? null : v === r.answer;
  H.answers[who] = { value: v, elapsed: Math.max(0, Number(elapsed) || 0), ok };
  bcast({ t: 'lock', n, who, ok });
  if (Object.keys(H.scores).every((k) => H.answers[k])) return hostResolve();
  if (ok && !H.grace) H.grace = hLater(700, hostResolve);
}
function hostResolve() {
  const H = S.h;
  if (!H || H.resolved) return;
  H.resolved = true;
  const r = H.round;
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

// ---------- actions ----------
const ACT = {
  reroll() { profile.name = randomName(); profile.avatar = randomAvatar(); save('profile', profile); trackLobby(); go('home'); },
  match() { startSearch(); },
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
    const solo = S.roomKind === 'solo';
    const waiting = ['searching', 'roomwait', 'connecting'].includes(S.screen);
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
  if (f.dataset.form === 'chain') {
    const first = $('.cres');
    if (first) first.click();
  }
});
document.addEventListener('keydown', (e) => {
  if (S.screen === 'round' && S.round && S.round.kind !== 'year' && /^[1-4]$/.test(e.key) && document.activeElement.tagName !== 'INPUT') {
    const v = +e.key - 1;
    if ($(`[data-act="answer"][data-v="${v}"]`)) answer(v);
  }
});
window.addEventListener('pagehide', () => { if (S.room) try { S.room.send({ t: 'bye', from: myId }); } catch (e) { /* closing */ } });

// ---------- boot ----------
(function boot() {
  const room = new URLSearchParams(location.search).get('room');
  M.detectMode();
  connectLobby();
  if (room && /^[A-Z0-9]{4}$/i.test(room)) joinRoom(room.toUpperCase(), 'friends');
  else go('home');
  window.__coldopen = { S, myId }; // handy for debugging
})();
