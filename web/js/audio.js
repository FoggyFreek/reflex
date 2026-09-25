// PC-speaker emulation. The original drives one square-wave voice with
// sound(freq) / delay(ms) / nosound(). Every effect here is a list of
// [freq, ms] steps (freq 0 = silence) played on a single voice, so a new effect
// cuts off the previous one, as it did on real hardware. A low-pass filter
// softens the harshest edges for modern speakers and headphones.
(function (root) {
  'use strict';

  const rnd = (n) => Math.floor(Math.random() * n);

  class Speaker {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.tickEnabled = true;
      this.volume = 0.07;
    }

    unlock() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.osc = ctx.createOscillator();
      this.osc.type = 'square';
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;
      this.osc.connect(this.gain).connect(lp).connect(ctx.destination);
      this.osc.start();
    }

    // Returns the effect's total duration in ms.
    play(steps, vol = 1) {
      const total = steps.reduce((a, s) => a + s[1], 0);
      if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return total;
      const f = this.osc.frequency, g = this.gain.gain;
      let t = this.ctx.currentTime + 0.005;
      f.cancelScheduledValues(t); g.cancelScheduledValues(t);
      for (const [freq, ms] of steps) {
        if (freq >= 20) {
          f.setValueAtTime(Math.min(freq, 12000), t);
          g.setValueAtTime(this.volume * vol, t);
        } else if (freq > 0) {
          // Sub-audio tones (the original's 20 Hz) come out as a click.
          f.setValueAtTime(40, t);
          g.setValueAtTime(this.volume * vol * 0.8, t);
        } else {
          g.setValueAtTime(0, t);
        }
        t += Math.max(ms, 1) / 1000;
      }
      g.setValueAtTime(0, t);
      return total;
    }

    // Named effects, each derived from the matching routine in REFLEX.EXE.
    fx(name, a, b) {
      switch (name) {
        case 'tick': return this.tickEnabled ? this.play([[2240, 3]], 0.35) : 0;
        case 'click': return this.play([[20, 4]], 0.6);
        case 'shield': return this.play([[2500, 60]], 0.6);
        case 'tone': return this.play([[a, b]]);
        case 'death': { // sub_0ddc: two converging tones
          const s = [];
          for (let k = 0; k < 40; k++) s.push([200 + k * 9, 7], [1500 - k * 24, 4]);
          s.push([90, 120], [60, 160]);
          return this.play(s);
        }
        case 'gameover': {
          const s = [];
          for (let k = 0; k < 24; k++) s.push([600 - k * 20, 22], [0, 6]);
          return this.play(s, 0.8);
        }
        case 'martini': { // sub_0d64: rising sweep with random blips
          const s = [];
          for (let si = 10; si < 70; si += 2) s.push([si * 50, 72 - si], [rnd(1000) + 50, 3]);
          return this.play(s);
        }
        case 'demon': { // sub_0d9e: low growl
          const s = [];
          for (let si = 40; si > 10; si -= 2) s.push([si + 50, si / 2], [1000, 3]);
          return this.play(s);
        }
        case 'extraman': return this.play([[400, 250], [3500, 150]]);
        case 'wipe': { // sub_0b60 sweep: pitch climbs row by row
          const s = [];
          for (let r = 0; r < 18; r++) for (let c = 0; c < 23; c += 6) s.push([100 + r * 36 + c * 2, 7]);
          return this.play(s, 0.8);
        }
        case 'devolve': {
          const s = [];
          for (let k = 0; k < 40; k++) s.push([rnd(4000) + 60, 8]);
          return this.play(s, 0.7);
        }
        case 'islandCell': {
          const s = [];
          for (let si = 100; si > 0; si -= 14) s.push([si * 10, 5]);
          return this.play(s, 0.8);
        }
        case 'cross': {
          const s = [];
          for (let si = 20; si > 0; si--) s.push([rnd(3000) + 60, rnd(si) + 4]);
          return this.play(s);
        }
        case 'ui': return this.play([[1320, 18]], 0.45);
        case 'uiSelect': return this.play([[990, 20], [1480, 30]], 0.5);
        case 'title': {
          const s = [];
          for (let i = 1; i < 6; i++) for (let d = (i - 1) * 250 + 2; d < i * 800; d += 90) s.push([d, 4]);
          return this.play(s, 0.5);
        }
        default: return 0;
      }
    }
  }

  root.ReflexAudio = { Speaker };
})(window);
