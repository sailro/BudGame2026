// Lobby: drives the "play online" panel and owns the peer lifecycle.
//
// Primary flow — one URL, nothing to send back:
//   host  : CREATE -> gets a room code -> shares .../#room=XXXX-XXXX
//   guest : opens the link -> both meet on public relays -> fight!
// The relays only broker the (encrypted) WebRTC handshake; the game itself is
// strictly peer-to-peer.
//
// Fallback flow — manual, zero third party, but with a round trip:
//   host pastes an invite token, guest returns an answer token.

import { NetPeer } from './peer.js';
import { NetSession } from './session.js';
import { buildJoinUrl, readJoinTokenFromUrl, packPayload, unpackPayload } from './signal.js';
import { loadTurnConfig, saveTurnConfig, testTurnConfig, normalizeTurnUrls, turnIceServers } from './turnConfig.js';
import { Rendezvous, makeRoomCode, normalizeRoomCode } from './rendezvous.js';

const $ = (id) => document.getElementById(id);

/** Each spectator costs the host another ~5 kB/s upstream. */
const MAX_SPECTATORS = 8;

export class Lobby {
  constructor({ game, input }) {
    this.game = game;
    this.input = input;
    this.peer = null;
    this.session = null;
    this.rendezvous = null;
    this._busy = false;
    this._joiners = new Map();          // host: cid -> { peer, seat }
    this._pendingSpectators = [];       // connected before the player seat filled
    this._joinSeat = 'player';

    this.panel = $('netPanel');
    this.steps = {
      home: $('netHome'),
      host: $('netHostStep'),
      join: $('netJoinStep'),
      roomHost: $('netRoomHostStep'),
      roomJoin: $('netRoomJoinStep'),
    };
    this.statusEl = $('netStatus');
    this.onlineBtn = $('onlineBtn');

    this._bind();
    this._badgeTimer = setInterval(() => this._updateBadge(), 500);

    this._consumeUrl();
    // Pasting a link into an already-open tab is a fragment navigation: the app
    // never reloads, so we have to react to it explicitly.
    window.addEventListener('hashchange', () => this._consumeUrl());
  }

