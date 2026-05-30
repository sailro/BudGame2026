// Character.js — procedurally builds a Mario-family style character from
// primitives, and provides animation methods and combat state.
//
// Coordinate convention (LOCAL space of the character root):
//   +x = forward (the direction the character looks)
//   +y = up
//   +z = character's left side
// The character's `facing` (+1 = looking world +x, -1 = looking world -x) is
// applied by rotating the root TransformNode around Y. All local offsets and
// animations stay the same regardless of facing.

import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scalar } from '@babylonjs/core/Maths/math.scalar.js';

import { ATTACKS, makeAttackInstance, tickAttack, isActive } from './attacks.js';

const GRAVITY = -28;
const GROUND_Y = 0;
const STAGE_HALF_WIDTH = 7.5;

function colorFromHex(hex) { return Color3.FromHexString(hex); }

function makeMat(scene, name, hex, opts = {}) {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = colorFromHex(hex);
  m.specularColor = new Color3(0.15, 0.15, 0.15);
  if (opts.emissive) m.emissiveColor = opts.emissive;
  return m;
}

export class Character {
  /**
   * @param {object} args
   * @param {import('@babylonjs/core/scene.js').Scene} args.scene
   * @param {object} args.config  one of CHARACTERS[*]
   * @param {-1|1} args.side  -1 = left player, +1 = right player
   * @param {string} args.playerSide  'p1' or 'p2'
   */
  constructor({ scene, config, side, playerSide }) {
    this.scene = scene;
    this.config = config;
    this.side = side;
    this.playerSide = playerSide;

    this.maxHp = 100;
    this.hp = this.maxHp;
    this.facing = -side;            // start facing center
    this.velocity = new Vector3(0, 0, 0);
    this.grounded = true;
    this.state = 'idle';            // idle | walk | jump | attack | hit | block | ko
    this.frame = 0;                 // for animations
    this.hitstun = 0;
    this.blockstun = 0;
    this.cooldown = 0;
    this.isBlocking = false;
    this.currentAttack = null;
    this.queuedProjectiles = [];    // game pulls these each frame

    this._buildRig();
    this.root.position.x = side * 4.0;
    this._applyFacing(true);
  }

