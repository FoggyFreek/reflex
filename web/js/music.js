// Game+ music: a beat conductor that also clocks the game, and a synthwave engine built
// from stacked layers. The layers (metronome, hi-hat, beat, bass, chords, melody, brass)
// fade in on bar lines as intensity rises. Everything is synthesized; there are no samples.
//
// Timing uses the lookahead pattern from "A Tale of Two Clocks" (web.dev): a 25 ms JS
// timer schedules audio events due in the next 120 ms against AudioContext.currentTime.
(function (root) {
  'use strict';

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rnd(a.length)];

  // A minor: Am - F - C - G, as semitone offsets from A. Hunger mode starts on C (brighter).
  const PROG = [
    { root: 0, tones: [0, 3, 7] },
    { root: -4, tones: [-4, 0, 3] },
    { root: 3, tones: [3, 7, 10] },
    { root: -2, tones: [-2, 2, 5] },
  ];
  const PROG_HUNGER = [PROG[2], PROG[3], PROG[0], PROG[1]];
  const SCALE = [0, 2, 3, 5, 7, 8, 10];

  const LAYERS = [
    { name: 'Metronome', at: 0, gain: 0.3 },
    { name: 'Hi-hat', at: 0.12, gain: 0.22 },
    { name: 'Beat', at: 0.25, gain: 0.85 },
    { name: 'Bass', at: 0.35, gain: 0.42 },
    { name: 'Chords', at: 0.45, gain: 0.16 },
    { name: 'Melody', at: 0.6, gain: 0.15 },
    { name: 'Brass', at: 0.75, gain: 0.17 },
  ];

  // ---------------------------------------------------------------- conductor
  class Conductor {
    constructor(ctx) {
      this.ctx = ctx && ctx.state === 'running' ? ctx : null;
      this.bpm = 84;
      this.step = 0;
      this.bar = 0;
      this.running = false;
      this.paused = false;
      this.handlers = [];
      this.waiters = [];
      this.turns = [];
      this.timers = new Set();
      this.tempoProvider = null;
    }
    now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }
    toPerf(t) { return performance.now() + (t - this.now()) * 1000; }
    get stepDur() { return 60 / this.bpm / 4; }
    get turnMs() { return this.stepDur * 2000; }

    start(bpm) {
      this.bpm = bpm || this.bpm;
      this.nextTime = this.now() + 0.08;
      this.running = true;
      this.interval = setInterval(() => this.schedule(), 25);
      this.schedule();
    }
    stop() {
      this.running = false;
      clearInterval(this.interval);
      for (const e of this.timers) clearTimeout(e.id);
      this.timers.clear();
      this.waiters.length = 0;
    }
    pause() {
      if (this.paused || !this.running) return;
      this.paused = true;
      clearInterval(this.interval);
      for (const e of this.timers) { clearTimeout(e.id); this.waiters.push(...e.ws); }
      this.timers.clear();
      this.turns.length = 0;
    }
    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.nextTime = this.now() + 0.06;
      this.interval = setInterval(() => this.schedule(), 25);
      this.schedule();
    }

    schedule() {
      if (!this.running || this.paused) return;
      const horizon = this.now() + 0.12;
      while (this.nextTime < horizon) {
        const s = this.step % 16;
        if (s === 0) {
          const b = this.tempoProvider && this.tempoProvider();
          if (b) this.bpm = b;
          for (const h of this.handlers) if (h.onBar) h.onBar(this.bar, this.nextTime, this);
        }
        for (const h of this.handlers) if (h.onStep) h.onStep(s, this.nextTime, this.bar, this);
        if (s % 2 === 0) this.addTurn(this.nextTime, s);
        this.nextTime += this.stepDur;
        this.step++;
        if (this.step % 16 === 0) this.bar++;
      }
    }

    addTurn(t, s) {
      const turn = { t, perf: this.toPerf(t), downbeat: s === 0, beat: s % 4 === 0 };
      this.turns.push(turn);
      if (this.turns.length > 12) this.turns.shift();
      if (this.waiters.length) this.fire(turn, this.waiters.splice(0));
    }
    fire(turn, ws) {
      const entry = { ws, id: 0 };
      entry.id = setTimeout(() => { this.timers.delete(entry); ws.forEach((r) => r()); }, Math.max(0, turn.perf - performance.now()));
      this.timers.add(entry);
    }
    // Resolves on the next 8th-note boundary: one worm move per 8th note.
    nextTurn() {
      return new Promise((resolve) => {
        const now = performance.now();
        const up = this.turns.find((tr) => tr.perf > now + 2);
        if (up && !this.paused) this.fire(up, [resolve]);
        else this.waiters.push(resolve);
      });
    }
    // For visuals: where we are inside the current move (0..1), and whether it began a bar.
    phase(nowPerf) {
      let last = null;
      for (const tr of this.turns) if (tr.perf <= nowPerf) last = tr;
      if (!last) return { phase: 1, downbeat: false, beat: false };
      return { phase: Math.min(1, (nowPerf - last.perf) / this.turnMs), downbeat: last.downbeat, beat: last.beat };
    }
    // Next 16th-note time on the audio clock, for quantized stingers.
    quant(ahead = 0.012) {
      const t = this.now() + ahead;
      const k = Math.floor((this.nextTime - t) / this.stepDur);
      return Math.max(t, this.nextTime - k * this.stepDur);
    }
  }

  // ---------------------------------------------------------------- music
  class Music {
    constructor(ctx) {
      this.ctx = ctx;
      this.enabled = true;
      this.volume = 0.8;
      this.state = () => ({});
      this.debugIntensity = null;
      this.intensity = 0;
      this.recover = 1;
      this.on = LAYERS.map((l, i) => i === 0);
      this.tail = LAYERS.map(() => -1);
      this.chord = PROG[0];
      this.transpose = 0;
      this.hunger = false;
      this.boss = false;
      this.motif = null;
      this.motifKey = null;

      const c = ctx;
      this.master = c.createGain();
      this.master.gain.value = 0;
      this.filter = c.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 18000;
      this.filter.Q.value = 0.8;
      this.comp = c.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.2;
      this.master.connect(this.filter).connect(this.comp).connect(c.destination);
      this.layerGains = LAYERS.map(() => {
        const g = c.createGain();
        g.gain.value = 0;
        g.connect(this.master);
        return g;
      });
      this.stingGain = c.createGain();
      this.stingGain.gain.value = 0.3;
      this.stingGain.connect(this.master);
      // A short feedback delay gives the lead and stingers a synthwave echo.
      this.echo = c.createDelay(1);
      this.echoFb = c.createGain();
      this.echoFb.gain.value = 0.28;
      this.echoOut = c.createGain();
      this.echoOut.gain.value = 0.22;
      this.echo.connect(this.echoFb).connect(this.echo);
      this.echo.connect(this.echoOut).connect(this.master);
      this.layerGains[5].connect(this.echo);
      this.stingGain.connect(this.echo);

      const len = c.sampleRate;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }

    get layers() { return LAYERS.map((l, i) => ({ name: l.name, on: this.on[i], gain: +this.layerGains[i].gain.value.toFixed(3) })); }

    start() {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this.enabled ? this.volume : 0, t + 0.3);
      this.filter.frequency.cancelScheduledValues(t);
      this.filter.frequency.setValueAtTime(18000, t);
      this.on = LAYERS.map((l, i) => i === 0);
      this.recover = 1;
      this.layerGains.forEach((g, i) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(i === 0 ? LAYERS[0].gain : 0, t); });
    }
    setEnabled(on) {
      this.enabled = on;
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(on ? this.volume : 0, t, 0.05);
    }
    setVolume(v) { this.volume = v; if (this.enabled) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
    stop() {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(0, t + 0.4);
    }
    muffle(on) {
      this.muffled = on;
      this.filter.frequency.setTargetAtTime(on ? 900 : 18000, this.ctx.currentTime, 0.15);
    }

    // Recompute intensity and decide which layers play this bar.
    onBar(bar, t, cond) {
      const st = this.state() || {};
      const lvl = st.level || 1;
      let I = Math.min(0.5, ((lvl - 1) / 29) * 0.5)
        + ((st.groove || 1) - 1) / 7 * 0.25
        + (st.danger || 0) * 0.25
        + (st.hunger ? 0.2 : 0)
        + (st.boss ? 0.3 : 0);
      I = Math.min(1, I) * this.recover;
      this.recover = Math.min(1, this.recover + 0.22);
      if (this.debugIntensity !== null && this.debugIntensity !== undefined) I = this.debugIntensity;
      this.intensity = I;
      this.hunger = !!st.hunger;
      this.boss = !!st.boss;
      const tr = Math.floor((lvl - 1) / 10) % 7;
      this.transpose = tr;
      const prog = this.hunger ? PROG_HUNGER : PROG;
      this.chord = prog[bar % 4];
      if (!this.motif || bar % 8 === 0 || this.motifKey !== tr) { this.motif = this.makeMotif(); this.motifKey = tr; }

      const barDur = cond.stepDur * 16;
      let active = 0;
      LAYERS.forEach((L, i) => {
        let want;
        if (i === 0) want = true;
        else if (this.on[i]) want = I >= L.at - 0.08;
        else want = I >= L.at;
        if (i === 1 && lvl >= 2 && this.recover > 0.5) want = true;
        if (i === 6 && this.boss) want = true;
        if (want !== this.on[i]) {
          const g = this.layerGains[i].gain;
          g.cancelScheduledValues(t);
          g.setValueAtTime(g.value, t);
          g.linearRampToValueAtTime(want ? L.gain : 0, t + barDur * (want ? 1 : 0.75));
          if (!want) this.tail[i] = bar + 1;
          this.on[i] = want;
        }
        if (want) active++;
      });
      // The metronome steps back as the band fills in.
      const mg = this.layerGains[0].gain;
      mg.setTargetAtTime(LAYERS[0].gain * Math.max(0.25, 1 - 0.13 * (active - 1)), t, barDur / 3);
      this.filter.frequency.setTargetAtTime(this.muffled ? 900 : st.freeze ? 700 : 18000, t, 0.12);
    }

    playing(i, bar) { return this.on[i] || this.tail[i] >= bar; }

    onStep(s, t, bar, cond) {
      if (!this.enabled) return;
      const I = this.intensity, sd = cond.stepDur;
      const tr = this.transpose, ch = this.chord;
      const L = this.layerGains;
      // L0: the original REFLEX turn tick, now a metronome on every 8th.
      if (s % 2 === 0) this.tick(t, s === 0 ? 1 : s % 4 === 0 ? 0.7 : 0.45, L[0]);
      // L1: hi-hat
      if (this.playing(1, bar)) {
        const sixteenths = I > 0.55 || this.hunger;
        if (sixteenths || s % 4 === 2) this.hat(t, s % 4 === 2 ? 1 : 0.45, I > 0.7 && s === 14, L[1]);
      }
      // L2: beat
      if (this.playing(2, bar)) {
        if (s === 0 || s === 8 || (I > 0.7 && (s === 4 || s === 12))) this.kick(t, L[2]);
        if (s === 4 || s === 12) this.snare(t, 1, L[2]);
        if (I > 0.88 && s === 15) this.snare(t, 0.35, L[2]);
      }
      // L3: bass, synthwave 8th pulse with an octave jump
      if (this.playing(3, bar) && s % 2 === 0) {
        const oct = s === 6 || s === 14 ? 12 : 0;
        this.bass(t, 33 + tr + ch.root + oct, sd * 1.8, L[3]);
      }
      // L4: chords
      if (this.playing(4, bar) && s === 0) this.pad(t, ch.tones.map((x) => 57 + tr + x), sd * 16, L[4]);
      // L5: melody
      if (this.playing(5, bar)) {
        const pos = (bar % 2) * 16 + s;
        const n = this.motif.find((m) => m.pos === pos);
        if (n) this.lead(t, 69 + tr + this.fitNote(n.p, s % 4 === 0), sd * n.len, L[5]);
      }
      // L6: brass stabs and swells
      if (this.playing(6, bar)) {
        const notes = ch.tones.map((x) => 57 + tr + x);
        if (s === 0 && (this.boss || I > 0.92)) this.brass(t, notes, sd * 15, true, L[6]);
        else if (s === 6 || s === 10 || (I > 0.9 && s === 14)) this.brass(t, notes, sd * 1.5, false, L[6]);
      }
    }

    fitNote(p, strong) {
      if (!strong) return p;
      let best = p, bd = 99;
      for (const c of this.chord.tones) for (const o of [-12, 0, 12]) {
        const d = Math.abs(c + o - p);
        if (d < bd) { bd = d; best = c + o; }
      }
      return best;
    }

    makeMotif() {
      const rhythms = [
        [0, 3, 6, 8, 10, 12, 16, 19, 22, 24, 28],
        [0, 2, 4, 7, 10, 14, 16, 18, 20, 23, 26],
        [0, 4, 6, 8, 12, 14, 16, 20, 24, 26, 28, 30],
        [0, 3, 6, 10, 12, 16, 19, 22, 26, 28],
      ];
      const r = pick(rhythms);
      let deg = pick([0, 2, 4]);
      const out = [];
      r.forEach((pos, k) => {
        deg = Math.max(-2, Math.min(9, deg + pick([-2, -1, 1, 1, 2, 0])));
        const p = SCALE[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
        const next = k + 1 < r.length ? r[k + 1] : 32;
        out.push({ pos, p, len: Math.max(1, Math.min(4, next - pos) - 0.2) });
      });
      return out;
    }

    // ------------------------------------------------------------ voices
    env(g, t, peak, a, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
    osc(type, freq, t, dur, dest) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
      return o;
    }
    tick(t, v, dest) {
      const g = this.ctx.createGain();
      g.connect(dest);
      this.env(g, t, 0.5 * v, 0.001, 0.025);
      this.osc('square', 2240, t, 0.03, g);
    }
    hat(t, v, open, dest) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7500;
      const g = this.ctx.createGain();
      src.connect(f).connect(g).connect(dest);
      this.env(g, t, 0.5 * v, 0.001, open ? 0.28 : 0.045);
      src.start(t, Math.random() * 0.5, 0.35);
    }
    kick(t, dest) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(155, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      const g = this.ctx.createGain();
      o.connect(g).connect(dest);
      this.env(g, t, 0.9, 0.002, 0.34);
      o.start(t); o.stop(t + 0.4);
    }
    snare(t, v, dest) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1900;
      f.Q.value = 0.7;
      const g = this.ctx.createGain();
      src.connect(f).connect(g).connect(dest);
      this.env(g, t, 0.55 * v, 0.001, 0.17);
      src.start(t, Math.random() * 0.5, 0.25);
      const tg = this.ctx.createGain();
      tg.connect(dest);
      this.env(tg, t, 0.25 * v, 0.001, 0.07);
      this.osc('triangle', 190, t, 0.09, tg);
    }
    bass(t, midi, dur, dest) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 5;
      f.frequency.setValueAtTime(900, t);
      f.frequency.exponentialRampToValueAtTime(220, t + dur);
      const g = this.ctx.createGain();
      f.connect(g).connect(dest);
      this.env(g, t, 0.7, 0.004, dur);
      this.osc('sawtooth', mtof(midi), t, dur, f);
      const sg = this.ctx.createGain();
      sg.gain.value = 0.6;
      sg.connect(g);
      this.osc('sine', mtof(midi - 12), t, dur, sg);
    }
    pad(t, notes, dur, dest) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(700, t);
      f.frequency.linearRampToValueAtTime(1800, t + dur * 0.5);
      f.frequency.linearRampToValueAtTime(900, t + dur);
      const g = this.ctx.createGain();
      f.connect(g).connect(dest);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + Math.min(0.35, dur * 0.3));
      g.gain.setValueAtTime(0.5, t + dur * 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.05);
      for (const n of notes) for (const det of [-8, 7]) {
        const o = this.osc('sawtooth', mtof(n), t, dur * 1.05, f);
        o.detune.value = det;
      }
    }
    lead(t, midi, dur, dest) {
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 3800;
      f.connect(g).connect(dest);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.008);
      g.gain.setValueAtTime(0.32, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const o = this.osc('square', mtof(midi), t, dur, f);
      o.frequency.setValueAtTime(mtof(midi), t + 0.1);
      o.frequency.linearRampToValueAtTime(mtof(midi + 0.12), t + dur);
    }
    brass(t, notes, dur, swell, dest) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 2;
      const g = this.ctx.createGain();
      f.connect(g).connect(dest);
      if (swell) {
        f.frequency.setValueAtTime(300, t);
        f.frequency.exponentialRampToValueAtTime(3200, t + dur * 0.9);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.55, t + dur * 0.9);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      } else {
        f.frequency.setValueAtTime(3000, t);
        f.frequency.exponentialRampToValueAtTime(500, t + dur);
        this.env(g, t, 0.6, 0.012, dur);
      }
      for (const n of notes) for (const det of [-12, 0, 11]) {
        const o = this.osc('sawtooth', mtof(n), t, dur, f);
        o.detune.value = det;
      }
    }
    bell(t, midi, v = 1, dur = 0.35) {
      const g = this.ctx.createGain();
      g.connect(this.stingGain);
      this.env(g, t, 0.5 * v, 0.003, dur);
      this.osc('triangle', mtof(midi), t, dur, g);
      const g2 = this.ctx.createGain();
      g2.connect(this.stingGain);
      this.env(g2, t, 0.18 * v, 0.002, dur * 0.5);
      this.osc('sine', mtof(midi + 12), t, dur, g2);
    }
    swell(t, dur) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(400, t - dur);
      f.frequency.exponentialRampToValueAtTime(5000, t);
      const g = this.ctx.createGain();
      src.connect(f).connect(g).connect(this.stingGain);
      g.gain.setValueAtTime(0.0001, t - dur);
      g.gain.exponentialRampToValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.start(t - dur, 0, dur + 0.1);
    }

    // ------------------------------------------------------------ stingers
    // Every stinger lands on the next 16th and uses the current chord, so it's in key.
    stinger(kind, cond, o = {}) {
      if (!this.enabled) return 0;
      const t = cond.quant();
      const sd = cond.stepDur;
      const tr = this.transpose;
      const tones = this.chord.tones;
      const chordNote = (k) => 72 + tr + tones[((k % 3) + 3) % 3] + 12 * Math.floor(k / 3);
      switch (kind) {
        case 'pickup': {
          const base = Math.min(6, (o.groove || 1) - 1);
          for (let k = 0; k < 3; k++) this.bell(t + k * sd, chordNote(base + k), 0.9);
          return sd * 3000;
        }
        case 'blip': {
          const m = 12 * Math.log2((o.freq || 440) / 440) + 69;
          let best = chordNote(0), bd = 99;
          for (let k = -3; k < 9; k++) { const c = chordNote(k); if (Math.abs(c - m) < bd) { bd = Math.abs(c - m); best = c; } }
          this.bell(t, Math.max(60, Math.min(96, best)), 0.7, 0.25);
          return sd * 1000;
        }
        case 'graze': this.bell(t, chordNote(6), 0.35, 0.12); return 0;
        case 'shield': this.swell(t + sd, sd * 2); this.bell(t + sd, chordNote(3), 0.8); return 0;
        case 'wipe': for (let k = 0; k < 6; k++) this.bell(t + k * sd * 0.5, chordNote(5 - k), 0.55, 0.2); return sd * 3000;
        case 'martini': for (let k = 0; k < 8; k++) this.bell(t + k * sd, chordNote(k), 0.8, 0.3); return sd * 8000;
        case 'extraman': for (let k = 0; k < 5; k++) this.bell(t + k * sd, chordNote(k + 1) + (k === 4 ? 12 : 0), 0.9, 0.3); return sd * 5000;
        case 'demon': this.brass(t, tones.map((x) => 45 + tr + x), sd * 3, false, this.stingGain); return sd * 4000;
        case 'cross': case 'boss': case 'rivalCrash':
          this.brass(t, tones.map((x) => 57 + tr + x), sd * (kind === 'boss' ? 8 : 3), kind === 'boss', this.stingGain);
          if (kind !== 'boss') for (let k = 0; k < 4; k++) this.bell(t + k * sd, chordNote(k + 3), 0.7);
          return sd * 4000;
        case 'devolve': for (let k = 0; k < 4; k++) this.bell(t + k * sd * 0.5, chordNote(4) - k, 0.5, 0.18); return sd * 2000;
        case 'island': this.bell(t, chordNote(-3), 0.5, 0.2); return 0;
        case 'rewind': this.swell(t + sd * 2, sd * 3); for (let k = 0; k < 4; k++) this.bell(t + k * sd * 0.5, chordNote(6 - k), 0.6, 0.2); return sd * 4000;
        case 'death': {
          // Tape stop: the band drops out and rebuilds over the next few bars.
          const now = this.ctx.currentTime;
          this.filter.frequency.cancelScheduledValues(now);
          this.filter.frequency.setValueAtTime(12000, now);
          this.filter.frequency.exponentialRampToValueAtTime(180, now + 0.5);
          this.filter.frequency.setTargetAtTime(18000, now + 0.9, 0.6);
          this.recover = 0;
          return 0;
        }
        case 'gameover': {
          const now = this.ctx.currentTime;
          this.layerGains.forEach((g) => { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + 1.2); });
          this.pad(now + 0.05, [57 + tr, 60 + tr, 64 + tr], 3, this.stingGain);
          this.on = LAYERS.map(() => false);
          return 0;
        }
        default: return 0;
      }
    }
  }

  root.ReflexMusic = { Conductor, Music, LAYERS };
})(window);
