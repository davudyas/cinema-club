// Background designs for Cinema Club. html[data-bg="1".."10"] picks one; the faded #posterwall is the fallback.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sized = (u, size) => (u ? u.replace(/\/w\d+\//, `/${size}/`) : null);

export const BG_NAMES = ['Marquee strips', 'Filmstrip edges', 'Corkboard pins', 'Hero still', 'Velvet curtains',
  'Night wall', 'Flashlight', 'Halftone print', 'Neon marquee', 'Ticket pattern'];
const PANELS = ['5', '6', '7', '8', '9', '10']; // designs where content sits on solid cards

let films = [];
let current = '';
let heroFilm = null;
// Every visit shows different posters: skip the ones shown last time (remembered on this device).
export function setFilms(list) {
  let all = (list || []).filter((f) => f.poster);
  let last = [];
  try { last = JSON.parse(localStorage.getItem('cinemaclub:lastposters') || '[]'); } catch (e) { /* private mode */ }
  const fresh = all.filter((f) => !last.includes(f.id));
  if (fresh.length >= 12) all = fresh;
  films = all;
  try { localStorage.setItem('cinemaclub:lastposters', JSON.stringify(films.slice(0, 24).map((f) => f.id))); } catch (e) { /* private mode */ }
  heroFilm = (list || []).find((f) => f.backdrop) || null;
  if (current) applyBg(current);
}
export const bgActive = () => current;

function posters(n, size = 'w185', offset = 0) {
  if (!films.length) return '';
  let out = '';
  for (let i = 0; i < n; i++) {
    const f = films[(i + offset) % films.length];
    out += `<img src="${esc(sized(f.poster, size))}" alt="" decoding="async"${n > 10 ? ' loading="lazy"' : ' fetchpriority="high"'}>`;
  }
  return out;
}

const jitter = () => Math.round((Math.random() - 0.5) * 6);
const PINS = [ // corkboard positions in the side margins
  { s: 'l', t: 9, r: -7 }, { s: 'l', t: 33, r: 5 }, { s: 'l', t: 57, r: -4 }, { s: 'l', t: 80, r: 8 },
  { s: 'r', t: 6, r: 6 }, { s: 'r', t: 30, r: -6 }, { s: 'r', t: 54, r: 4 }, { s: 'r', t: 78, r: -8 },
];

const BUILD = {
  2: () => `<div class="fstrip l"><div class="fs-track">${posters(10)}${posters(10)}</div></div>
            <div class="fstrip r"><div class="fs-track">${posters(10, 'w185', 10)}${posters(10, 'w185', 10)}</div></div>`,
  3: () => PINS.map((p, i) => `<figure class="cpin ${p.s}" style="top:${p.t + jitter() / 2}%;--r:${p.r + jitter()}deg">${posters(1, 'w342', i)}<i></i></figure>`).join(''),
  5: () => '<div class="curtain l"></div><div class="curtain r"></div><div class="valance"></div>',
  6: () => `<div class="pgrid6">${posters(54)}</div>`,
  7: () => `<div class="lampwrap"><div class="pgrid6">${posters(54)}</div></div>`,
  8: () => `<div class="pgrid6 halftone">${posters(54)}</div>`,
  9: () => '<div class="stars"></div>',
  10: () => '',
};

export function applyBg(v) {
  current = v || '';
  const root = document.documentElement;
  if (current) root.dataset.bg = current; else delete root.dataset.bg;
  if (PANELS.includes(current)) root.dataset.bgPanels = ''; else delete root.dataset.bgPanels;
  let fx = document.getElementById('bgfx');
  if (!fx) { fx = document.createElement('div'); fx.id = 'bgfx'; fx.setAttribute('aria-hidden', 'true'); document.body.prepend(fx); }
  fx.innerHTML = BUILD[current] ? BUILD[current]() : '';
  decorate();
}

// fill the in-page pieces (strips, hero still) — called after every home render
export function decorate() {
  const top = document.querySelector('[data-belt="top"]');
  const bottom = document.querySelector('[data-belt="bottom"]');
  if (top) top.innerHTML = ['1', '2'].includes(current) ? `<div class="belt-track">${posters(16)}${posters(16)}</div>`
    : current === '3' ? `<div class="pinrow">${posters(3, 'w185', 0)}</div>` : '';
  if (bottom) bottom.innerHTML = current === '1' ? `<div class="belt-track rev">${posters(16, 'w185', 16)}${posters(16, 'w185', 16)}</div>` : '';
  const hero = document.querySelector('[data-herobg]');
  if (hero) hero.innerHTML = current === '4' && heroFilm
    ? `<img src="${esc(sized(heroFilm.backdrop, 'w1280'))}" alt=""><span class="hero-cap">🎞️ Now showing: ${esc(heroFilm.title)}${heroFilm.year ? ` (${heroFilm.year})` : ''}</span>` : '';
}

// Flashlight: the spotlight follows the pointer; on touch screens it drifts on its own
let lampT = 0;
function lamp(x, y) { const fx = document.getElementById('bgfx'); if (fx) { fx.style.setProperty('--mx', x + 'px'); fx.style.setProperty('--my', y + 'px'); } }
window.addEventListener('pointermove', (e) => { if (current === '7' && e.pointerType === 'mouse') lamp(e.clientX, e.clientY); }, { passive: true });
(function drift() {
  if (current === '7' && !matchMedia('(pointer:fine)').matches) {
    lampT += 0.006;
    lamp(innerWidth * (0.5 + 0.35 * Math.sin(lampT * 1.3)), innerHeight * (0.45 + 0.3 * Math.sin(lampT * 0.9 + 1)));
  }
  requestAnimationFrame(drift);
})();
