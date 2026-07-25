// Binary wire format for the realtime channel.
//
// Two packet kinds travel over the unreliable channel at 60 Hz:
//
//   INPUT     guest -> host   7 bytes   what the remote player is holding
//   SNAPSHOT  host  -> guest  ~48 B     authoritative world state
//
// The host owns the simulation; the guest only replicates what it receives, so
// the two machines never have to agree on floating point results.

import { ATTACKS } from '../attacks.js';

export const PKT_INPUT = 1;
export const PKT_SNAPSHOT = 2;

export const ACTIONS = ['left', 'right', 'jump', 'block', 'punch', 'kick', 'special'];
/** Actions consumed as edges (isPressed) rather than levels (isHeld). */
export const EDGE_ACTIONS = ['jump', 'punch', 'kick', 'special'];

export const CHAR_STATES = ['idle', 'walk', 'jump', 'attack', 'hit', 'block', 'ko'];
export const GAME_STATES = ['menu', 'countdown', 'fight', 'ko'];
export const ATTACK_PHASES = ['startup', 'active', 'recovery'];
export const ATTACK_KEYS = ['punch', 'kick', 'belly', 'jumpkick', 'nose', 'rock'];

export const NO_ATTACK = 255;

export const EVT_HIT = 1;
export const EVT_BLOCK = 2;

const DEF_TO_INDEX = new Map(ATTACK_KEYS.map((key, i) => [ATTACKS[key], i]));

export function attackIndex(def) {
  const i = DEF_TO_INDEX.get(def);
  return i === undefined ? NO_ATTACK : i;
}
export function attackDefFromIndex(i) {
  return i === NO_ATTACK ? null : (ATTACKS[ATTACK_KEYS[i]] || null);
}

function indexOfOr0(list, value) {
  const i = list.indexOf(value);
  return i < 0 ? 0 : i;
}

// ---------- INPUT ----------

const INPUT_BYTES = 6;

/**
 * @param {number} seq        wrapping 16-bit sequence number
 * @param {object} held       {left, right, jump, block, punch, kick, special} booleans
 * @param {object} counters   per EDGE_ACTION 4-bit wrapping press counters
 */
export function encodeInput(seq, held, counters) {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, PKT_INPUT);
  v.setUint16(1, seq & 0xffff);
  let bits = 0;
  for (let i = 0; i < ACTIONS.length; i++) if (held[ACTIONS[i]]) bits |= 1 << i;
  v.setUint8(3, bits);
  let packed = 0;
  for (let i = 0; i < EDGE_ACTIONS.length; i++) {
    packed |= (counters[EDGE_ACTIONS[i]] & 0x0f) << (i * 4);
  }
  v.setUint16(4, packed);
  return buf;
}

export function decodeInput(buffer) {
  const v = new DataView(buffer);
  const seq = v.getUint16(1);
  const bits = v.getUint8(3);
  const packed = v.getUint16(4);
  const held = {};
  for (let i = 0; i < ACTIONS.length; i++) held[ACTIONS[i]] = (bits & (1 << i)) !== 0;
  const counters = {};
  for (let i = 0; i < EDGE_ACTIONS.length; i++) {
    counters[EDGE_ACTIONS[i]] = (packed >> (i * 4)) & 0x0f;
  }
  return { seq, held, counters };
}

// ---------- SNAPSHOT ----------

const SNAP_HEADER_BYTES = 11;
const SNAP_PLAYER_BYTES = 18;
const SNAP_PROJ_BYTES = 10;

const F_FACING_POS = 1 << 0;
const F_GROUNDED = 1 << 1;
const F_BLOCKING = 1 << 2;

/**
 * @param {object} s
 *   {seq, gameState, timer, events, players:[{x,y,frame,state,facing,grounded,
 *    blocking,hp,hitstun,attack:{index,frame,phase}|null}], projectiles:[{id,x,y}]}
 */
