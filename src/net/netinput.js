// Input plumbing for netplay.
//
// `RemoteInput` reconstructs the opponent's held/pressed state from the input
// packets we receive. Edge-triggered actions (jump, punch, kick, special) are
// transmitted as small wrapping counters instead of booleans so that a dropped
// packet on the unreliable channel can never swallow a button press.
//
// `NetInputRouter` exposes the exact same surface as `InputSystem`, so
// `Character.applyInput()` stays completely unaware of the network: it just
// asks for "p1"/"p2" and the router decides whether that is the local keyboard
// or the remote player.

import { ACTIONS, EDGE_ACTIONS, seqNewer } from './protocol.js';

export class RemoteInput {
  constructor() {
    this.held = Object.fromEntries(ACTIONS.map(a => [a, false]));
    this.pressed = new Set();
    this._counters = null;
    this._seq = null;
  }

  apply(packet) {
    if (this._seq !== null && !seqNewer(packet.seq, this._seq)) return; // stale or duplicate
    this._seq = packet.seq;
    this.held = packet.held;
    if (this._counters) {
      for (const a of EDGE_ACTIONS) {
        if (((packet.counters[a] - this._counters[a]) & 0x0f) !== 0) this.pressed.add(a);
      }
    }
    this._counters = packet.counters;
  }

  isHeld(action) { return !!this.held[action]; }
  isPressed(action) { return this.pressed.has(action); }
  endFrame() { this.pressed.clear(); }

  reset() {
    for (const a of ACTIONS) this.held[a] = false;
    this.pressed.clear();
    this._counters = null;
    this._seq = null;
  }
}

export class NetInputRouter {
  /**
   * @param {object} args
   * @param {import('../input.js').InputSystem} args.local
   * @param {RemoteInput} args.remote
   * @param {'p1'|'p2'} args.localSide  which fighter the local keyboard drives
   */
  constructor({ local, remote, localSide }) {
    this.local = local;
    this.remote = remote;
    this.localSide = localSide;
  }

  onAnyKey(cb) { this.local.onAnyKey(cb); }
  getMap(side) { return this.local.getMap(side); }

  endFrame() {
    this.local.endFrame();
    this.remote.endFrame();
  }

  isHeld(side, action) {
    return side === this.localSide ? this.local.isHeldAny(action) : this.remote.isHeld(action);
  }
  isPressed(side, action) {
    return side === this.localSide ? this.local.isPressedAny(action) : this.remote.isPressed(action);
  }
}
