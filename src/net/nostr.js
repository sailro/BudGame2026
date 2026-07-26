// Minimal Nostr client, used purely as a rendezvous point.
//
// Nostr relays are public, free, account-less WebSocket servers that accept
// signed JSON events and forward them to whoever subscribed to a matching
// filter. We use them to hand a WebRTC handshake from one browser to the
// other; once the peer connection is up they are dropped entirely and the
// game traffic never touches them.
//
// We publish "ephemeral" events (kind 20000-29999), which relays forward to
// current subscribers but never store, so nothing is left behind.
//
// Only what a relay strictly needs is exposed: the payload itself is
// encrypted with a key derived from the room code (see rendezvous.js), so a
// relay only ever sees opaque ciphertext under a random-looking tag.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const EVENT_KIND = 20042;

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://relay.nostr.band',
];

const toHex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** Build and sign a Nostr event. */
function buildEvent({ secretKey, pubkey, kind, tags, content }) {
  const created_at = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const idBytes = sha256(new TextEncoder().encode(serialized));
  const id = toHex(idBytes);
  const sig = toHex(schnorr.sign(idBytes, secretKey));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/**
 * A pool of relay connections. Publishing goes to all of them, and incoming
 * events are de-duplicated by id, so a single reachable relay is enough.
 */
export class NostrPool {
  constructor(relays = DEFAULT_RELAYS) {
    this.relayUrls = relays;
    this.sockets = new Map();       // url -> WebSocket
    this.seenEvents = new Set();
    this.onEvent = null;            // (event) => void
    this.onStatus = null;           // (connectedCount, total) => void
    this._subs = [];                // [{ id, filter }]
    this._closed = false;

    this.secretKey = schnorr.utils.randomSecretKey();
    this.pubkey = toHex(schnorr.getPublicKey(this.secretKey));
  }

  get connectedCount() {
    let n = 0;
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  connect() {
    for (const url of this.relayUrls) this._connectOne(url);
  }

  _connectOne(url) {
    if (this._closed) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this.sockets.set(url, ws);

    ws.addEventListener('open', () => {
      if (this._closed) return ws.close();
      // Replay every active subscription onto this relay.
      for (const sub of this._subs) this._send(ws, ['REQ', sub.id, sub.filter]);
      this._notifyStatus();
    });
    ws.addEventListener('close', () => this._notifyStatus());
    ws.addEventListener('error', () => this._notifyStatus());
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
      const ev = msg[2];
      if (!ev || this.seenEvents.has(ev.id)) return;
      this.seenEvents.add(ev.id);
      if (this.onEvent) this.onEvent(ev);
    });
  }

  _send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)); } catch { /* relay went away */ }
    }
  }

  _notifyStatus() {
    if (this.onStatus) this.onStatus(this.connectedCount, this.relayUrls.length);
  }

  /** Subscribe to a tag on every relay. Returns the subscription id. */
  subscribe(tag) {
    const id = 'sub' + Math.random().toString(36).slice(2, 10);
    const filter = { kinds: [EVENT_KIND], '#d': [tag] };
    this._subs.push({ id, filter });
    for (const ws of this.sockets.values()) this._send(ws, ['REQ', id, filter]);
    return id;
  }

  /** Publish an encrypted payload under a tag. */
  publish(tag, content) {
    const event = buildEvent({
      secretKey: this.secretKey,
      pubkey: this.pubkey,
      kind: EVENT_KIND,
      tags: [['d', tag]],
      content,
    });
    for (const ws of this.sockets.values()) this._send(ws, ['EVENT', event]);
    return event.id;
  }

  /** Resolve once at least one relay is connected, or reject on timeout. */
  waitForAnyRelay(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (this.connectedCount > 0) return resolve(this.connectedCount);
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.connectedCount > 0) { clearInterval(timer); resolve(this.connectedCount); }
        else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('Aucun relais de rendez-vous joignable'));
        }
      }, 150);
    });
  }

  close() {
    this._closed = true;
    for (const ws of this.sockets.values()) {
      try { ws.close(); } catch { /* already closing */ }
    }
    this.sockets.clear();
    this._subs = [];
  }
}