  // ---------- Rig construction ----------
  _buildRig() {
    const scene = this.scene;
    const cfg = this.config;
    const id = cfg.id;

    // Materials
    const mShirt = makeMat(scene, `${id}_shirt`, cfg.shirt);
    const mCap = makeMat(scene, `${id}_cap`, cfg.cap);
    const mOver = makeMat(scene, `${id}_over`, cfg.overalls);
    const mAcc = makeMat(scene, `${id}_acc`, cfg.overallsAccent);
    const mShoe = makeMat(scene, `${id}_shoe`, cfg.shoes);
    const mGlove = makeMat(scene, `${id}_glove`, cfg.gloves);
    const mSkin = makeMat(scene, `${id}_skin`, cfg.skin);
    const mMust = makeMat(scene, `${id}_must`, cfg.mustacheColor);
    const mNose = makeMat(scene, `${id}_nose`, cfg.noseColor);

    this.materials = { mShirt, mCap, mOver, mShoe, mGlove, mSkin, mMust, mNose, mAcc };

    // Root - position controls world position, no rotation here
    this.root = new TransformNode(`${id}_root`, scene);

    // BodyOffset - holds the visible offset from ground (root.y stays at GROUND_Y)
    this.bodyOffset = new TransformNode(`${id}_bodyOff`, scene);
    this.bodyOffset.parent = this.root;

    // FacingPivot - rotated around Y to flip facing direction (180° when facing -x in world)
    this.facingPivot = new TransformNode(`${id}_facing`, scene);
    this.facingPivot.parent = this.bodyOffset;

    // --- Legs ---
    const legY = cfg.legLength;
    // Pelvis sits at top of legs
    this.pelvis = new TransformNode(`${id}_pelvis`, scene);
    this.pelvis.parent = this.facingPivot;
    this.pelvis.position.y = legY;

    // Hip pivots (rotated to kick); legs extend down from pivot
    const makeLeg = (zSign, name) => {
      const pivot = new TransformNode(`${id}_${name}HipPivot`, scene);
      pivot.parent = this.pelvis;
      pivot.position.set(0, 0, zSign * cfg.legSpread);

      const leg = MeshBuilder.CreateCylinder(`${id}_${name}Leg`,
        { diameter: cfg.legRadius * 2, height: cfg.legLength, tessellation: 12 }, scene);
      leg.material = mOver;
      leg.parent = pivot;
      // Cylinder's center is at y=0; place its top at the pivot (so it extends down)
      leg.position.y = -cfg.legLength / 2;

      const foot = MeshBuilder.CreateBox(`${id}_${name}Foot`,
        { width: cfg.legRadius * 2.4, height: cfg.legRadius * 0.8, depth: cfg.legRadius * 3.6 }, scene);
      foot.material = mShoe;
      foot.parent = pivot;
      foot.position.set(cfg.legRadius * 0.6, -cfg.legLength + cfg.legRadius * 0.3, zSign * 0);

      return { pivot, leg, foot };
    };
    this.leftLeg = makeLeg(+1, 'L');
    this.rightLeg = makeLeg(-1, 'R');

    // --- Torso ---
    this.torsoGroup = new TransformNode(`${id}_torsoGroup`, scene);
    this.torsoGroup.parent = this.pelvis;
    this.torsoGroup.position.y = cfg.bodyHeight / 2;

    // Torso shape: capsule-ish - use a sphere scaled
    const torso = MeshBuilder.CreateSphere(`${id}_torso`,
      { diameter: 1, segments: 16 }, scene);
    torso.material = mShirt;
    torso.parent = this.torsoGroup;
    torso.scaling.set(cfg.bodyWidth, cfg.bodyHeight * 1.05, cfg.bodyDepth);
    this.torsoMesh = torso;

    // (Overalls bib, shoulder straps, and front button removed - they were
    // reading as ugly "bars" sticking off the front of the torso.)

    // --- Belly (separate mesh so it can scale for Pat's special) ---
    this.bellyPivot = new TransformNode(`${id}_bellyPivot`, scene);
    this.bellyPivot.parent = this.torsoGroup;
    this.bellyPivot.position.set(cfg.bellyForward, -cfg.bodyHeight * 0.05, 0);
    const belly = MeshBuilder.CreateSphere(`${id}_belly`,
      { diameter: cfg.bellyRadius * 2, segments: 16 }, scene);
    belly.material = mOver;
    belly.parent = this.bellyPivot;
    this.bellyMesh = belly;
    this.bellyBaseScale = 1.0;

    // --- Arms (rotated at shoulder) ---
    const shoulderY = cfg.bodyHeight * 0.42;
    const shoulderZSpread = cfg.bodyWidth * 0.55 + cfg.armRadius;

    const makeArm = (zSign, name) => {
      const pivot = new TransformNode(`${id}_${name}ShoulderPivot`, scene);
      pivot.parent = this.torsoGroup;
      pivot.position.set(0, shoulderY, zSign * shoulderZSpread);

      const arm = MeshBuilder.CreateCylinder(`${id}_${name}Arm`,
        { diameter: cfg.armRadius * 2, height: cfg.armLength, tessellation: 10 }, scene);
      arm.material = mShirt;
      arm.parent = pivot;
      arm.position.y = -cfg.armLength / 2;

      const hand = MeshBuilder.CreateSphere(`${id}_${name}Hand`,
        { diameter: cfg.armRadius * 2.4, segments: 10 }, scene);
      hand.material = mGlove;
      hand.parent = pivot;
      hand.position.y = -cfg.armLength + cfg.armRadius * 0.4;

      return { pivot, arm, hand };
    };
    this.leftArm = makeArm(+1, 'L');
    this.rightArm = makeArm(-1, 'R');

    // --- Head ---
    this.neck = new TransformNode(`${id}_neck`, scene);
    this.neck.parent = this.torsoGroup;
    this.neck.position.y = cfg.bodyHeight * 0.5 + cfg.headRadius * 0.55;

    // headFacing - a child of neck that we counter-rotate each frame so the
    // baked face (at U=0.5 of the sphere texture) always faces the camera,
    // regardless of which side the character is currently facing. The cap
    // remains parented to `neck` directly so its brim continues to point in
    // the character's actual facing direction.
    this.headFacing = new TransformNode(`${id}_headFacing`, scene);
    this.headFacing.parent = this.neck;

    const head = MeshBuilder.CreateSphere(`${id}_head`,
      { diameter: cfg.headRadius * 2, segments: 24 }, scene);
    head.parent = this.headFacing;
    const headMat = new StandardMaterial(`${id}_headMat`, scene);
    // invertY=false so PNG row 0 (forehead/top of face) maps to BabylonJS
    // sphere V=0 which is the top pole on a default CreateSphere. Otherwise
    // the face appears upside-down.
    const headTex = new Texture(cfg.headPath, scene, false, false,
      Texture.TRILINEAR_SAMPLINGMODE);
    headTex.wrapU = Texture.CLAMP_ADDRESSMODE;
    headTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    headMat.diffuseTexture = headTex;
    headMat.specularColor = new Color3(0.08, 0.08, 0.08);
    headMat.emissiveColor = new Color3(0.30, 0.30, 0.30);
    head.material = headMat;
    // With clamp + counter-rotation, U=0.5 on the texture maps to the side of
    // the sphere we'll keep aimed at the camera (+z by default for a non-
    // rotated sphere); no rotation needed here.
    this.headMesh = head;

    // Hair (only for Pat who has hair - others bald-ish) — using mustache color as a thin cap
    // Skip detailed hair; the cap covers the top.

    // --- Cap removed: the face fills the whole head now, no hat. ---
    // (Previously: this._buildCap(mCap, mAcc))

    // (Face plane removed - face is now baked into the head sphere texture.)

    // --- Mustache (small horizontal box under nose) ---
    const must = MeshBuilder.CreateBox(`${id}_mustache`,
      { width: cfg.headRadius * 0.05, height: cfg.headRadius * 0.18, depth: cfg.headRadius * 1.05 }, scene);
    must.material = mMust;
    must.parent = this.neck;
    must.position.set(cfg.headRadius * 0.78, -cfg.headRadius * 0.18, 0);
    // Hide mustache because the face photo already has it - keep but very subtle
    must.isVisible = false;

    // --- Nose (sphere; scaled along x for Seb special; long pointy for Nico inherently) ---
    this.nosePivot = new TransformNode(`${id}_nosePivot`, scene);
    this.nosePivot.parent = this.neck;
    this.nosePivot.position.set(cfg.headRadius * 0.95, 0, 0);
    const nose = MeshBuilder.CreateSphere(`${id}_nose`,
      { diameter: cfg.noseSize * 2, segments: 12 }, scene);
    nose.material = mNose;
    nose.parent = this.nosePivot;
    // Use scaling.x to express "nose length" so we can elongate by tweaking scaling.x
    nose.scaling.x = Math.max(0.5, cfg.noseLength / cfg.noseSize);
    nose.position.x = cfg.noseSize * 0.5;
    this.noseMesh = nose;
    this.noseBaseScaleX = nose.scaling.x;
    // The face sticker covers the front of the head, so hide the 3D nose to
    // avoid clipping with the photo. We reveal it only during Seb's special
    // (see updateAnimation()), or whenever we want a 3D effect.
    nose.isVisible = false;

    // --- Hitbox spheres (debug helpers) ---
    this._buildDebugHitboxes();

    // Save base rotations / positions for animation reset
    this._saveBasePose();
  }

