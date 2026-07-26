// Game state machine and combat orchestration.
//
// States:
//   menu        - selecting characters; canvas paused
//   countdown   - "Prêt ?" then "COMBATTEZ !" then enters fight
//   fight       - normal play loop, timer counting down
//   ko          - one or both players reached 0 HP; freeze briefly; show result
//   roundEnd    - after KO message, return to menu after a delay

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Character } from './character.js';
import { Projectile } from './projectile.js';
import { isActive } from './attacks.js';
import { CHARACTERS, CHARACTER_IDS } from './characterData.js';
import { attackDefFromIndex, EVT_HIT, EVT_BLOCK } from './net/protocol.js';

const ROUND_SECONDS = 120;

export class Game {
  constructor({ scene, hud, input, camera }) {
    this.scene = scene;
    this.hud = hud;
    this.baseInput = input;
    this.input = input;
    this.camera = camera;
    this.state = 'menu';
    this.p1Choice = 'pat';
    this.p2Choice = 'bud';
    this.players = [];
    this.projectiles = [];
    this.debug = false;
    this.timer = ROUND_SECONDS;
    this._countdownT = 0;
    this._koTimer = 0;
    this._hitFreeze = 0;
    this._cameraShake = 0;

    // Netplay session (null = local couch play). See src/net/session.js.
    this.net = null;
    this._netProjectiles = new Map();

    // F1 toggles debug
    input.onAnyKey((code) => {
      if (code === 'F1') {
        this.debug = !this.debug;
        for (const p of this.players) p.setDebug(this.debug);
      }
    });
  }

  setupMenu() {
    this.hud.buildPortraits(CHARACTER_IDS.map(id => CHARACTERS[id]), (side, id) => {
      // Online: you may only pick your own fighter; spectators pick nothing.
      if (this.net && (this.net.spectator || side !== this.net.localSide)) return;
      if (side === 'p1') { this.p1Choice = id; this.hud.setActivePortrait('p1', id); }
      else { this.p2Choice = id; this.hud.setActivePortrait('p2', id); }
      if (this.net) this.net.sendSelect(side, id);
    });
    this.hud.setActivePortrait('p1', this.p1Choice);
    this.hud.setActivePortrait('p2', this.p2Choice);
    this.hud.onStart(() => this.startMatch());
    this.hud.showMenu(true);
  }

  startMatch() {
    // Only the host starts a round; guests and spectators just follow.
    if (this.net && this.net.role !== 'host') return;
    this._beginMatch(this.p1Choice, this.p2Choice);
    if (this.net) this.net.sendStart(this.p1Choice, this.p2Choice);
  }

  _beginMatch(p1Id, p2Id) {
    this.p1Choice = p1Id;
    this.p2Choice = p2Id;

    // Tear down previous players
    for (const p of this.players) p.dispose();
    this.players = [];
    for (const pr of this.projectiles) pr.dispose();
    this.projectiles = [];
    this._netProjectiles.clear();

    const p1 = new Character({
      scene: this.scene, config: CHARACTERS[p1Id],
      side: -1, playerSide: 'p1',
    });
    const p2 = new Character({
      scene: this.scene, config: CHARACTERS[p2Id],
      side: +1, playerSide: 'p2',
    });
    this.players = [p1, p2];

    this.hud.setNames(p1.config.name, p2.config.name);
    this.hud.setHP(1, 1);
    this.hud.showMenu(false);

    for (const p of this.players) p.setDebug(this.debug);

    this.timer = ROUND_SECONDS;
    this.state = 'countdown';
    this._countdownT = 0;
    this._hitFreeze = 0;
    this._cameraShake = 0;
    if (this.net) this.net.remoteInput.reset();
    this.hud.showMessage('PRÊT ?', 900);
  }

  endMatch() {
    this.state = 'menu';
    this.hud.showMenu(true);
    this.hud.clearMessage();
    if (this.net) {
      this.net.sendMenu();
      this.net.remoteInput.reset();
    }
  }

  /** Show a centered message and mirror it to the remote player (host only). */
  _msg(text, duration) {
    this.hud.showMessage(text, duration);
    if (this.net) this.net.sendMsg(text, duration);
  }
  _clearMsg() {
    this.hud.clearMessage();
    if (this.net) this.net.sendMsg(null, 0);
  }

  // ---------- Per-frame ----------

  /** Local play and the netplay host run the fixed-step simulation. */
  isSimulating() { return !this.net || this.net.role === 'host'; }

  update(dt) {
    if (this.net && this.net.role === 'guest') { this._guestStep(dt); return; }
    this._step(dt);
    if (this.net) this.net.afterHostTick();
  }

