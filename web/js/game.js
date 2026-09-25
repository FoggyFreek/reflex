// REFLEX game engine: a port of the logic reverse-engineered from REFLEX.EXE v1.2.3.
// DOM-free. The host supplies timing (wait), input, sound and visual-effect hooks.
// Addresses in comments refer to functions in the original code segment
// (see docs/REVERSE_ENGINEERING.md).
(function (root) {
  'use strict';

  const W = 23, H = 18;

  // Cell values. They double as sprite indices, in the order stored in REFLEX.EGA.
  // Spawning bumps a cell one step along this chain, so objects "evolve".
  const T = {
    HEAD: 0, TRAIL: 1, CLEAR: 2, EMPTY: 3, PIGMAN: 4, TRANSPORT: 5, PALM: 6, ARROW: 7,
    MARTINI: 8, EXTRAMAN: 9, DEMON: 10, SUPER: 11, ISLAND: 12, CROSS: 13, PREBARREN: 14,
    BARREN: 15, BADGE: 15 /* + 1..10 = 100..1000 points */, POWERED: 26,
  };

  class Abort extends Error {}

  const rnd = (n) => Math.floor(Math.random() * n);

  class Game {
    constructor(host) {
      this.host = host;
      this.val = new Uint8Array(W * H);   // game value per cell
      this.disp = new Uint8Array(W * H);  // sprite shown per cell
      this.sparkles = new Map();          // barren cell -> random pixels
      this.reset();
    }

    reset() {
      this.level = 1;       // 0xa0
      this.speed = 1;       // 0xa2: spawns per turn, wraps 50 -> 1
      this.worms = 4;       // 0xa4
      this.shields = 0;     // 0xa6: forcefields
      this.freezes = 0;     // 0xa8: pauses
      this.score = 0;       // 0xaa
      this.x = 12; this.y = 8;          // 0xae / 0xb0
      this.dx = 0; this.dy = 1;         // 0xb2 / 0xb4
      this.safe = 22;       // 0x9e: safe lane column
      this.over = false;
      this.hunger = 0; this.hungerMax = 0;
      this.freezeLeft = 0;
      this.ink = 0;         // setbkcolor(): which palette colour index 0 shows as
      this.powered = false;
      this.moveId = 0; this.prevX = 12; this.prevY = 8; this.wrapped = false;
      this.turns = 0;
      this.val.fill(T.EMPTY); this.disp.fill(T.EMPTY); this.sparkles.clear();
    }

    idx(x = this.x, y = this.y) { return y * W + x; }
    set(i, v, shown = v) { this.val[i] = v; this.disp[i] = shown; this.sparkles.delete(i); }
    emit(type, data) { this.host.fx && this.host.fx(type, data || {}); }
    sfx(name, ...args) { return (this.host.sfx && this.host.sfx(name, ...args)) || 0; }
    wait(ms) { return this.host.wait(ms); }

    // Main loop from sub_04f1: move, spawn, tick, delay.
    turnDelay() {
      const factor = Math.floor(8 / (Math.floor(this.level / 50) + 1));
      // The original waits (50 - speed) * factor ms. The rest of each turn (drawing,
      // two 6 ms button polls) cost roughly 40 ms more on period hardware.
      return (50 - this.speed) * factor + 40 + this.speed;
    }

    async run() {
      try {
        while (!this.over) {
          await this.turn();
          if (this.over) break;
          this.spawn();
          this.sfx('tick');
          this.turns++;
          await this.pace();
        }
      } catch (e) {
        if (!(e instanceof Abort)) throw e;
      }
      return { score: this.score, level: this.level };
    }

    // Overridable hooks (used by Game+). The classic versions keep the original behaviour.
    pace() { return this.wait(this.turnDelay()); }
    hungerPace() { return this.wait(350); }
    wantShield() { return this.host.input.takeShield(); }
    wantFreeze() { return this.host.input.takeFreeze(); }
    demonCount() { return rnd(4); }
    onScore() {}
    gain(points, source) { this.score += points; this.onScore(points, source); }

    step() {
      this.prevX = this.x; this.prevY = this.y;
      this.x += this.dx; this.y += this.dy;
      this.wrapped = false;
      if (this.x < 0) { this.x = W - 1; this.wrapped = true; }
      if (this.x > W - 1) { this.x = 0; this.wrapped = true; }
      if (this.y < 0) { this.y = H - 1; this.wrapped = true; }
      if (this.y > H - 1) { this.y = 0; this.wrapped = true; }
      this.moveId++;
    }

    readDir() {
      const d = this.host.input.takeDir();
      if (d) { this.dx = d[0]; this.dy = d[1]; }
    }

    // sub_0637: one move of the worm.
    async turn() {
      if (this.wantFreeze() && this.freezes > 0) await this.freeze();

      const old = this.idx();
      if (this.val[old] !== T.BARREN) this.set(old, T.TRAIL);

      let shield = false;
      if (this.wantShield() && this.shields > 0) {
        shield = true;
        this.shields--;
        this.sfx('shield');
      }
      this.readDir();
      this.step();
      this.powered = shield;

      const i = this.idx();
      if (shield) {
        // A forcefield turns whatever is here into trail, barren cells included.
        this.emit('shield', { x: this.x, y: this.y, v: this.val[i] });
        this.set(i, T.TRAIL);
      } else {
        await this.collide(i);
      }
      // Hunger mode moves the worm, so look the cell up again (0x07c1 does too).
      const j = this.idx();
      if (this.val[j] !== T.BARREN) this.set(j, T.TRAIL);
    }

    // sub_1152: dispatch on the value of the cell the head entered.
    async collide(i) {
      switch (this.val[i]) {
        case T.TRAIL: case T.PIGMAN: case T.BARREN: return this.die();
        case T.TRANSPORT: return this.descend(1);
        case T.PALM: return this.palm();
        case T.ARROW: return this.devolve();
        case T.MARTINI: return this.hungerMode();
        case T.EXTRAMAN: return this.extraman();
        case T.DEMON: return this.demon();
        case T.SUPER: return this.descend(6);
        case T.ISLAND: return this.island();
        case T.CROSS: return this.cross();
        case T.PREBARREN: return this.preBarren();
        default: return undefined; // clear trail, empty space: harmless
      }
    }

    // sub_09ba: each turn `speed` random cells outside the safe lane evolve one step.
    spawn() {
      const pick = () => {
        let c;
        do { c = rnd(W); } while (c === this.safe);
        return this.idx(c, rnd(H));
      };
      if (this.speed > 32) {
        const i = pick();
        const v = Math.min(T.BARREN, this.val[i] + rnd(7) + 1);
        this.set(i, v);
      }
      let barrenHits = 0;
      for (let n = 0; n < this.speed;) {
        const i = pick();
        if (this.val[i] === T.BARREN) {
          if (++barrenHits === 1) continue; // the first barren hit gets a re-roll
          // Barren cells collect random coloured pixels (putpixel in the original).
          let s = this.sparkles.get(i);
          if (!s) this.sparkles.set(i, (s = []));
          if (s.length < 80) s.push([rnd(27), rnd(17), rnd(15) + 1]);
        } else {
          this.set(i, this.val[i] + 1);
          this.emit('evolve', { i, v: this.val[i] });
        }
        n++;
      }
      this.score += this.level;
    }

    // sub_11e5: lose a worm. The fatal cell turns barren and the board is cleared.
    async die() {
      this.emit('death', { x: this.x, y: this.y });
      this.sfx('death');
      await this.wait(950);
      this.set(this.idx(), T.BARREN);
      this.worms--;
      this.emit('worms', { delta: -1 });
      if (this.worms <= 0) {
        this.worms = 0;
        this.gameOver();
        return;
      }
      this.clearBoard();
      this.emit('cleared', {});
      await this.wait(450);
    }

    gameOver() {
      this.over = true;
      this.emit('gameover', {});
      this.sfx('gameover');
    }

    // sub_0b60: everything except barren cells becomes empty space.
    clearBoard() {
      for (let i = 0; i < W * H; i++) if (this.val[i] < T.BARREN) this.set(i, T.EMPTY);
    }

    // Same routine with sweep=1: the row-by-row wipe when descending a level.
    async wipeBoard() {
      this.sfx('wipe');
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          const i = this.idx(c, r);
          if (this.val[i] < T.BARREN) this.set(i, T.EMPTY);
        }
        this.gain(this.level, 'wipe');
        this.emit('wipeRow', { r });
        await this.wait(28);
      }
    }

    // sub_1246: Transport (1 level) and Super Transport (6 levels).
    async descend(n) {
      this.set(this.idx(), T.BARREN); // the used transport leaves a barren cell behind
      this.emit('transport', { x: this.x, y: this.y, n });
      for (let k = 0; k < n; k++) {
        await this.wipeBoard();
        this.level++;
        this.speed++;
        if (this.speed === 51) this.speed = 1;
        if (this.shields < 10) this.shields++;
        this.freezes++;
        if (this.speed >= 30) this.safe--;
        if (this.speed >= 35) await this.randomSafeLane();
        this.emit('level', { level: this.level });
      }
      await this.wait(200);
    }

    // sub_19df
    async randomSafeLane() {
      this.safe = rnd(W);
      for (let r = 0; r < H; r++) this.set(this.idx(this.safe, r), T.EMPTY);
      this.emit('safelane', { col: this.safe });
    }

    // sub_12ea: 100-1000 points
    palm() {
      const k = rnd(10) + 1;
      this.gain(k * 100, 'palm');
      this.sfx('tone', k * 200, 300);
      this.emit('bonus', { x: this.x, y: this.y, sprite: T.BADGE + k, points: k * 100 });
    }

    // sub_1352: every object steps back one stage along the chain.
    async devolve() {
      const cells = [];
      for (let i = 0; i < W * H; i++) {
        const v = this.val[i];
        if (v > T.EMPTY && v < T.BARREN) {
          this.set(i, v - 1);
          this.gain(rnd(5), 'devolve');
          cells.push(i);
        }
      }
      this.sfx('devolve');
      this.emit('devolve', { cells, x: this.x, y: this.y });
      await this.wait(350);
    }

    // sub_1403: eat anything for (value - 3) * 100 points for level + 2 moves.
    async hungerMode() {
      this.emit('hunger', { on: true, x: this.x, y: this.y });
      await this.wait(this.sfx('martini') || 900);
      this.ink = 6;
      let steps = this.level + 2;
      this.hungerMax = Math.min(steps, 50);
      this.powered = true;
      while (steps > 0) {
        if (steps === 3) this.ink = 4;
        if (steps === 2) this.ink = 2;
        if (steps === 1) this.ink = 7;
        this.hunger = Math.min(steps, 50);
        this.set(this.idx(), T.TRAIL);
        this.readDir();
        this.step();
        const i = this.idx();
        const v = this.val[i];
        if (v === T.BARREN) {
          this.powered = false;
          await this.die();
          break;
        }
        if (v > T.EMPTY) {
          const points = (v - 3) * 100;
          this.gain(points, 'eat');
          this.sfx('tone', v * 200, 330);
          this.emit('eat', { x: this.x, y: this.y, v, points, sprite: v + 12 <= 25 ? v + 12 : -1 });
        }
        await this.hungerPace();
        this.sfx('click');
        steps--;
      }
      this.hunger = 0; this.hungerMax = 0; this.ink = 0; this.powered = false;
      this.emit('hunger', { on: false });
    }

    // sub_16f1
    extraman() {
      if (this.worms >= 10) return;
      this.worms++;
      this.gain(3000, 'extraman');
      this.sfx('extraman');
      this.emit('extraman', { x: this.x, y: this.y, points: 3000 });
      this.emit('worms', { delta: 1 });
    }

    // sub_1738: lose 0-3 worms.
    async demon() {
      const n = this.demonCount();
      this.emit('demon', { x: this.x, y: this.y, n });
      for (let k = 0; k < n; k++) {
        await this.wait(this.sfx('demon') || 240);
        this.worms--;
        this.emit('worms', { delta: -1 });
        if (this.worms <= 0) {
          this.worms = 0;
          this.gameOver();
          return;
        }
      }
      if (n === 0) this.sfx('tone', 1800, 60);
    }

    // sub_1761: every trail cell turns barren (+8 each).
    async island() {
      const cells = [];
      for (let i = 0; i < W * H; i++) if (this.val[i] === T.TRAIL) cells.push(i);
      this.emit('island', { x: this.x, y: this.y, count: cells.length });
      const per = cells.length ? Math.max(12, Math.min(60, 1400 / cells.length)) : 0;
      for (const i of cells) {
        this.set(i, T.BARREN);
        this.gain(8, 'island');
        this.sfx('islandCell');
        this.emit('barren', { i });
        await this.wait(per);
      }
    }

    // sub_1821: clear the head's row and column, barren included (+4000).
    async cross() {
      for (let r = 0; r < H; r++) this.set(this.idx(this.x, r), T.CLEAR, T.EMPTY);
      for (let c = 0; c < W; c++) this.set(this.idx(c, this.y), T.CLEAR, T.EMPTY);
      this.gain(4000, 'cross');
      this.sfx('cross');
      this.emit('cross', { x: this.x, y: this.y, points: 4000 });
      await this.wait(300);
    }

    // sub_18ed: every pre-barren area flashes away (+500 each).
    async preBarren() {
      const cells = [];
      for (let i = 0; i < W * H; i++) if (this.val[i] === T.PREBARREN) cells.push(i);
      this.emit('prebarren', { x: this.x, y: this.y, cells, points: cells.length * 500 });
      for (let s = 12; s > 0; s--) {
        for (const i of cells) this.disp[i] = s % 2 ? T.PREBARREN : T.EMPTY;
        this.sfx('tone', s % 2 ? s * 90 : s * 400, s * 7 + 18);
        await this.wait(s * 7 + 18);
      }
      for (const i of cells) { this.set(i, T.EMPTY); this.gain(500, 'prebarren'); }
    }

    // sub_0c09: the pause freezes play for ~3 s and uses up every pause you hold.
    async freeze() {
      this.freezes = 0;
      this.emit('freeze', { on: true });
      const steps = 60;
      for (let s = steps; s > 0; s--) {
        this.freezeLeft = s / steps;
        this.sfx('click');
        await this.wait(50);
      }
      this.freezeLeft = 0;
      this.emit('freeze', { on: false });
    }
  }

  root.Reflex = { Game, Abort, T, W, H, rnd };
})(typeof window !== 'undefined' ? window : globalThis);