  _buildCap(mCap, mAcc) {
    const scene = this.scene;
    const cfg = this.config;
    const id = cfg.id;

    // Cap dome - a small squashed sphere ON TOP of the head, not covering the face
    const dome = MeshBuilder.CreateSphere(`${id}_capDome`,
      { diameter: cfg.headRadius * 1.95, segments: 20 }, scene);
    dome.material = mCap;
    dome.parent = this.neck;
    dome.position.y = cfg.headRadius * 0.55;
    dome.scaling.y = 0.55;          // squash vertically
    dome.scaling.x = 1.02;
    dome.scaling.z = 1.02;

    // Cap brim - flat horizontal disc that sticks out forward from the cap base
    const brim = MeshBuilder.CreateCylinder(`${id}_capBrim`,
      { diameter: cfg.headRadius * 1.4, height: 0.05, tessellation: 24 }, scene);
    brim.material = mCap;
    brim.parent = this.neck;
    brim.position.set(cfg.headRadius * 0.95, cfg.headRadius * 0.35, 0);
    // Slight downward tilt so the brim shades the eyes
    brim.rotation.z = 0.15;

    // Cap medallion: a white roundel on the front of the cap
    const medal = MeshBuilder.CreateDisc(`${id}_capMedal`,
      { radius: cfg.headRadius * 0.30, tessellation: 24 }, scene);
    const medalMat = makeMat(scene, `${id}_medalMat`, '#ffffff');
    medalMat.emissiveColor = new Color3(0.5, 0.5, 0.5);
    medal.material = medalMat;
    medal.parent = this.neck;
    medal.position.set(cfg.headRadius * 0.78, cfg.headRadius * 0.75, 0);
    medal.rotation.y = -Math.PI / 2; // face forward (+x)
  }

  _buildFacePlane() {
    const scene = this.scene;
    const cfg = this.config;
    const id = cfg.id;

    const size = cfg.headRadius * 2.05;
    const plane = MeshBuilder.CreatePlane(`${id}_face`, { size }, scene);
    plane.parent = this.neck;
    // Slight forward offset; the billboard mode handles rotation so it always
    // faces the camera (Y-axis billboard keeps the face upright).
    plane.position.set(0, 0, 0);
    plane.billboardMode = Mesh.BILLBOARDMODE_Y;

    const mat = new StandardMaterial(`${id}_faceMat`, scene);
    mat.diffuseTexture = new Texture(cfg.facePath, scene, false, true,
      Texture.TRILINEAR_SAMPLINGMODE);
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.emissiveColor = new Color3(0.65, 0.65, 0.65);
    mat.backFaceCulling = false;
    mat.disableDepthWrite = false;
    plane.material = mat;
    plane.hasVertexAlpha = true;
    // Render on top of head sphere to avoid z-fighting
    plane.renderingGroupId = 1;
    this.faceMesh = plane;
  }