  _step(dt) {
    // Camera shake decay
    if (this._cameraShake > 0) this._cameraShake = Math.max(0, this._cameraShake - dt * 6);

    if (this.state === 'menu') {
      this.input.endFrame();
      return;
    }

    if (this.state === 'countdown') {
      this._countdownT += dt;
      if (this._countdownT < 1.0) {
        // "PRÊT ?" already shown
      } else if (this._countdownT < 1.05) {
        this._msg('COMBATTEZ !', 900);
      } else if (this._countdownT >= 1.8) {
        this.state = 'fight';
        this._clearMsg();
      }
      // While countdown, run minimal updates to position players (no input)
      for (const p of this.players) p.update(dt, this._otherOf(p), 0);
      this._resolvePlayerCollision();
      this._updateCamera(dt);
      this.input.endFrame();
      return;
    }

    if (this.state === 'fight') {
      // Hit freeze: skip world tick briefly for impact feel
      if (this._hitFreeze > 0) {
        this._hitFreeze -= dt;
        this._updateCamera(dt);
        this.input.endFrame();
        return;
      }

      // Timer
      this.timer -= dt;
      this.hud.setTimer(this.timer);

      // Player input + sim
      for (const p of this.players) p.applyInput(this.input);
      for (const p of this.players) p.update(dt, this._otherOf(p));
      this._resolvePlayerCollision();

      // Spawn rock projectiles when Nico's ability becomes active
      for (const p of this.players) {
        const spawn = p.pollProjectile();
        if (spawn) {
          this.projectiles.push(new Projectile(this.scene, {
            position: spawn.position, velocity: spawn.velocity,
            owner: p, attackDef: spawn.damage,
          }));
        }
      }

      // Update projectiles
      for (const pr of this.projectiles) pr.update(dt);

      // Hit detection: melee
      for (const attacker of this.players) {
        const a = attacker.currentAttack;
        if (!a || !isActive(a)) continue;
        const hb = attacker.getAttackHitboxWorld();
        if (!hb) continue;
        for (const target of this.players) {
          if (target === attacker) continue;
          if (a.alreadyHit.has(target)) continue;
          if (!target.isAlive()) continue;
          const hurt = target.getHurtboxWorld();
          const d = Vector3.Distance(hb.center, hurt.center);
          if (d <= hb.radius + hurt.radius) {
            a.alreadyHit.add(target);
            const kind = target.takeHit(a, attacker);
            this._onHit(attacker, target, kind);
          }
        }
      }

      // Hit detection: projectiles
      for (const pr of this.projectiles) {
        if (!pr.alive) continue;
        for (const target of this.players) {
          if (target === pr.owner) continue;
          if (pr.hitTargets.has(target)) continue;
          if (!target.isAlive()) continue;
          const hurt = target.getHurtboxWorld();
          if (Vector3.Distance(pr.position, hurt.center) <= pr.radius + hurt.radius) {
            pr.hitTargets.add(target);
            pr.alive = false; // single-hit
            const fake = { def: pr.attackDef, alreadyHit: pr.hitTargets };
            const kind = target.takeHit(fake, pr.owner);
            this._onHit(pr.owner, target, kind);
          }
        }
      }

      // Cull dead projectiles
      this.projectiles = this.projectiles.filter(p => {
        if (!p.alive) { p.dispose(); return false; }
        return true;
      });

      // HUD HP
      this.hud.setHP(this.players[0].hp / this.players[0].maxHp,
                     this.players[1].hp / this.players[1].maxHp);

      this._updateCamera(dt);

      // Check for KO / timeout
      const p1Alive = this.players[0].isAlive();
      const p2Alive = this.players[1].isAlive();
      if (!p1Alive || !p2Alive || this.timer <= 0) {
        this._enterKO();
      }

      this.input.endFrame();
      return;
    }

    if (this.state === 'ko') {
      this._koTimer -= dt;
      for (const p of this.players) p.update(dt, this._otherOf(p));
      for (const pr of this.projectiles) pr.update(dt);
      this._updateCamera(dt);
      if (this._koTimer <= 0) {
        this.endMatch();
      }
      this.input.endFrame();
      return;
    }
  }

