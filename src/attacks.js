// Attack definitions and lifecycle helpers.
//
// Each attack instance is created when a player triggers a move. It has:
//   - startup / active / recovery frames (60 fps)
//   - damage / hitstun / blockstun / knockback
//   - a hitbox spec (offset relative to the character, size) that is only
//     "live" during active frames.
//   - alreadyHit: Set<Character>  so a single attack cannot damage twice.
//
// Hitbox geometry is reported via getHitboxWorld(char): returns {center, radius}
// in world space, taking the character's facing into account.

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * @typedef {object} AttackDef
 * @property {string} name
 * @property {'punch'|'kick'|'special'} kind
 * @property {number} startup
 * @property {number} active
 * @property {number} recovery
 * @property {number} damage
 * @property {number} hitstun     frames the opponent is in hit state
 * @property {number} blockstun   frames the opponent is in block state if blocked
 * @property {number} knockback   horizontal knock velocity
 * @property {number} knockup     vertical knock velocity
 * @property {number} cooldown    additional cooldown after recovery
 * @property {(char) => {offsetX:number, offsetY:number, radius:number}} hitbox
 *      offset is relative to character (facing-aware multiplication happens later)
 */

/** Make the default attack lifecycle behavior. */
export function makeAttackInstance(def) {
  return {
    def,
    frame: 0,
    state: 'startup', // -> 'active' -> 'recovery' -> done
    alreadyHit: new Set(),
    done: false,
  };
}

/** Advance the attack one frame; returns 'active' state changes. */
export function tickAttack(att) {
  att.frame++;
  const { startup, active, recovery } = att.def;
  if (att.frame <= startup) att.state = 'startup';
  else if (att.frame <= startup + active) att.state = 'active';
  else if (att.frame <= startup + active + recovery) att.state = 'recovery';
  else att.done = true;
}

export function isActive(att) {
  return att && !att.done && att.state === 'active';
}

// ---------- Catalog ----------

export const ATTACKS = {
  punch: {
    name: 'punch',
    kind: 'punch',
    startup: 4,
    active: 4,
    recovery: 10,
    damage: 6,
    hitstun: 14,
    blockstun: 8,
    knockback: 3.0,
    knockup: 0.0,
    cooldown: 0,
    // hitbox spec is built dynamically in Character.getAttackHitbox()
  },
  kick: {
    name: 'kick',
    kind: 'kick',
    startup: 7,
    active: 5,
    recovery: 14,
    damage: 9,
    hitstun: 18,
    blockstun: 10,
    knockback: 5.0,
    knockup: 2.0,
    cooldown: 0,
  },

  // Per-character specials
  belly: {
    name: 'Coup de Bide',
    kind: 'special',
    startup: 12,
    active: 8,
    recovery: 22,
    damage: 18,
    hitstun: 28,
    blockstun: 14,
    knockback: 9.0,
    knockup: 3.0,
    cooldown: 30,
  },
  jumpkick: {
    name: 'Coup de Pied Sauté',
    kind: 'special',
    startup: 6,    // very fast launch
    active: 18,    // active across the whole arc
    recovery: 14,
    damage: 16,
    hitstun: 24,
    blockstun: 12,
    knockback: 7.0,
    knockup: 1.5,
    cooldown: 40,
  },
  nose: {
    name: 'Coup de Pif',
    kind: 'special',
    startup: 10,
    active: 6,
    recovery: 24,
    damage: 17,
    hitstun: 26,
    blockstun: 14,
    knockback: 8.0,
    knockup: 1.5,
    cooldown: 35,
  },
  rock: {
    name: 'Lancer de Caillou',
    kind: 'special',
    startup: 12,
    active: 4,        // launches projectile briefly
    recovery: 24,
    damage: 14,
    hitstun: 20,
    blockstun: 10,
    knockback: 6.0,
    knockup: 1.0,
    cooldown: 50,
  },
};