  _buildDebugHitboxes() {
    const scene = this.scene;
    const id = this.config.id;
    // Hurtbox (defender hit sphere) - around the torso
    const hurt = MeshBuilder.CreateSphere(`${id}_hurtbox`, { diameter: 1, segments: 8 }, scene);
    hurt.parent = this.torsoGroup;
    hurt.scaling.set(this.config.bodyWidth * 1.15, this.config.bodyHeight * 1.05, this.config.bodyDepth * 1.15);
    const hm = new StandardMaterial(`${id}_hurtmat`, scene);
    hm.diffuseColor = new Color3(0, 0.7, 0);
    hm.alpha = 0.25;
    hm.wireframe = true;
    hurt.material = hm;
    hurt.isVisible = false;
    this.hurtboxMesh = hurt;

    // Hitbox (attacker active sphere) - reused for any attack
    const hit = MeshBuilder.CreateSphere(`${id}_hitbox`, { diameter: 1, segments: 8 }, scene);
    hit.parent = this.facingPivot;
    const hitMat = new StandardMaterial(`${id}_hitmat`, scene);
    hitMat.diffuseColor = new Color3(1, 0.1, 0.1);
    hitMat.alpha = 0.3;
    hitMat.wireframe = true;
    hit.material = hitMat;
    hit.isVisible = false;
    this.hitboxMesh = hit;
  }

  _saveBasePose() {
    this.basePose = {
      leftHipRot: this.leftLeg.pivot.rotation.clone(),
      rightHipRot: this.rightLeg.pivot.rotation.clone(),
      leftShoulderRot: this.leftArm.pivot.rotation.clone(),
      rightShoulderRot: this.rightArm.pivot.rotation.clone(),
      torsoRot: this.torsoGroup.rotation.clone(),
      neckRot: this.neck.rotation.clone(),
      bellyScale: this.bellyMesh.scaling.clone(),
      noseScaleX: this.noseMesh.scaling.x,
      noseBasePosX: this.noseMesh.position.x,
      bodyOffsetY: 0,
    };
  }

  _resetPose() {
    const b = this.basePose;
    this.leftLeg.pivot.rotation.copyFrom(b.leftHipRot);
    this.rightLeg.pivot.rotation.copyFrom(b.rightHipRot);
    this.leftArm.pivot.rotation.copyFrom(b.leftShoulderRot);
    this.rightArm.pivot.rotation.copyFrom(b.rightShoulderRot);
    this.torsoGroup.rotation.copyFrom(b.torsoRot);
    this.neck.rotation.copyFrom(b.neckRot);
    this.bellyMesh.scaling.copyFrom(b.bellyScale);
    this.noseMesh.scaling.x = b.noseScaleX;
    this.noseMesh.position.x = b.noseBasePosX;
    this.noseMesh.isVisible = false;
  }

  // ---------- High-level API ----------

  setDebug(visible) {
    this.hurtboxMesh.isVisible = visible;
    // hitbox visibility is also gated by active state in updateAnimation
    this._debug = visible;
  }

  isAlive() { return this.hp > 0 && this.state !== 'ko'; }
  isBusy() {
    return this.state === 'hit' || this.state === 'ko' || this.currentAttack ||
           this.hitstun > 0 || this.blockstun > 0;
  }
  isAirborne() { return !this.grounded; }

  /** Apply input each frame. Disables input if busy/KO. */
  applyInput(input) {
    if (!this.isAlive()) return;
    const side = this.playerSide;

    if (this.hitstun > 0 || this.blockstun > 0) {
      // can hold block direction but no other input
      this.isBlocking = input.isHeld(side, 'block') && this.grounded;
      return;
    }

    if (this.currentAttack) return; // committed to an attack

    this.isBlocking = input.isHeld(side, 'block') && this.grounded;
    if (this.isBlocking) {
      this.velocity.x = 0;
      this.state = 'block';
      return;
    }

    // Movement
    let move = 0;
    if (input.isHeld(side, 'left')) move -= 1;
    if (input.isHeld(side, 'right')) move += 1;
    this.velocity.x = move * this.config.moveSpeed;
    if (this.grounded) this.state = move !== 0 ? 'walk' : 'idle';

    // Jump
    if (this.grounded && input.isPressed(side, 'jump')) {
      this.velocity.y = this.config.jumpPower;
      this.grounded = false;
      this.state = 'jump';
    }

    // Attacks
    if (this.cooldown <= 0) {
      if (input.isPressed(side, 'punch')) this.startAttack('punch');
      else if (input.isPressed(side, 'kick')) this.startAttack('kick');
      else if (input.isPressed(side, 'special')) this.startAttack(this.config.special);
    }
  }

