// Lobby: drives the "play online" panel and owns the peer lifecycle.
//
// Flow (no server anywhere in the picture):
//   host  : CREATE -> gets an invite token -> sends it over Discord/SMS/mail
//   guest : pastes the invite -> gets an answer token -> sends it back
//   host  : pastes the answer -> the data channels open -> fight!

import { NetPeer } from './peer.js';
import { NetSession } from './session.js';
import { buildJoinUrl, readJoinTokenFromUrl } from './signal.js';
import { loadTurnConfig, saveTurnConfig, testTurnConfig, normalizeTurnUrls } from './turnConfig.js';

const $ = (id) => document.getElementById(id);

export class Lobby {
  constructor({ game, input }) {
    this.game = game;
    this.input = input;
    this.peer = null;
    this.session = null;
    this._busy = false;

    this.panel = $('netPanel');
    this.steps = { home: $('netHome'), host: $('netHostStep'), join: $('netJoinStep') };
    this.statusEl = $('netStatus');
    this.onlineBtn = $('onlineBtn');

    this._bind();
    this._badgeTimer = setInterval(() => this._updateBadge(), 500);

    this._consumeInviteFromUrl();
    // Pasting a #join link into an already-open tab is a fragment navigation:
    // the app never reloads, so we have to react to it explicitly.
    window.addEventListener('hashchange', () => this._consumeInviteFromUrl());
  }

  _consumeInviteFromUrl() {
    if (this.session) return;
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
    $('netHostBtn').addEventListener('click', () => this._startHost());
    $('netJoinBtn').addEventListener('click', () => { this.open('join'); this._status(''); });
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
    this._inviteToken = null;
    this._showStep('home');
    this._status('');
  }

  _teardownPeer() {
    if (this.peer) { this.peer.close(); this.peer = null; }
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
    this.session = new NetSession({ peer: this.peer, game: this.game, input: this.input });
    this.game.attachNet(this.session);
    // Make sure both ends agree on the initial character selection.
    const side = this.session.localSide;
    this.session.sendSelect(side, side === 'p1' ? this.game.p1Choice : this.game.p2Choice);
    this.onlineBtn.textContent = 'QUITTER LA PARTIE EN LIGNE';
    this.panel.hidden = true;
    this._inviteToken = null;
    if (window.location.hash.startsWith('#join=')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    this.game.hud.showMessage('CONNECTÉ !', 1200);
  }

  disconnect(reason) {
    const wasPlaying = !!this.session;
    if (!wasPlaying && !this.peer) return;
    this.session = null;
    this._teardownPeer();
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
    const who = this.session.localSide === 'p1' ? 'J1 · hôte' : 'J2';
    this.game.hud.setNetStatus(`EN LIGNE — ${who} — ${this.session.rtt} ms`);
  }
}
