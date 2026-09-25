// App shell: screens, input (keyboard / touch / gamepad), HUD, Top Forty and attract mode.
(function () {
  'use strict';

  const { Game, Abort, T, W, H } = window.Reflex;
  const { Renderer } = window.ReflexRender;
  const { GamePlus, BOONS } = window.ReflexPlus;
  const { Conductor, Music } = window.ReflexMusic;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const app = $('#app');
  const speaker = new window.ReflexAudio.Speaker();
  const renderer = new Renderer($('#board'));

  // ---------- storage ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch { return fallback; }
    },
    set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const settings = Object.assign(
    { sound: true, tick: true, safeHint: true, scanlines: false, palette: 'modern', music: true, musicVolume: 0.8, sphere: false },
    store.get('reflex.settings', {}),
  );
  function applySettings() {
    speaker.enabled = settings.sound;
    speaker.tickEnabled = settings.tick;
    if (music) { music.setEnabled(settings.music && settings.sound); music.setVolume(settings.musicVolume); }
    $('#music-volume').value = Math.round(settings.musicVolume * 100);
    renderer.setOptions({ palette: settings.palette, safeHint: settings.safeHint, sphere: settings.sphere });
    app.classList.toggle('sphere-view', settings.sphere);
    if (game && game.plus) game.levelHold = settings.sphere ? 950 : 0;
    if (typeof layout === 'function') layout();
    app.dataset.palette = settings.palette;
    app.classList.toggle('crt', settings.scanlines);
    $$('[data-setting]').forEach((el) => { el.checked = !!settings[el.dataset.setting]; });
    $$('[data-palette]').forEach((el) => el.classList.toggle('on', el.dataset.palette === settings.palette));
    refreshIcons();
    store.set('reflex.settings', settings);
  }

  // Top Forty, seeded like the original REFLEX.T40: 40 x "Vacant", level 0, 1000 points.
  // Classic and Game+ keep separate tables.
  const VACANT = () => Array.from({ length: 40 }, () => ({ name: 'Vacant', level: 0, score: 1000 }));
  const TOP_KEYS = { classic: 'reflex.top40', plus: 'reflex.top40plus' };
  const tables = {};
  for (const m of Object.keys(TOP_KEYS)) {
    const t = store.get(TOP_KEYS[m], null);
    tables[m] = Array.isArray(t) && t.length === 40 ? t : VACANT();
  }
  const saveTop40 = (m) => store.set(TOP_KEYS[m], tables[m]);
  // sub_2733: a new score goes above any entry it ties with.
  const rankFor = (score, m) => {
    const top40 = tables[m];
    let i = 39;
    while (i >= 0 && top40[i].score <= score) i--;
    return i + 1 < 40 ? i + 1 : -1;
  };
  let top40Tab = 'classic';

  // ---------- sprite icons ----------
  function spriteCanvas(k, cls = 'sprite') {
    const c = document.createElement('canvas');
    c.width = 27; c.height = 17;
    c.className = cls;
    c.dataset.sprite = k;
    c.getContext('2d').drawImage(renderer.icon(k), 0, 0);
    return c;
  }
  function refreshIcons() {
    $$('canvas[data-sprite]').forEach((c) => {
      const cx = c.getContext('2d');
      cx.clearRect(0, 0, 27, 17);
      cx.drawImage(renderer.icon(+c.dataset.sprite), 0, 0);
    });
  }
  $('.brand-icon').appendChild(spriteCanvas(0, ''));
  [4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13].forEach((k, n) => {
    const c = spriteCanvas(k, '');
    c.style.animationDelay = n * 0.12 + 's';
    $('#parade').appendChild(c);
  });

  // ---------- timing ----------
  // Pausable, abortable timers. The engine awaits these, so pausing the clock freezes the game.
  class Clock {
    constructor() { this.waiters = new Set(); this.paused = false; this.dead = false; }
    wait(ms) {
      if (this.dead) return Promise.reject(new Abort());
      return new Promise((resolve, reject) => {
        const w = { left: ms, resolve, reject, t: 0, start: 0 };
        this.waiters.add(w);
        if (!this.paused) this.arm(w);
      });
    }
    arm(w) {
      w.start = performance.now();
      w.t = setTimeout(() => { this.waiters.delete(w); w.resolve(); }, Math.max(0, w.left));
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      const now = performance.now();
      for (const w of this.waiters) { clearTimeout(w.t); w.left -= now - w.start; }
    }
    resume() {
      if (!this.paused) return;
      this.paused = false;
      for (const w of this.waiters) this.arm(w);
    }
    abort() {
      this.dead = true;
      for (const w of this.waiters) { clearTimeout(w.t); w.reject(new Abort()); }
      this.waiters.clear();
      for (const g of this.guards || []) g(new Abort());
      this.guards = null;
    }
    // Wraps an outside promise (the beat, a boon choice) so aborting the clock rejects it too.
    guard(p) {
      if (this.dead) return Promise.reject(new Abort());
      if (!this.guards) this.guards = new Set();
      return new Promise((resolve, reject) => {
        this.guards.add(reject);
        p.then((v) => { if (this.guards) this.guards.delete(reject); resolve(v); });
      });
    }
  }

  // ---------- input ----------
  const input = {
    queue: [], lastPush: 0, shieldHeld: false, shieldLatch: false, freezeLatch: false,
    push(dir, merge = false) {
      const now = performance.now();
      // Two keys pressed almost together form a diagonal; replace the pending single move.
      if (merge && this.queue.length && now - this.lastPush < 90) this.queue[this.queue.length - 1] = dir;
      else if (this.queue.length < 3) this.queue.push(dir);
      this.lastPush = now;
    },
    takeDir() { return this.queue.shift() || null; },
    takeShield() { const r = this.shieldHeld || this.shieldLatch; this.shieldLatch = false; return r; },
    takeFreeze() { const r = this.freezeLatch; this.freezeLatch = false; return r; },
    clear() { this.queue.length = 0; this.shieldLatch = this.freezeLatch = false; },
  };

  const KEY_DIRS = {
    Numpad7: [-1, -1], Numpad8: [0, -1], Numpad9: [1, -1], Numpad4: [-1, 0], Numpad6: [1, 0],
    Numpad1: [-1, 1], Numpad2: [0, 1], Numpad3: [1, 1],
    KeyQ: [-1, -1], KeyW: [0, -1], KeyE: [1, -1], KeyA: [-1, 0], KeyD: [1, 0], KeyZ: [-1, 1], KeyS: [0, 1], KeyX: [0, 1], KeyC: [1, 1],
    Home: [-1, -1], PageUp: [1, -1], End: [-1, 1], PageDown: [1, 1],
    Digit7: [-1, -1], Digit8: [0, -1], Digit9: [1, -1], Digit4: [-1, 0], Digit6: [1, 0], Digit1: [-1, 1], Digit2: [0, 1], Digit3: [1, 1],
  };
  const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const heldArrows = new Set();

  function arrowDir() {
    let x = 0, y = 0;
    for (const k of heldArrows) { x += ARROWS[k][0]; y += ARROWS[k][1]; }
    return [Math.sign(x), Math.sign(y)];
  }

  // ---------- state ----------
  let mode = 'menu';          // menu | play | pause | draft | gameover
  let game = null, clock = null;
  let gameMode = 'classic';   // classic | plus
  let music = null, conductor = null;
  let attract = null, attractClock = null;
  let screenStack = [];
  let lastResult = null;
  let myRank = -1;

  function setMode(m) { mode = m; app.dataset.mode = m === 'menu' ? 'menu' : 'play'; }

  function showScreen(name, push = true) {
    const current = screenStack[screenStack.length - 1];
    if (push && current !== name) screenStack.push(name);
    $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
    if (name === 'top40') { if (mode === 'gameover' && lastResult) top40Tab = lastResult.mode; renderTop40(); }
    if (name === 'howto') renderHowto();
    const target = $(`#screen-${name} .primary`) || $(`#screen-${name} .menu button`) || $(`#screen-${name} .close`);
    if (target && name !== 'gameover') setTimeout(() => target.focus({ preventScroll: true }), 30);
  }
  function hideScreens() { screenStack = []; $$('.screen').forEach((s) => s.classList.remove('active')); }
  function back() {
    screenStack.pop();
    const prev = screenStack[screenStack.length - 1];
    if (prev) showScreen(prev, false);
    else if (mode === 'pause') showScreen('pause');
    else hideScreens();
  }

  // ---------- attract mode ----------
  // Behind the menu a bot plays on a live board, so the evolving objects are visible.
  function startAttract() {
    stopAttract();
    attractClock = new Clock();
    let a;
    const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    const botInput = {
      takeDir() {
        const score = ([dx, dy]) => {
          const x = (a.x + dx + W) % W, y = (a.y + dy + H) % H, v = a.val[y * W + x];
          if (a.hunger > 0) return v === T.BARREN ? -99 : v;
          if (v === T.TRAIL || v === T.PIGMAN || v === T.BARREN || v === T.DEMON) return -99;
          const bonus = { [T.PALM]: 5, [T.EXTRAMAN]: 6, [T.MARTINI]: 4, [T.CROSS]: 5, [T.PREBARREN]: 3 }[v] || 0;
          return bonus + (dx === a.dx && dy === a.dy ? 1.5 : 0) + Math.random();
        };
        let best = null, bs = -Infinity;
        for (const d of DIRS) { const s = score(d); if (s > bs) { bs = s; best = d; } }
        return best;
      },
      takeShield: () => false,
      takeFreeze: () => false,
    };
    a = attract = new Game({ wait: (ms) => attractClock.wait(ms), input: botInput, sfx: () => 0, fx: (t, d) => renderer.fx(t, d) });
    const loop = async () => {
      while (attract === a) {
        a.reset();
        a.level = 6; a.speed = 6; a.worms = 3;
        for (let k = 0; k < 160; k++) a.spawn();
        a.score = 0;
        await a.run();
        if (attract !== a) return;
        try { await attractClock.wait(1500); } catch { return; }
      }
    };
    renderer.setGame(a);
    renderer.dim = 0.15;
    loop();
  }
  function stopAttract() {
    if (attractClock) attractClock.abort();
    attract = null; attractClock = null;
  }

  // ---------- game session ----------
  let session = 0;
  async function startGame(m = gameMode) {
    gameMode = m;
    speaker.unlock();
    stopAttract();
    stopMusic();
    if (clock) clock.abort();
    const id = ++session;
    hideScreens();
    setMode('play');
    app.classList.toggle('plus', m === 'plus');
    input.clear();
    clock = new Clock();
    const c = clock;
    const host = {
      wait: (ms) => c.wait(ms),
      input,
      sfx: (n, a, b) => speaker.fx(n, a, b),
      fx: (t, d) => { renderer.fx(t, d); uiFx(t, d); },
    };
    if (m === 'plus') {
      // Game+ runs on the music: the conductor's 8th notes are the game's turns.
      if (!music && speaker.ctx) { music = new Music(speaker.ctx); applySettings(); }
      conductor = new Conductor(speaker.ctx);
      const cond = conductor;
      if (music && cond.ctx) {
        cond.handlers.push(music);
        music.state = () => plusState(game);
        music.start();
      }
      cond.tempoProvider = () => (game && game.tempo ? game.tempo() : 84);
      host.beat = () => c.guard(cond.nextTurn());
      host.chooseBoon = (choices) => c.guard(showDraft(choices));
      host.sfx = plusSfx;
      game = new GamePlus(host);
      game.levelHold = settings.sphere ? 950 : 0; // time to land on the new planet
      renderer.conductor = cond;
      cond.start(game.tempo());
    } else {
      game = new Game(host);
      renderer.conductor = null;
    }
    renderer.setGame(game);
    renderer.dim = 0;
    layout();
    hud.reset();
    toast('GET READY', m === 'plus' ? 'move on the beat' : 'use the arrows or numpad');
    try { await c.wait(m === 'plus' ? conductor.turnMs * 8 : 1300); } catch { return; }
    const result = await game.run();
    if (id !== session) return;
    result.mode = m;
    lastResult = result;
    try { await c.wait(1600); } catch { return; }
    if (id !== session) return;
    stopMusic();
    gameOver(result);
  }

  function stopMusic() {
    if (conductor) conductor.stop();
    if (music) music.stop();
    conductor = null;
    renderer.conductor = null;
  }

  // Intensity inputs for the music, read once per bar.
  function plusState(g) {
    if (!g) return {};
    let danger = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const v = g.val[((g.y + dy + H) % H) * W + ((g.x + dx + W) % W)];
      if (v === T.TRAIL || v === T.PIGMAN || v === T.BARREN || v === T.DEMON) danger++;
    }
    return { level: g.level, groove: g.groove, danger: danger / 8, hunger: g.hunger > 0, boss: !!g.rival, freeze: g.freezeLeft > 0 };
  }

  // Game+ sounds: most effects become in-key stingers quantized to the beat.
  const STINGERS = new Set(['boom', 'shield', 'wipe', 'martini', 'extraman', 'demon', 'cross', 'devolve', 'graze', 'boss', 'rivalCrash', 'rewind']);
  function plusSfx(name, a, b) {
    if (name === 'tick' || name === 'click') return 0;
    if (name === 'death') return speaker.fx('death');
    const live = music && conductor && conductor.ctx;
    if (name === 'musicDeath') return live ? music.stinger('death', conductor) : 0;
    if (name === 'gameover') { if (live) music.stinger('gameover', conductor); return speaker.fx('gameover'); }
    if (!live) return name === 'graze' ? 0 : speaker.fx(name, a, b);
    if (name === 'tone') return music.stinger(b >= 300 ? 'pickup' : 'blip', conductor, { freq: a, groove: game ? game.groove : 1 });
    if (name === 'islandCell') return music.stinger('island', conductor);
    if (STINGERS.has(name)) return music.stinger(name, conductor);
    return speaker.fx(name, a, b);
  }

  // Boon draft: the game waits on this promise while the music plays on, muffled.
  let draftResolve = null;
  function showDraft(choices) {
    return new Promise((resolve) => {
      const wrap = $('#draft-cards');
      wrap.innerHTML = '';
      choices.forEach((id, n) => {
        const b = BOONS[id];
        const card = document.createElement('button');
        card.className = 'card';
        card.dataset.boon = id;
        card.appendChild(spriteCanvas(b.sprite));
        card.insertAdjacentHTML('beforeend', '<b></b><span></span><kbd></kbd>');
        card.querySelector('b').textContent = b.name;
        card.querySelector('span').textContent = b.text;
        card.querySelector('kbd').textContent = n + 1;
        card.addEventListener('click', () => chooseBoon(id));
        wrap.appendChild(card);
      });
      $('#draft-sub').textContent = `Level ${game.level} reached. Pick one upgrade for this run.`;
      draftResolve = resolve;
      setMode('draft');
      if (music) music.muffle(true);
      speaker.fx('uiSelect');
      showScreen('draft');
      setTimeout(() => wrap.firstChild && wrap.firstChild.focus(), 60);
    });
  }
  function chooseBoon(id) {
    if (!draftResolve) return;
    const r = draftResolve;
    draftResolve = null;
    hideScreens();
    setMode('play');
    input.clear();
    if (music) music.muffle(false);
    speaker.fx('uiSelect');
    toast(BOONS[id].name.toUpperCase(), BOONS[id].text);
    r(id);
  }

  function pauseGame() {
    if (mode !== 'play' || !clock) return;
    clock.pause();
    if (conductor) conductor.pause();
    setMode('pause');
    showScreen('pause');
  }
  function resumeGame() {
    if (mode !== 'pause') return;
    hideScreens();
    setMode('play');
    input.clear();
    clock.resume();
    if (conductor) conductor.resume();
  }
  function endGame() {
    // Like Ctrl-Alt in the original: stop now and go to the score table.
    if (!game) return;
    session++;
    clock.abort();
    stopMusic();
    game.over = true;
    lastResult = { score: game.score, level: game.level, mode: gameMode };
    gameOver(lastResult);
  }

  function gameOver(result) {
    setMode('gameover');
    $('#final-score').textContent = fmt(result.score);
    $('#final-level').textContent = result.level;
    myRank = rankFor(result.score, result.mode);
    $('#gameover-mode').textContent = result.mode === 'plus' ? 'Game+' : 'Classic';
    const entry = $('#entry');
    entry.classList.toggle('show', myRank >= 0);
    showScreen('gameover');
    if (myRank >= 0) {
      $('#entry-rank').textContent = `You placed #${myRank + 1} in the Top Forty!`;
      const inp = $('#entry-name');
      inp.value = store.get('reflex.lastName', '');
      setTimeout(() => { inp.focus(); inp.select(); }, 60);
    } else {
      setTimeout(() => $('#gameover-menu .primary').focus(), 60);
    }
  }

  $('#entry').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ($('#entry-name').value.trim() || 'Anonymous').slice(0, 20);
    store.set('reflex.lastName', name);
    const top40 = tables[lastResult.mode];
    top40.splice(myRank, 0, { name, level: lastResult.level, score: lastResult.score });
    top40.length = 40;
    saveTop40(lastResult.mode);
    $('#entry').classList.remove('show');
    speaker.fx('uiSelect');
    screenStack = ['gameover'];
    showScreen('top40');
  });

  function goHome() {
    session++;
    if (clock) clock.abort();
    stopMusic();
    game = null;
    app.classList.remove('plus', 'boss');
    setMode('menu');
    layout();
    screenStack = [];
    showScreen('menu');
    startAttract();
    updateBest();
  }

  // ---------- HUD ----------
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const hud = {
    shown: {},
    score: 0,
    reset() { this.shown = {}; this.score = 0; },
    update(dt) {
      if (!game) return;
      const g = game;
      this.score += (g.score - this.score) * Math.min(1, dt / 90);
      if (Math.abs(g.score - this.score) < 1) this.score = g.score;
      this.set('score', fmt(this.score), (v) => { $('#hud-score').textContent = v; });
      this.set('level', g.level, (v) => { $('#hud-level').textContent = v; });
      this.set('freezes', g.freezes, (v) => { $('#hud-freezes').textContent = v; $('#touch-freeze-n').textContent = v; });
      this.set('shieldsN', g.shields, (v) => { $('#touch-shield-n').textContent = v; });
      this.set('shields', g.shields, (v) => {
        const el = $('#hud-shields');
        if (!el.children.length) for (let k = 0; k < 10; k++) el.appendChild(document.createElement('i'));
        [...el.children].forEach((p, k) => p.classList.toggle('on', k < v));
      });
      this.set('worms', g.worms, (v, prev) => {
        const el = $('#hud-worms');
        el.textContent = '';
        const show = Math.min(v, 6);
        for (let k = 0; k < show; k++) {
          const c = spriteCanvas(0, '');
          if (prev !== undefined && v > prev && k === show - 1) c.classList.add('pop');
          el.appendChild(c);
        }
        if (v > 6) el.appendChild(Object.assign(document.createElement('span'), { className: 'more', textContent: '+' + (v - 6) }));
        el.appendChild(Object.assign(document.createElement('span'), { className: 'count', textContent: '×' + v }));
      });
      if (g.plus) {
        this.set('groove', g.groove, (v, prev) => {
          const el = $('#hud-groove');
          el.textContent = '×' + v;
          el.parentElement.dataset.level = v;
          if (prev !== undefined && v > prev) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
        });
        $('#hud-groove-bar').style.transform = `scaleX(${g.groove > 1 ? g.grooveBeats / g.grooveWindow : 0})`;
        this.set('bpm', conductor ? Math.round(conductor.bpm) : g.tempo(), (v) => { $('#hud-bpm').textContent = v; });
        this.set('boons', Object.entries(g.boons).map(([k, n]) => k + n).join(','), () => {
          const el = $('#hud-boons');
          el.textContent = '';
          for (const [id, n] of Object.entries(g.boons)) {
            const chip = document.createElement('span');
            chip.className = 'boon-chip';
            chip.title = BOONS[id].text;
            chip.appendChild(spriteCanvas(BOONS[id].sprite, ''));
            chip.append(BOONS[id].name + (n > 1 ? ' ×' + n : ''));
            el.appendChild(chip);
          }
        });
        app.classList.toggle('boss', !!g.rival);
      }
      app.classList.toggle('hungry', g.hunger > 0);
      app.classList.toggle('frozen', g.freezeLeft > 0);
      if (g.hunger > 0) $('#meter-hunger span').style.transform = `scaleX(${g.hunger / Math.max(1, g.hungerMax)})`;
      if (g.freezeLeft > 0) $('#meter-freeze span').style.transform = `scaleX(${g.freezeLeft})`;
    },
    set(key, v, apply) {
      const prev = this.shown[key];
      if (prev === v) return;
      this.shown[key] = v;
      apply(v, prev);
    },
  };

  let toastTimer = 0;
  function toast(text, sub) {
    const el = $('#toast');
    el.innerHTML = '';
    el.append(text);
    if (sub) el.appendChild(Object.assign(document.createElement('small'), { textContent: sub }));
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  function uiFx(type, d) {
    if (type === 'level') {
      const g = game;
      if (g.plus && settings.sphere) plusSfx('boom');
      const sub = g.speed >= 35 ? 'safe lane on the move' : g.speed >= 30 ? 'safe lane drifting' : g.speed === 1 && g.level > 1 ? 'the cycle begins again — faster' : '';
      toast('LEVEL ' + d.level, g.plus ? `${g.tempo()} BPM` + (sub ? ' · ' + sub : '') : sub);
    }
    if (type === 'gameover') toast('GAME OVER');
    if (type === 'boss') toast('GLUTTON!', 'a rival worm: make it crash');
    if (type === 'rewind') toast('SECOND WIND', 'rewound 4 beats');
    if (type === 'freeze' && d.on) toast('PAUSE', '3 seconds');
  }

  // ---------- How to play / Top forty ----------
  const CHAIN = [
    [T.TRAIL, 'Trail'], [T.CLEAR, 'Clear trail'], [T.EMPTY, 'Empty'], [T.PIGMAN, 'Pigman'], [T.TRANSPORT, 'Transport'],
    [T.PALM, 'Palmtree'], [T.ARROW, 'Down arrow'], [T.MARTINI, 'Martini'], [T.EXTRAMAN, 'Extraman'], [T.DEMON, 'Demon'],
    [T.SUPER, 'Super transport'], [T.ISLAND, 'Sunny island'], [T.CROSS, 'Cross'], [T.PREBARREN, 'Pre-barren'], [T.BARREN, 'Barren'],
  ];
  const LEGEND = [
    [T.HEAD, 'Worm head', 'This is you. It never stops moving.', ''],
    [T.TRAIL, 'Worm trail', 'Death of worm.', 'bad'],
    [T.CLEAR, 'Clear trail', 'Harmless. Old trail fades into this.', ''],
    [T.EMPTY, 'Empty space', 'Harmless.', ''],
    [T.PIGMAN, 'Pigman', 'Death of worm.', 'bad'],
    [T.TRANSPORT, 'Transport', 'Down one level. Leaves a barren hole behind.', 'good'],
    [T.PALM, 'Palmtree', '100 – 1000 points.', 'good'],
    [T.ARROW, 'Down arrow', 'De-evolves every object one step (a Transport becomes a Pigman).', ''],
    [T.MARTINI, 'Martini', 'Hunger mode: eat everything for (rank × 100) points for level + 2 moves. Only Barren still kills.', 'good'],
    [T.EXTRAMAN, 'Extraman', 'One extra worm and 3000 points (up to 10 worms).', 'good'],
    [T.DEMON, 'Demon', 'Takes 0 – 3 worms. Feeling lucky?', 'bad'],
    [T.SUPER, 'Super transport', 'Drop six levels at once.', 'good'],
    [T.ISLAND, 'Sunny island', 'Turns your whole trail into Barren areas (+8 each).', ''],
    [T.CROSS, 'Cross', 'Wipes your row and column clean, Barren included. +4000.', 'good'],
    [T.PREBARREN, 'Pre-barren area', 'Clears every Pre-barren area on the board, +500 each.', 'good'],
    [T.BARREN, 'Barren area', 'Death of worm, even in hunger mode. Stays across levels.', 'bad'],
  ];
  let howtoBuilt = '';
  function renderHowto() {
    if (howtoBuilt === settings.palette) return;
    howtoBuilt = settings.palette;
    const body = $('#howto-body');
    body.className = 'panel-body howto';
    body.innerHTML = `
      <h3>The idea</h3>
      <p>Steer your worm around the board. It always keeps moving, and it leaves a deadly trail behind it.
      Leaving one edge brings you back on the opposite edge. Score as many points as you can before you run out of worms.
      You also score your level number every turn you survive.</p>
      <h3>The board is alive</h3>
      <p>Every turn, some tiles move one step along this chain. Old trail fades to empty space, empty space grows
      into a Pigman, and the chain runs on up to deadly Barren. The deeper you go, the more tiles change each turn.
      <em>This was never in the 1988 manual; it came out of the machine code.</em></p>
      <div class="chain" id="chain"></div>
      <h3>Objects</h3>
      <div class="legend" id="legend"></div>
      <h3>Levels, safe lane and powers</h3>
      <p>Transports take you <strong>down</strong> a level. Deeper levels play faster, change more tiles, and score more
      per turn. Each level also earns a <strong>Forcefield</strong> (max 10) and a <strong>Pause</strong>.</p>
      <p>One column, the <strong>safe lane</strong>, never grows objects. It starts on the far right. At level 30 it starts
      drifting left, and from level 35 it jumps around. After level 50 the cycle starts over, faster.</p>
      <p><strong>Forcefield</strong>: hold it while you move and your worm passes through anything, Barren included,
      for one move per charge. <strong>Pause</strong>: freezes everything for 3 seconds, and uses up every pause you've saved.</p>
      <h3>Game+</h3>
      <p>Same board, same objects, same evolution. Game+ adds ideas from the 35 years of games since:</p>
      <ul class="plus-list">
        <li><strong>Everything moves on the beat.</strong> Each move is an 8th note. The original's tick is the metronome, and the band joins in as things heat up: hi-hat, beat, bass, chords, melody, then brass. Deeper levels play faster.</li>
        <li><strong>Groove ×1–×8.</strong> Chain pickups (Palmtrees, Extramen, Crosses, Pre-barren, hunger eats) to raise your multiplier. It drains when you go quiet and resets when you lose a worm. Higher groove also means a faster tempo.</li>
        <li><strong>Graze.</strong> Finishing a move right next to something deadly scores points and keeps the groove alive.</li>
        <li><strong>Telegraphs.</strong> Tiles that will evolve on the next beat pulse: <span class="t-red">red</span> if they're turning deadly, <span class="t-gold">gold</span> if they're turning into something good.</li>
        <li><strong>Glutton.</strong> Every 10th level a rival worm arrives and steals Palmtrees. Its trail is deadly to you, and yours to it. Make it crash and its body turns into Palmtrees.</li>
        <li><strong>Boons.</strong> Every 5th level, pick one of three upgrades for the rest of the run.</li>
      </ul>
      <h3>Controls</h3>
      <table class="controls-table">
        <tr><td><kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> / <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Steer. Press two arrows together for a diagonal.</td></tr>
        <tr><td>Numpad <kbd>1</kbd>–<kbd>9</kbd> / <kbd>Q</kbd><kbd>E</kbd><kbd>Z</kbd><kbd>C</kbd></td><td>All 8 directions, just like the original numeric keypad.</td></tr>
        <tr><td><kbd>Space</kbd> / <kbd>Right Shift</kbd></td><td>Forcefield (hold)</td></tr>
        <tr><td><kbd>P</kbd> / <kbd>Left Shift</kbd></td><td>Pause (3 seconds)</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Menu</td></tr>
        <tr><td>Gamepad</td><td>Stick / d-pad to steer, <kbd>A</kbd> forcefield, <kbd>B</kbd> pause, <kbd>Start</kbd> menu</td></tr>
        <tr><td>Touch</td><td>On-screen pad, or swipe across the board</td></tr>
      </table>`;
    const chain = $('#chain', body);
    CHAIN.forEach(([k, name], n) => {
      const f = document.createElement('figure');
      f.appendChild(spriteCanvas(k));
      f.appendChild(Object.assign(document.createElement('figcaption'), { textContent: name }));
      chain.appendChild(f);
      if (n < CHAIN.length - 1) chain.appendChild(Object.assign(document.createElement('span'), { className: 'arrow', textContent: '›' }));
    });
    const legend = $('#legend', body);
    LEGEND.forEach(([k, name, text, cls]) => {
      const row = document.createElement('div');
      if (cls) row.className = cls;
      row.appendChild(spriteCanvas(k));
      const t = document.createElement('div');
      t.innerHTML = `<b></b><span></span>`;
      t.firstChild.textContent = name;
      t.lastChild.textContent = text;
      row.appendChild(t);
      legend.appendChild(row);
    });
  }

  function renderTop40() {
    const el = $('#top40');
    el.innerHTML = '';
    const top40 = tables[top40Tab];
    $$('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === top40Tab));
    const highlight = mode === 'gameover' && lastResult && lastResult.mode === top40Tab ? myRank : -1;
    for (let col = 0; col < 2; col++) {
      const list = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'row head';
      head.innerHTML = '<span>#</span><span>Player</span><span class="lvl">Lvl</span><span class="score">Score</span>';
      list.appendChild(head);
      for (let i = col * 20; i < col * 20 + 20; i++) {
        const e = top40[i];
        const row = document.createElement('div');
        row.className = 'row' + (i === highlight ? ' me' : '');
        const cells = [
          ['rank', i + 1 + '.'],
          ['name' + (e.name === 'Vacant' && e.level === 0 ? ' vacant' : ''), e.name],
          ['lvl', e.level],
          ['score', fmt(e.score)],
        ];
        for (const [cls, txt] of cells) row.appendChild(Object.assign(document.createElement('span'), { className: cls, textContent: txt }));
        list.appendChild(row);
      }
      el.appendChild(list);
    }
  }

  function updateBest() {
    const best = (m) => tables[m].find((e) => !(e.name === 'Vacant' && e.level === 0));
    const parts = [['Classic', best('classic')], ['Game+', best('plus')]].filter(([, b]) => b)
      .map(([label, b]) => `${label}: ${fmt(b.score)} by ${b.name}`);
    $('#menu-best').textContent = parts.length ? 'Top scores · ' + parts.join(' · ') : 'Based on REFLEX (1988) by 3F Productions';
  }

  // ---------- actions ----------
  const actions = {
    play: () => startGame('classic'),
    playplus: () => startGame('plus'),
    again: () => startGame(lastResult ? lastResult.mode : gameMode),
    howto: () => showScreen('howto'),
    top40: () => showScreen('top40'),
    settings: () => showScreen('settings'),
    about: () => showScreen('about'),
    back,
    resume: resumeGame,
    restart: () => startGame(gameMode),
    end: endGame,
    home: goHome,
    'reset-scores': () => {
      for (const m of Object.keys(TOP_KEYS)) { tables[m] = VACANT(); saveTop40(m); }
      updateBest();
      toastMenu('Top Forty reset');
    },
  };
  function toastMenu(t) { const b = $('[data-action="reset-scores"]'); b.textContent = t; setTimeout(() => { b.textContent = 'Reset Top Forty'; }, 1500); }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    speaker.unlock();
    speaker.fx(['play', 'playplus', 'again', 'restart'].includes(b.dataset.action) ? 'uiSelect' : 'ui');
    actions[b.dataset.action]();
  });
  $$('[data-setting]').forEach((el) => el.addEventListener('change', () => {
    settings[el.dataset.setting] = el.checked;
    applySettings();
    speaker.unlock();
    speaker.fx('ui');
  }));
  $$('[data-palette]').forEach((el) => el.addEventListener('click', () => {
    settings.palette = el.dataset.palette;
    applySettings();
    speaker.fx('ui');
  }));
  $$('[data-tab]').forEach((el) => el.addEventListener('click', () => { top40Tab = el.dataset.tab; renderTop40(); speaker.fx('ui'); }));
  $('#music-volume').addEventListener('input', (e) => {
    settings.musicVolume = e.target.value / 100;
    applySettings();
  });
  $('#btn-menu').addEventListener('click', () => (mode === 'pause' ? resumeGame() : pauseGame()));

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    speaker.unlock();
    const typing = e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range';
    if (typing) return;
    if (mode === 'draft') {
      const n = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }[e.code];
      const cards = $$('#draft-cards .card');
      if (n !== undefined && cards[n]) { e.preventDefault(); cards[n].click(); return; }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const i = cards.indexOf(document.activeElement);
        cards[(i + (e.code === 'ArrowRight' ? 1 : cards.length - 1)) % cards.length].focus();
        return;
      }
      if (e.code === 'Escape') { e.preventDefault(); return; }
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      if (mode === 'play') pauseGame();
      else if (mode === 'pause' && screenStack.length <= 1) resumeGame();
      else if (screenStack.length > 1 || (mode === 'menu' && screenStack.length === 1 && screenStack[0] !== 'menu')) actions.back();
      return;
    }
    if (mode === 'play') {
      if (ARROWS[e.code]) {
        e.preventDefault();
        if (e.repeat) return;
        heldArrows.add(e.code);
        const d = arrowDir();
        if (d[0] || d[1]) input.push(d, heldArrows.size > 1);
        return;
      }
      if (KEY_DIRS[e.code]) { e.preventDefault(); if (!e.repeat) input.push(KEY_DIRS[e.code]); return; }
      if (e.code === 'Space' || e.code === 'ShiftRight') { e.preventDefault(); input.shieldHeld = true; input.shieldLatch = true; return; }
      if (e.code === 'KeyP' || e.code === 'ShiftLeft') { e.preventDefault(); input.freezeLatch = true; return; }
      return;
    }
    // Menu navigation with the arrow keys.
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      const screen = $('.screen.active');
      if (!screen) return;
      const items = $$('button:not([disabled]), input', screen).filter((b) => b.offsetParent !== null);
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next = e.code === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
      speaker.fx('ui');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (ARROWS[e.code]) heldArrows.delete(e.code);
    if (e.code === 'Space' || e.code === 'ShiftRight') input.shieldHeld = false;
  });
  window.addEventListener('blur', () => { heldArrows.clear(); input.shieldHeld = false; pauseGame(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

  // ---------- touch ----------
  const enableTouch = () => { if (!app.classList.contains('touch-on')) { app.classList.add('touch-on'); layout(); } };
  if (window.matchMedia('(pointer: coarse)').matches) enableTouch();
  window.addEventListener('touchstart', enableTouch, { passive: true, once: true });
  $$('#dpad button').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      speaker.unlock();
      b.classList.add('down');
      if (mode === 'play') input.push(b.dataset.dir.split(',').map(Number));
    });
    const up = () => b.classList.remove('down');
    b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up); b.addEventListener('pointercancel', up);
  });
  const shieldBtn = $('#touch-shield');
  shieldBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); input.shieldHeld = true; input.shieldLatch = true; shieldBtn.classList.add('down'); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => shieldBtn.addEventListener(ev, () => { input.shieldHeld = false; shieldBtn.classList.remove('down'); }));
  $('#touch-freeze').addEventListener('pointerdown', (e) => { e.preventDefault(); input.freezeLatch = true; });

  // Swipe across the board to steer (8 directions).
  let swipe = null;
  const board = $('#board');
  board.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; board.setPointerCapture(e.pointerId); });
  board.addEventListener('pointermove', (e) => {
    if (!swipe || mode !== 'play') return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.hypot(dx, dy) < 26) return;
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    const dirs = { 0: [1, 0], 1: [1, 1], 2: [0, 1], 3: [-1, 1], 4: [-1, 0], '-4': [-1, 0], '-3': [-1, -1], '-2': [0, -1], '-1': [1, -1] };
    input.push(dirs[oct]);
    swipe = { x: e.clientX, y: e.clientY };
  });
  board.addEventListener('pointerup', () => { swipe = null; });

  // ---------- gamepad ----------
  const pad = { dir: '', a: false, b: false, start: false, up: false, down: false };
  function pollGamepad() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...gps].find((g) => g && g.connected);
    if (!gp) return;
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let x = gp.axes[0] || 0, y = gp.axes[1] || 0;
    if (btn(14)) x = -1; if (btn(15)) x = 1; if (btn(12)) y = -1; if (btn(13)) y = 1;
    const d = [Math.abs(x) > 0.5 ? Math.sign(x) : 0, Math.abs(y) > 0.5 ? Math.sign(y) : 0];
    const key = d.join(',');
    if (mode === 'play') {
      if (key !== pad.dir && (d[0] || d[1])) input.push(d);
      input.shieldHeld = btn(0);
      if (btn(0) && !pad.a) input.shieldLatch = true;
      if (btn(1) && !pad.b) input.freezeLatch = true;
    } else {
      const screen = $('.screen.active');
      if (screen && d[1] && key !== pad.dir) {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: d[1] > 0 ? 'ArrowDown' : 'ArrowUp' }));
      }
      if (btn(0) && !pad.a && document.activeElement && document.activeElement.click) document.activeElement.click();
      if (btn(1) && !pad.b) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    }
    if (btn(9) && !pad.start) { if (mode === 'play') pauseGame(); else if (mode === 'pause') resumeGame(); }
    pad.dir = key; pad.a = btn(0); pad.b = btn(1); pad.start = btn(9);
  }

  // ---------- layout & loop ----------
  function layout() {
    const stage = $('#stage');
    const r = stage.getBoundingClientRect();
    const availW = Math.max(200, r.width - 12);
    const availH = Math.max(140, r.height - 30);
    // Planet view uses the whole stage, so stars and flying debris reach the edges.
    if (renderer.sphereOn) return renderer.resizeTo(Math.floor(availW), Math.floor(availH));
    const w = Math.floor(Math.min(availW, availH * renderer.aspect));
    renderer.resize(w);
  }
  window.addEventListener('resize', layout);

  const boardWrap = $('#board-wrap');
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame); // first, so one bad frame can't stop the loop
    const dt = Math.min(100, now - last);
    last = now;
    pollGamepad();
    hud.update(dt);
    if (conductor && game && game.plus) {
      const b = conductor.phase(now);
      const k = Math.pow(1 - b.phase, 2) * (b.downbeat ? 1 : b.beat ? 0.55 : 0.25);
      boardWrap.style.setProperty('--beat', k.toFixed(3));
    } else boardWrap.style.setProperty('--beat', '0');
    renderer.draw(now, dt);
  }

  // Console handle for debugging: __reflex.game.val[i] = Reflex.T.MARTINI, etc.
  window.__reflex = {
    get game() { return game; }, get music() { return music; }, get conductor() { return conductor; },
    renderer, speaker,
  };

  applySettings();
  layout();
  showScreen('menu');
  startAttract();
  updateBest();
  requestAnimationFrame(frame);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
})();