  /** React to both #room= (automatic) and #join= (manual) links. */
  _consumeUrl() {
    if (this.session) return;
    const hash = window.location.hash || '';
    const room = hash.match(/^#room=([A-Za-z0-9-]+)(?:&turn=(.+))?$/);
    if (room) {
      const code = normalizeRoomCode(room[1]);
      if (code) {
        this.open('roomJoin');
        $('netRoomCodeIn').value = code;
        this._joinRoom(code, room[2] || null);
      }
      return;
    }
    const invite = readJoinTokenFromUrl();
    if (!invite) return;
    this.open('join');
    $('netOfferIn').value = invite;
    $('netAnswerWrap').hidden = true;
    $('netAnswerOut').value = '';
    this._status('Invitation détectée : cliquez sur « GÉNÉRER MA RÉPONSE ».');
  }

  _bind() {
    this.onlineBtn.addEventListener('click', () => {
      if (this.session) this.disconnect('Partie en ligne quittée');
      else this.open('home');
    });
    $('netCloseBtn').addEventListener('click', () => this.close());
    $('netHostBtn').addEventListener('click', () => this._hostRoom());
    $('netJoinBtn').addEventListener('click', () => {
      this._setJoinBusy(false);
      $('netRoomCodeIn').value = '';
      $('netRoomJoinTurn').textContent = '';
      this.open('roomJoin');
      this._status('');
    });
    $('netManualHost').addEventListener('click', () => this._startHost());
    $('netManualJoin').addEventListener('click', () => { this.open('join'); this._status(''); });
    $('netCancelRoomHost').addEventListener('click', () => this._cancel());
    $('netCancelRoomJoin').addEventListener('click', () => this._cancel());
    $('netRoomJoinGo').addEventListener('click', () => {
      const code = normalizeRoomCode($('netRoomCodeIn').value);
      if (!code) return this._status('Code invalide (8 caractères attendus).', true);
      this._joinRoom(code);
    });    $('netCopyRoomLink').addEventListener('click', () => this._copy($('netRoomLink').value, 'Lien copié !'));
    $('netCopyRoomCode').addEventListener('click', () => this._copy($('netRoomCode').textContent, 'Code copié !'));
    $('netBackHost').addEventListener('click', () => this._cancel());
    $('netBackJoin').addEventListener('click', () => this._cancel());
    $('netConnectBtn').addEventListener('click', () => this._hostAcceptAnswer());
    $('netGenAnswer').addEventListener('click', () => this._guestAnswer());

    $('netCopyLink').addEventListener('click', () => this._copy(buildJoinUrl(this._inviteToken || ''), 'Lien copié !'));
    $('netCopyCode').addEventListener('click', () => this._copy(this._inviteToken || '', 'Code copié !'));
    $('netCopyAnswer').addEventListener('click', () => this._copy($('netAnswerOut').value, 'Réponse copiée !'));

    const turn = loadTurnConfig();
    if (turn) {
      $('turnUrl').value = turn.urls || '';
      $('turnUser').value = turn.username || '';
      $('turnPass').value = turn.credential || '';
    }
    $('turnSave').addEventListener('click', () => {
      const cfg = this._readTurnForm();
      saveTurnConfig(cfg.urls ? cfg : null);
      if (!cfg.urls) return this._status('Relais TURN effacé — retour au pair-à-pair pur.');
      this._status('Relais enregistré : ' + normalizeTurnUrls(cfg.urls).join(', '));
    });
    $('turnTest').addEventListener('click', async () => {
      const cfg = this._readTurnForm();
      if (!cfg.urls) return this._status('Renseignez d\'abord une adresse de relais.', true);
      const btn = $('turnTest');
      btn.disabled = true;
      this._status('Test du relais en cours…');
      try {
        const res = await testTurnConfig(cfg);
        this._status(res.message, !res.ok);
      } finally {
        btn.disabled = false;
      }
    });
    $('turnClear').addEventListener('click', () => {
      $('turnUrl').value = $('turnUser').value = $('turnPass').value = '';
      saveTurnConfig(null);
      this._status('Relais TURN effacé — retour au pair-à-pair pur.');
    });
  }

  _readTurnForm() {
    return {
      urls: $('turnUrl').value.trim(),
      username: $('turnUser').value.trim(),
      credential: $('turnPass').value.trim(),
    };
  }

  // ---------- Panel plumbing ----------

  open(step) {
    this.panel.hidden = false;
    this._showStep(step);
  }

  close() {
    this.panel.hidden = true;
    if (!this.session) this._teardownPeer();
  }

  _showStep(name) {
    for (const [key, el] of Object.entries(this.steps)) el.hidden = key !== name;
  }

  _status(text, isError = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', isError);
  }

  /** Prefix a status line with anything the peer wants the user to know. */
  _withWarnings(text) {
    const w = this.peer?.warnings || [];
    return w.length ? w.join(' ') + ' — ' + text : text;
  }

  /**
   * Human-readable summary of what ICE actually obtained. Shown on both ends
   * so a failing pairing can be diagnosed from the device itself: "relay"
   * present means the TURN relay really was allocated.
   */
  _iceSummary(peer) {
    const t = [...(peer?.candidateTypes || [])];
    if (!t.length) return '';
    const label = t.includes('relay') ? 'relais OK' : (t.includes('srflx') ? 'pas de relais' : 'local seulement');
    return ` [réseau : ${t.join('+')} — ${label}]`;
  }

  async _copy(text, okMessage) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this._status(okMessage);
    } catch {
      this._status('Copie impossible : sélectionnez le texte et faites Ctrl+C', true);
    }
  }

  _cancel() {
    this._teardownPeer();
    this._teardownRendezvous();
    this._setJoinBusy(false);
    this._inviteToken = null;
    this._showStep('home');
    this._status('');
  }

  _teardownPeer() {
    if (this.peer) { this.peer.close(); this.peer = null; }
  }

  _teardownRendezvous() {
    if (this.rendezvous) { this.rendezvous.close(); this.rendezvous = null; }
    for (const e of this._joiners.values()) {
      if (e.peer && e.peer !== this.peer) { try { e.peer.close(); } catch { /* gone */ } }
    }
    this._joiners.clear();
    this._pendingSpectators = [];
  }

  // ---------- Room flow (one URL, nothing to send back) ----------

  /**
   * Build the invitation URL. The relay (TURN) configuration is embedded in
   * the link itself, so the guest holds it up front, it does not depend on the
   * rendezvous relay, and the host can see with their own eyes that it is
   * there. Anyone holding the link holds the credentials — same trade-off as
   * the manual invite token.
   */
  async _buildRoomUrl(code) {
    const url = new URL(window.location.href);
    const ice = turnIceServers();
    url.hash = 'room=' + code + (ice.length ? '&turn=' + await packPayload(ice) : '');
    return url.toString();
  }

  async _hostRoom() {
    if (this._busy) return;
    this._busy = true;
    this._showStep('roomHost');
    const code = makeRoomCode();
    const ice = turnIceServers();
    $('netRoomCode').textContent = code;
    $('netRoomLink').value = await this._buildRoomUrl(code);
    $('netRoomTurn').textContent = ice.length
      ? 'Relais TURN inclus dans le lien : ' + normalizeTurnUrls(loadTurnConfig().urls).join(', ')
      : 'Aucun relais TURN configuré — la connexion échouera si un des deux réseaux bloque le direct.';
    $('netRoomTurn').className = ice.length ? 'net-sub turn-ok' : 'net-sub turn-warn';
    this._status('Connexion aux relais de rendez-vous…');

    this._joiners = new Map();   // cid -> { peer, seat }
    try {
      this._teardownRendezvous();
      this.rendezvous = new Rendezvous({ code, onStatus: (t) => this._status(t) });
      await this.rendezvous.start();
      this.rendezvous.on((p) => this._onRoomMessage(p));
      this._status('En attente de votre adversaire…');
    } catch (err) {
      this._status('Erreur : ' + err.message, true);
      this._teardownRendezvous();
    } finally {
      this._busy = false;
    }
  }

  _onRoomMessage(p) {
    if (p.role === 'hello') this._serveJoiner(p.cid);
    else if (p.role === 'answer') this._applyJoinerAnswer(p.cid, p.sdp);
  }

  /**
   * A new arrival. The first one takes the player seat; everyone after that
   * gets a read-only view of the fight. Each joiner gets its own connection,
   * so offers are addressed by joiner id and never stolen.
   */
  async _serveJoiner(cid) {
    if (!cid || !this.rendezvous) return;
    const existing = this._joiners.get(cid);
    if (existing) {
      // Duplicate hello (the guest retries until it hears back): re-send.
      if (existing.offer) this.rendezvous.publish({ role: 'offer', cid, ...existing.offer });
      return;
    }
    if (this._joiners.size >= 1 + MAX_SPECTATORS) {
      this.rendezvous.publish({ role: 'full', cid });
      return;
    }

    const seat = this._hasPlayer() ? 'spectator' : 'player';
    const entry = { seat, offer: null, peer: null };
    this._joiners.set(cid, entry);

    try {
      const peer = new NetPeer();
      entry.peer = peer;
      peer.onStatus = () => {};
      peer.onOpen = () => this._onJoinerConnected(cid, entry);
      peer.onClose = () => this._onJoinerLost(cid, entry);
      const offer = await peer.createOffer();
      entry.offer = { sdp: offer.sdp, type: offer.type, ice: offer.iceServers, seat };
      this.rendezvous.publish({ role: 'offer', cid, ...entry.offer });
      peer.armWatchdog(45000);
    } catch (err) {
      this._joiners.delete(cid);
    }
  }

  _applyJoinerAnswer(cid, sdp) {
    const entry = this._joiners.get(cid);
    if (!entry || !entry.peer || entry.answered) return;
    entry.answered = true;
    entry.peer.applyAnswer(sdp).catch(() => {});
  }

  _hasPlayer() {
    for (const e of this._joiners.values()) if (e.seat === 'player') return true;
    return false;
  }

  _onJoinerConnected(cid, entry) {
    if (entry.seat === 'player') {
      this.peer = entry.peer;
      // From here on, losing this peer means losing the match.
      entry.peer.onClose = (reason) => this.disconnect(reason);
      this._onConnected();
    } else if (this.session) {
      this.session.addSpectator(entry.peer);
      this._updateBadge();
    } else {
      // Spectator arrived before the player did; hold it until the seat fills.
      this._pendingSpectators.push(entry.peer);
    }
  }

  _onJoinerLost(cid, entry) {
    this._joiners.delete(cid);
    if (entry.seat === 'spectator') {
      if (this.session) this.session.removeSpectator(entry.peer);
      const i = this._pendingSpectators.indexOf(entry.peer);
      if (i >= 0) this._pendingSpectators.splice(i, 1);
    }
  }

  /**
   * @param {string} code
   * @param {string|null} turnFromUrl packed relay config carried by the link
   */
  async _joinRoom(code, turnFromUrl = null) {
    if (this._busy) return;
    this._busy = true;
    this._showStep('roomJoin');
    $('netRoomCodeIn').value = code;
    // Joining starts on its own when arriving from a link, so the form must
    // not keep looking like it is waiting to be submitted.
    this._setJoinBusy(true);
    this._status('Connexion aux relais de rendez-vous…');

    try {
      const urlIce = turnFromUrl ? (await unpackPayload(turnFromUrl)) || [] : [];
      if (urlIce.length) {
        $('netRoomJoinTurn').textContent = 'Relais TURN reçu dans le lien de l\'hôte.';
        $('netRoomJoinTurn').className = 'net-sub turn-ok';
      }

      this._teardownRendezvous();
      this.rendezvous = new Rendezvous({ code, onStatus: (t) => this._status(t) });
      await this.rendezvous.start();
      this._status('Recherche de la partie…');

      const { cid, offer } = await this.rendezvous.join();
      this._joinSeat = offer.seat === 'spectator' ? 'spectator' : 'player';
      const peer = this._newPeer();
      // The link is the primary source; whatever arrives over the rendezvous
      // is merged in as a backstop.
      const ice = urlIce.length ? urlIce : (offer.ice || []);
      const answer = await peer.acceptOffer(offer.sdp, ice);
      await this.rendezvous.sendAnswer(cid, answer);
      peer.armWatchdog();
      const seatNote = this._joinSeat === 'spectator'
        ? 'Partie déjà complète : vous rejoignez en spectateur. ' : '';
      this._status(this._withWarnings(seatNote + 'Connexion en cours…' + this._iceSummary(peer)));
    } catch (err) {
      this._status('Erreur : ' + err.message, true);
      this._teardownPeer();
      this._teardownRendezvous();
      this._setJoinBusy(false);      // let them fix the code and try again
    } finally {
      this._busy = false;
    }
  }

  /** Lock or release the join form while a connection attempt is under way. */
  _setJoinBusy(busy) {
    const btn = $('netRoomJoinGo');
    btn.disabled = busy;
    btn.textContent = busy ? 'CONNEXION…' : 'REJOINDRE';
    $('netRoomCodeIn').readOnly = busy;
    $('netRoomJoinLabel').textContent = busy
      ? 'Connexion à la partie…'
      : 'Entrez le code du salon reçu';
  }

  _newPeer() {
    this._teardownPeer();
    const peer = new NetPeer();
    peer.onStatus = (t) => this._status(t);
    peer.onOpen = () => this._onConnected();
    peer.onClose = (reason) => this.disconnect(reason);
    this.peer = peer;
    return peer;
  }

  // ---------- Host ----------

  async _startHost() {
    if (this._busy) return;
    this._busy = true;
    this._showStep('host');
    $('netOffer').value = '';
    $('netAnswerIn').value = '';
    this._status('Préparation de l\'invitation…');
    try {
      const peer = this._newPeer();
      this._inviteToken = await peer.createInvite();
      $('netOffer').value = buildJoinUrl(this._inviteToken);
      const relayNote = peer.usingTurn
        ? 'Relais inclus dans l\'invitation (votre adversaire n\'a rien à configurer). '
        : '';
      this._status(this._withWarnings(relayNote + 'Envoyez le lien, puis collez la réponse reçue.'),
                   peer.warnings.length > 0);
    } catch (err) {
      this._status('Erreur : ' + err.message, true);
      this._teardownPeer();
    } finally {
      this._busy = false;
    }
  }

  async _hostAcceptAnswer() {
    if (this._busy || !this.peer) return;
    this._busy = true;
    try {
      await this.peer.acceptAnswer($('netAnswerIn').value);
    } catch (err) {
      this._status('Erreur : ' + err.message, true);
    } finally {
      this._busy = false;
    }
  }

  // ---------- Guest ----------

  async _guestAnswer() {
    if (this._busy) return;
    this._busy = true;
    this._status('Lecture de l\'invitation…');
    try {
      const peer = this._newPeer();
      const answer = await peer.acceptInvite($('netOfferIn').value);
      $('netAnswerOut').value = answer;
      $('netAnswerWrap').hidden = false;
      const relayNote = peer.inheritedTurn ? 'Relais fourni par l\'hôte. ' : '';
      this._status(this._withWarnings(relayNote + 'Renvoyez cette réponse à l\'hôte et patientez…'),
                   peer.warnings.length > 0);
    } catch (err) {
      this._status('Erreur : ' + err.message, true);
      this._teardownPeer();
    } finally {
      this._busy = false;
    }
  }

  // ---------- Connection lifecycle ----------

  _onConnected() {
    // The room stays open so latecomers can watch, but we no longer need to
    // hold the panel: the fight is starting.
    this.session = new NetSession({
      peer: this.peer, game: this.game, input: this.input,
      spectator: this.peer.role === 'guest' && this._joinSeat === 'spectator',
    });
    this.game.attachNet(this.session);
    // Anyone who connected before the player seat filled can now be wired in.
    for (const s of this._pendingSpectators) this.session.addSpectator(s);
    this._pendingSpectators = [];
    // Make sure both ends agree on the initial character selection.
    if (!this.session.spectator) {
      const side = this.session.localSide;
      this.session.sendSelect(side, side === 'p1' ? this.game.p1Choice : this.game.p2Choice);
    }
    this.onlineBtn.textContent = 'QUITTER LA PARTIE EN LIGNE';
    this.panel.hidden = true;
    this._inviteToken = null;
    if (/^#(join=|room=)/.test(window.location.hash)) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    this.game.hud.showMessage(this.session.spectator ? 'MODE SPECTATEUR' : 'CONNECTÉ !', 1500);
  }

  disconnect(reason) {
    const wasPlaying = !!this.session;
    if (!wasPlaying && !this.peer) return;
    this.session = null;
    this._teardownPeer();
    this._teardownRendezvous();
    this.onlineBtn.textContent = 'JOUER EN LIGNE';

    if (wasPlaying) {
      this.game.detachNet();
      this.game.endMatch();
      this.game.hud.showMessage('DÉCONNECTÉ', 2500);
      this.panel.hidden = true;
      this._showStep('home');
      this._status('');
    } else {
      // Handshake failure: stay in the panel and keep the diagnosis on screen.
      this.panel.hidden = false;
      this._showStep('home');
      this._status(reason || 'Connexion impossible', true);
    }
  }

  _updateBadge() {
    if (!this.session) return;
    const s = this.session;
    const who = s.spectator ? 'spectateur' : (s.localSide === 'p1' ? 'J1 · hôte' : 'J2');
    const viewers = s.role === 'host' && s.spectatorCount
      ? ` — ${s.spectatorCount} spectateur${s.spectatorCount > 1 ? 's' : ''}` : '';
    this.game.hud.setNetStatus(`EN LIGNE — ${who} — ${s.rtt} ms${viewers}`);
  }
}
