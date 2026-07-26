// UI / HUD bindings to the DOM elements declared in index.html
// Keeps DOM mutation out of the game module.

export class HUD {
  constructor() {
    this.hud = document.getElementById('hud');
    this.menu = document.getElementById('menu');
    this.p1Name = document.getElementById('p1Name');
    this.p2Name = document.getElementById('p2Name');
    this.p1HP = document.getElementById('p1HP');
    this.p2HP = document.getElementById('p2HP');
    this.timer = document.getElementById('timer');
    this.center = document.getElementById('centerMsg');
    this.startBtn = document.getElementById('startBtn');
    this.p1Portraits = document.getElementById('p1Portraits');
    this.p2Portraits = document.getElementById('p2Portraits');
    this.netBanner = document.getElementById('netBanner');
    this.netBadge = document.getElementById('netBadge');
    this.localControls = document.getElementById('localControls');
    this.onlineControls = document.getElementById('onlineControls');
    this.onlineSide = null;
  }

  /**
   * Switch the character-select screen between couch play and online play.
   * @param {'p1'|'p2'|'spectator'|null} localSide  what this end may control
   */
  setOnlineRole(localSide) {
    this.onlineSide = localSide || null;
    const online = !!localSide;
    const spectator = localSide === 'spectator';
    this.netBanner.hidden = !online;
    this.netBadge.hidden = !online;
    this.localControls.hidden = online;
    this.onlineControls.hidden = !online || spectator;
    if (online) {
      this.netBanner.textContent = spectator
        ? 'SPECTATEUR — vous regardez le combat'
        : (localSide === 'p1'
          ? 'EN LIGNE — vous êtes JOUEUR 1 (hôte)'
          : 'EN LIGNE — vous êtes JOUEUR 2');
      this.netBanner.classList.toggle('spectator', spectator);
      this.startBtn.textContent = spectator
        ? 'EN ATTENTE DU COMBAT…'
        : (localSide === 'p1' ? 'COMBATTRE !' : "EN ATTENTE DE L'HÔTE…");
      this.startBtn.disabled = localSide !== 'p1';
    } else {
      this.netBanner.classList.remove('spectator');
      this.startBtn.textContent = 'COMBATTRE !';
      this.startBtn.disabled = false;
    }
    this.p1Portraits.classList.toggle('locked', online && localSide !== 'p1');
    this.p2Portraits.classList.toggle('locked', online && localSide !== 'p2');
  }

  setNetStatus(text) {
    this.netBadge.textContent = text;
  }

  showMenu(visible) {
    this.menu.style.display = visible ? 'flex' : 'none';
    this.hud.hidden = visible;
  }

  setNames(p1Name, p2Name) {
    this.p1Name.textContent = p1Name;
    this.p2Name.textContent = p2Name;
  }
  setHP(p1Ratio, p2Ratio) {
    this.p1HP.style.width = (Math.max(0, Math.min(1, p1Ratio)) * 100) + '%';
    this.p2HP.style.width = (Math.max(0, Math.min(1, p2Ratio)) * 100) + '%';
  }
  setTimer(seconds) {
    this.timer.textContent = String(Math.max(0, Math.ceil(seconds))).padStart(2, '0');
  }

  /** Show a big centered message. duration ms. */
  showMessage(text, duration = 1400) {
    this.center.textContent = text;
    this.center.classList.add('show');
    clearTimeout(this._msgTimer);
    if (duration > 0) {
      this._msgTimer = setTimeout(() => this.center.classList.remove('show'), duration);
    }
  }
  clearMessage() {
    this.center.classList.remove('show');
  }

  /** Build character-select portraits. */
  buildPortraits(characters, onSelect) {
    for (const side of ['p1', 'p2']) {
      const root = side === 'p1' ? this.p1Portraits : this.p2Portraits;
      root.innerHTML = '';
      for (const c of characters) {
        const el = document.createElement('div');
        el.className = 'portrait';
        el.dataset.id = c.id;
        el.dataset.side = side;
        el.style.backgroundImage = `url('${c.facePath}')`;
        el.style.backgroundColor = c.shirt;
        const lbl = document.createElement('div');
        lbl.className = 'label';
        lbl.textContent = c.name;
        el.appendChild(lbl);
        el.addEventListener('click', () => onSelect(side, c.id));
        root.appendChild(el);
      }
    }
  }

  setActivePortrait(side, id) {
    const root = side === 'p1' ? this.p1Portraits : this.p2Portraits;
    for (const el of root.children) {
      el.classList.toggle('active', el.dataset.id === id);
    }
  }

  onStart(cb) { this.startBtn.addEventListener('click', cb); }
}
