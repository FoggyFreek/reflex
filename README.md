# Reflex Reimagined

A modern web remake of **REFLEX v1.2.3** (1988, 3F Productions), a DOS EGA arcade game. It was rebuilt by reverse-engineering the original binaries in `sourcefiles/reflex/`.

## Play

The game is a static site with no build step and no dependencies:

```sh
cd web
python -m http.server 8123
# open http://127.0.0.1:8123
```

Opening `web/index.html` directly from disk also works.

**Controls**

| Input | Action |
|---|---|
| Arrows / WASD | Steer. Press two arrows together for a diagonal. |
| Numpad 1–9 / Q E Z C | All 8 directions |
| Space / Right Shift | Forcefield (hold) |
| P / Left Shift | Pause power (3 s) |
| Esc | Menu |
| Gamepad | Stick or d-pad to steer, A = forcefield, B = pause, Start = menu |
| Touch | On-screen pad, or swipe across the board |

## Layout

```
sourcefiles/reflex/   original REFLEX.EXE, REFLEX.EGA, REFLEX.T40
tools/                disassembler, annotator, asset extractor (Python: capstone, pillow)
re/                   generated disassembly listings (funcs.txt, user.txt)
assets/               extracted sprites (PNG + JSON), sprite sheet, strings, score table
docs/                 REVERSE_ENGINEERING.md: formats, functions, exact game rules
web/                  the game
  js/game.js          DOM-free engine, a port of the original logic
  js/render.js        canvas renderer (original sprites, palettes, effects)
  js/audio.js         PC-speaker emulation (WebAudio)
  js/main.js          UI, input, HUD, Top Forty, attract mode
  js/sprites.js       generated from REFLEX.EGA
tests/sim.js          headless bot run of the engine (node tests/sim.js)
```

## Regenerate

```sh
pip install capstone pillow
python tools/extract_assets.py   # assets/ and web/js/sprites.js
python tools/disassemble.py      # re/funcs.txt
python tools/annotate.py         # re/user.txt
node tests/sim.js                # 300 bot games against the engine
```

## Faithful vs. new

**Faithful to the machine code:**

- The 23×18 board, and the evolution chain of cell values.
- The spawn rules, the safe lane, the turn timing formula, every object's effect and point value.
- Hunger mode and its palette flashes, forcefield and pause rules, barren speckles, and the Top Forty format.

**New in this remake:**

- Dark "modern" palette. The original EGA palette is available in Settings.
- Smooth head movement, glow, particles, popups and screen shake.
- A live attract-mode board behind the menu.
- An input queue, and diagonals from two arrow keys.
- Gamepad and touch controls.
- Effects that took many seconds in the original are compressed: Sunny Island and Pre-Barren ran per cell.
- A short pause after losing a worm.
- A "Get ready" pause at the start of each game.

REFLEX and its artwork belong to their original authors. This project is a non-commercial tribute.
