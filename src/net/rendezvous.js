// Room-code rendezvous over public Nostr relays.
//
// The whole point is that the host shares ONE url and nothing comes back by
// hand. WebRTC still needs a two-way handshake — that is a protocol
// requirement, not a design choice — so the answer travels over a public
// relay instead of through the players.
//
// Privacy: an SDP contains local and public IP addresses, and relays are
// public. So the payload is encrypted with AES-GCM using a key derived from
// the room code, and it is published under a tag derived separately from the
// same code. A relay therefore sees an opaque blob under a random-looking
// tag, and only someone who already knows the room code can read it.

import { NostrPool } from './nostr.js';

// Ambiguous characters (O/0, I/1) are left out so a code can be read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const REPUBLISH_MS = 2000;

export const ROOM_FULL = 'Cette partie a déjà un adversaire. Demandez un nouveau lien.';

export function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    if (i === 4) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function normalizeRoomCode(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== CODE_LEN) return null;
  return cleaned.slice(0, 4) + '-' + cleaned.slice(4);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveRoom(code) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) throw new Error('Code de salon invalide');
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(normalized), 'PBKDF2', false, ['deriveBits', 'deriveKey']);

  // The tag is public (it is the relay filter), the key never leaves here.
  const tagBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('budgame-tag-v1'), iterations: 60000, hash: 'SHA-256' },
    material, 128);
  const tag = Array.from(new Uint8Array(tagBits), b => b.toString(16).padStart(2, '0')).join('');

  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('budgame-key-v1'), iterations: 60000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  return { code: normalized, tag, key };
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  let bin = '';
  for (const b of packed) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function open(key, b64) {
  const bin = atob(b64);
  const packed = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
  return JSON.parse(dec.decode(plain));
}

/**
 * Rendezvous session. Wraps a relay pool plus the encrypted offer/answer
 * exchange for one room code.
 */
export class Rendezvous {
  constructor({ code, onStatus } = {}) {
    this.codePromise = deriveRoom(code || makeRoomCode());
    this.pool = new NostrPool();
    this.onStatus = onStatus || null;
    this.ready = false;
    this._handlers = new Set();
    this._republishTimer = null;
    this._closed = false;

    this.pool.onStatus = (n, total) => {
      if (!this.onStatus) return;
      // Once we are up and running the meaningful message is "waiting for your
      // opponent"; relay churn must not keep overwriting it.
      if (this.ready) {
        if (n === 0) this.onStatus('Plus aucun relais de rendez-vous joignable…');
        return;
      }
      this.onStatus(`Relais de rendez-vous : ${n}/${total} connecté(s)`);
    };
    this.pool.onEvent = (ev) => this._dispatch(ev);
  }

  async start() {
    const room = await this.codePromise;
    this.room = room;
    this.pool.connect();
    await this.pool.waitForAnyRelay();
    this.pool.subscribe(room.tag);
    this.ready = true;
    return room.code;
  }

  async _dispatch(ev) {
    if (this._closed || ev.pubkey === this.pool.pubkey) return;
    let payload;
    try { payload = await open(this.room.key, ev.content); }
    catch { return; }              // not ours, or wrong room code
    for (const h of [...this._handlers]) h(payload);
  }

  /** Register a payload handler. Returns an unsubscribe function. */
  on(cb) {
    this._handlers.add(cb);
    return () => this._handlers.delete(cb);
  }

  async _publish(payload) {
    this.pool.publish(this.room.tag, await seal(this.room.key, payload));
  }

  /** Publish an encrypted payload to the room. */
  publish(payload) { return this._publish(payload); }

  /**
   * Guest side: announce ourselves and wait for an offer addressed to us.
   *
   * Every joiner gets its own id, so a room can serve several people at once
   * and nobody steals an offer meant for someone else.
   */
  async join(timeoutMs = 90000) {
    const cid = Math.random().toString(36).slice(2, 10);
    const waiter = new Promise((resolve, reject) => {
      const off = this.on((p) => {
        if (p.cid !== cid) return;
        if (p.role === 'offer') { cleanup(); resolve(p); }
        else if (p.role === 'full') { cleanup(); reject(new Error(ROOM_FULL)); }
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Aucune partie trouvée pour ce code. L'hôte a-t-il "
          + 'toujours sa page ouverte ?'));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); off(); };
    });

    const hello = () => { if (!this._closed) this._publish({ role: 'hello', cid }).catch(() => {}); };
    hello();
    const retry = setInterval(hello, 1500);
    try {
      const offer = await waiter;
      return { cid, offer };
    } finally {
      clearInterval(retry);
    }
  }

  /** Guest side: publish our answer a few times, in case a relay drops one. */
  async sendAnswer(cid, answer) {
    const payload = { role: 'answer', cid, sdp: answer.sdp, type: answer.type };
    for (let i = 0; i < 3; i++) {
      await this._publish(payload);
      if (i < 2) await new Promise(r => setTimeout(r, 900));
    }
  }

  close() {
    this._closed = true;
    clearInterval(this._republishTimer);
    this._handlers.clear();
    this.pool.close();
  }
}
