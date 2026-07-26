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

/** Union of two iceServers lists, de-duplicated. */
function mergeIceServers(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const entry of [...a, ...b]) {
    if (!entry || !entry.urls) continue;
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

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
    this.inheritedTurn = false;
    this.warnings = [];

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

  _createConnection(extraIce = []) {
    this.usingTurn = extraIce.length > 0;
    // iceCandidatePoolSize is deliberately 0: pre-gathering would open TURN
    // allocations we may never use, and buys nothing with non-trickle ICE.
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [...STUN_SERVERS, ...extraIce],
        iceCandidatePoolSize: 0,
      });
    } catch (err) {
      // A malformed relay URL must never take online play down with it.
      this.usingTurn = false;
      this.warnings.push('Relais TURN ignoré (URL invalide) — connexion directe uniquement.');
      pc = new RTCPeerConnection({ iceServers: STUN_SERVERS, iceCandidatePoolSize: 0 });
    }
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
    const seen = await waitForIceGathering(this.pc, {
      quietMs: this.usingTurn ? 2500 : 1500,
      timeoutMs: this.usingTurn ? 25000 : 15000,
    });
    // Events can be missed (listeners are attached after gathering starts, and
    // a quiet timer can fire early), so the finished SDP is the authority.
    const sdp = this.pc.localDescription ? this.pc.localDescription.sdp : '';
    for (const m of sdp.matchAll(/ typ (\w+)/g)) seen.add(m[1]);
    this.candidateTypes = seen;

    if (!seen.has('srflx') && !seen.has('relay')) {
      this.warnings.push("Aucune adresse publique trouvée : l'UDP sortant semble bloqué.");
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
    clearTimeout(this._watchdog);
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
    clearTimeout(this._watchdog);
    this.open = false;
    this._status(reason);
    if (this.onClose) this.onClose(reason);
  }

  // ---------- Host side ----------

  /**
   * Build the offer and gather ICE.
   * @returns {{sdp:string, type:string, iceServers:Array}} the relay config is
   *   returned alongside so it can be handed to the guest, which needs to be
   *   able to allocate through the same relay.
   */
  async createOffer() {
    this.role = 'host';
    const extraIce = turnIceServers();
    const pc = this._createConnection(extraIce);
    this._bindChannel(pc.createDataChannel('ctrl', { ordered: true }));
    this._bindChannel(pc.createDataChannel('rt', { ordered: false, maxRetransmits: 0 }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._status(this.usingTurn ? 'Recherche du chemin réseau (avec relais)…' : 'Recherche du chemin réseau…');
    await this._gather();
    return {
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
      iceServers: this.usingTurn ? extraIce : [],
    };
  }

  /** Host: apply the guest's answer. */
  async applyAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this._status('Établissement de la connexion…');
  }

  /** Create the offer. Returns the shareable invite token (manual mode). */
  async createInvite() {
    const offer = await this.createOffer();
    return encodeSignal({ type: offer.type, sdp: offer.sdp }, offer.iceServers);
  }

  /** Host: consume the answer token sent back by the guest (manual mode). */
  async acceptAnswer(token) {
    const desc = await decodeSignal(token);
    if (desc.type !== 'answer') throw new Error('Ce code n\'est pas une réponse');
    await this.applyAnswer(desc.sdp);
  }

  // ---------- Guest side ----------

  /**
   * Build the answer to a received offer.
   * @param {string} sdp
   * @param {Array} hostIceServers relay config inherited from the host, so the
   *   guest can allocate through the same relay without owning an account.
   */
  async acceptOffer(sdp, hostIceServers = []) {
    this.role = 'guest';
    const extraIce = mergeIceServers(hostIceServers, turnIceServers());
    if (hostIceServers.length) this.inheritedTurn = true;
    const pc = this._createConnection(extraIce);
    pc.addEventListener('datachannel', (e) => {
      this._bindChannel(e.channel);
      this._maybeOpen();
    });

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._status(this.usingTurn ? 'Recherche du chemin réseau (avec relais)…' : 'Recherche du chemin réseau…');
    await this._gather();
    return { sdp: pc.localDescription.sdp, type: pc.localDescription.type };
  }

  /** Guest: consume the invite token and produce the answer token (manual mode). */
  async acceptInvite(token) {
    const desc = await decodeSignal(token);
    if (desc.type !== 'offer') throw new Error('Ce code n\'est pas une invitation');
    const answer = await this.acceptOffer(desc.sdp, desc.iceServers);
    return encodeSignal({ type: answer.type, sdp: answer.sdp });
  }

  /**
   * Both descriptions are set, so the channels should open shortly. If they do
   * not, fail loudly: silently waiting forever is the worst outcome, and it is
   * exactly what a guest sees when someone else already took the seat.
   */
  armWatchdog(ms = 30000) {
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (this.open || this._closed) return;
      this._fail(diagnoseIceFailure(this.candidateTypes, this.usingTurn));
    }, ms);
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
    clearTimeout(this._watchdog);
    this.open = false;
    try { this.ctrl?.close(); } catch { /* already gone */ }
    try { this.rt?.close(); } catch { /* already gone */ }
    try { this.pc?.close(); } catch { /* already gone */ }
    this.ctrl = this.rt = this.pc = null;
  }
}
