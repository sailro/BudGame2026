// Projectile (rock thrown by Nico). Owns its mesh, updates physics each frame,
// reports collision with a target hurtbox.

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const GRAVITY = -28;

let rockCounter = 0;

export class Projectile {
  constructor(scene, { position, velocity, owner, attackDef }) {
    this.scene = scene;
    this.position = position.clone();
    this.velocity = velocity.clone();
    this.owner = owner;
    this.attackDef = attackDef;
    this.alive = true;
    this.lifetime = 2.5; // seconds
    this.hitTargets = new Set();
    this.radius = 0.25;

    this.netId = rockCounter & 0xffff; // stable handle for state replication
    const id = `rock_${rockCounter++}`;
    this.mesh = MeshBuilder.CreateSphere(id, { diameter: this.radius * 2, segments: 10 }, scene);
    const mat = new StandardMaterial(id + '_mat', scene);
    mat.diffuseColor = new Color3(0.45, 0.42, 0.40);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    this.mesh.material = mat;
    this.mesh.position.copyFrom(this.position);
    this.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  }

  update(dt) {
    if (!this.alive) return;
    this.lifetime -= dt;
    this.velocity.y += GRAVITY * dt;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.mesh.position.copyFrom(this.position);
    this.mesh.rotation.x += dt * 8;
    this.mesh.rotation.z += dt * 6;
    if (this.position.y <= this.radius || this.lifetime <= 0 || Math.abs(this.position.x) > 12) {
      this.alive = false;
    }
  }

  dispose() {
    this.mesh.dispose();
  }
}
