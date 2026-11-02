// Messaging between the computer page (host) and the iPhone page (sensor).
//  - 'peer'  : WebRTC data channel via PeerJS (signalling server: 0.peerjs.com by default).
//              Only small JSON messages (averaged numbers) travel; camera images never leave the phone.
//  - 'local' : BroadcastChannel between two tabs of the same browser (testing / demo).

const PREFIX = 'imcal-v1-';

export function randomRoom() {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('').slice(0, 6);
}

class Emitter {
  constructor() { this.h = {}; }
  on(e, f) { (this.h[e] ||= []).push(f); return this; }
  emit(e, ...a) { (this.h[e] || []).forEach((f) => { try { f(...a); } catch (err) { console.error(err); } }); }
}

class LocalLink extends Emitter {
  constructor(room, role) {
    super();
    this.role = role;
    this.ch = new BroadcastChannel(PREFIX + room);
    this.ch.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.__from === role) return;
      if (m.t === '__hello') {
        const wasOpen = this.open;
        this._open();
        if (!wasOpen || m.reply !== false) this.ch.postMessage({ t: '__hello', __from: role, reply: false });
        return;
      }
      this.emit('message', m);
    };
    this.open = false;
    setTimeout(() => this.ch.postMessage({ t: '__hello', __from: role }), 50);
  }
  _open() { if (!this.open) { this.open = true; this.emit('open'); } }
  send(m) { this.ch.postMessage({ ...m, __from: this.role }); }
  close() { this.ch.close(); this.emit('close'); }
}

class PeerLink extends Emitter {
  constructor(room, role, opts = {}) {
    super();
    if (!globalThis.Peer) throw new Error('PeerJS 未載入');
    this.role = role;
    this.conn = null;
    const peerOpts = { debug: 1, ...(opts.peerServer || {}) };
    const hostId = PREFIX + room;
    if (role === 'host') {
      this.peer = new globalThis.Peer(hostId, peerOpts);
      this.peer.on('open', () => this.emit('status', 'waiting'));
      this.peer.on('connection', (conn) => {
        if (this.conn) { try { this.conn.close(); } catch {} }
        this._bind(conn);
      });
    } else {
      this.peer = new globalThis.Peer(peerOpts);
      this.peer.on('open', () => {
        this.emit('status', 'connecting');
        this._bind(this.peer.connect(hostId, { reliable: true, serialization: 'json' }));
      });
    }
    this.peer.on('error', (e) => this.emit('error', e));
    this.peer.on('disconnected', () => { this.emit('status', 'signalling-lost'); try { this.peer.reconnect(); } catch {} });
  }
  _bind(conn) {
    this.conn = conn;
    conn.on('open', () => this.emit('open'));
    conn.on('data', (d) => this.emit('message', d));
    conn.on('close', () => { if (this.conn === conn) this.conn = null; this.emit('close'); });
    conn.on('error', (e) => this.emit('error', e));
  }
  get open() { return !!this.conn?.open; }
  send(m) { if (this.conn?.open) this.conn.send(m); }
  close() { try { this.peer.destroy(); } catch {} }
}

export function createLink({ kind = 'peer', room, role, peerServer }) {
  return kind === 'local' ? new LocalLink(room, role) : new PeerLink(room, role, { peerServer });
}
