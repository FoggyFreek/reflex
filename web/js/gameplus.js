// Game+: REFLEX with ideas from the 35 years of games since.
// Beat-locked moves (NecroDancer), a groove multiplier and graze (Geometry Wars, bullet-hell),
// telegraphed evolution (Into the Breach), a rival worm boss (Tron, Nibbler, slither.io)
// and a boon draft (Hades, Vampire Survivors). The evolution chain and every object's effect
// are unchanged from the original.
(function (root) {
  'use strict';

  const { Game, T, W, H, rnd } = root.Reflex;
  const DEADLY = (v) => v === T.TRAIL || v === T.PIGMAN || v === T.BARREN || v === T.DEMON;
  const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const wrapX = (x) => (x + W) % W, wrapY = (y) => (y + H) % H;

  const BOONS = {
    longField: { name: 'Long Field', text: 'Each forcefield lasts two moves.', sprite: 26, max: 1 },
    magnet: { name: 'Magnet', text: 'Grab Palmtrees next to you without touching them.', sprite: 6, max: 1 },
    secondWind: { name: 'Second Wind', text: 'Once per level, a death rewinds 4 beats instead.', sprite: 0, max: 1 },
    lucky: { name: 'Lucky Charm', text: 'Demons take at most one worm.', sprite: 10, max: 1 },
    harvest: { name: 'Harvest', text: 'Hunger-mode eats chain: ×1, ×2, ×4, ×8.', sprite: 8, max: 1 },
    deepPockets: { name: 'Deep Pockets', text: 'Pauses are spent one at a time (hold up to 3).', sprite: 5, max: 1 },
    fastFade: { name: 'Fast Fade', text: 'Your trail skips the Clear stage and fades twice as fast.', sprite: 2, max: 1 },
    grooveKeeper: { name: 'Groove Keeper', text: 'Longer groove window, and grazes count double.', sprite: 25, max: 1 },
    insurance: { name: 'Insurance', text: 'Sunny Island turns your trail into Clear trail, not Barren.', sprite: 12, max: 1 },
    cruise: { name: 'Cruise Control', text: '−10 BPM, but ×0.9 score. Stacks twice.', sprite: 7, max: 2 },
  };

  class GamePlus extends Game {
    reset() {
      super.reset();
      this.plus = true;
      this.groove = 1;
      this.grooveBeats = 0;
      this.grazes = 0;
      this.boons = {};
      this.pending = [];
      this.rival = null;
      this.history = [];
      this.windLevel = 0;
      this.hungerChain = 0;
      this.shieldCarry = 0;
      this.beat = 0;
      this.path = [this.idx()]; // recent head cells: moving off your own tail isn't a graze
      this.upBeat = {};
      this.owner = new Uint8Array(W * H); // 1 = your trail, 2 = rival trail
      this.painter = 1;
    }

    has(id) { return (this.boons[id] || 0) > 0; }
    get grooveWindow() { return this.has('grooveKeeper') ? 24 : 16; }

    bpmFor(level) { return Math.min(84 + 3 * (level - 1), 180); }
    tempo() {
      const heat = Math.round(((this.groove - 1) / 7) * 12);
      return Math.max(60, this.bpmFor(this.level) + heat - 10 * (this.boons.cruise || 0));
    }

    set(i, v, shown = v) {
      super.set(i, v, shown);
      if (this.owner) this.owner[i] = v === T.TRAIL ? this.painter : 0;
    }

    // Moves wait for the next 8th note.
    pace() { return this.host.beat(); }
    hungerPace() { return this.host.beat(); }

    wantShield() {
      if (this.shieldCarry > 0) {
        this.shieldCarry--;
        this.shields++; // the base turn spends one; this keeps the carried move free
        return true;
      }
      const want = super.wantShield();
      if (want && this.shields > 0 && this.has('longField')) this.shieldCarry = 1;
      return want;
    }

    demonCount() {
      const n = super.demonCount();
      return this.has('lucky') ? Math.min(1, n) : n;
    }

    emit(type, data) {
      if (type === 'worms' && data.delta < 0) this.resetGroove();
      super.emit(type, data);
    }

    // ------------------------------------------------------------- turn
    async turn() {
      this.beat++;
      this.snapshot();
      const before = this.level;
      await super.turn();
      if (this.over) return;
      this.path.push(this.idx());
      if (this.path.length > 4) this.path.shift();
      this.afterMove();
      await this.rivalTurn();
      this.tickGroove();
      if (this.level !== before && !this.over) await this.onLevels(before);
    }

    afterMove() {
      if (this.hunger > 0) return;
      // Magnet: collect Palmtrees in the 8 neighbouring cells.
      if (this.has('magnet')) {
        for (const [dx, dy] of DIRS) {
          const i = this.idx(wrapX(this.x + dx), wrapY(this.y + dy));
          if (this.val[i] === T.PALM) {
            const k = rnd(10) + 1;
            this.set(i, T.EMPTY);
            this.gain(k * 100, 'palm');
            this.sfx('tone', k * 200, 200);
            this.emit('bonus', { x: i % W, y: (i / W) | 0, sprite: T.BADGE + k, points: k * 100 });
          }
        }
      }
      // Graze: finishing a move right next to something deadly.
      if (this.powered) return;
      let near = 0;
      for (const [dx, dy] of DIRS) {
        const i = this.idx(wrapX(this.x + dx), wrapY(this.y + dy));
        if (!DEADLY(this.val[i])) continue;
        if (this.val[i] === T.TRAIL && this.owner[i] === 1 && this.path.includes(i)) continue;
        near++;
      }
      if (near > 0) {
        const n = this.has('grooveKeeper') ? 2 : 1;
        const points = this.level * this.groove * n;
        this.score += points;
        this.grooveBeats = this.grooveWindow;
        const before = Math.floor(this.grazes / 6);
        this.grazes += n;
        if (Math.floor(this.grazes / 6) > before) this.grooveUp('graze');
        this.sfx('graze');
        this.emit('graze', { x: this.x, y: this.y, points, near });
      }
    }

    // ------------------------------------------------------------- groove
    grooveUp(source) {
      if (source && this.upBeat[source] === this.beat) return;
      if (source) this.upBeat[source] = this.beat;
      const was = this.groove;
      this.groove = Math.min(8, this.groove + 1);
      this.grooveBeats = this.grooveWindow;
      if (this.groove !== was) this.emit('groove', { groove: this.groove, x: this.x, y: this.y });
    }
    resetGroove() {
      if (this.groove > 1) this.emit('grooveLost', { groove: this.groove });
      this.groove = 1;
      this.grooveBeats = 0;
      this.grazes = 0;
    }
    tickGroove() {
      if (this.grooveBeats > 0) this.grooveBeats--;
      else if (this.groove > 1) {
        this.groove--;
        this.grooveBeats = Math.floor(this.grooveWindow / 2);
      }
    }

    onScore(delta, source) {
      if (source === 'wipe') return;
      let mult = this.groove;
      if (source === 'eat' && this.has('harvest')) mult *= Math.pow(2, Math.min(3, this.hungerChain));
      mult *= Math.pow(0.9, this.boons.cruise || 0);
      this.score += Math.round(delta * mult) - delta;
      if (source === 'palm' || source === 'extraman' || source === 'cross' || source === 'prebarren') this.grooveUp(source);
      if (source === 'eat') {
        this.hungerChain++;
        if (this.hungerChain % 3 === 0) this.grooveUp();
      }
    }

    async hungerMode() {
      this.hungerChain = 0;
      await super.hungerMode();
    }

    // ------------------------------------------------------------- telegraphed evolution
    spawn() {
      for (const p of this.pending) {
        const v = this.val[p.i];
        if (v === T.BARREN) {
          let s = this.sparkles.get(p.i);
          if (!s) { s = []; this.sparkles.set(p.i, s); }
          if (s.length < 80) s.push([rnd(27), rnd(17), rnd(15) + 1]);
          continue;
        }
        let inc = p.inc;
        if (v === T.TRAIL && this.owner[p.i] === 1 && this.has('fastFade')) inc = Math.max(inc, 2);
        const nv = Math.min(T.BARREN, v + inc);
        this.painter = this.owner[p.i];
        this.set(p.i, nv);
        this.painter = 1;
        this.emit('evolve', { i: p.i, v: nv });
      }
      this.pending = this.pickSpawns();
      this.score += this.level;
    }

    // Same choices as the original spawn routine, made one beat ahead so they can be shown.
    pickSpawns() {
      const out = [];
      const pick = () => {
        let c;
        do { c = rnd(W); } while (c === this.safe);
        return this.idx(c, rnd(H));
      };
      if (this.speed > 32) out.push({ i: pick(), inc: rnd(7) + 1 });
      let barrenHits = 0;
      for (let n = 0; n < this.speed;) {
        const i = pick();
        if (this.val[i] === T.BARREN && ++barrenHits === 1) continue;
        out.push({ i, inc: 1 });
        n++;
      }
      return out;
    }

    async descend(n) {
      await super.descend(n);
      if (this.levelHold) await this.wait(this.levelHold);
    }

    async wipeBoard() {
      this.pending = [];
      await super.wipeBoard();
    }

    // ------------------------------------------------------------- boons
    async island() {
      if (!this.has('insurance')) return super.island();
      const cells = [];
      for (let i = 0; i < W * H; i++) if (this.val[i] === T.TRAIL) cells.push(i);
      this.emit('island', { x: this.x, y: this.y, count: cells.length });
      for (const i of cells) {
        this.set(i, T.CLEAR);
        this.gain(8, 'island');
      }
      this.sfx('islandCell');
      await this.wait(300);
    }

    async freeze() {
      const keep = this.has('deepPockets') ? Math.max(0, this.freezes - 1) : 0;
      await super.freeze();
      this.freezes += keep;
    }

    snapshot() {
      this.history.push({
        val: this.val.slice(), disp: this.disp.slice(), owner: this.owner.slice(),
        x: this.x, y: this.y, dx: this.dx, dy: this.dy,
        rival: this.rival ? { ...this.rival, trail: this.rival.trail.slice() } : null,
      });
      if (this.history.length > 6) this.history.shift();
    }

    async die() {
      if (this.has('secondWind') && this.windLevel !== this.level && this.history.length >= 4) {
        this.windLevel = this.level;
        const s = this.history[this.history.length - 4];
        this.val.set(s.val); this.disp.set(s.disp); this.owner.set(s.owner);
        this.x = s.x; this.y = s.y; this.dx = s.dx; this.dy = s.dy;
        this.prevX = s.x; this.prevY = s.y; this.moveId++; this.wrapped = true;
        this.rival = s.rival;
        this.history.length = 0;
        this.pending = [];
        this.path = [this.idx()];
        this.resetGroove();
        this.sfx('rewind');
        this.emit('rewind', { x: this.x, y: this.y });
        await this.wait(700);
        return;
      }
      this.sfx('musicDeath');
      await super.die();
    }

    async onLevels(before) {
      if (this.has('deepPockets')) this.freezes = Math.min(this.freezes, 3);
      const drafts = Math.floor(this.level / 5) - Math.floor(before / 5);
      for (let k = 0; k < drafts; k++) await this.draft();
      if (Math.floor(this.level / 10) > Math.floor(before / 10) && !this.rival) this.spawnRival();
    }

    async draft() {
      const pool = Object.keys(BOONS).filter((id) => (this.boons[id] || 0) < BOONS[id].max);
      if (!pool.length) return;
      const choices = [];
      while (choices.length < Math.min(3, pool.length)) {
        const id = pool[rnd(pool.length)];
        if (!choices.includes(id)) choices.push(id);
      }
      this.emit('draft', { choices });
      const id = await this.host.chooseBoon(choices);
      if (!BOONS[id]) return;
      this.boons[id] = (this.boons[id] || 0) + 1;
      this.emit('boon', { id });
    }

    // ------------------------------------------------------------- rival worm
    spawnRival() {
      const cells = [];
      for (let i = 0; i < W * H; i++) {
        const x = i % W, y = (i / W) | 0;
        if (this.val[i] !== T.EMPTY || x === this.safe) continue;
        const dx = Math.min(Math.abs(x - this.x), W - Math.abs(x - this.x));
        const dy = Math.min(Math.abs(y - this.y), H - Math.abs(y - this.y));
        if (Math.max(dx, dy) >= 8) cells.push(i);
      }
      if (!cells.length) return;
      const i = cells[rnd(cells.length)];
      const [dx, dy] = DIRS[rnd(8)];
      this.rival = { x: i % W, y: (i / W) | 0, dx, dy, beats: 0, trail: [], prevX: i % W, prevY: (i / W) | 0, moveId: 0 };
      this.painter = 2;
      this.set(i, T.TRAIL);
      this.painter = 1;
      this.sfx('boss');
      this.emit('boss', { x: this.rival.x, y: this.rival.y });
    }

    flood(sx, sy, limit) {
      const seen = new Set([sy * W + sx]);
      const queue = [[sx, sy]];
      while (queue.length && seen.size < limit) {
        const [x, y] = queue.shift();
        for (const [dx, dy] of DIRS) {
          const nx = wrapX(x + dx), ny = wrapY(y + dy), i = ny * W + nx;
          if (seen.has(i) || DEADLY(this.val[i])) continue;
          seen.add(i);
          queue.push([nx, ny]);
        }
      }
      return seen.size;
    }

    rivalChoose() {
      const r = this.rival;
      const tx = wrapX(this.x + this.dx * 2), ty = wrapY(this.y + this.dy * 2);
      let best = null, bs = -Infinity;
      for (const [dx, dy] of DIRS) {
        const nx = wrapX(r.x + dx), ny = wrapY(r.y + dy), v = this.val[ny * W + nx];
        if (DEADLY(v) || (nx === this.x && ny === this.y)) continue;
        const ddx = Math.min(Math.abs(nx - tx), W - Math.abs(nx - tx));
        const ddy = Math.min(Math.abs(ny - ty), H - Math.abs(ny - ty));
        const s = this.flood(nx, ny, 60)
          + (v === T.PALM ? 12 : 0) + (v === T.EXTRAMAN ? 16 : 0)
          - Math.max(ddx, ddy) * 0.9
          + (dx === r.dx && dy === r.dy ? 2 : 0)
          + Math.random() * 3;
        if (s > bs) { bs = s; best = [dx, dy]; }
      }
      return best || [r.dx, r.dy];
    }

    async rivalTurn() {
      const r = this.rival;
      if (!r) return;
      r.beats++;
      if (r.beats > 64) {
        this.emit('rivalLeave', { x: r.x, y: r.y });
        this.rival = null;
        return;
      }
      [r.dx, r.dy] = this.rivalChoose();
      r.prevX = r.x; r.prevY = r.y;
      r.x = wrapX(r.x + r.dx); r.y = wrapY(r.y + r.dy);
      r.moveId++;
      const i = r.y * W + r.x;
      const v = this.val[i];
      if (DEADLY(v) || (r.x === this.x && r.y === this.y)) return this.rivalCrash();
      if (v === T.PALM || v === T.EXTRAMAN) this.emit('rivalEat', { x: r.x, y: r.y, v });
      this.painter = 2;
      this.set(i, T.TRAIL);
      this.painter = 1;
      r.trail.push(i);
      if (r.trail.length > 6) r.trail.shift();
    }

    rivalCrash() {
      const r = this.rival;
      this.rival = null;
      const cells = r.trail.filter((i) => this.val[i] === T.TRAIL && this.owner[i] === 2);
      for (const i of cells) this.set(i, T.PALM);
      const points = 5000 * this.groove;
      this.score += points;
      this.grooveUp('rival');
      if (this.shields < 10) this.shields++;
      this.sfx('rivalCrash');
      this.emit('rivalCrash', { x: r.x, y: r.y, points, cells });
    }
  }

  root.ReflexPlus = { GamePlus, BOONS };
})(typeof window !== 'undefined' ? window : globalThis);
