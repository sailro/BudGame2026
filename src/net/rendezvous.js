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

  /** Receive the first payload matching `predicate`. */
  _waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const handler = (payload) => {
        if (!predicate(payload)) return;
        cleanup();
        resolve(payload);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Aucune réponse de l'adversaire (délai dépassé)"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this._handlers.delete(handler);
      };
      this._handlers.add(handler);
    });
  }

  async _publish(payload) {
    this.pool.publish(this.room.tag, await seal(this.room.key, payload));
  }

  /**
   * Host side: announce the offer and wait for an answer.
   *
   * Ephemeral events only reach current subscribers, so the offer has to be
   * repeated for a guest that opens the link later. Timers are throttled hard
   * in background tabs (down to once a minute), so rather than rely on that
   * cadence the guest says hello on arrival and we answer immediately; the
   * interval is only a backstop.
   */
  async hostExchange(offer, iceServers, timeoutMs = 300000) {
    const payload = { role: 'offer', sdp: offer.sdp, type: offer.type, ice: iceServers };
    const announce = () => { if (!this._closed) this._publish(payload).catch(() => {}); };

    const onHello = (p) => { if (p.role === 'hello') announce(); };
    this._handlers.add(onHello);

    announce();
    this._republishTimer = setInterval(announce, REPUBLISH_MS);
    try {
      return await this._waitFor(p => p.role === 'answer', timeoutMs);
    } finally {
      clearInterval(this._republishTimer);
      this._republishTimer = null;
      this._handlers.delete(onHello);
    }
  }

  /**
   * Guest side: wait for the offer, announcing ourselves so the host can send
   * it straight away instead of waiting for its next scheduled announce.
   */
  async awaitOffer(timeoutMs = 90000) {
    const waiter = this._waitFor(p => p.role === 'offer', timeoutMs);
    const hello = () => { if (!this._closed) this._publish({ role: 'hello' }).catch(() => {}); };
    hello();
    const retry = setInterval(hello, 1500);
    try {
      return await waiter;
    } finally {
      clearInterval(retry);
    }
  }

  /** Guest side: publish the answer a few times, in case a relay drops one. */
  async sendAnswer(answer) {
    const payload = { role: 'answer', sdp: answer.sdp, type: answer.type };
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