  _enterKO() {
    this.state = 'ko';
    this._koTimer = 3.5;
    const p1 = this.players[0], p2 = this.players[1];
    // Freeze both players so the winner doesn't keep walking / attacking.
    // (The loser's KO topple animation is still driven by their 'ko' state
    // inside updateAnimation; zeroing velocity does not interfere with it.)
    for (const p of this.players) {
      p.velocity.x = 0;
      if (p.isAlive()) {
        p.state = 'idle';
        p.currentAttack = null;
        p.isBlocking = false;
      }
    }
    let msg;
    if (!p1.isAlive() && !p2.isAlive()) msg = 'ÉGALITÉ !';
    else if (!p1.isAlive()) msg = `${p2.config.name} GAGNE !`;
    else if (!p2.isAlive()) msg = `${p1.config.name} GAGNE !`;
    else if (this.timer <= 0) {
      if (p1.hp === p2.hp) msg = 'TEMPS ÉCOULÉ !\nÉGALITÉ !';
      else msg = `TEMPS ÉCOULÉ !\n${(p1.hp > p2.hp ? p1 : p2).config.name} GAGNE !`;
    }
    this._msg(msg, 3300);
    this._cameraShake = 1.0;
  }

  _onHit(attacker, target, kind) {
    if (this.net) this.net.noteEvent(kind);
    if (kind === 'hit') {
      this._hitFreeze = 0.06;
      this._cameraShake = 0.7;
      // small attacker recoil
      attacker.velocity.x -= attacker.facing * 0.4;
    } else if (kind === 'block') {
      this._hitFreeze = 0.03;
    }
  }

  _otherOf(p) {
    return this.players[0] === p ? this.players[1] : this.players[0];
  }

  // ---------- Netplay ----------

  /** Take over input + simulation ownership from a connected NetSession. */
  attachNet(session) {
    this.net = session;
    this.input = session.router;
    this.hud.setOnlineRole(session.spectator ? 'spectator' : session.localSide);
  }

  /** Go back to plain couch play. */
  detachNet() {
    if (this.net) this.net.dispose();
    this.net = null;
    this.input = this.baseInput;
    this.hud.setOnlineRole(null);
    this.hud.setNetStatus('');
  }

  netOnRemoteSelect(side, id) {
    if (side === 'p1') this.p1Choice = id; else this.p2Choice = id;
    this.hud.setActivePortrait(side, id);
  }

  netOnStart(p1Id, p2Id) { this._beginMatch(p1Id, p2Id); }

  netOnMenu() {
    this.state = 'menu';
    this.hud.showMenu(true);
    this.hud.clearMessage();
    // Stop replaying the last frame of the finished round.
    if (this.net) this.net.latestSnapshot = null;
  }

  /**
   * Guest frame: no simulation at all. We ship our keystrokes to the host and
   * replay the authoritative snapshot it sends back, smoothing positions so
   * network jitter does not show up as stutter.
   */
  _guestStep(dt) {
    if (this._cameraShake > 0) this._cameraShake = Math.max(0, this._cameraShake - dt * 6);
    this.net.guestFrame(dt);

    const snap = this.net.latestSnapshot;
    if (snap && this.players.length === 2) {
      this._applySnapshot(snap, dt, this.net.consumeNewSnapshot());
      this._updateCamera(dt);
    }
    this.input.endFrame();
  }

  _applySnapshot(snap, dt, isFresh) {
    this.state = snap.gameState;
    this.timer = snap.timer;
    this.hud.setTimer(snap.timer);

    if (isFresh && snap.events) {
      if (snap.events & EVT_HIT) this._cameraShake = 0.7;
      else if (snap.events & EVT_BLOCK) this._cameraShake = 0.25;
    }

    const smooth = Math.min(1, dt * 30);
    for (let i = 0; i < 2; i++) {
      const p = this.players[i];
      const s = snap.players[i];

      // Lerp small corrections, hard-snap teleports (round start, big knockback).
      const dx = s.x - p.root.position.x;
      const dy = s.y - p.root.position.y;
      if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) {
        p.root.position.x = s.x;
        p.root.position.y = s.y;
      } else {
        p.root.position.x += dx * smooth;
        p.root.position.y += dy * smooth;
      }

      if (p.facing !== s.facing) { p.facing = s.facing; p._applyFacing(); }
      p.state = s.state;
      p.frame = s.frame;
      p.hp = s.hp;
      p.hitstun = s.hitstun;
      p.grounded = s.grounded;
      p.isBlocking = s.blocking;

      if (s.attack) {
        const def = attackDefFromIndex(s.attack.index);
        if (!p.currentAttack || p.currentAttack.def !== def) {
          p.currentAttack = { def, frame: s.attack.frame, state: s.attack.phase, alreadyHit: new Set(), done: false };
        } else {
          p.currentAttack.frame = s.attack.frame;
          p.currentAttack.state = s.attack.phase;
        }
      } else {
        p.currentAttack = null;
      }

      p.updateAnimation();
    }

