// Tiny synthesized sound effects + vibration. No audio files; everything is generated with Web Audio.
let ac = null;
let on = true;
try { on = localStorage.getItem('cinemaclub:sound') !== 'off'; } catch (e) { /* private mode */ }

export const soundOn = () => on;
export function setSound(v) {
  on = !!v;
  try { localStorage.setItem('cinemaclub:sound', on ? 'on' : 'off'); } catch (e) { /* private mode */ }
  if (on) { unlock(); sfx('pop'); }
}

function ctx() {
  if (!ac) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ac = new C();
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
// browsers only allow audio after a tap/click — call this from the first user gesture
export function unlock() { if (on) try { ctx(); } catch (e) { /* no audio */ } }

function tone(a, { f = 440, to = null, at = 0, dur = 0.12, type = 'sine', vol = 0.12 }) {
  const t0 = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

const SFX = {
  tick: (a) => tone(a, { f: 760, dur: 0.07, type: 'square', vol: 0.035 }),
  go: (a) => tone(a, { f: 1180, dur: 0.16, type: 'square', vol: 0.05 }),
  correct: (a) => { tone(a, { f: 660, dur: 0.11, type: 'triangle', vol: 0.16 }); tone(a, { f: 990, at: 0.09, dur: 0.18, type: 'triangle', vol: 0.16 }); },
  wrong: (a) => tone(a, { f: 210, to: 120, dur: 0.28, type: 'sawtooth', vol: 0.06 }),
  point: (a) => [523, 659, 784].forEach((f, i) => tone(a, { f, at: i * 0.07, dur: 0.14, type: 'triangle', vol: 0.12 })),
  win: (a) => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(a, { f, at: i * 0.1, dur: i === 5 ? 0.4 : 0.13, type: 'triangle', vol: 0.14 })),
  lose: (a) => [392, 370, 349, 262].forEach((f, i) => tone(a, { f, at: i * 0.18, dur: i === 3 ? 0.45 : 0.16, type: 'triangle', vol: 0.1 })),
  match: (a) => { tone(a, { f: 587, dur: 0.12, type: 'sine', vol: 0.16 }); tone(a, { f: 880, at: 0.12, dur: 0.22, type: 'sine', vol: 0.16 }); },
  pop: (a) => tone(a, { f: 520, to: 880, dur: 0.09, type: 'sine', vol: 0.08 }),
  turn: (a) => { tone(a, { f: 880, dur: 0.08, type: 'sine', vol: 0.1 }); tone(a, { f: 880, at: 0.14, dur: 0.08, type: 'sine', vol: 0.1 }); },
};

export function sfx(name) {
  if (!on || !SFX[name]) return;
  try { const a = ctx(); if (a) SFX[name](a); } catch (e) { /* audio unavailable */ }
}
export function buzz(pattern) {
  if (!on) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not supported */ }
}