  startAttack(name) {
    const def = ATTACKS[name];
    if (!def) return;
    this.currentAttack = makeAttackInstance(def);
    this.state = 'attack';
    this.frame = 0;

    // Jump kick: launch the character upward+forward immediately
    if (name === 'jumpkick' && this.grounded) {
      this.velocity.y = this.config.jumpPower * 0.95;
      this.velocity.x = this.facing * this.config.moveSpeed * 1.6;
      this.grounded = false;
    }
  }

  /**
   * Apply hit on this character.
   * @returns {'hit'|'block'} resolution kind
   */
  takeHit(att, attacker) {
    if (!this.isAlive()) return 'hit';
    // Block: facing the attacker AND blocking AND grounded AND not airborne attack escapes?
    const facingAttacker = Math.sign(attacker.root.position.x - this.root.position.x) === this.facing;
    const canBlock = this.isBlocking && facingAttacker && this.grounded;

    const dir = attacker.facing; // attacker pushes target in attacker's facing direction
    if (canBlock) {
      this.blockstun = att.def.blockstun;
      this.hp = Math.max(0, this.hp - Math.round(att.def.damage * 0.15));
      // Small push-back
      this.velocity.x = dir * att.def.knockback * 0.25;
      this.state = 'block';
      return 'block';
    }
    this.hp = Math.max(0, this.hp - att.def.damage);
    this.hitstun = att.def.hitstun;
    this.velocity.x = dir * att.def.knockback;
    this.velocity.y = att.def.knockup;
    this.grounded = false;
    this.state = this.hp <= 0 ? 'ko' : 'hit';
    if (this.hp <= 0) {
      // strong final knockback
      this.velocity.x = dir * Math.max(att.def.knockback, 6);
      this.velocity.y = Math.max(att.def.knockup, 4);
    }
    return 'hit';
  }

  // ---------- Per-frame update ----------

  update(dt, opponent, frame) {
    // Facing flip based on opponent
    if (opponent && this.grounded && this.isAlive() && this.state !== 'ko') {
      const desiredFacing = Math.sign(opponent.root.position.x - this.root.position.x);
      if (desiredFacing !== 0 && desiredFacing !== this.facing && !this.currentAttack) {
        this.facing = desiredFacing;
        this._applyFacing();
      }
    }

    // Timers
    if (this.hitstun > 0) this.hitstun--;
    if (this.blockstun > 0) this.blockstun--;
    if (this.cooldown > 0) this.cooldown--;
    this.frame++;

    // Physics
    if (!this.grounded) this.velocity.y += GRAVITY * dt;
    this.root.position.x += this.velocity.x * dt;
    this.root.position.y += this.velocity.y * dt;

    // Stage bounds
    if (this.root.position.x < -STAGE_HALF_WIDTH) {
      this.root.position.x = -STAGE_HALF_WIDTH;
      if (this.velocity.x < 0) this.velocity.x = 0;
    }
    if (this.root.position.x > STAGE_HALF_WIDTH) {
      this.root.position.x = STAGE_HALF_WIDTH;
      if (this.velocity.x > 0) this.velocity.x = 0;
    }
    if (this.root.position.y <= GROUND_Y) {
      this.root.position.y = GROUND_Y;
      if (this.velocity.y < 0) this.velocity.y = 0;
      if (!this.grounded) {
        this.grounded = true;
        if (this.state === 'jump' || this.state === 'attack' && !this.currentAttack) {
          this.state = 'idle';
        }
      }
    }

    // Horizontal friction when grounded and not actively moving
    if (this.grounded && !this.currentAttack && this.hitstun <= 0 && this.blockstun <= 0) {
      // velocity.x is set explicitly from input; nothing to do
    } else if (!this.grounded) {
      // mild air drag on x (so post-knockback character lands somewhat reasonably)
      this.velocity.x *= 0.995;
    } else if (this.hitstun > 0 || this.blockstun > 0) {
      this.velocity.x *= 0.85;
    }

    // Tick attack
    if (this.currentAttack) {
      tickAttack(this.currentAttack);
      if (this.currentAttack.done) {
        this.cooldown = this.currentAttack.def.cooldown || 0;
        this.currentAttack = null;
        if (this.grounded) this.state = 'idle';
      }
    }

    // KO landing
    if (this.state === 'ko' && this.grounded) {
      this.velocity.x *= 0.85;
    }

    // Animate
    this.updateAnimation();
  }