    this.hud.setHP(this.players[0].hp / this.players[0].maxHp,
                   this.players[1].hp / this.players[1].maxHp);

    this._syncNetProjectiles(snap.projectiles, dt);
  }

  /** Mirror the host's projectile list, creating/removing meshes by net id. */
  _syncNetProjectiles(list, dt) {
    const smooth = Math.min(1, dt * 30);
    const seen = new Set();
    for (const s of list) {
      seen.add(s.id);
      let pr = this._netProjectiles.get(s.id);
      if (!pr) {
        pr = new Projectile(this.scene, {
          position: new Vector3(s.x, s.y, 0),
          velocity: new Vector3(0, 0, 0),
          owner: null, attackDef: null,
        });
        pr.netId = s.id;
        this._netProjectiles.set(s.id, pr);
        this.projectiles.push(pr);
      }
      pr.position.x += (s.x - pr.position.x) * smooth;
      pr.position.y += (s.y - pr.position.y) * smooth;
      pr.mesh.position.copyFrom(pr.position);
      pr.mesh.rotation.x += dt * 8;
      pr.mesh.rotation.z += dt * 6;
    }
    if (this._netProjectiles.size === seen.size) return;
    let removed = false;
    for (const [id, pr] of this._netProjectiles) {
      if (!seen.has(id)) { pr.dispose(); this._netProjectiles.delete(id); removed = true; }
    }
    if (removed) this.projectiles = this.projectiles.filter(p => this._netProjectiles.has(p.netId));
  }

  /**
   * Resolve player-vs-player body collision on the X axis so the two
   * characters can't pass through each other. Called after each physics
   * step. KO'd players are exempt (they ragdoll freely).
   */
  _resolvePlayerCollision() {
    if (this.players.length !== 2) return;
    const [a, b] = this.players;
    if (a.state === 'ko' || b.state === 'ko') return;

    const halfA = a.config.bodyWidth * 0.55;
    const halfB = b.config.bodyWidth * 0.55;
    const minSep = halfA + halfB;
    const dx = b.root.position.x - a.root.position.x;
    const absDx = Math.abs(dx);
    if (absDx >= minSep) return;

    let sign = dx >= 0 ? 1 : -1;
    // Tiebreaker when exactly overlapped: respect original sides (P1 left, P2 right)
    if (absDx < 1e-4) sign = 1;
    const overlap = minSep - absDx;
    a.root.position.x -= (overlap / 2) * sign;
    b.root.position.x += (overlap / 2) * sign;

    // Clamp to stage bounds; if one is at a wall, push the other away by the
    // unabsorbed slack so the constraint stays satisfied.
    const HW = 7.5;
    const aClampedX = Math.max(-HW, Math.min(HW, a.root.position.x));
    const bClampedX = Math.max(-HW, Math.min(HW, b.root.position.x));
    const aSlack = aClampedX - a.root.position.x;
    const bSlack = bClampedX - b.root.position.x;
    a.root.position.x = aClampedX;
    b.root.position.x = bClampedX;
    if (aSlack !== 0) b.root.position.x -= aSlack;
    if (bSlack !== 0) a.root.position.x -= bSlack;
    a.root.position.x = Math.max(-HW, Math.min(HW, a.root.position.x));
    b.root.position.x = Math.max(-HW, Math.min(HW, b.root.position.x));

    // Cancel any inward velocity so they don't keep pushing into each other
    if (a.velocity.x * sign > 0) a.velocity.x = 0;
    if (b.velocity.x * -sign > 0) b.velocity.x = 0;
  }

  _updateCamera(dt) {
    if (this.players.length !== 2) return;
    const a = this.players[0].root.position;
    const b = this.players[1].root.position;
    const mid = new Vector3((a.x + b.x) / 2, 1.6, 0);
    const dist = Math.abs(a.x - b.x);
    // Zoom out as distance grows. Camera sits on -z side now (see main.js).
    const targetZ = -(7.5 + dist * 0.45);
    this.camera.target.x += (mid.x - this.camera.target.x) * Math.min(1, dt * 6);
    this.camera.target.y += (mid.y - this.camera.target.y) * Math.min(1, dt * 4);
    this.camera.position.x += (mid.x - this.camera.position.x) * Math.min(1, dt * 6);
    this.camera.position.y += (3.0 - this.camera.position.y) * Math.min(1, dt * 4);
    this.camera.position.z += (targetZ - this.camera.position.z) * Math.min(1, dt * 4);

    if (this._cameraShake > 0) {
      const s = this._cameraShake * 0.4;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }
  }
}
