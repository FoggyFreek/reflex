// Canvas renderer. It draws the original palette-indexed sprites from REFLEX.EGA,
// recoloured per palette, plus modern effects: glow, particles, popups and shake.
(function (root) {
  'use strict';

  const { W, H, T } = root.Reflex;
  const S = root.REFLEX_SPRITES;
  const SW = S.width, SH = S.height;
  const PIX = Uint8Array.from(atob(S.data), (c) => c.charCodeAt(0));
  const CELL_ASPECT = SW / (SH * S.pixelAspect); // EGA pixels were ~1.37x taller than wide

  const PALETTES = {
    classic: S.palette,
    modern: [
      '#070a13', '#ec3a56', '#2fbf71', '#2bc4c4', '#ec3a56', '#b146e0', '#e08a2e', '#c3c9dc',
      '#5d6685', '#5c8dff', '#7cf29c', '#28365f', '#ff7b7b', '#ff79d0', '#ffd447', '#f5f7ff',
    ],
  };
  // Palette swaps: the rival worm is the player's head sprite in other colours.
  const VARIANTS = { rival: { 13: '#7cf29c', 15: '#fffbe0', 2: '#ec3a56', 12: '#2fbf71' } };
  const FRAME = { modern: '#0d1322', classic: '#aa0000' };

  const hexToRgb = (h) => [1, 3, 5].map((o) => parseInt(h.substr(o, 2), 16));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cache = new Map();
      this.opts = { palette: 'modern', safeHint: true };
      this.game = null;
      this.particles = [];
      this.popups = [];
      this.rings = [];
      this.beams = [];
      this.cellFx = new Map();
      this.rowFx = [];
      this.flash = null;
      this.shake = 0;
      this.headAnim = { id: -1, t0: 0 };
      this.dim = 0;
      this.resize(640);
    }

    setGame(g) {
      this.game = g;
      this.particles.length = this.popups.length = this.rings.length = this.beams.length = this.rowFx.length = 0;
      this.cellFx.clear();
      this.flash = null;
      this.headAnim = { id: g ? g.moveId : -1, t0: 0 };
      this.rivalAnim = { id: -1 };
    }

    setOptions(o) { Object.assign(this.opts, o); this.overlay = null; }

    get sphereOn() { return !!(this.opts.sphere && this.game && this.game.plus); }
    get aspect() { return this.sphereOn ? 1.22 : (W * CELL_ASPECT) / H; }

    resize(cssW) { this.resizeTo(cssW, cssW / this.aspect); }

    resizeTo(cssW, cssH) {
      const dpr = Math.min(root.devicePixelRatio || 1, 3);
      this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
      this.canvas.style.width = cssW + 'px';
      this.canvas.style.height = cssH + 'px';
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.cw = cssW / W; this.ch = cssH / H;
      this.overlay = null;
    }

    // 27 sprite canvases for a palette, with palette index 0 remapped (setbkcolor).
    sprites(pal, ink, variant) {
      const key = pal + ':' + ink + ':' + (variant || '');
      let set = this.cache.get(key);
      if (set) return set;
      const colors = PALETTES[pal].map(hexToRgb);
      const map = colors.slice();
      map[0] = colors[ink];
      if (variant) for (const [k, hex] of Object.entries(VARIANTS[variant])) map[k] = hex === null ? null : hexToRgb(hex);
      set = [];
      for (let k = 0; k < S.names.length; k++) {
        const c = document.createElement('canvas');
        c.width = SW; c.height = SH;
        const cx = c.getContext('2d');
        const img = cx.createImageData(SW, SH);
        for (let p = 0; p < SW * SH; p++) {
          const rgb = map[PIX[k * SW * SH + p]];
          if (!rgb) continue; // transparent
          img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1]; img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
        }
        cx.putImageData(img, 0, 0);
        set.push(c);
      }
      this.cache.set(key, set);
      return set;
    }

    // Canvas for UI icons (legend, HUD).
    icon(k, pal = this.opts.palette) { return this.sprites(pal, 0)[k]; }

    buildOverlay() {
      const o = document.createElement('canvas');
      o.width = this.canvas.width; o.height = this.canvas.height;
      const c = o.getContext('2d');
      if (this.opts.palette === 'modern') {
        const d = this.dpr, cw = this.cw * d, ch = this.ch * d;
        const gap = Math.max(1, cw * 0.05), r = Math.min(cw, ch) * 0.16;
        c.fillStyle = FRAME.modern;
        c.fillRect(0, 0, o.width, o.height);
        c.globalCompositeOperation = 'destination-out';
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            c.beginPath();
            c.roundRect(x * cw + gap / 2, y * ch + gap / 2, cw - gap, ch - gap, r);
            c.fill();
          }
        }
      }
      this.overlay = o;
    }

    // Visual-effect hooks, called from the game's emit().
    fx(type, d) {
      const now = performance.now();
      const cx = (x) => (x + 0.5) * this.cw, cy = (y) => (y + 0.5) * this.ch;
      switch (type) {
        case 'evolve':
          if (d.v >= T.PIGMAN) this.cellFx.set(d.i, { t0: now, dur: 320, color: '255,255,255', a: 0.55 });
          break;
        case 'death':
          this.shake = 14;
          this.flash = { t0: now, dur: 700, color: '236,58,86', a: 0.55 };
          this.burst(cx(d.x), cy(d.y), 42, ['#ff79d0', '#ffd447', '#f5f7ff', '#ec3a56'], 1.3);
          this.rings.push({ x: cx(d.x), y: cy(d.y), t0: now, dur: 700, color: '236,58,86', r: this.cw * 4 });
          break;
        case 'cleared':
          this.flash = { t0: now, dur: 450, color: '245,247,255', a: 0.25 };
          break;
        case 'gameover':
          this.flash = { t0: now, dur: 1400, color: '10,13,24', a: 0.6 };
          break;
        case 'shield':
          this.rings.push({ x: cx(d.x), y: cy(d.y), t0: now, dur: 420, color: '92,225,255', r: this.cw * 1.4 });
          if (d.v >= T.PIGMAN) this.burst(cx(d.x), cy(d.y), 14, ['#5ce1ff', '#f5f7ff'], 0.7);
          break;
        case 'transport':
          for (let k = 0; k < 3; k++) this.rings.push({ x: cx(d.x), y: cy(d.y), t0: now + k * 120, dur: 650, color: '92,141,255', r: this.cw * (2 + k), inward: true });
          this.popText(cx(d.x), cy(d.y), d.n > 1 ? `DROP ${d.n} LEVELS` : 'DOWN A LEVEL', '#8fb0ff');
          break;
        case 'level':
          if (this.sphereOn && this.sphereView) this.sphereView.explode(now, d.level);
          break;
        case 'wipeRow':
          this.rowFx.push({ r: d.r, t0: now, dur: 380 });
          break;
        case 'safelane':
          this.beams.push({ col: d.col, t0: now, dur: 700, color: '124,242,156' });
          break;
        case 'bonus':
          this.popSprite(cx(d.x), cy(d.y), d.sprite, '+' + d.points);
          this.burst(cx(d.x), cy(d.y), 18, ['#ffd447', '#e08a2e', '#7cf29c'], 0.8);
          break;
        case 'eat':
          if (d.sprite >= 0) this.popSprite(cx(d.x), cy(d.y), d.sprite, '+' + d.points);
          else this.popText(cx(d.x), cy(d.y), '+' + d.points, '#ffd447');
          this.burst(cx(d.x), cy(d.y), 16, ['#ffb347', '#ffd447', '#ff79d0'], 0.8);
          break;
        case 'hunger':
          if (d.on) {
            this.popText(cx(d.x), cy(d.y), 'HUNGER!', '#ffb347', 1.3);
            this.flash = { t0: now, dur: 500, color: '255,179,71', a: 0.3 };
          }
          break;
        case 'extraman':
          this.popText(cx(d.x), cy(d.y), '+1 WORM  +3000', '#7cf29c', 1.1);
          this.burst(cx(d.x), cy(d.y), 24, ['#7cf29c', '#5c8dff', '#f5f7ff'], 1);
          break;
        case 'demon':
          this.shake = 8;
          this.flash = { t0: now, dur: 500, color: '236,58,86', a: 0.35 };
          this.popText(cx(d.x), cy(d.y), d.n ? `DEMON! -${d.n} WORM${d.n > 1 ? 'S' : ''}` : 'DEMON… LUCKY!', d.n ? '#ff7b7b' : '#c3c9dc', 1.1);
          break;
        case 'island':
          this.popText(cx(d.x), cy(d.y), 'SUNNY ISLAND', '#ffd447');
          break;
        case 'barren': {
          const x = d.i % W, y = (d.i / W) | 0;
          this.cellFx.set(d.i, { t0: now, dur: 400, color: '255,212,71', a: 0.7 });
          this.burst(cx(x), cy(y), 5, ['#ffd447', '#5d6685'], 0.4);
          break;
        }
        case 'cross':
          this.beams.push({ row: d.y, col: d.x, t0: now, dur: 650, color: '255,212,71' });
          this.popText(cx(d.x), cy(d.y), '+4000', '#ffd447', 1.2);
          break;
        case 'prebarren':
          for (const i of d.cells) {
            this.rings.push({ x: cx(i % W), y: cy((i / W) | 0), t0: now, dur: 600, color: '255,123,123', r: this.cw * 1.2 });
          }
          if (d.points) this.popText(cx(d.x), cy(d.y), '+' + d.points, '#ffd447', 1.1);
          break;
        case 'devolve':
          for (const i of d.cells) this.cellFx.set(i, { t0: now + Math.random() * 150, dur: 420, color: '92,141,255', a: 0.6 });
          this.popText(cx(d.x), cy(d.y), 'DEVOLVE', '#8fb0ff');
          break;
        case 'graze':
          this.burst(cx(d.x), cy(d.y), 3 + d.near, ['#5ce1ff', '#f5f7ff'], 0.35);
          break;
        case 'groove':
          this.popText(cx(d.x), cy(d.y) - this.ch * 0.6, '×' + d.groove, '#5ce1ff', 1 + d.groove * 0.06);
          this.rings.push({ x: cx(d.x), y: cy(d.y), t0: now, dur: 450, color: '92,225,255', r: this.cw * 1.6 });
          break;
        case 'boss':
          this.flash = { t0: now, dur: 700, color: '124,242,156', a: 0.3 };
          for (let k = 0; k < 3; k++) this.rings.push({ x: cx(d.x), y: cy(d.y), t0: now + k * 150, dur: 700, color: '124,242,156', r: this.cw * (2.5 + k) });
          break;
        case 'rivalCrash':
          this.shake = 10;
          this.burst(cx(d.x), cy(d.y), 40, ['#7cf29c', '#2fbf71', '#ffd447', '#f5f7ff'], 1.3);
          this.popText(cx(d.x), cy(d.y), 'GLUTTON DOWN! +' + d.points, '#7cf29c', 1.2);
          for (const i of d.cells) this.cellFx.set(i, { t0: now, dur: 600, color: '255,212,71', a: 0.8 });
          break;
        case 'rivalEat':
          this.popText(cx(d.x), cy(d.y), 'STOLEN!', '#7cf29c', 0.9);
          break;
        case 'rivalLeave':
          this.popText(cx(d.x), cy(d.y), 'GLUTTON FLED', '#c3c9dc');
          this.rings.push({ x: cx(d.x), y: cy(d.y), t0: now, dur: 600, color: '124,242,156', r: this.cw * 2, inward: true });
          break;
        case 'rewind':
          this.flash = { t0: now, dur: 700, color: '245,247,255', a: 0.45 };
          this.popText(cx(d.x), cy(d.y), 'SECOND WIND', '#f5f7ff', 1.2);
          break;
        default:
          break;
      }
    }

    burst(x, y, n, colors, power = 1) {
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, v = (0.08 + Math.random() * 0.25) * power * this.cw * 0.06;
        this.particles.push({
          x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.05 * power,
          life: 0, max: 500 + Math.random() * 500, color: colors[k % colors.length],
          size: this.cw * (0.05 + Math.random() * 0.08),
        });
      }
    }

    popText(x, y, text, color, scale = 1) { this.popups.push({ x, y, text, color, scale, t0: performance.now(), dur: 1100 }); }
    popSprite(x, y, sprite, text) { this.popups.push({ x, y, sprite, text, color: '#ffd447', scale: 1, t0: performance.now(), dur: 1100 }); }

    draw(now, dt) {
      const g = this.game;
      const c = this.ctx, d = this.dpr, cw = this.cw, ch = this.ch;
      const pal = this.opts.palette;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!g) return;
      if (!this.overlay) this.buildOverlay();

      let sx = 0, sy = 0;
      if (this.shake > 0.2) {
        sx = (Math.random() - 0.5) * this.shake; sy = (Math.random() - 0.5) * this.shake;
        this.shake *= Math.pow(0.9, dt / 16);
      } else this.shake = 0;
      c.setTransform(d, 0, 0, d, sx * d, sy * d);
      c.imageSmoothingEnabled = false;

      const spr = this.sprites(pal, g.ink);
      const colors = PALETTES[pal];
      if (!this.sphereView && root.ReflexSphere) this.sphereView = new root.ReflexSphere.SphereView(this);
      const sphere = this.sphereOn && this.sphereView;
      this.warp = sphere ? (x, y) => this.sphereView.warp(x, y) : null;
      if (sphere) {
        this.sphereView.draw(c, now, dt, sx, sy);
        this.rowFx = this.rowFx.filter((r) => now - r.t0 < r.dur);
        this.beams = this.beams.filter((b) => now - b.t0 < b.dur);
        for (const [i, f] of this.cellFx) if (now - f.t0 >= f.dur) this.cellFx.delete(i);
      } else {
        // tiles
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            c.drawImage(spr[g.disp[i]], x * cw, y * ch, cw + 0.5, ch + 0.5);
          }
        }
        // barren sparkles
        const px = cw / SW, py = ch / SH;
        for (const [i, list] of g.sparkles) {
          if (g.disp[i] !== T.BARREN) continue;
          const ox = (i % W) * cw, oy = ((i / W) | 0) * ch;
          for (const [x, y, col] of list) {
            c.fillStyle = colors[col];
            c.fillRect(ox + x * px, oy + y * py, px + 0.3, py + 0.3);
          }
        }
        // A soft outline makes the deadly trail readable on the dark modern board.
        if (pal === 'modern' || g.owner) {
          c.lineWidth = Math.max(1, cw * 0.035);
          for (let i = 0; i < W * H; i++) {
            if (g.disp[i] !== T.TRAIL) continue;
            const rival = g.owner && g.owner[i] === 2;
            if (pal !== 'modern' && !rival) continue;
            c.strokeStyle = rival ? 'rgba(124,242,156,0.75)' : 'rgba(255,121,208,0.28)';
            const x = i % W, y = (i / W) | 0;
            c.beginPath();
            c.ellipse((x + 0.5) * cw, (y + 0.5) * ch, cw * 0.44, ch * 0.42, 0, 0, Math.PI * 2);
            c.stroke();
          }
        }
        // cell flashes
        for (const [i, f] of this.cellFx) {
          const t = (now - f.t0) / f.dur;
          if (t >= 1) { this.cellFx.delete(i); continue; }
          if (t < 0) continue;
          c.fillStyle = `rgba(${f.color},${f.a * (1 - t)})`;
          c.fillRect((i % W) * cw, ((i / W) | 0) * ch, cw, ch);
        }
        // Game+: tiles that will evolve on the next beat pulse (red = turning deadly).
        if (g.pending && g.pending.length && !g.over) {
          const ph = this.conductor ? this.conductor.phase(now).phase : 0.5;
          const r = Math.min(cw, ch) * 0.16;
          c.lineWidth = Math.max(1.2, cw * 0.05);
          for (const p of g.pending) {
            const v = g.val[p.i];
            if (v === T.BARREN) continue;
            const nv = Math.min(T.BARREN, v + p.inc);
            const deadly = nv === T.PIGMAN || nv === T.DEMON || nv === T.BARREN;
            const good = nv >= T.TRANSPORT && nv !== T.DEMON && nv !== T.BARREN && nv !== T.ARROW;
            if (!deadly && !good) continue;
            const col = deadly ? '236,58,86' : '255,212,71';
            const a = 0.25 + 0.6 * ph;
            const x = (p.i % W) * cw, y = ((p.i / W) | 0) * ch, ins = cw * (0.14 - 0.08 * ph);
            c.strokeStyle = `rgba(${col},${a})`;
            c.beginPath();
            c.roundRect(x + ins, y + ins * (ch / cw), cw - ins * 2, ch - ins * 2 * (ch / cw), r);
            c.stroke();
          }
        }
        // safe lane hint
        if (this.opts.safeHint && g.safe >= 0 && g.safe < W) {
          const x = g.safe * cw;
          const grad = c.createLinearGradient(0, 0, 0, this.cssH);
          grad.addColorStop(0, 'rgba(124,242,156,0.10)');
          grad.addColorStop(0.5, 'rgba(124,242,156,0.03)');
          grad.addColorStop(1, 'rgba(124,242,156,0.10)');
          c.fillStyle = grad;
          c.fillRect(x, 0, cw, this.cssH);
        }
        // row wipe
        this.rowFx = this.rowFx.filter((r) => {
          const t = (now - r.t0) / r.dur;
          if (t >= 1) return false;
          c.fillStyle = `rgba(143,176,255,${0.5 * (1 - t)})`;
          c.fillRect(0, r.r * ch, this.cssW, ch);
          return true;
        });

        c.setTransform(1, 0, 0, 1, sx * d, sy * d);
        if (this.overlay.width) c.drawImage(this.overlay, 0, 0);
        c.setTransform(d, 0, 0, d, sx * d, sy * d);

        if (this.opts.safeHint && g.safe >= 0 && g.safe < W) {
          c.fillStyle = 'rgba(124,242,156,0.85)';
          const mx = (g.safe + 0.5) * cw, s = Math.max(3, cw * 0.12);
          c.beginPath(); c.moveTo(mx - s, 0); c.lineTo(mx + s, 0); c.lineTo(mx, s * 0.9); c.fill();
          c.beginPath(); c.moveTo(mx - s, this.cssH); c.lineTo(mx + s, this.cssH); c.lineTo(mx, this.cssH - s * 0.9); c.fill();
        }

        // beams (cross, safe lane)
        this.beams = this.beams.filter((b) => {
          const t = (now - b.t0) / b.dur;
          if (t >= 1) return false;
          const a = 0.8 * (1 - t);
          c.fillStyle = `rgba(${b.color},${a})`;
          if (b.row !== undefined) c.fillRect(0, b.row * ch + ch * 0.5 * t, this.cssW, ch * (1 - t));
          if (b.col !== undefined) c.fillRect(b.col * cw + cw * 0.5 * t, 0, cw * (1 - t), this.cssH);
          return true;
        });

        // head
        if (!g.over || now % 600 < 400) this.drawHead(now, spr);
        if (g.rival) this.drawRival(now, pal, g.ink);
      }

      // rings
      c.lineWidth = Math.max(1.5, cw * 0.06);
      this.rings = this.rings.filter((r) => {
        const t = (now - r.t0) / r.dur;
        if (t >= 1) return false;
        if (t < 0) return true;
        const m = this.warp ? this.warp(r.x, r.y) : { x: r.x, y: r.y, k: 1, z: 1 };
        if (m.z < 0) return true;
        const rad = (r.inward ? r.r * (1 - easeOut(t)) + 2 : r.r * easeOut(t) + 2) * m.k;
        c.strokeStyle = `rgba(${r.color},${1 - t})`;
        c.beginPath(); c.ellipse(m.x, m.y, rad, rad * (ch / cw), 0, 0, Math.PI * 2); c.stroke();
        return true;
      });

      // particles
      this.particles = this.particles.filter((p) => {
        p.life += dt;
        if (p.life >= p.max) return false;
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.0006 * dt * cw * 0.05;
        const m = this.warp && !p.screen ? this.warp(p.x, p.y) : { x: p.x, y: p.y, k: 1, z: 1 };
        if (m.z < 0) return true;
        const size = p.size * m.k;
        c.globalAlpha = 1 - p.life / p.max;
        c.fillStyle = p.color;
        c.fillRect(m.x - size / 2, m.y - size / 2, size, size);
        return true;
      });
      c.globalAlpha = 1;

      // popups
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      this.popups = this.popups.filter((p) => {
        const t = (now - p.t0) / p.dur;
        if (t >= 1) return false;
        const rise = easeOut(Math.min(1, t * 1.4)) * ch * 1.6;
        let x, y;
        if (this.warp) {
          // On the globe, popups rise from their cell's standing position.
          const m = this.warp(p.x, p.y);
          x = m.x; y = m.y - ch * 0.6 - rise;
        } else {
          y = Math.max(ch * 0.9, p.y - rise);
          x = Math.min(this.cssW - cw * 1.5, Math.max(cw * 1.5, p.x));
        }
        c.globalAlpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
        if (p.sprite !== undefined) {
          const pop = 1 + 0.25 * Math.sin(Math.min(1, t * 4) * Math.PI);
          c.drawImage(spr[p.sprite], x - cw * 0.6 * pop, y - ch * 0.6 * pop, cw * 1.2 * pop, ch * 1.2 * pop);
          y -= ch * 0.95;
        }
        const fs = Math.max(11, cw * 0.42) * p.scale;
        c.font = `700 ${fs}px "Chakra Petch", system-ui, sans-serif`;
        c.lineWidth = fs * 0.22;
        c.strokeStyle = 'rgba(7,10,19,0.85)';
        c.strokeText(p.text, x, y);
        c.fillStyle = p.color;
        c.fillText(p.text, x, y);
        return true;
      });
      c.globalAlpha = 1;

      // freeze tint
      if (g.freezeLeft > 0) this.tint('120,190,255', 0.12 + 0.05 * Math.sin(now / 120));
      // hunger vignette
      if (g.hunger > 0 && this.warp) this.tint('255,140,40', 0.2 + 0.08 * Math.sin(now / 90));
      else if (g.hunger > 0) {
        const grad = c.createRadialGradient(this.cssW / 2, this.cssH / 2, this.cssH * 0.3, this.cssW / 2, this.cssH / 2, this.cssW * 0.7);
        grad.addColorStop(0, 'rgba(255,140,40,0)');
        grad.addColorStop(1, `rgba(255,140,40,${0.22 + 0.08 * Math.sin(now / 90)})`);
        c.fillStyle = grad;
        c.fillRect(0, 0, this.cssW, this.cssH);
      }
      // screen flash
      if (this.flash) {
        const t = (now - this.flash.t0) / this.flash.dur;
        if (t >= 1) this.flash = null;
        else {
          this.tint(this.flash.color, this.flash.a * (1 - t));
        }
      }
      if (this.dim > 0) this.tint('7,10,19', this.dim);
    }

    // Full-view colour wash. On the planet it's a soft glow around the globe, so the
    // canvas edges never show against space.
    tint(rgb, a) {
      const c = this.ctx;
      if (this.warp && this.sphereView) {
        const v = this.sphereView;
        const grad = c.createRadialGradient(v.cx, v.cy, v.R * 0.6, v.cx, v.cy, v.R * 1.35);
        grad.addColorStop(0, `rgba(${rgb},${a})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        c.fillStyle = grad;
        c.beginPath(); c.arc(v.cx, v.cy, v.R * 1.35, 0, Math.PI * 2); c.fill();
        return;
      }
      c.fillStyle = `rgba(${rgb},${a})`;
      c.fillRect(0, 0, this.cssW, this.cssH);
    }

    drawRival(now, pal, ink) {
      const r = this.game.rival, c = this.ctx, cw = this.cw, ch = this.ch;
      if (this.rivalAnim.id !== r.moveId) this.rivalAnim = { id: r.moveId, t0: now, fx: r.prevX, fy: r.prevY };
      const far = Math.abs(r.x - this.rivalAnim.fx) > 1 || Math.abs(r.y - this.rivalAnim.fy) > 1;
      const t = far ? 1 : Math.min(1, (now - this.rivalAnim.t0) / 110);
      const hx = lerp(this.rivalAnim.fx, r.x, easeOut(t)) * cw, hy = lerp(this.rivalAnim.fy, r.y, easeOut(t)) * ch;
      const pulse = 0.7 + 0.3 * Math.sin(now / 90);
      const grad = c.createRadialGradient(hx + cw / 2, hy + ch / 2, 0, hx + cw / 2, hy + ch / 2, cw * 1.3);
      grad.addColorStop(0, `rgba(124,242,156,${0.55 * pulse})`);
      grad.addColorStop(1, 'rgba(124,242,156,0)');
      c.fillStyle = grad;
      c.fillRect(hx - cw, hy - ch, cw * 3, ch * 3);
      c.drawImage(this.sprites(pal, ink, 'rival')[T.POWERED], hx, hy, cw + 0.5, ch + 0.5);
    }

    drawHead(now, spr) {
      const g = this.game, c = this.ctx, cw = this.cw, ch = this.ch;
      if (this.headAnim.id !== g.moveId) {
        this.headAnim = { id: g.moveId, t0: now, fromX: g.prevX, fromY: g.prevY, wrap: g.wrapped };
      }
      const dur = Math.min(110, g.turnDelay() * 0.5);
      const t = this.headAnim.wrap ? 1 : Math.min(1, (now - this.headAnim.t0) / dur);
      const hx = lerp(this.headAnim.fromX ?? g.x, g.x, easeOut(t)) * cw;
      const hy = lerp(this.headAnim.fromY ?? g.y, g.y, easeOut(t)) * ch;
      const powered = g.powered || g.hunger > 0;
      const glow = g.hunger > 0 ? '255,179,71' : g.powered ? '92,225,255' : '255,121,208';
      const pulse = 0.75 + 0.25 * Math.sin(now / (powered ? 70 : 260));
      const grad = c.createRadialGradient(hx + cw / 2, hy + ch / 2, 0, hx + cw / 2, hy + ch / 2, cw * 1.25);
      grad.addColorStop(0, `rgba(${glow},${0.55 * pulse})`);
      grad.addColorStop(1, `rgba(${glow},0)`);
      c.fillStyle = grad;
      c.fillRect(hx - cw, hy - ch, cw * 3, ch * 3);
      c.drawImage(spr[powered ? T.POWERED : T.HEAD], hx, hy, cw + 0.5, ch + 0.5);
      if (g.powered) {
        c.strokeStyle = `rgba(92,225,255,${0.9 * pulse})`;
        c.lineWidth = Math.max(1.5, cw * 0.07);
        c.beginPath();
        c.ellipse(hx + cw / 2, hy + ch / 2, cw * 0.62, ch * 0.62, 0, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }

  root.ReflexRender = { Renderer, PALETTES, CELL_ASPECT, VARIANTS };
})(window);