  _applyFacing(force = false) {
    // facing +1 means "looking +x in world", so facingPivot rotation = 0
    // facing -1 means looking -x, so facingPivot rotation = PI
    const target = this.facing === 1 ? 0 : Math.PI;
    this.facingPivot.rotation.y = target;
    // Counter-rotate the head sphere so the baked-in face (centered at U=0.5
    // on the spherical texture) always points toward the camera, which now
    // sits on -z. U=0.5 maps to -x on a default Babylon sphere; a world
    // rotation of -PI/2 around Y aligns -x to -z (toward the camera).
    if (this.headFacing) this.headFacing.rotation.y = -Math.PI / 2 - target;
  }

  // ---------- Animation ----------
  updateAnimation() {
    this._resetPose();
    const cfg = this.config;
    const t = this.frame / 60;

    // BodyOffset is purely cosmetic bobs; root.y handles real jump altitude.
    this.bodyOffset.position.y = 0;

    if (this.state === 'ko') {
      // Topple over (rotate facingPivot pitch-wise)
      const fall = Math.min(1, this.frame / 30);
      this.facingPivot.rotation.z = -Math.PI / 2 * fall * this.facing;
      // Once toppled, leave it
      return;
    }

    if (this.state === 'hit') {
      const lean = Math.min(1, this.hitstun / 14);
      this.torsoGroup.rotation.z = 0.6 * lean * (-this.facing);
      this.neck.rotation.z = 0.3 * lean * (-this.facing);
      return;
    }

    if (this.state === 'block') {
      // Crouch slightly, arms FORWARD like a guard (raised in front to shield).
      // +Math.PI/2 (~1.57) rotates the down-hanging arms forward (+x).
      this.leftArm.pivot.rotation.z = 1.5;
      this.rightArm.pivot.rotation.z = 1.5;
      this.leftArm.pivot.rotation.x = -0.6;
      this.rightArm.pivot.rotation.x = 0.6;
      this.torsoGroup.rotation.z = -0.2 * this.facing;
      this.bodyOffset.position.y = -0.05;
      return;
    }

    // Idle bob
    if (this.state === 'idle' && !this.currentAttack) {
      this.bodyOffset.position.y = Math.sin(t * 2.4) * 0.025;
      const sway = Math.sin(t * 2.4) * 0.06;
      this.leftArm.pivot.rotation.x = sway;
      this.rightArm.pivot.rotation.x = -sway;
    }

    // Walk
    if (this.state === 'walk' && !this.currentAttack) {
      const phase = Math.sin(t * 9);
      this.leftLeg.pivot.rotation.z = phase * 0.6;
      this.rightLeg.pivot.rotation.z = -phase * 0.6;
      this.leftArm.pivot.rotation.z = -phase * 0.6;
      this.rightArm.pivot.rotation.z = phase * 0.6;
      this.bodyOffset.position.y = Math.abs(Math.sin(t * 9)) * 0.05;
    }

    // Air pose
    if (!this.grounded && !this.currentAttack) {
      this.leftLeg.pivot.rotation.z = -0.4;
      this.rightLeg.pivot.rotation.z = 0.4;
      this.leftArm.pivot.rotation.z = -0.5;
      this.rightArm.pivot.rotation.z = 0.5;
    }

    // Attack-specific anims
    if (this.currentAttack) {
      const a = this.currentAttack;
      const p = a.frame / (a.def.startup + a.def.active + a.def.recovery);
      switch (a.def.name) {
        case 'punch': this._animPunch(a); break;
        case 'kick': this._animKick(a); break;
        case 'Coup de Bide': this._animBelly(a); break;
        case 'Coup de Pied Sauté': this._animJumpKick(a); break;
        case 'Coup de Pif': this._animNose(a); break;
        case 'Lancer de Caillou': this._animRock(a); break;
        default: break;
      }
    }

    // Sync hitbox debug visualization
    if (this._debug) {
      const live = this.currentAttack && isActive(this.currentAttack);
      this.hitboxMesh.isVisible = !!live;
      if (live) {
        const h = this.getAttackHitboxLocal();
        if (h) {
          this.hitboxMesh.position.set(h.x, h.y, h.z);
          this.hitboxMesh.scaling.setAll(h.r * 2);
        } else {
          this.hitboxMesh.isVisible = false;
        }
      }
    } else {
      this.hitboxMesh.isVisible = false;
    }
  }

