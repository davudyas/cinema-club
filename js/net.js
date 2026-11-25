// Realtime transport. Three interchangeable channel types share one tiny API:
//   ready (Promise) · track(state) · untrack() · peers() · onSync(fn) · onMsg(fn) · send(msg) · leave()
// - SupaChannel:  Supabase Realtime presence + broadcast (production)
// - LocalChannel: BroadcastChannel between tabs of one browser (?net=local, for testing)
// - LoopChannel:  in-memory channel with a bot peer (solo play)
import { CONFIG } from './config.js';

const params = new URLSearchParams(location.search);
export const NET_MODE = params.get('net') === 'local' || !CONFIG.SUPABASE_URL ? 'local' : 'supabase';

let sbPromise = null;
function supabase() {
  if (!sbPromise) {
    sbPromise = import('https://esm.sh/@supabase/supabase-js@2').then(({ createClient }) =>
      createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 20 } },
      })
    );
  }
  return sbPromise;
}

class Base {
  constructor() { this._sync = []; this._msg = []; }
  onSync(f) { this._sync.push(f); }
  onMsg(f) { this._msg.push(f); }
  emitSync() { const p = this.peers(); this._sync.forEach((f) => f(p)); }
  emitMsg(m) { this._msg.forEach((f) => { try { f(m); } catch (e) { console.error(e); } }); }
}

class SupaChannel extends Base {
  constructor(name, key) {
    super();
    this.key = key;
    this.ready = supabase().then((sb) => {
      this.sb = sb;
      this.ch = sb.channel(`${CONFIG.CHANNEL_PREFIX}-${name}`, {
        config: { presence: { key }, broadcast: { self: false, ack: false } },
      });
      this.ch.on('presence', { event: 'sync' }, () => this.emitSync());
      this.ch.on('broadcast', { event: 'm' }, ({ payload }) => this.emitMsg(payload));
      return new Promise((res, rej) => {
        let done = false;
        this.ch.subscribe((status) => {
          if (status === 'SUBSCRIBED' && !done) { done = true; res(); }
          if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !done) { done = true; rej(new Error(status)); }
        });
      });
    });
  }
  async track(state) { await this.ready; return this.ch.track(state); }
  async untrack() { await this.ready; return this.ch.untrack(); }
  peers() {
    if (!this.ch) return [];
    const st = this.ch.presenceState();
    return Object.entries(st).map(([k, metas]) => {
      const { phx_ref, phx_ref_prev, presence_ref, ...rest } = metas[metas.length - 1] || {};
      return { ...rest, key: k };
    });
  }
  send(msg) { if (this.ch) this.ch.send({ type: 'broadcast', event: 'm', payload: msg }); }
  async leave() { try { await this.ready; await this.sb.removeChannel(this.ch); } catch (e) { /* ignore */ } }
}

class LocalChannel extends Base {
  constructor(name, key) {
    super();
    this.key = key;
    this.state = null;
    this.others = new Map();
    this.bc = new BroadcastChannel(`${CONFIG.CHANNEL_PREFIX}-${name}`);
    this.bc.onmessage = (e) => this._on(e.data);
    this.hb = setInterval(() => {
      if (this.state) this.bc.postMessage({ k: 'p', from: key, state: this.state });
      this._expire();
    }, 1500);
    this.ready = Promise.resolve();
    this.bc.postMessage({ k: 'q', from: key });
  }
  _on(d) {
    if (!d || d.from === this.key) return;
    if (d.k === 'p') {
      const prev = this.others.get(d.from);
      this.others.set(d.from, { state: d.state, t: Date.now() });
      if (!prev || JSON.stringify(prev.state) !== JSON.stringify(d.state)) this.emitSync();
    } else if (d.k === 'q') {
      if (this.state) this.bc.postMessage({ k: 'p', from: this.key, state: this.state });
    } else if (d.k === 'x') {
      if (this.others.delete(d.from)) this.emitSync();
    } else if (d.k === 'm') {
      this.emitMsg(d.m);
    }
  }
  _expire() {
    let changed = false;
    for (const [k, v] of this.others) if (Date.now() - v.t > 5000) { this.others.delete(k); changed = true; }
    if (changed) this.emitSync();
  }
  async track(state) { this.state = state; this.bc.postMessage({ k: 'p', from: this.key, state }); this.emitSync(); }
  async untrack() { this.state = null; this.bc.postMessage({ k: 'x', from: this.key }); this.emitSync(); }
  peers() {
    const arr = [...this.others].map(([k, v]) => ({ ...v.state, key: k }));
    if (this.state) arr.push({ ...this.state, key: this.key });
    return arr;
  }
  send(msg) { this.bc.postMessage({ k: 'm', from: this.key, m: msg }); }
  async leave() { clearInterval(this.hb); try { this.bc.postMessage({ k: 'x', from: this.key }); this.bc.close(); } catch (e) { /* closed */ } }
}

export class LoopChannel extends Base {
  constructor(key, botState) {
    super();
    this.key = key;
    this.state = null;
    this.botState = botState;
    this.bot = null; // set by app: { receive(msg) }
    this.ready = Promise.resolve();
    this.closed = false;
  }
  async track(state) { this.state = state; setTimeout(() => this.emitSync(), 10); }
  async untrack() { this.state = null; }
  peers() { return [{ ...this.state, key: this.key }, { ...this.botState, key: '~bot' }]; }
  send(msg) { setTimeout(() => { if (!this.closed && this.bot) this.bot.receive(msg); }, 40); }
  botSend(msg) { setTimeout(() => { if (!this.closed) this.emitMsg({ ...msg, from: '~bot' }); }, 40); }
  async leave() { this.closed = true; }
}

// Reports go into the insert-only table public.cinema_club_reports (read them in the Supabase dashboard).
export async function fileReport(row) {
  if (NET_MODE === 'local') { console.info('[report]', row); return; }
  const sb = await supabase();
  const { error } = await sb.from('cinema_club_reports').insert(row);
  if (error) throw error;
}

export function openChannel(name, key) {
  return NET_MODE === 'local' ? new LocalChannel(name, key) : new SupaChannel(name, key);
}
