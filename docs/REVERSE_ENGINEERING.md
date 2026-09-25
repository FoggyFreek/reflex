# Reverse-engineering REFLEX v1.2.3

Source: `sourcefiles/reflex/` holds `REFLEX.EXE`, `REFLEX.EGA` and `REFLEX.T40`.
The game is "REFLEX (C) Ver 1.2.3, more than the mind can handle!", © 1988 3F Productions, Chicago. It was shareware ($15).

## Tooling

| Script | Output |
|---|---|
| `tools/disassemble.py` | `re/funcs.txt`: recursive-descent disassembly from `main`. It follows near and far calls and switch jump tables (capstone, 16-bit). |
| `tools/annotate.py` | `re/user.txt`: only the game's own code (0x01a5–0x2cd0), with Turbo C and BGI library calls named. |
| `tools/extract_assets.py` | Sprites (PNG, JSON, `web/js/sprites.js`), game strings and the score table. |

`pip install capstone pillow`, then run the scripts from anywhere.

## The executable

- **File layout:** MZ header of 0x400 bytes. The image is linked by Turbo C 1987 in the **small memory model**: one code segment at 0, and DGROUP at segment `0x0d6e` (file offset `0xdae0`).
- **Not packed:** every string is plain text in the data segment.
- **Graphics:** the Borland BGI EGA/VGA driver is linked in with `registerbgidriver`. The game runs in 640×350 EGA mode.
  - Menus and text screens use `conio` text mode.
  - Floating point goes through the 8087 emulator (`int 34h`–`3Dh`). It is only used in `random()` and one sound routine.

### Identified functions (code offsets)

| Offset | Purpose |
|---|---|
| `01a5` | `main`: menu loop (text mode) |
| `04f1` | play one game: init, then loop `{move; spawn; draw score; tick; delay}` |
| `0637` | move the worm one cell (forcefield / pause / input / collision) |
| `09ba` | spawn / evolve cells |
| `0b60` | clear the board (everything except Barren becomes Empty), optionally with a sweep sound and a score bonus |
| `0c09` | the 3 s Pause power |
| `0cf3` | `random(n)` = `rand()/32768.0*n` |
| `0e84` | load `reflex.ega` |
| `0f11` / `0fc7` | keyboard / joystick direction input |
| `1033` | button test: Right Shift or joystick 1 = forcefield, Left Shift or joystick 2 = pause |
| `1152` | collision dispatch (jump table over the cell value) |
| `11e5` | lose a worm |
| `1246` | descend *n* levels (Transport n=1, Super Transport n=6) |
| `12ea` | Palmtree |
| `1352` | Down Arrow |
| `1403` | Martini, hunger mode |
| `16f1` | Extraman |
| `1738` | Demon |
| `1761` | Sunny Island |
| `1821` | Cross |
| `18ed` | Pre-Barren Area |
| `19df` | move the safe lane to a random column |
| `1a5b` | game over |
| `24fa` / `2564` | read / write `reflex.t40` |
| `2733` / `2801` | Top Forty insertion / name editor |
| `2964` | title screen |
| `2c0d` | shareware notice |

### Globals (DGROUP offsets)

| Offset | Meaning | Initial value |
|---|---|---|
| `9e` | safe-lane column | 22 |
| `a0` | level | 1 |
| `a2` | speed: cells evolved per turn, wraps from 51 to 1 | 1 |
| `a4` | worms | 4 |
| `a6` | forcefields | 0 |
| `a8` | pauses | 0 |
| `aa` | score (long) | 0 |
| `ae`, `b0` | worm x, y | 12, 8 |
| `b2`, `b4` | direction dx, dy | 0, 1 (down) |
| `b6` | game-over flag | |
| `bc` | 1 = keyboard, 0 = joystick | |
| `474d` | board: 23×18 bytes, indexed `x*18+y` | |
| `295a` | table of 27 sprite pointers | |

## Asset formats

### `REFLEX.EGA`: 27 sprites

The file holds 27 records of 280 bytes each. Each record is a BGI `getimage` buffer:

- `u16 width-1 = 26` and `u16 height-1 = 16`, so each sprite is **27×17** pixels.
- Then 17 scanlines of 4 bit planes × 4 bytes, in plane order **I, R, G, B** (bit 3 → bit 0 of the colour index).
- The last 4 bytes of each record are padding.
- The game reads the file with a loop that steps 279 bytes per record, so one trailing byte of each record is dropped.

Cells are drawn at `(x*27+9, y*17+21)`, so the playfield covers 621×306 pixels inside a red border. The status line sits in a yellow bar at the top.

EGA 640×350 on a 4:3 monitor has pixels about **1.37× taller than wide**. The remake applies that aspect.