  _animPunch(a) {
    // Right arm punches forward across startup+active, returns during recovery
    const total = a.def.startup + a.def.active;
    const totalAll = total + a.def.recovery;
    const t = a.frame <= total
      ? Scalar.Clamp(a.frame / total, 0, 1)
      : 1 - Scalar.Clamp((a.frame - total) / a.def.recovery, 0, 1);
    // Rotate arm pivot around Z so arm goes from "down" to "forward" (+x).
    // +Math.PI/2 rotates the down-hanging arm forward toward the opponent.
    this.rightArm.pivot.rotation.z = Scalar.Lerp(0, Math.PI / 2 + 0.2, t);
    // Slight torso twist for impact
    this.torsoGroup.rotation.y = Scalar.Lerp(0, -0.3, t);
  }
  _animKick(a) {
    const total = a.def.startup + a.def.active;
    const t = a.frame <= total
      ? Scalar.Clamp(a.frame / total, 0, 1)
      : 1 - Scalar.Clamp((a.frame - total) / a.def.recovery, 0, 1);
    // Right leg kicks forward (+x). +Math.PI/2 swings the leg up & forward.
    this.rightLeg.pivot.rotation.z = Scalar.Lerp(0, Math.PI / 2 + 0.1, t);
    // Lean back
    this.torsoGroup.rotation.z = Scalar.Lerp(0, 0.3, t);
    // Counter-balance arm (pulled back)
    this.leftArm.pivot.rotation.z = Scalar.Lerp(0, -1.3, t);
  }
  _animBelly(a) {
    // Belly grows dramatically forward + scale up; lean back then thrust
    const total = a.def.startup + a.def.active + a.def.recovery;
    const t = a.frame / total;
    // Use a triangle: ramp up to active peak, down through recovery
    const peak = (a.def.startup + a.def.active) / total;
    const k = a.frame <= a.def.startup + a.def.active
      ? Scalar.Clamp(a.frame / (a.def.startup + a.def.active), 0, 1)
      : 1 - Scalar.Clamp((a.frame - (a.def.startup + a.def.active)) / a.def.recovery, 0, 1);
    // belly scale: balloon outwards along x (forward)
    this.bellyMesh.scaling.x = 1 + k * 2.6;
    this.bellyMesh.scaling.y = 1 + k * 1.4;
    this.bellyMesh.scaling.z = 1 + k * 1.4;
    // Torso leans back to anchor the bash
    this.torsoGroup.rotation.z = Scalar.Lerp(0, -0.4, k);
    // Arms flare
    this.leftArm.pivot.rotation.z = Scalar.Lerp(0, -1.6, k);
    this.rightArm.pivot.rotation.z = Scalar.Lerp(0, -1.6, k);
    this.leftArm.pivot.rotation.x = Scalar.Lerp(0, 0.8, k);
    this.rightArm.pivot.rotation.x = Scalar.Lerp(0, -0.8, k);
  }
  _animJumpKick(a) {
    // Tuck on launch, extend leg during active, return during recovery
    const total = a.def.startup + a.def.active;
    const t = a.frame <= total
      ? Scalar.Clamp(a.frame / total, 0, 1)
      : 1 - Scalar.Clamp((a.frame - total) / a.def.recovery, 0, 1);
    // Extended leg forward
    this.rightLeg.pivot.rotation.z = Scalar.Lerp(0, -Math.PI / 2 - 0.2, t);
    this.leftLeg.pivot.rotation.z = Scalar.Lerp(0, -0.6, t * 0.5);
    // Arms back for balance
    this.leftArm.pivot.rotation.z = Scalar.Lerp(0, -0.6, t);
    this.rightArm.pivot.rotation.z = Scalar.Lerp(0, -0.6, t);
    this.torsoGroup.rotation.z = Scalar.Lerp(0, 0.15, t);
  }
  _animNose(a) {
    // Show 3D nose and extend it dramatically along +x (forward only).
    // The nose sphere has radius=noseSize. To keep its BACK anchored at the
    // face (x=0 relative to nosePivot) and extend only forward, we set:
    //   position.x = noseSize * scaling.x
    // so back = position.x - noseSize*scaling.x = 0 and front = 2*noseSize*scaling.x.
    this.noseMesh.isVisible = true;
    const total = a.def.startup + a.def.active;
    const t = a.frame <= total
      ? Scalar.Clamp(a.frame / total, 0, 1)
      : 1 - Scalar.Clamp((a.frame - total) / a.def.recovery, 0, 1);
    const base = this.basePose.noseScaleX || 1;
    const s = base + t * 14;
    this.noseMesh.scaling.x = s;
    this.noseMesh.position.x = this.config.noseSize * s;
    // Lean head forward
    this.neck.rotation.z = Scalar.Lerp(0, -0.5, t);
    // Arms back
    this.leftArm.pivot.rotation.z = Scalar.Lerp(0, -0.4, t);
    this.rightArm.pivot.rotation.z = Scalar.Lerp(0, -0.4, t);
  }
  _animRock(a) {
    // Wind up right arm, throw forward
    const total = a.def.startup + a.def.active;
    const t = a.frame <= total
      ? Scalar.Clamp(a.frame / total, 0, 1)
      : 1 - Scalar.Clamp((a.frame - total) / a.def.recovery, 0, 1);
    // Wind up: arm goes UP and BACK during startup, then forward in active
    if (a.frame <= a.def.startup) {
      const k = a.frame / a.def.startup;
      this.rightArm.pivot.rotation.z = Scalar.Lerp(0, Math.PI * 0.7, k);
    } else {
      const k = Math.min(1, (a.frame - a.def.startup) / (a.def.active + a.def.recovery));
      this.rightArm.pivot.rotation.z = Scalar.Lerp(Math.PI * 0.7, -Math.PI / 2, k);
    }
    this.torsoGroup.rotation.y = Scalar.Lerp(0, -0.4, t);
    this.leftArm.pivot.rotation.z = Scalar.Lerp(0, -0.4, t);
  }

