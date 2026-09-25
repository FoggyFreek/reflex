// Game+ "Planet view": the board drawn on a globe that rolls under the worm.
//
// Projection: every cell's offset from the worm (wrapped, so the torus never shows a
// seam) becomes an angle on the sphere (azimuthal equidistant around the worm). The worm
// stays at the centre of the view and the globe turns the opposite way it moves.
// Ground (trail, empty, portals, barren) is mapped flat onto each cell; objects are 2D
// billboards standing on their cell. On each level-down the planet shatters and the worm
// drops onto a new one.
(function (root) {
  'use strict';

  const { W, H, T } = root.Reflex;
  const { VARIANTS } = root.ReflexRender;
  const SW = 27, SH = 17;
  const DEG = Math.PI / 180;
  const SX = 7.4 * DEG, SY = 6.4 * DEG;   // angle per column / row (keeps the cell aspect)
  const TILT = 14 * DEG;                   // camera looks slightly down on the worm
  const ZOOM = 1.3;                        // >1 lets the globe's lower edge run past the view
  const SIN_T = Math.sin(TILT), COS_T = Math.cos(TILT);
  const FLAT = new Set([T.TRAIL, T.CLEAR, T.EMPTY, T.TRANSPORT, T.SUPER, T.PREBARREN, T.BARREN]);

  // One look per level; the list repeats.
  const THEMES = [
    { ground: '#28365f', base: '#141c33', atmo: '92,141,255' },
    { ground: '#1f4a4f', base: '#0f2628', atmo: '43,196,196' },
    { ground: '#3e2d5c', base: '#1d1530', atmo: '185,140,255' },
    { ground: '#553128', base: '#2a1712', atmo: '255,140,90' },
    { ground: '#2a4d34', base: '#12261a', atmo: '124,242,156' },
    { ground: '#4d4524', base: '#27220f', atmo: '255,212,71' },
    { ground: '#552848', base: '#2a1224', atmo: '255,121,208' },
    { ground: '#23405a', base: '#0f1f2e', atmo: '150,220,255' },
  ];
  THEMES.forEach((th, k) => { VARIANTS['planet' + k] = { 11: th.ground }; });
  VARIANTS.cut = { 11: null };
  VARIANTS.rivalcut = Object.assign({}, VARIANTS.rival, { 11: null });

  const wrapf = (v, n) => { v = ((v % n) + n) % n; return v >= n / 2 ? v - n : v; };
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeOutBack = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class SphereView {
    constructor(renderer) {
      this.r = renderer;
      this.cam = { id: -1, t0: 0, fx: 0, fy: 0 };
      this.anim = null;
      this.stars = Array.from({ length: 160 }, () => ({
        x: Math.random(), y: Math.random(), s: Math.random() * 1.4 + 0.3, p: Math.random() * 6.28,
      }));
    }

    active() { const r = this.r; return !!(r.opts.sphere && r.game && r.game.plus); }
    theme(level) { return THEMES[(Math.max(1, level) - 1) % THEMES.length]; }
    themeKey(level) { return 'planet' + ((Math.max(1, level) - 1) % THEMES.length); }

    // Globe size and centre. The worm sits at the middle of the canvas.
    layout(scale = 1) {
      const w = this.r.cssW, h = this.r.cssH;
      const R0 = ZOOM * Math.min(w * 0.44, (h * 0.5 - h * 0.07) / (1 + SIN_T));
      const R = R0 * scale;
      this.px = w / 2; this.py = h / 2;
      this.R = R;
      // A planet growing in keeps its core fixed; at full size the worm is back at the centre.
      this.cx = w / 2; this.cy = h / 2 + R0 * SIN_T;
      this.cellW = R0 * SX;
    }

    // Board offset (in cells) from the worm -> screen point on the globe.
    project(du, dv) {
      const a = du * SX, b = dv * SY;
      const dd = Math.hypot(a, b);
      const k = dd < 1e-6 ? 1 : Math.sin(dd) / dd;
      const lx = a * k, ly = b * k, lz = Math.cos(dd);
      const X = lx, Y = ly * COS_T - lz * SIN_T, Z = ly * SIN_T + lz * COS_T;
      return { x: this.cx + this.R * X, y: this.cy + this.R * Y, z: Z, nx: X, ny: Y };
    }

    // A cell's offset plus its wrapped repeats that land on the camera-facing half of the globe.
    copies(du, dv) {
      const out = [];
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const u = du + kx * W, v = dv + ky * H;
          if (Math.hypot(u * SX, v * SY) < 1.9) out.push([u, v]);
        }
      }
      return out;
    }

    // Worm position between cells, so the globe rolls smoothly.
    camera(now) {
      const g = this.r.game;
      if (this.cam.id !== g.moveId) {
        let dx = wrapf(g.x - g.prevX, W), dy = wrapf(g.y - g.prevY, H);
        if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) dx = dy = 0;
        this.cam = { id: g.moveId, t0: now, dx, dy };
      }
      const cond = this.r.conductor;
      const dur = cond ? Math.min(180, cond.turnMs * 0.6) : 120;
      const e = easeOut(Math.min(1, (now - this.cam.t0) / dur));
      return { x: g.x - this.cam.dx * (1 - e), y: g.y - this.cam.dy * (1 - e) };
    }

    // Maps the flat renderer's pixel coordinates (used by popups, particles and rings).
    warp(px, py) {
      const cw = this.r.cw, ch = this.r.ch;
      const du = wrapf(px / cw - 0.5 - this.camX, W), dv = wrapf(py / ch - 0.5 - this.camY, H);
      const p = this.project(du, dv);
      p.k = (0.45 + 0.55 * Math.max(0, p.z)) * (this.cellW / cw);
      return p;
    }

    explode(now, level) {
      if (!this.active()) return;
      const r = this.r;
      const snap = document.createElement('canvas');
      snap.width = r.canvas.width; snap.height = r.canvas.height;
      const sc = snap.getContext('2d');
      sc.imageSmoothingEnabled = false;
      this.layout(1);
      const prevLevel = this.shownLevel || Math.max(1, level - 1);
      this.drawGlobe(sc, now, 0, 0, prevLevel, true);

      // Rings of jagged wedges around the core; the outer pieces are larger.
      const C = { x: this.cx, y: this.cy }, R = this.R;
      const radii = [0, 0.26, 0.52, 0.78, 1.06];
      const segs = [6, 10, 14, 18];
      const pieces = [];
      const pt = (a, rr) => { const j = 1 + (Math.random() - 0.5) * 0.08; return { x: C.x + Math.cos(a) * rr * R * j, y: C.y + Math.sin(a) * rr * R * j }; };
      for (let k = 0; k < segs.length; k++) {
        const n = segs[k], step = (Math.PI * 2) / n, off = Math.random() * step;
        const angles = Array.from({ length: n }, (_, j) => off + j * step + (Math.random() - 0.5) * step * 0.45);
        for (let j = 0; j < n; j++) {
          const a0 = angles[j], a1 = j + 1 < n ? angles[j + 1] : angles[0] + Math.PI * 2;
          const poly = [];
          for (let m = 0; m <= 3; m++) poly.push(pt(a0 + ((a1 - a0) * m) / 3, radii[k + 1]));
          if (k === 0) poly.push({ x: C.x, y: C.y });
          else for (let m = 3; m >= 0; m--) poly.push(pt(a0 + ((a1 - a0) * m) / 3, radii[k]));
          const cx = poly.reduce((a, q) => a + q.x, 0) / poly.length, cy = poly.reduce((a, q) => a + q.y, 0) / poly.length;
          const dx = cx - C.x, dy = cy - C.y, dist = Math.hypot(dx, dy) || 1;
          const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
          // Speed grows with distance from the core, so the planet visibly expands outward.
          const speed = (0.12 + 0.55 * (dist / R)) * (0.85 + Math.random() * 0.3) * (R / 300);
          pieces.push({
            poly, cx, cy, ring: k,
            vx: (dx / dist) * speed, vy: (dy / dist) * speed,
            spin: (Math.random() - 0.5) * 0.004 * (k + 1),
            box: [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2],
          });
        }
      }
      this.anim = { t0: now, snap, pieces, C, R, atmo: this.theme(prevLevel).atmo, blasted: false };
      this.shownLevel = level;
      r.shake = Math.max(r.shake, 6);
    }

    draw(c, now, dt, sx, sy) {
      const r = this.r, g = r.game, d = r.dpr;
      if (!this.shownLevel) this.shownLevel = g.level;
      const cam = this.camera(now);
      this.camX = cam.x; this.camY = cam.y;

      // Level-down: the core cracks (0-0.26 s) and blasts the planet apart; a new planet
      // grows from the core (0.55-1.15 s) while the worm falls onto it.
      let scale = 1, drop = 0;
      const A = this.anim;
      if (A) {
        const t = (now - A.t0) / 1000;
        if (t > 1.5) this.anim = null;
        scale = t < 0.55 ? 0.001 : Math.min(1, easeOutBack(clamp((t - 0.55) / 0.6, 0, 1)));
        drop = t < 1.15 ? (1 - easeOut(clamp(t / 1.15, 0, 1))) : 0;
      }
      c.setTransform(d, 0, 0, d, sx * d, sy * d);
      this.drawStars(c, now);
      this.layout(scale);
      if (scale > 0.01) this.drawGlobe(c, now, sx, sy, g.level, false, drop);
      if (A) this.drawShards(c, now, sx, sy, A);
      c.setTransform(d, 0, 0, d, sx * d, sy * d);
      this.layout(1); // popups, particles and rings use the full-size globe
    }

    drawStars(c, now) {
      const w = this.r.cssW, h = this.r.cssH;
      const ox = (this.camX || 0) * 4, oy = (this.camY || 0) * 4;
      for (const s of this.stars) {
        const x = (((s.x * w - ox) % w) + w) % w, y = (((s.y * h - oy) % h) + h) % h;
        c.globalAlpha = 0.35 + 0.35 * Math.sin(now / 700 + s.p);
        c.fillStyle = '#dfe6ff';
        c.fillRect(x, y, s.s, s.s);
      }
      c.globalAlpha = 1;
    }

    piecePath(c, poly) {
      c.beginPath();
      c.moveTo(poly[0].x, poly[0].y);
      for (let m = 1; m < poly.length; m++) c.lineTo(poly[m].x, poly[m].y);
      c.closePath();
    }

    drawShards(c, now, sx, sy, A) {
      const r = this.r, d = r.dpr, C = A.C, R = A.R;
      const CRACK = 260, BLAST = 950;
      const t = now - A.t0;
      c.setTransform(d, 0, 0, d, sx * d, sy * d);

      if (t < CRACK) {
        // The planet swells while cracks glow outward from a white-hot core.
        const k = t / CRACK;
        const sw = 1 + 0.035 * k;
        c.setTransform(d * sw, 0, 0, d * sw, (sx + C.x * (1 - sw)) * d, (sy + C.y * (1 - sw)) * d);
        c.drawImage(A.snap, 0, 0, A.snap.width / d, A.snap.height / d);
        const core = c.createRadialGradient(C.x, C.y, 0, C.x, C.y, R * (0.15 + 0.4 * k));
        core.addColorStop(0, `rgba(255,255,240,${0.9 * k})`);
        core.addColorStop(0.4, `rgba(255,190,90,${0.6 * k})`);
        core.addColorStop(1, 'rgba(255,120,40,0)');
        c.fillStyle = core;
        c.beginPath(); c.arc(C.x, C.y, R * 0.6, 0, Math.PI * 2); c.fill();
        c.lineWidth = 1 + 1.5 * k;
        for (const p of A.pieces) {
          if (p.ring > k * 4) continue; // cracks reach further out as the core heats up
          c.strokeStyle = `rgba(255,${200 - p.ring * 25},120,${0.9 * k})`;
          this.piecePath(c, p.poly);
          c.stroke();
        }
        return;
      }

      if (!A.blasted) {
        A.blasted = true;
        r.shake = Math.max(r.shake, 18);
        r.flash = { t0: now, dur: 450, color: '255,236,200', a: 0.5 };
        const n0 = r.particles.length;
        r.burst(C.x, C.y, 60, ['#fff6d8', '#ffd447', '#ffb347', `rgb(${A.atmo})`], 2.2);
        for (let k = n0; k < r.particles.length; k++) r.particles[k].screen = true; // already in view space
      }
      const bt = t - CRACK, u = Math.min(1, bt / BLAST);
      if (u >= 1) return;

      // fireball from the core
      const fr = R * (0.25 + 1.5 * easeOut(u));
      const fire = c.createRadialGradient(C.x, C.y, 0, C.x, C.y, fr);
      fire.addColorStop(0, `rgba(255,250,230,${0.95 * (1 - u)})`);
      fire.addColorStop(0.35, `rgba(255,190,90,${0.7 * (1 - u)})`);
      fire.addColorStop(0.7, `rgba(${A.atmo},${0.35 * (1 - u)})`);
      fire.addColorStop(1, `rgba(${A.atmo},0)`);
      c.fillStyle = fire;
      c.beginPath(); c.arc(C.x, C.y, fr, 0, Math.PI * 2); c.fill();

      // pieces fly straight out from the core, slowing slightly, spinning, glowing at the edges
      const travel = bt * (1 - 0.3 * u);
      for (const p of A.pieces) {
        const ox = p.vx * travel, oy = p.vy * travel, ang = p.spin * bt;
        const alpha = p.ring === 0 ? Math.max(0, 1 - u * 2.2) : 1 - u * u;
        if (alpha <= 0) continue;
        c.save();
        c.setTransform(d, 0, 0, d, (sx + ox) * d, (sy + oy) * d);
        c.translate(p.cx, p.cy); c.rotate(ang); c.translate(-p.cx, -p.cy);
        c.globalAlpha = alpha;
        this.piecePath(c, p.poly);
        c.save();
        c.clip();
        const [x0, y0, x1, y1] = p.box;
        c.drawImage(A.snap, x0 * d, y0 * d, (x1 - x0) * d, (y1 - y0) * d, x0, y0, x1 - x0, y1 - y0);
        // molten tint, strongest on the pieces nearest the core
        c.fillStyle = `rgba(255,150,60,${(0.55 - p.ring * 0.12) * (1 - u)})`;
        c.fillRect(x0, y0, x1 - x0, y1 - y0);
        c.restore();
        c.strokeStyle = `rgba(255,210,140,${0.9 * (1 - u)})`;
        c.lineWidth = 1.5;
        c.stroke();
        c.restore();
      }
      c.globalAlpha = 1;

      // shockwave
      c.setTransform(d, 0, 0, d, sx * d, sy * d);
      c.strokeStyle = `rgba(${A.atmo},${0.8 * (1 - u)})`;
      c.lineWidth = 2 + 10 * (1 - u);
      c.beginPath(); c.arc(C.x, C.y, R * (0.3 + u * 1.8), 0, Math.PI * 2); c.stroke();
    }

    // The globe: base disc, flat cells, shading, atmosphere, then standing billboards.
    drawGlobe(c, now, sx, sy, level, snapshot, drop = 0) {
      const r = this.r, g = r.game, d = r.dpr, pal = r.opts.palette;
      const th = this.theme(level);
      const ground = r.sprites(pal, g.ink, this.themeKey(level));
      const colors = root.ReflexRender.PALETTES[pal];
      const R = this.R;
      c.imageSmoothingEnabled = false;

      // atmosphere halo, beating with the music
      const beat = r.conductor && !snapshot ? r.conductor.phase(now) : { phase: 1, downbeat: false };
      const pulse = Math.pow(1 - beat.phase, 2) * (beat.downbeat ? 1 : 0.4);
      c.setTransform(d, 0, 0, d, sx * d, sy * d);
      const halo = c.createRadialGradient(this.cx, this.cy, R * 0.9, this.cx, this.cy, R * (1.22 + 0.06 * pulse));
      halo.addColorStop(0, `rgba(${th.atmo},${0.45 + 0.3 * pulse})`);
      halo.addColorStop(1, `rgba(${th.atmo},0)`);
      c.fillStyle = halo;
      c.beginPath(); c.arc(this.cx, this.cy, R * 1.3, 0, Math.PI * 2); c.fill();
      // base disc (shows through the gaps between cells as the grid)
      const base = c.createRadialGradient(this.cx - R * 0.3, this.cy - R * 0.4, R * 0.1, this.cx, this.cy, R);
      base.addColorStop(0, th.base);
      base.addColorStop(1, '#05070d');
      c.fillStyle = base;
      c.beginPath(); c.arc(this.cx, this.cy, R, 0, Math.PI * 2); c.fill();

      const pending = new Map();
      if (g.pending && !g.over && !snapshot) for (const p of g.pending) pending.set(p.i, p.inc);
      const ph = r.conductor ? r.conductor.phase(now).phase : 0.5;
      const standing = [];
      const gap = 0.07;

      // The board wraps, so its repeats tile the rest of the globe: tiles go all the way round.
      for (let i = 0; i < W * H; i++) {
        const x = i % W, y = (i / W) | 0;
        for (const [du, dv] of this.copies(wrapf(x - this.camX, W), wrapf(y - this.camY, H))) {
          const pc = this.project(du, dv);
          if (pc.z < 0.03) continue;
          const p00 = this.project(du - 0.5, dv - 0.5), p10 = this.project(du + 0.5, dv - 0.5), p01 = this.project(du - 0.5, dv + 0.5);
          if (p00.z < -0.02 || p10.z < -0.02 || p01.z < -0.02) continue;
          const q = (p) => ({ x: pc.x + (p.x - pc.x) * (1 - gap), y: pc.y + (p.y - pc.y) * (1 - gap) });
          const a = q(p00), b = q(p10), e = q(p01);
          c.setTransform(d * (b.x - a.x) / SW, d * (b.y - a.y) / SW, d * (e.x - a.x) / SH, d * (e.y - a.y) / SH, d * (a.x + sx), d * (a.y + sy));
          const v = g.disp[i];
          const flat = FLAT.has(v);
          c.drawImage(ground[flat ? v : T.EMPTY], 0, 0);
          if (!snapshot) this.cellOverlays(c, now, i, x, y, v, colors, pending, ph);
          // curvature shading: darker toward the limb
          c.fillStyle = `rgba(4,6,12,${0.62 * (1 - pc.z)})`;
          c.fillRect(0, 0, SW, SH);
          if (!flat) standing.push({ kind: 'obj', v, p: pc });
        }
      }

      // terminator light: a soft highlight from the upper left
      c.setTransform(d, 0, 0, d, sx * d, sy * d);
      const light = c.createRadialGradient(this.cx - R * 0.45, this.cy - R * 0.55, 0, this.cx - R * 0.45, this.cy - R * 0.55, R * 1.2);
      light.addColorStop(0, 'rgba(255,255,255,0.08)');
      light.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = light;
      c.beginPath(); c.arc(this.cx, this.cy, R, 0, Math.PI * 2); c.fill();

      if (!snapshot) {
        standing.push({ kind: 'head', p: this.project(0, 0) });
        if (g.rival) {
          const rv = g.rival;
          for (const [du, dv] of this.copies(wrapf(rv.x - this.camX, W), wrapf(rv.y - this.camY, H))) {
            standing.push({ kind: 'rival', p: this.project(du, dv) });
          }
        }
      }
      standing.sort((m, n) => m.p.y - n.p.y);
      const cut = r.sprites(pal, g.ink, 'cut');
      for (const s of standing) this.drawStanding(c, now, s, cut, sx, sy, drop);
    }

    // Per-cell effects, drawn in the cell's own 27x17 sprite space.
    cellOverlays(c, now, i, x, y, v, colors, pending, ph) {
      const r = this.r, g = r.game;
      if (v === T.BARREN) {
        const list = g.sparkles.get(i);
        if (list) for (const [px, py, col] of list) { c.fillStyle = colors[col]; c.fillRect(px, py, 1, 1); }
      }
      if (v === T.TRAIL) {
        const rival = g.owner && g.owner[i] === 2;
        c.strokeStyle = rival ? 'rgba(124,242,156,0.8)' : 'rgba(255,121,208,0.35)';
        c.lineWidth = 1.2;
        c.beginPath(); c.ellipse(SW / 2, SH / 2, SW * 0.44, SH * 0.42, 0, 0, Math.PI * 2); c.stroke();
      }
      if (r.opts.safeHint && x === g.safe) { c.fillStyle = 'rgba(124,242,156,0.10)'; c.fillRect(0, 0, SW, SH); }
      const f = r.cellFx.get(i);
      if (f) {
        const t = (now - f.t0) / f.dur;
        if (t >= 0 && t < 1) { c.fillStyle = `rgba(${f.color},${f.a * (1 - t)})`; c.fillRect(0, 0, SW, SH); }
      }
      for (const rf of r.rowFx) {
        if (rf.r !== y) continue;
        const t = (now - rf.t0) / rf.dur;
        if (t < 1) { c.fillStyle = `rgba(143,176,255,${0.5 * (1 - t)})`; c.fillRect(0, 0, SW, SH); }
      }
      for (const b of r.beams) {
        if (b.row !== y && b.col !== x) continue;
        const t = (now - b.t0) / b.dur;
        if (t < 1) { c.fillStyle = `rgba(${b.color},${0.8 * (1 - t)})`; c.fillRect(0, 0, SW, SH); }
      }
      const inc = pending.get(i);
      if (inc !== undefined && v !== T.BARREN) {
        const nv = Math.min(T.BARREN, g.val[i] + inc);
        const deadly = nv === T.PIGMAN || nv === T.DEMON || nv === T.BARREN;
        const good = nv >= T.TRANSPORT && nv !== T.DEMON && nv !== T.BARREN && nv !== T.ARROW;
        if (deadly || good) {
          c.strokeStyle = `rgba(${deadly ? '236,58,86' : '255,212,71'},${0.3 + 0.6 * ph})`;
          c.lineWidth = 1.6;
          const ins = 3 - 2 * ph;
          c.beginPath(); c.roundRect(ins, ins, SW - ins * 2, SH - ins * 2, 4); c.stroke();
        }
      }
    }

    // A 2D sprite standing on the surface; it leans outward toward the left and right limbs.
    drawStanding(c, now, s, cut, sx, sy, drop) {
      const r = this.r, g = r.game, d = r.dpr, p = s.p;
      if (p.z < 0.05) return;
      const lean = Math.asin(clamp(p.nx, -1, 1)) * 0.9;
      const depth = 0.55 + 0.45 * p.z;
      let w = this.cellW * 1.08 * depth;
      let h = w * (SH * 1.37) / SW;
      let bx = p.x, by = p.y;
      // shadow
      c.setTransform(d, 0, 0, d, (bx + sx) * d, (by + sy) * d);
      c.rotate(lean);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.beginPath(); c.ellipse(0, h * 0.12, w * 0.36, h * 0.12, 0, 0, Math.PI * 2); c.fill();

      if (s.kind === 'head') {
        // the worm drops onto a new planet after a level-down
        if (drop > 0) {
          by -= drop * r.cssH * 0.45;
          const squash = 1 + 0.25 * Math.sin(Math.min(1, (1 - drop) * 1.4) * Math.PI) * (drop < 0.25 ? 1 : 0);
          h /= squash; w *= squash;
        }
        const powered = g.powered || g.hunger > 0;
        const glow = g.hunger > 0 ? '255,179,71' : g.powered ? '92,225,255' : '255,121,208';
        const pulse = 0.75 + 0.25 * Math.sin(now / (powered ? 70 : 260));
        c.setTransform(d, 0, 0, d, (bx + sx) * d, (by + sy) * d);
        const grad = c.createRadialGradient(0, -h * 0.4, 0, 0, -h * 0.4, w * 1.4);
        grad.addColorStop(0, `rgba(${glow},${0.55 * pulse})`);
        grad.addColorStop(1, `rgba(${glow},0)`);
        c.fillStyle = grad;
        c.fillRect(-w * 1.5, -h * 2, w * 3, h * 3);
        if (!g.over || now % 600 < 400) c.drawImage(cut[powered ? T.POWERED : T.HEAD], -w / 2, -h * 0.85, w, h);
        if (g.powered) {
          c.strokeStyle = `rgba(92,225,255,${0.9 * pulse})`;
          c.lineWidth = 2;
          c.beginPath(); c.ellipse(0, -h * 0.35, w * 0.7, h * 0.75, 0, 0, Math.PI * 2); c.stroke();
        }
        return;
      }
      c.setTransform(d, 0, 0, d, (bx + sx) * d, (by + sy) * d);
      c.rotate(lean);
      if (s.kind === 'rival') {
        const grad = c.createRadialGradient(0, -h * 0.4, 0, 0, -h * 0.4, w * 1.3);
        grad.addColorStop(0, 'rgba(124,242,156,0.5)');
        grad.addColorStop(1, 'rgba(124,242,156,0)');
        c.fillStyle = grad;
        c.fillRect(-w * 1.5, -h * 2, w * 3, h * 3);
        c.drawImage(r.sprites(r.opts.palette, g.ink, 'rivalcut')[T.POWERED], -w / 2, -h * 0.85, w, h);
        return;
      }
      c.drawImage(cut[s.v], -w / 2, -h * 0.85, w, h);
    }
  }

  root.ReflexSphere = { SphereView, THEMES };
})(window);