`main` calls `setpalette(1, RED)`. Only the Cross sprite's outline uses palette index 1.

| # | Sprite | # | Sprite |
|---|---|---|---|
| 0 | Worm head | 14 | Pre-Barren Area |
| 1 | Worm trail | 15 | Barren Area |
| 2 | Clear trail | 16–25 | Point badges 100…1000 |
| 3 | Empty space | 26 | Worm head, powered (forcefield or hunger) |
| 4 | Pigman | | |
| 5 | Transport | | |
| 6 | Palmtree | | |
| 7 | Down Arrow | | |
| 8 | Martini | | |
| 9 | Extraman | | |
| 10 | Demon | | |
| 11 | Super Transport | | |
| 12 | Sunny Island | | |
| 13 | Cross | | |

### `REFLEX.T40`: Top Forty

The file holds 40 fixed-width text records written with `"%20s%3d%7lu"` (name, level, score). A missing file is recreated as 40 × `Vacant`, level 0, 1000 points.

### `reflex.joy`

Four bytes (joystick calibration: left, up, right, down) written with `fputc`. It isn't shipped with the game.

## Game rules as implemented in the binary

**Cell values are sprite indices, and spawning *increments* them.** This is the key discovery. Each turn (`09ba`), `speed` random cells outside the safe-lane column get `+1`:

`Trail(1) → Clear trail(2) → Empty(3) → Pigman(4) → Transport → Palmtree → Down Arrow → Martini → Extraman → Demon → Super Transport → Sunny Island → Cross → Pre-Barren → Barren(15)`

The consequences:

- Old trail fades and becomes harmless again.
- Empty space first turns into a Pigman.
- Objects "ripen" into better and worse things over time.
- The manual only says objects "appear".

Details of the spawn routine:

- **Barren hits:** the first time a pick lands on a Barren cell, the pick is re-rolled. Later Barren hits draw a random coloured pixel inside that cell instead, so Barren areas slowly fill with speckles.
- **High speed:** if `speed > 32`, one extra random cell also jumps `+1…+7`, capped at Barren.
- **Score:** the player earns `score += level` every turn.

### Turn order (`0637`)

1. If the pause button is down and pauses > 0, run the 3 s pause (`0c09`). This spends *all* stored pauses.
2. The old head cell becomes trail, unless it is Barren.
3. If the forcefield button is down and forcefields > 0, use one forcefield this turn.
4. Read the input. The direction only changes when a key or joystick input arrives.
5. Move one cell. Edges wrap: x runs 0–22 and y runs 0–17.
6. **Forcefield:** the new cell becomes trail, even if it was Barren. **Otherwise:** run the collision table.
7. The head cell becomes trail, unless it is Barren.

### Timing

After each turn the game runs `sound(2240); delay(2); nosound()` (the tick), then waits:

`delay((50 - speed) * (8 / (level/50 + 1)))` ms, using integer division.

At level 1 that is 392 ms plus overhead.

### Collision table (`1152`)

| Cell | Effect |
|---|---|
| Trail, Pigman, Barren | Lose a worm (`11e5`): death sound, the cell turns Barren, and worms−1. At 0 worms the game is over. Otherwise the board is cleared and the worm carries on in the same direction. |
| Clear trail, Empty | Nothing |
| Transport / Super Transport | The cell turns **Barren**. Then, for each level: wipe the board (sound sweep, `+level` per row), level+1, speed+1 (51 wraps to 1), forcefields+1 (max 10), pauses+1. If speed ≥ 30, the safe lane moves one column left. If speed ≥ 35, the safe lane jumps to a random column. |
| Palmtree | `k = random(10)+1`: +100·k points, shows point badge k |
| Down Arrow | Every cell with a value between 4 and 14 gets −1 and `+random(5)` points |
| Martini | Hunger mode for `level+2` moves at a fixed 350 ms per move, with no spawning. Walk over anything. A cell with value v > 3 gives `(v−3)·100` points. Barren still kills. `setbkcolor` flashes the ink colour through brown, then red/green/grey for the last 3 moves. |
| Extraman | If worms < 10: worms+1 and +3000 |
| Demon | Lose `random(4)` worms, so 0–3 |
| Sunny Island | Every trail cell becomes Barren, +8 each |
| Cross | The head's row and column become Clear trail (drawn as empty), Barren included. +4000. |
| Pre-Barren | Every Pre-Barren cell flashes and becomes Empty, +500 each |

### Small quirks

- The Demon loop keeps going below 0 worms: the counter can show −1. The remake stops at 0.
- A score equal to the 40th entry can never take the last Top Forty slot.
- The safe lane can walk off the board (column −1) after the 50 → 1 speed wrap. That leaves no safe lane until speed 35 re-randomizes it.