  // ---------- Hit detection helpers ----------

  /** World-space hurtbox center+radius for THIS character. */
  getHurtboxWorld() {
    // Use torso world position, with radius approximating bodyWidth*bodyHeight
    const wm = this.torsoGroup.computeWorldMatrix(true);
    const center = Vector3.TransformCoordinates(Vector3.Zero(), wm);
    // Average extent for sphere-ish hurtbox
    const r = 0.55 * (this.config.bodyWidth + this.config.bodyHeight) * 0.5;
    return { center, radius: r };
  }

  /** Local-space hitbox for current attack (relative to facingPivot, with +x forward). Returns {x,y,z,r}. */
  getAttackHitboxLocal() {
    if (!this.currentAttack) return null;
    const cfg = this.config;
    const name = this.currentAttack.def.name;
    // Heights are measured in the local frame relative to facingPivot
    const shoulderY = cfg.legLength + cfg.bodyHeight * 0.42;
    const hipY = cfg.legLength;
    const torsoMidY = cfg.legLength + cfg.bodyHeight * 0.5;
    const headY = cfg.legLength + cfg.bodyHeight * 0.5 + cfg.headRadius * 0.55;
    switch (name) {
      case 'punch':
        return { x: cfg.armLength * 0.95, y: shoulderY - 0.1, z: -cfg.bodyWidth * 0.55, r: 0.35 };
      case 'kick':
        return { x: cfg.legLength * 0.95, y: hipY - 0.1, z: -cfg.bodyWidth * 0.0, r: 0.42 };
      case 'Coup de Bide':
        return { x: cfg.bellyRadius * 2.4, y: torsoMidY - cfg.bodyHeight * 0.05, z: 0, r: cfg.bellyRadius * 1.8 };
      case 'Coup de Pied Sauté':
        return { x: cfg.legLength * 0.9, y: hipY + 0.1, z: 0, r: 0.55 };
      case 'Coup de Pif':
        // Nose extends along x: scale * noseSize
        return { x: cfg.headRadius * 0.95 + cfg.noseSize * 12, y: headY, z: 0, r: 0.45 };
      case 'Lancer de Caillou':
        return null; // handled by projectile
      default: return null;
    }
  }

  /** World-space hitbox sphere {center, radius} for current attack. */
  getAttackHitboxWorld() {
    const local = this.getAttackHitboxLocal();
    if (!local) return null;
    const wm = this.facingPivot.computeWorldMatrix(true);
    const center = Vector3.TransformCoordinates(new Vector3(local.x, local.y, local.z), wm);
    return { center, radius: local.r };
  }

  /** For Nico: pull queued projectile spawns (one-shot per active window). */
  pollProjectile() {
    const a = this.currentAttack;
    if (!a || a.def.name !== 'Lancer de Caillou') return null;
    if (a.state !== 'active') return null;
    if (a._launched) return null;
    a._launched = true;
    // Spawn point: at the right hand
    const cfg = this.config;
    const local = new Vector3(cfg.armLength * 0.8, cfg.legLength + cfg.bodyHeight * 0.55, -cfg.bodyWidth * 0.4);
    const wm = this.facingPivot.computeWorldMatrix(true);
    const pos = Vector3.TransformCoordinates(local, wm);
    const vx = this.facing * 16;
    return { position: pos, velocity: new Vector3(vx, 4, 0), owner: this, damage: a.def };
  }

  resetForRound(side) {
    this.hp = this.maxHp;
    this.state = 'idle';
    this.frame = 0;
    this.hitstun = 0;
    this.blockstun = 0;
    this.cooldown = 0;
    this.currentAttack = null;
    this.isBlocking = false;
    this.velocity.set(0, 0, 0);
    this.facing = -side;
    this.root.position.x = side * 4.0;
    this.root.position.y = 0;
    this.grounded = true;
    this._applyFacing(true);
    this.facingPivot.rotation.z = 0;
    this._resetPose();
  }

  dispose() {
    this.root.dispose(false, true);
  }
}
