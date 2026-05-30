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

const ROUND_SECONDS = 120;

export class Game {
  constructor({ scene, hud, input, camera }) {
    this.scene = scene;
    this.hud = hud;
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
      if (side === 'p1') { this.p1Choice = id; this.hud.setActivePortrait('p1', id); }
      else { this.p2Choice = id; this.hud.setActivePortrait('p2', id); }
    });
    this.hud.setActivePortrait('p1', this.p1Choice);
    this.hud.setActivePortrait('p2', this.p2Choice);
    this.hud.onStart(() => this.startMatch());
    this.hud.showMenu(true);
  }

  startMatch() {
    // Tear down previous players
    for (const p of this.players) p.dispose();
    this.players = [];
    for (const pr of this.projectiles) pr.dispose();
    this.projectiles = [];

    const p1 = new Character({
      scene: this.scene, config: CHARACTERS[this.p1Choice],
      side: -1, playerSide: 'p1',
    });
    const p2 = new Character({
      scene: this.scene, config: CHARACTERS[this.p2Choice],
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
    this.hud.showMessage('PRÊT ?', 900);
  }

  endMatch() {
    this.state = 'menu';
    this.hud.showMenu(true);
    this.hud.clearMessage();
  }

  // ---------- Per-frame ----------

  update(dt) {
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
        this.hud.showMessage('COMBATTEZ !', 900);
      } else if (this._countdownT >= 1.8) {
        this.state = 'fight';
        this.hud.clearMessage();
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
    this.hud.showMessage(msg, 3300);
    this._cameraShake = 1.0;
  }

  _onHit(attacker, target, kind) {
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