export function encodeSnapshot(s) {
  const projCount = Math.min(255, s.projectiles.length);
  const size = SNAP_HEADER_BYTES + 2 * SNAP_PLAYER_BYTES + 1 + projCount * SNAP_PROJ_BYTES;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);

  v.setUint8(0, PKT_SNAPSHOT);
  v.setUint32(1, s.seq >>> 0);
  v.setUint8(5, indexOfOr0(GAME_STATES, s.gameState));
  v.setFloat32(6, s.timer);
  v.setUint8(10, s.events & 0xff);

  let o = SNAP_HEADER_BYTES;
  for (let i = 0; i < 2; i++) {
    const p = s.players[i];
    v.setFloat32(o + 0, p.x);
    v.setFloat32(o + 4, p.y);
    v.setUint16(o + 8, Math.min(65535, p.frame));
    v.setUint8(o + 10, indexOfOr0(CHAR_STATES, p.state));
    let flags = 0;
    if (p.facing > 0) flags |= F_FACING_POS;
    if (p.grounded) flags |= F_GROUNDED;
    if (p.blocking) flags |= F_BLOCKING;
    v.setUint8(o + 11, flags);
    v.setUint8(o + 12, Math.max(0, Math.min(255, p.hp)));
    v.setUint8(o + 13, Math.max(0, Math.min(255, p.hitstun)));
    v.setUint8(o + 14, p.attack ? p.attack.index : NO_ATTACK);
    v.setUint8(o + 15, p.attack ? Math.min(255, p.attack.frame) : 0);
    v.setUint8(o + 16, p.attack ? indexOfOr0(ATTACK_PHASES, p.attack.phase) : 0);
    v.setUint8(o + 17, 0);
    o += SNAP_PLAYER_BYTES;
  }

  v.setUint8(o, projCount);
  o += 1;
  for (let i = 0; i < projCount; i++) {
    const pr = s.projectiles[i];
    v.setUint16(o + 0, pr.id & 0xffff);
    v.setFloat32(o + 2, pr.x);
    v.setFloat32(o + 6, pr.y);
    o += SNAP_PROJ_BYTES;
  }
  return buf;
}

export function decodeSnapshot(buffer) {
  const v = new DataView(buffer);
  const snap = {
    seq: v.getUint32(1),
    gameState: GAME_STATES[v.getUint8(5)] || 'fight',
    timer: v.getFloat32(6),
    events: v.getUint8(10),
    players: [],
    projectiles: [],
  };

  let o = SNAP_HEADER_BYTES;
  for (let i = 0; i < 2; i++) {
    const flags = v.getUint8(o + 11);
    const attackIdx = v.getUint8(o + 14);
    snap.players.push({
      x: v.getFloat32(o + 0),
      y: v.getFloat32(o + 4),
      frame: v.getUint16(o + 8),
      state: CHAR_STATES[v.getUint8(o + 10)] || 'idle',
      facing: (flags & F_FACING_POS) ? 1 : -1,
      grounded: (flags & F_GROUNDED) !== 0,
      blocking: (flags & F_BLOCKING) !== 0,
      hp: v.getUint8(o + 12),
      hitstun: v.getUint8(o + 13),
      attack: attackIdx === NO_ATTACK ? null : {
        index: attackIdx,
        frame: v.getUint8(o + 15),
        phase: ATTACK_PHASES[v.getUint8(o + 16)] || 'startup',
      },
    });
    o += SNAP_PLAYER_BYTES;
  }

  const projCount = v.getUint8(o);
  o += 1;
  for (let i = 0; i < projCount; i++) {
    snap.projectiles.push({
      id: v.getUint16(o + 0),
      x: v.getFloat32(o + 2),
      y: v.getFloat32(o + 6),
    });
    o += SNAP_PROJ_BYTES;
  }
  return snap;
}

/** True when `a` is newer than `b` for 16-bit wrapping sequence numbers. */
export function seqNewer(a, b) {
  return ((a - b) & 0xffff) < 0x8000 && a !== b;
}
