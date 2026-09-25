// Headless smoke test: bots play classic and Game+ games with instant timers.
// Usage: node tests/sim.js
require('../web/js/game.js');
require('../web/js/gameplus.js');
const { Game, T, W, H } = globalThis.Reflex;
const { GamePlus, BOONS } = globalThis.ReflexPlus;
const dirs = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function check(cond, msg) { if (!cond) throw new Error(msg); }

async function play(Mode, stats) {
  let g;
  const host = {
    wait: () => Promise.resolve(),
    beat: () => Promise.resolve(),
    chooseBoon: (choices) => { stats.drafts = (stats.drafts || 0) + 1; return Promise.resolve(choices[Math.floor(Math.random() * choices.length)]); },
    sfx: () => 0,
    fx: (t) => { stats.events[t] = (stats.events[t] || 0) + 1; },
    input: {
      takeDir() {
        const ok = dirs.filter(([dx, dy]) => {
          const x = (g.x + dx + W) % W, y = (g.y + dy + H) % H, v = g.val[y * W + x];
          return v !== T.TRAIL && v !== T.PIGMAN && v !== T.BARREN && v !== T.DEMON;
        });
        return ok.length ? ok[Math.floor(Math.random() * ok.length)] : null;
      },
      takeShield: () => Math.random() < 0.05,
      takeFreeze: () => Math.random() < 0.01,
    },
  };
  g = new Mode(host);
  let guard = 0;
  const origTurn = g.turn.bind(g);
  g.turn = async () => {
    if (++guard > 20000) g.over = true;
    await origTurn();
    for (let i = 0; i < W * H; i++) check(g.val[i] <= 15 && g.disp[i] <= 26, 'bad cell ' + g.val[i]);
    check(g.worms >= 0 && g.worms <= 10, 'worms ' + g.worms);
    check(Number.isFinite(g.score), 'score');
    if (g.plus) {
      check(g.groove >= 1 && g.groove <= 8, 'groove ' + g.groove);
      check(g.tempo() >= 60 && g.tempo() <= 192, 'tempo ' + g.tempo());
      if (g.rival) check(g.rival.x >= 0 && g.rival.x < W && g.rival.y >= 0 && g.rival.y < H, 'rival bounds');
      for (const id of Object.keys(g.boons)) check(BOONS[id] && g.boons[id] <= BOONS[id].max, 'boon ' + id);
      stats.maxGroove = Math.max(stats.maxGroove || 1, g.groove);
    }
  };
  const r = await g.run();
  stats.games++;
  stats.maxLevel = Math.max(stats.maxLevel, r.level);
  stats.maxScore = Math.max(stats.maxScore, r.score);
}

(async () => {
  for (const [name, Mode] of [['classic', Game], ['plus', GamePlus]]) {
    const stats = { games: 0, maxLevel: 0, maxScore: 0, events: {} };
    for (let k = 0; k < 300; k++) await play(Mode, stats);
    console.log(name, JSON.stringify(stats));
  }
})().catch((e) => { console.error(e); process.exit(1); });

// Targeted Game+ checks with a scripted host.
(async () => {
  const { GamePlus: GP } = globalThis.ReflexPlus;
  const mk = () => {
    const events = [];
    const g = new GP({
      wait: () => Promise.resolve(), beat: () => Promise.resolve(), chooseBoon: (c) => Promise.resolve(c[0]),
      sfx: () => 0, fx: (t, d) => events.push([t, d]),
      input: { takeDir: () => null, takeShield: () => false, takeFreeze: () => false },
    });
    return { g, events };
  };
  const put = (g, x, y, v) => { const i = ((y + H) % H) * W + ((x + W) % W); g.val[i] = v; g.disp[i] = v; };

  // Rival crash: surrounded by Pigmen, its recent trail becomes Palmtrees and pays 5000 x groove.
  {
    const { g } = mk();
    g.x = 0; g.y = 0;
    g.spawnRival();
    check(g.rival, 'rival spawned');
    for (let k = 0; k < 3; k++) await g.rivalTurn();
    const r = g.rival;
    for (const [dx, dy] of dirs) put(g, r.x + dx, r.y + dy, T.PIGMAN);
    g.groove = 3;
    const before = g.score;
    await g.rivalTurn();
    check(!g.rival, 'rival crashed');
    check(g.score - before === 15000, 'crash bonus ' + (g.score - before));
    check([...g.val].filter((v) => v === T.PALM).length >= 1, 'palms dropped');
  }
  // Second Wind: a death rewinds instead of costing a worm, once per level.
  {
    const { g, events } = mk();
    g.boons.secondWind = 1;
    for (let k = 0; k < 5; k++) await g.turn();
    put(g, g.x, g.y + 1, T.PIGMAN);
    await g.turn();
    check(g.worms === 4 && events.some(([t]) => t === 'rewind'), 'second wind rewound');
    put(g, g.x, g.y + 1, T.PIGMAN);
    await g.turn();
    check(g.worms === 3, 'second wind only once per level');
  }
  // Long Field: one forcefield charge covers two moves.
  {
    const { g } = mk();
    g.boons.longField = 1;
    g.shields = 1;
    let asked = 0;
    g.host.input.takeShield = () => (asked++ === 0);
    put(g, g.x, g.y + 1, T.PIGMAN); put(g, g.x, g.y + 2, T.PIGMAN);
    await g.turn(); await g.turn();
    check(g.worms === 4 && g.shields === 0, 'long field covered two moves');
  }
  // Groove: a Palmtree raises it and multiplies the points.
  {
    const { g } = mk();
    put(g, g.x, g.y + 1, T.PALM);
    const before = g.score;
    await g.turn();
    check(g.groove === 2, 'groove up on palm');
    const gained = g.score - before;
    check(gained >= 100 && gained <= 1000 && gained % 100 === 0, 'palm scored ' + gained);
  }
  console.log('Game+ targeted checks: ok');
})().catch((e) => { console.error(e); process.exit(1); });
