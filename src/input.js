// Input system: tracks per-player held + just-pressed keys.
// Handles blur to clear stuck keys, and prevents default for arrow keys.

const P1_KEYS = {
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['KeyW'],
  block: ['KeyS'],
  punch: ['KeyF'],
  kick: ['KeyG'],
  special: ['KeyH'],
};

const P2_KEYS = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  jump: ['ArrowUp'],
  block: ['ArrowDown'],
  punch: ['KeyJ'],
  kick: ['KeyK'],
  special: ['KeyL'],
};

const ALL_KEYS = new Set();
for (const m of [P1_KEYS, P2_KEYS])
  for (const arr of Object.values(m)) for (const k of arr) ALL_KEYS.add(k);

const PREVENT_DEFAULT = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'F1',
]);

export class InputSystem {
  constructor() {
    this.held = new Set();         // currently held key codes
    this.pressed = new Set();      // pressed since last frame
    this.released = new Set();
    this._anyKeyListeners = [];

    window.addEventListener('keydown', (e) => {
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      if (!this.held.has(e.code)) {
        this.pressed.add(e.code);
        for (const cb of this._anyKeyListeners) cb(e.code);
      }
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      this.held.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.held.clear();
      this.pressed.clear();
      this.released.clear();
    });
  }

  onAnyKey(cb) { this._anyKeyListeners.push(cb); }

  /** Call once per frame AFTER game has consumed pressed/released. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }

  /** Returns "p1" or "p2" key map. */
  getMap(side) { return side === 'p1' ? P1_KEYS : P2_KEYS; }

  isHeld(side, action) {
    const codes = this.getMap(side)[action];
    return codes.some(c => this.held.has(c));
  }
  isPressed(side, action) {
    const codes = this.getMap(side)[action];
    return codes.some(c => this.pressed.has(c));
  }
}
