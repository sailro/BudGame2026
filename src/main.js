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
import { Lobby } from './net/lobby.js';

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

// Serverless peer-to-peer lobby (WebRTC). Local play keeps working untouched.
const lobby = new Lobby({ game, input });

// Fixed timestep simulation. Combat timings (startup/active/recovery, hitstun,
// cooldowns) are counted in frames, so the world MUST tick at a constant 60 Hz
// or the game speed would follow the monitor refresh rate — and, online, host
// and guest would disagree on how long a move lasts.
const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
let accumulator = 0;
let lastTime = performance.now() / 1000;

engine.runRenderLoop(() => {
  const now = performance.now() / 1000;
  const frameTime = Math.min(0.25, now - lastTime);
  lastTime = now;

  if (game.isSimulating()) {
    accumulator += frameTime;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      game.update(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    // Too far behind (tab was hidden, GC spike...): drop the debt instead of
    // spiralling into an ever-growing catch-up loop.
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  } else {
    // Netplay guest: no simulation, just replicate + interpolate at display rate.
    accumulator = 0;
    game.update(frameTime);
  }

  scene.render();
});

window.addEventListener('resize', () => engine.resize());

// Expose for console debugging
window.__game = game;
window.__scene = scene;
window.__lobby = lobby;
