# Game+

Game+ keeps REFLEX's board, objects and evolution chain unchanged. Around them it adds ideas from the 35 years of games that followed. Classic mode still plays exactly as the original machine code does.

Code:
- `web/js/gameplus.js`: `GamePlus extends Game`
- `web/js/music.js`: the `Conductor` and `Music` classes
- `web/js/main.js`: session setup, the boon draft screen, the HUD

## Where the ideas come from

| Feature | Inspiration |
|---|---|
| Music built from layers that fade in with intensity | "Vertical layering" in adaptive game music ([CRI ADX2](https://blog.criware.com/index.php/2020/04/20/dynamic-music-with-adx2-part1-vertical-layering/), [FMOD re-orchestration](https://alessandrofama.com/tutorials/fmod/fmod-studio/vertical-reorchestration)) |
| Pickups play notes in key, quantized to the beat | Rez and Tetris Effect ([Tetris Effect audio analysis](https://www.gamedeveloper.com/audio/game-audio-analysis---tetris-effect)) |
| Every move lands on the beat | Crypt of the NecroDancer ([beat movement](https://necrodancer.miraheze.org/wiki/Gameplay_Basics)) |
| Groove multiplier that resets when you get hit | NecroDancer's [groove chain](https://necrodancer.miraheze.org/wiki/Groove_Chain), Geometry Wars' multiplier |
| Graze near-miss points | Bullet-hell games |
| Tempo that rises with your streak and drops on death; escalating hunger chains | [Pac-Man Championship Edition DX](https://en.wikipedia.org/wiki/Pac-Man_Championship_Edition_DX) |
| Rival worm; a crashed worm turns into pickups | Tron light cycles, Nibbler, slither.io |
| Pick 1 of 3 upgrades per run | Roguelites: Hades, Vampire Survivors, [SNKRX](https://store.steampowered.com/app/915310/SNKRX/) |
| Warnings of what's about to change | Into the Breach telegraphs, Tetris's next-piece preview |
| Rewind a death | Snake Rewind |
| Sample-accurate web audio timing | ["A Tale of Two Clocks"](https://web.dev/articles/audio-scheduling) |

## Timing

- **The beat is the clock.** The `Conductor` runs a lookahead scheduler: a 25 ms JS timer schedules every audio event due within the next 120 ms on the `AudioContext` clock.
- **Grid:** 16 steps per bar, and **one worm move = one 8th note**. `GamePlus.pace()` awaits `conductor.nextTurn()`.
- **Silent fallback:** if audio is unavailable, the same scheduler runs on `performance.now()`.
- **Measured in Chrome:** moves land 0–17 ms after the scheduled beat.

**Tempo formula:**

```
bpm = min(84 + 3 × (level − 1), 180) + heat − 10 × cruiseControlStacks
heat = round((groove − 1) / 7 × 12)
```

Tempo changes take effect on the next bar line. At level 1 a move takes 357 ms; the original took about 430 ms.

## Music layers

The key is A minor, with the chords Am–F–C–G, one per bar. Every 10 levels the key moves up a semitone. In hunger mode the loop starts on C instead, which sounds brighter, and the hi-hat doubles.

| # | Layer | Enters at intensity | Sound |
|---|---|---|---|
| L0 | Metronome | always | The original 2240 Hz REFLEX tick on every 8th note. It gets quieter as other layers come in. |
| L1 | Hi-hat | ≥ .12 (or level ≥ 2) | Offbeat 8ths; 16ths above .55; an open hat above .7 |
| L2 | Beat | ≥ .25 | Kick on beats 1 and 3 (all four above .7), snare on 2 and 4 |
| L3 | Bass | ≥ .35 | Saw plus sub, pulsing 8ths with octave jumps |
| L4 | Chords | ≥ .45 | Detuned saw pad with a slow filter sweep |
| L5 | Melody | ≥ .6 | Square-wave "chip" lead (a nod to the PC speaker), new 2-bar motifs every 8 bars, with an echo |
| L6 | Brass | ≥ .75, or always while the rival is on the board | Stabs on the offbeats; a full-bar swell during the rival fight |

**Intensity** is recomputed once per bar:

```
intensity = min(0.5, (level−1)/29 × 0.5) + (groove−1)/7 × 0.25 + danger × 0.25 + 0.2·hunger + 0.3·boss
```

- `danger` is the share of the head's 8 neighbouring cells that are deadly.
- **Changes:** a layer that turns on or off fades over a bar. Layers switch off 0.08 below their threshold, so they don't flicker at the boundary.
- **Death:** a "tape stop" effect, a sweep down to 180 Hz. Intensity then drops to 0 and recovers by +0.22 per bar.
- **Pause power:** the whole mix is muffled with a low-pass filter.
- **Boon draft:** the music keeps playing, muffled, while you choose.

**Stingers** land on the next 16th note and use the current chord's notes, so they're always in key:

| Stinger | Plays |
|---|---|
| Palmtree / eat | 3-note arpeggio that climbs as the groove rises |
| Graze | High tick |
| Forcefield | Reverse swell |
| Martini | 8-note rise |
| Extraman | Fanfare |
| Wipe (level transition) | Falling arpeggio |
| Demon | Low brass hit |
| Cross, rival crash | Brass hit plus arpeggio |
| Rival arrives | Brass swell |
| Second Wind | Reverse swell plus falling notes |

The original PC-speaker death sound still plays, as a homage.

## Rules added on top of classic

- **Telegraphed evolution:** each turn's spawn picks, made with the original rules, are chosen one beat ahead and applied on the next beat.
  - Pending cells pulse **red** if they're about to become Pigman, Demon or Barren.
  - They pulse **gold** if they're about to become something good.
- **Groove ×1–×8**, with a 16-beat window (24 with Groove Keeper):
  - **Raised by:** Palmtree, Extraman, Cross, Pre-barren, a rival crash, every 3rd hunger-mode eat, and every 6th graze.
  - **Drain:** it drops one step each time the window runs out.
  - **Reset:** it goes back to ×1 whenever you lose a worm, including to a Demon.
  - **Scoring:** all object points are multiplied by it. The per-turn level bonus and the level-wipe bonus are not.
- **Graze:** ending a move next to a deadly cell pays `level × groove` points. Deadly cells are trail (except your own last few cells), Pigman, Barren, Demon and the rival.
- **Glutton**, the rival worm, arrives at levels 10, 20, 30 and so on:
  - It uses the same movement rules as you, and its trail is ordinary deadly trail.
  - Its AI looks for open space, Palmtrees, and the cell two moves ahead of you.
  - It eats Palmtrees and Extramen before you can.
  - If it crashes, its last 6 trail cells turn into Palmtrees, and you get `5000 × groove` points, +1 groove and +1 forcefield.
  - After 64 beats it leaves.
- **Boon draft** at every 5th level: pick 1 of 3 from the pool below.

| Boon | Effect |
|---|---|
| Long Field | A forcefield lasts 2 moves |
| Magnet | Collects Palmtrees in the 8 cells around you |
| Second Wind | Once per level, a death rewinds 4 beats instead |
| Lucky Charm | Demons take at most 1 worm |
| Harvest | Hunger-mode eats chain ×1/×2/×4/×8 |
| Deep Pockets | Pauses are spent one at a time (up to 3 stored) |
| Fast Fade | Your trail skips the Clear stage |
| Groove Keeper | 24-beat window; grazes count double |
| Insurance | Sunny Island makes Clear trail instead of Barren |
| Cruise Control | −10 BPM at ×0.9 score (stacks twice) |

## Testing

`node tests/sim.js` runs:
- 300 bot games of each mode, checking the invariants each turn: cell values, worms, groove, tempo, rival bounds, boon limits.
- Targeted checks: the rival-crash payout, Second Wind only once per level, Long Field covering two moves, and Palmtree groove scoring.

In the browser, `window.__reflex.music.debugIntensity = 0..1` forces the layers on and off, and `__reflex.music.layers` shows each layer's gain.
