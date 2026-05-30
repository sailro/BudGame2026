// Entry point: Babylon engine + scene setup, fixed-step game loop.

import '@babylonjs/core/Materials/standardMaterial.js';
import '@babylonjs/core/Maths/math.color.js';
import '@babylonjs/core/Maths/math.vector.js';

import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera.js';
import { Color4 } from '@babylonjs/core/Maths/math.color.js';

import { HUD } from './ui.js';
import { InputSystem } from './input.js';
import { Game } from './game.js';
import { buildStage } from './stage.js';
import { CHARACTERS, CHARACTER_IDS } from './characterData.js';

// Warm the browser HTTP cache for every face + head texture as soon as the
// page loads, so when the player clicks FIGHT the textures are already there
// (no in-game stutter for first-time visitors on slow networks).
for (const id of CHARACTER_IDS) {
  const c = CHARACTERS[id];
  for (const url of [c.facePath, c.headPath]) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

const canvas = document.getElementById('renderCanvas');
const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: false,
  stencil: true,
  antialias: true,
}, true);

const scene = new Scene(engine);
scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);
scene.autoClear = true;
scene.collisionsEnabled = false;

// Camera: locked side view (perpendicular to fight plane = x axis).
// Position is updated by Game._updateCamera; we don't attach controls.
// We place the camera on the -z side so that world +x lands on screen-right;
// this makes Player 1 (side=-1, x=-4) appear on screen-left as expected, and
// "press left" actually moves the character to the left on screen.
const camera = new TargetCamera('cam', new Vector3(0, 3, -9), scene);
camera.setTarget(new Vector3(0, 1.6, 0));
camera.fov = 0.75;
camera.minZ = 0.1;
camera.maxZ = 200;
scene.activeCamera = camera;

buildStage(scene);

const hud = new HUD();
const input = new InputSystem();
const game = new Game({ scene, hud, input, camera });

// Initial menu setup
game.setupMenu();

// Fixed timestep simulation: cap dt to avoid huge jumps after tab switch
let lastTime = performance.now() / 1000;
engine.runRenderLoop(() => {
  const now = performance.now() / 1000;
  let dt = Math.min(0.05, now - lastTime);
  lastTime = now;
  game.update(dt);
  scene.render();
});

window.addEventListener('resize', () => engine.resize());

// Expose for console debugging
window.__game = game;
window.__scene = scene;
