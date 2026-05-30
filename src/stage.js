// Stage / environment: boxing ring arena.

import { Scene } from '@babylonjs/core/scene.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

// Layout constants — keep in sync with character.js GROUND_Y=0 and
// STAGE_HALF_WIDTH=7.5. The mat's TOP surface sits at y=0 so characters
// stand on it. Camera sits on the -z side so we expose back/left/right
// ropes; the FRONT ropes are skipped (would block the action otherwise).
const RING_W = 18;     // x extent of mat
const RING_D = 8;      // z extent of mat
const MAT_THICK = 0.5; // canvas thickness (mat top is at y=0)
const POST_H = 2.1;    // turnbuckle post height above mat
const ROPE_YS = [0.55, 1.10, 1.65]; // rope heights above mat

export function buildStage(scene) {
  // Dim arena clear color
  scene.clearColor = new Color4(0.04, 0.04, 0.08, 1);

  // Lights: warm overhead key + cool ambient (arena vibe)
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.65;
  hemi.diffuse = new Color3(1.0, 0.95, 0.85);
  hemi.groundColor = new Color3(0.10, 0.10, 0.15);

  const dir = new DirectionalLight('dir', new Vector3(0, -1, -0.3), scene);
  dir.intensity = 0.75;
  dir.diffuse = new Color3(1, 1, 0.95);

  // === Arena floor (dark, extends well beyond ring) ===
  const arena = MeshBuilder.CreateBox('arena_floor',
    { width: 60, height: 0.2, depth: 30 }, scene);
  arena.position.y = -1.1;
  const arMat = new StandardMaterial('arMat', scene);
  arMat.diffuseColor = new Color3(0.07, 0.07, 0.09);
  arMat.specularColor = new Color3(0.02, 0.02, 0.02);
  arena.material = arMat;

  // === Ring mat (the blue canvas) — top surface at y=0 ===
  const mat = MeshBuilder.CreateBox('ring_mat',
    { width: RING_W, height: MAT_THICK, depth: RING_D }, scene);
  mat.position.y = -MAT_THICK / 2;
  const matMat = new StandardMaterial('ring_matMat', scene);
  matMat.diffuseColor = new Color3(0.15, 0.28, 0.55);
  matMat.specularColor = new Color3(0.06, 0.06, 0.10);
  mat.material = matMat;

  // Center logo circle (red roundel painted on the mat)
  const logo = MeshBuilder.CreateCylinder('ring_logo',
    { diameter: 2.6, height: 0.02, tessellation: 32 }, scene);
  logo.position.set(0, 0.015, 0);
  const logoMat = new StandardMaterial('logoMat', scene);
  logoMat.diffuseColor = new Color3(0.80, 0.12, 0.15);
  logoMat.emissiveColor = new Color3(0.18, 0.04, 0.04);
  logo.material = logoMat;

  // === Apron (red overhang under the mat, visible from front) ===
  const apron = MeshBuilder.CreateBox('ring_apron',
    { width: RING_W + 0.4, height: 0.45, depth: RING_D + 0.4 }, scene);
  apron.position.y = -MAT_THICK - 0.12;
  const apronMat = new StandardMaterial('apronMat', scene);
  apronMat.diffuseColor = new Color3(0.62, 0.10, 0.13);
  apronMat.specularColor = new Color3(0.05, 0.05, 0.05);
  apron.material = apronMat;

  // === Corner posts + turnbuckle pads ===
  const postMat = new StandardMaterial('postMat', scene);
  postMat.diffuseColor = new Color3(0.78, 0.78, 0.82);
  postMat.specularColor = new Color3(0.5, 0.5, 0.55);

  const padTopMat = new StandardMaterial('padTopMat', scene);
  padTopMat.diffuseColor = new Color3(0.85, 0.13, 0.15);
  padTopMat.emissiveColor = new Color3(0.20, 0.03, 0.03);
  const padBotMat = new StandardMaterial('padBotMat', scene);
  padBotMat.diffuseColor = new Color3(0.13, 0.28, 0.85);
  padBotMat.emissiveColor = new Color3(0.03, 0.06, 0.20);

  const corners = [
    { x: -RING_W / 2, z: -RING_D / 2, id: 'fl' },
    { x: +RING_W / 2, z: -RING_D / 2, id: 'fr' },
    { x: -RING_W / 2, z: +RING_D / 2, id: 'bl' },
    { x: +RING_W / 2, z: +RING_D / 2, id: 'br' },
  ];
  for (const c of corners) {
    // Vertical post
    const post = MeshBuilder.CreateCylinder(`post_${c.id}`,
      { diameter: 0.20, height: POST_H, tessellation: 14 }, scene);
    post.position.set(c.x, POST_H / 2, c.z);
    post.material = postMat;

    // Pad lower (blue band, ~30cm)
    const padLow = MeshBuilder.CreateBox(`pad_lo_${c.id}`,
      { width: 0.55, height: 0.45, depth: 0.55 }, scene);
    padLow.position.set(c.x, ROPE_YS[1] - 0.05, c.z);
    padLow.material = padBotMat;

    // Pad upper (red band)
    const padUp = MeshBuilder.CreateBox(`pad_up_${c.id}`,
      { width: 0.55, height: 0.55, depth: 0.55 }, scene);
    padUp.position.set(c.x, ROPE_YS[2] + 0.1, c.z);
    padUp.material = padTopMat;
  }

  // === Ropes: three horizontal cylinders. We render BACK, LEFT, RIGHT only
  // (no front ropes so they don't block the camera's view of the action). ===
  const ropeColors = [
    new Color3(0.85, 0.15, 0.15), // bottom: red
    new Color3(0.96, 0.96, 0.96), // middle: white
    new Color3(0.15, 0.28, 0.85), // top: blue
  ];
  for (let h = 0; h < 3; h++) {
    const rmat = new StandardMaterial(`ropeMat_${h}`, scene);
    rmat.diffuseColor = ropeColors[h];
    rmat.emissiveColor = ropeColors[h].scale(0.20);

    // Back rope (along x at z = +RING_D/2)
    const back = MeshBuilder.CreateCylinder(`rope_back_${h}`,
      { diameter: 0.08, height: RING_W, tessellation: 8 }, scene);
    back.rotation.z = Math.PI / 2;
    back.position.set(0, ROPE_YS[h], +RING_D / 2);
    back.material = rmat;

    // Left rope (along z at x = -RING_W/2)
    const left = MeshBuilder.CreateCylinder(`rope_left_${h}`,
      { diameter: 0.08, height: RING_D, tessellation: 8 }, scene);
    left.rotation.x = Math.PI / 2;
    left.position.set(-RING_W / 2, ROPE_YS[h], 0);
    left.material = rmat;

    // Right rope (along z at x = +RING_W/2)
    const right = MeshBuilder.CreateCylinder(`rope_right_${h}`,
      { diameter: 0.08, height: RING_D, tessellation: 8 }, scene);
    right.rotation.x = Math.PI / 2;
    right.position.set(+RING_W / 2, ROPE_YS[h], 0);
    right.material = rmat;
  }

  // === Backdrop wall (deep dark stadium back) ===
  const wall = MeshBuilder.CreateBox('wall',
    { width: 70, height: 16, depth: 0.5 }, scene);
  wall.position.set(0, 7, 13);
  const wmat = new StandardMaterial('wmat', scene);
  wmat.diffuseColor = new Color3(0.05, 0.04, 0.09);
  wmat.specularColor = new Color3(0, 0, 0);
  wall.material = wmat;

  // === Crowd silhouettes (rows of dark blobs in the stands) ===
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 18; i++) {
      const head = MeshBuilder.CreateSphere(`crowd_${row}_${i}`,
        { diameter: 0.55, segments: 6 }, scene);
      const wobble = (i * 31 + row * 17) % 7 / 7 * 0.3;
      head.position.set(
        -25 + i * 2.8 + row * 0.6,
        0.4 + row * 0.9 + wobble,
        9 + row * 1.1,
      );
      const hm = new StandardMaterial(`cm_${row}_${i}`, scene);
      const k = 0.05 + ((i + row * 3) % 5) * 0.015;
      hm.diffuseColor = new Color3(k, k, k * 1.1);
      hm.specularColor = new Color3(0, 0, 0);
      head.material = hm;
    }
  }

  // === Overhead spotlight cones (decorative emissive quads) ===
  for (let i = -1; i <= 1; i++) {
    const beam = MeshBuilder.CreateBox(`beam_${i}`,
      { width: 0.4, height: 12, depth: 0.4 }, scene);
    beam.position.set(i * 6, 8, 2.5);
    beam.rotation.z = i * 0.12;
    const bm = new StandardMaterial(`bm_${i}`, scene);
    bm.diffuseColor = new Color3(0.95, 0.92, 0.7);
    bm.emissiveColor = new Color3(0.55, 0.50, 0.30);
    bm.alpha = 0.20;
    bm.specularColor = new Color3(0, 0, 0);
    beam.material = bm;
  }

  // Hanging spotlight housings (small black cylinders above the beams)
  for (let i = -1; i <= 1; i++) {
    const lamp = MeshBuilder.CreateCylinder(`lamp_${i}`,
      { diameter: 0.7, height: 0.4, tessellation: 14 }, scene);
    lamp.position.set(i * 6, 14, 2.5);
    const lm = new StandardMaterial(`lm_${i}`, scene);
    lm.diffuseColor = new Color3(0.10, 0.10, 0.12);
    lm.specularColor = new Color3(0.4, 0.4, 0.4);
    lamp.material = lm;
  }
}
