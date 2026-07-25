// Netplay session: binds a connected NetPeer to the Game.
//
// Topology is host-authoritative:
//   * the host runs the one and only simulation and streams state snapshots;
//   * the guest streams its raw input and replicates whatever it is told.
// Nothing has to be deterministic across the two machines, which makes this
// robust against browser/CPU differences at the cost of one RTT of input lag
// for the guest.

import {
  encodeInput, decodeInput, encodeSnapshot, decodeSnapshot,
  PKT_INPUT, PKT_SNAPSHOT, EDGE_ACTIONS, attackIndex,
  EVT_HIT, EVT_BLOCK,
} from './protocol.js';
import { RemoteInput, NetInputRouter } from './netinput.js';

const INPUT_SEND_INTERVAL = 1 / 60;

export class NetSession {
  /**
   * @param {object} args
   * @param {import('./peer.js').NetPeer} args.peer  already-connected peer
   * @param {object} args.game
   * @param {import('../input.js').InputSystem} args.input local keyboard
   */
  constructor({ peer, game, input }) {
    this.peer = peer;
    this.game = game;
    this.localInput = input;
    this.role = peer.role;                                  // 'host' | 'guest'
    this.localSide = this.role === 'host' ? 'p1' : 'p2';
    this.remoteSide = this.role === 'host' ? 'p2' : 'p1';

    this.remoteInput = new RemoteInput();
    this.router = new NetInputRouter({
      local: input, remote: this.remoteInput, localSide: this.localSide,
    });

    this.latestSnapshot = null;
    this.snapshotAge = 0;      // seconds since the last snapshot was applied

    this._snapSeq = 0;
    this._inputSeq = 0;
    this._sendAcc = INPUT_SEND_INTERVAL;
    this._counters = Object.fromEntries(EDGE_ACTIONS.map(a => [a, 0]));
    this._pendingEvents = 0;
    this._newSnapshot = false;

    peer.onRealtime = (data) => this._onRealtime(data);
    peer.onCtrl = (msg) => this._onCtrl(msg);
  }

  get rtt() { return this.peer.rtt; }

  // ---------- Realtime ----------

  _onRealtime(data) {
    if (!(data instanceof ArrayBuffer)) return;
    const kind = new DataView(data).getUint8(0);
    if (this.role === 'host' && kind === PKT_INPUT) {
      this.remoteInput.apply(decodeInput(data));
    } else if (this.role === 'guest' && kind === PKT_SNAPSHOT) {
      const snap = decodeSnapshot(data);
      // Unordered channel: only ever move forward in time.
      if (!this.latestSnapshot || snap.seq > this.latestSnapshot.seq) {
        this.latestSnapshot = snap;
        this.snapshotAge = 0;
        this._newSnapshot = true;
      }
    }
  }

  /** Host: flag a combat event so the guest can play the same juice. */
  noteEvent(kind) {
    if (kind === 'hit') this._pendingEvents |= EVT_HIT;
    else if (kind === 'block') this._pendingEvents |= EVT_BLOCK;
  }

  /** Host: called once per fixed simulation step, after the world was ticked. */
  afterHostTick() {
    if (this.role !== 'host' || !this.peer.open) return;
    const g = this.game;
    if (g.state === 'menu' || g.players.length !== 2) return;

    const players = g.players.map((p) => ({
      x: p.root.position.x,
      y: p.root.position.y,
      frame: p.frame,
      state: p.state,
      facing: p.facing,
      grounded: p.grounded,
      blocking: p.isBlocking,
      hp: p.hp,
      hitstun: p.hitstun,
      attack: p.currentAttack ? {
        index: attackIndex(p.currentAttack.def),
        frame: p.currentAttack.frame,
        phase: p.currentAttack.state,
      } : null,
    }));

    this.peer.sendRealtime(encodeSnapshot({
      seq: this._snapSeq++,
      gameState: g.state,
      timer: g.timer,
      events: this._pendingEvents,
      players,
      projectiles: g.projectiles.map(pr => ({ id: pr.netId, x: pr.position.x, y: pr.position.y })),
    }));
    this._pendingEvents = 0;
  }

  /** Guest: sample the keyboard every rendered frame, ship it at 60 Hz. */
  guestFrame(dt) {
    if (this.role !== 'guest') return;
    this.snapshotAge += dt;

    for (const a of EDGE_ACTIONS) {
      if (this.localInput.isPressedAny(a)) this._counters[a] = (this._counters[a] + 1) & 0x0f;
    }

    this._sendAcc += dt;
    if (this._sendAcc < INPUT_SEND_INTERVAL || !this.peer.open) return;
    this._sendAcc = 0;

    const held = {};
    for (const a of ['left', 'right', 'jump', 'block', 'punch', 'kick', 'special']) {
      held[a] = this.localInput.isHeldAny(a);
    }
    this.peer.sendRealtime(encodeInput(this._inputSeq++ & 0xffff, held, this._counters));
  }

  /** Guest: true exactly once for each freshly received snapshot. */
  consumeNewSnapshot() {
    const fresh = this._newSnapshot;
    this._newSnapshot = false;
    return fresh;
  }

  // ---------- Control channel ----------

  _onCtrl(msg) {
    const g = this.game;
    switch (msg.t) {
      case 'select':
        g.netOnRemoteSelect(msg.side, msg.id);
        break;
      case 'start':
        if (this.role === 'guest') g.netOnStart(msg.p1, msg.p2);
        break;
      case 'msg':
        if (this.role === 'guest') {
          if (msg.text) g.hud.showMessage(msg.text, msg.duration);
          else g.hud.clearMessage();
        }
        break;
      case 'menu':
        if (this.role === 'guest') g.netOnMenu();
        break;
      default:
        break;
    }
  }

  sendSelect(side, id) { this.peer.sendCtrl({ t: 'select', side, id }); }
  sendStart(p1, p2) { if (this.role === 'host') this.peer.sendCtrl({ t: 'start', p1, p2 }); }
  sendMsg(text, duration) { if (this.role === 'host') this.peer.sendCtrl({ t: 'msg', text, duration }); }
  sendMenu() { if (this.role === 'host') this.peer.sendCtrl({ t: 'menu' }); }

  dispose() {
    this.peer.onRealtime = null;
    this.peer.onCtrl = null;
    this.latestSnapshot = null;
  }
}
