// WebRTC peer wrapper: two data channels over a single direct connection.
//
//   ctrl : reliable + ordered  -> lobby, character select, match start, chat-ish
//   rt   : unreliable + unordered -> 60 Hz input packets and state snapshots
//
// No server is involved: only public STUN servers are contacted, and only to
// discover our own public address. All game traffic flows peer-to-peer.

import { encodeSignal, decodeSignal, waitForIceGathering } from './signal.js';
import { turnIceServers, diagnoseIceFailure } from './turnConfig.js';

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const PING_INTERVAL_MS = 1000;

export class NetPeer {
  constructor() {
    this.pc = null;
    this.ctrl = null;
    this.rt = null;
    this.role = null;       // 'host' | 'guest'
    this.open = false;
    this.rtt = 0;
    this.candidateTypes = new Set();
    this.usingTurn = false;

    // Callbacks, assigned by the owner.
    this.onOpen = null;      // ()
    this.onClose = null;     // (reason)
    this.onCtrl = null;      // (msgObject)
    this.onRealtime = null;  // (ArrayBuffer)
    this.onStatus = null;    // (humanReadableString)

    this._pingTimer = null;
    this._closed = false;
  }

  _status(text) { if (this.onStatus) this.onStatus(text); }

  _createConnection() {
    const turn = turnIceServers();
    this.usingTurn = turn.length > 0;
    // iceCandidatePoolSize is deliberately 0: pre-gathering would open TURN
    // allocations we may never use, and buys nothing with non-trickle ICE.
    const pc = new RTCPeerConnection({
      iceServers: [...STUN_SERVERS, ...turn],
      iceCandidatePoolSize: 0,
    });
    this.pc = pc;
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed') this._fail(diagnoseIceFailure(this.candidateTypes, this.usingTurn));
      else if (s === 'disconnected') this._status('Connexion instable…');
      else if (s === 'closed') this._fail('Connexion fermée');
    });
    return pc;
  }

  /** Gather ICE, remembering which candidate types we managed to obtain. */
  async _gather() {
    // A TURN allocation needs a DNS lookup plus a round trip, so give it room.
    this.candidateTypes = await waitForIceGathering(this.pc, {
      quietMs: this.usingTurn ? 2500 : 1500,
      timeoutMs: this.usingTurn ? 25000 : 15000,
    });
    if (!this.candidateTypes.has('srflx') && !this.candidateTypes.has('relay')) {
      this._status('Attention : aucune adresse publique trouvée, l\'UDP sortant semble bloqué.');
    }
  }

  _bindChannel(ch) {
    if (ch.label === 'ctrl') {
      this.ctrl = ch;
      ch.addEventListener('message', (e) => this._onCtrlMessage(e.data));
      ch.addEventListener('open', () => this._maybeOpen());
      ch.addEventListener('close', () => this._fail('Adversaire déconnecté'));
    } else if (ch.label === 'rt') {
      this.rt = ch;
      ch.binaryType = 'arraybuffer';
      ch.addEventListener('message', (e) => {
        if (this.onRealtime) this.onRealtime(e.data);
      });
      ch.addEventListener('open', () => this._maybeOpen());
    }
  }

  _maybeOpen() {
    if (this.open || this._closed) return;
    if (!this.ctrl || this.ctrl.readyState !== 'open') return;
    if (!this.rt || this.rt.readyState !== 'open') return;
    this.open = true;
    this._status('Connecté !');
    // Both ends ping so both can display a latency figure.
    this._pingTimer = setInterval(() => {
      this.sendCtrl({ t: 'ping', ts: performance.now() });
    }, PING_INTERVAL_MS);
    if (this.onOpen) this.onOpen();
  }

  _onCtrlMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'ping') { this.sendCtrl({ t: 'pong', ts: msg.ts }); return; }
    if (msg.t === 'pong') { this.rtt = Math.round(performance.now() - msg.ts); return; }
    if (this.onCtrl) this.onCtrl(msg);
  }

  _fail(reason) {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    this.open = false;
    this._status(reason);
    if (this.onClose) this.onClose(reason);
  }

  // ---------- Host side ----------

  /** Create the offer. Returns the shareable invite token. */
  async createInvite() {
    this.role = 'host';
    const pc = this._createConnection();
    this._bindChannel(pc.createDataChannel('ctrl', { ordered: true }));
    this._bindChannel(pc.createDataChannel('rt', { ordered: false, maxRetransmits: 0 }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._status(this.usingTurn ? 'Recherche du chemin réseau (avec relais)…' : 'Recherche du chemin réseau…');
    await this._gather();
    return encodeSignal(pc.localDescription);
  }

  /** Host: consume the answer token sent back by the guest. */
  async acceptAnswer(token) {
    const desc = await decodeSignal(token);
    if (desc.type !== 'answer') throw new Error('Ce code n\'est pas une réponse');
    await this.pc.setRemoteDescription(desc);
    this._status('Établissement de la connexion…');
  }

  // ---------- Guest side ----------

  /** Guest: consume the invite token and produce the answer token. */
  async acceptInvite(token) {
    const desc = await decodeSignal(token);
    if (desc.type !== 'offer') throw new Error('Ce code n\'est pas une invitation');

    this.role = 'guest';
    const pc = this._createConnection();
    pc.addEventListener('datachannel', (e) => {
      this._bindChannel(e.channel);
      this._maybeOpen();
    });

    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._status(this.usingTurn ? 'Recherche du chemin réseau (avec relais)…' : 'Recherche du chemin réseau…');
    await this._gather();
    return encodeSignal(pc.localDescription);
  }

  // ---------- Transport ----------

  sendCtrl(msg) {
    if (this.ctrl && this.ctrl.readyState === 'open') this.ctrl.send(JSON.stringify(msg));
  }

  sendRealtime(buffer) {
    // bufferedAmount guard: never let an unreliable channel build a backlog.
    if (this.rt && this.rt.readyState === 'open' && this.rt.bufferedAmount < 64 * 1024) {
      this.rt.send(buffer);
    }
  }

  close() {
    this._closed = true;
    clearInterval(this._pingTimer);
    this.open = false;
    try { this.ctrl?.close(); } catch { /* already gone */ }
    try { this.rt?.close(); } catch { /* already gone */ }
    try { this.pc?.close(); } catch { /* already gone */ }
    this.ctrl = this.rt = this.pc = null;
  }
}
