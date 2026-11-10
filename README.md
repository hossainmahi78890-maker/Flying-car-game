# AEROVOLT

A minimalist, heavy-metal flying car game. Pick a car, fly through a
procedurally generated obstacle corridor, and don't crash or fall — that's the
whole game. Runs as a website, a web app, and a native Windows desktop app
from a single codebase.

## Play it

**As a website / web app** (any modern browser, no install):

```
npm install
npm start
```

Then open http://localhost:5173

**As a Windows desktop app** (dev mode, opens a native window):

```
npm install
npm run electron
```

**Build a Windows installer (.exe)**:

```
npm run dist:win
```

The installer is written to `dist/`. This uses [electron-builder](https://www.electron.build/)'s NSIS target — no code-signing certificate is required to build or run it locally (Windows SmartScreen will show an "unknown publisher" warning on first run, which is normal for unsigned apps).

**Build a Microsoft Store package (.appx)**:

```
npm run dist:appx
```

Before this will produce a package you can actually submit to the Microsoft Store, edit the `build.appx` section of `package.json` and replace `publisher` / `publisherDisplayName` with the identity values from your [Partner Center](https://partner.microsoft.com/dashboard) app registration. Building `.appx` also requires the Windows SDK (`makeappx.exe`), which ships with Visual Studio's "Desktop development with C++" workload or the standalone Windows SDK installer.

## How to play

- **W / ↑** — thrust forward
- **S / ↓** — brake / reverse
- **A D / ← →** — steer
- **SPACE** — vertical thrusters (fly)
- **SHIFT** — boost (limited, refills over time — or fly through a cyan ring to refill instantly)
- **R** — restart after a run ends

Hit a pillar or a wall and you crash. Drift off the edge of the flight corridor or lose too much altitude, and you fall. Either one ends the run. Thrusters cut out at max altitude, so the only way past a wall is through its gap. Distance flown is your score; your best is saved locally.

## Cars

Five cars, each a different point on the power/mass/handling/lift trade-off — heavier cars accelerate harder and have a bigger hitbox but are far less forgiving in the air; lighter cars are fragile in a straight line but easy to thread through gaps:

| Car | Power | Mass | Handling | Lift |
|---|---|---|---|---|
| TITAN | High | High | Low | Low |
| VIPER | Med | Low | High | High |
| HAMMERHEAD | Med | Med | Med | Med |
| GHOST | Low | Very Low | High | Very High |
| JUGGERNAUT | Max | Max | Very Low | Low |

## Project structure

```
web/                  the actual game (open web/index.html via a server — see below)
  index.html
  style.css
  vendor/three.*       vendored Three.js build (no CDN dependency, works offline)
  src/
    main.js            screen flow / UI wiring
    game.js            flight physics, camera, collision, HUD updates
    world.js           procedural obstacle corridor generation + collision checks
    cars.js            car stats + low-poly car mesh builder
    carPreview.js       rotating car-select showroom render
server.js              tiny static file server (used standalone for `npm start`,
                        and internally by the Electron app so it can reuse the
                        exact same web app instead of a second codepath)
electron/main.js        Windows desktop wrapper — starts server.js on a local
                        port and loads it in a native window
```

`web/vendor/three.module.js` and `three.core.js` are Three.js's own build output, copied from `node_modules/three/build/` (not hand-written) so the game has no CDN dependency and works fully offline, including when packaged as a Windows app.

## Why a local HTTP server instead of `file://`

Both the browser build and the Electron app load the game over `http://` rather than `file://`. Chromium blocks ES module imports (`<script type="module">`, which `main.js` needs for its `import` statements) from `file://` URLs. `electron/main.js` starts `server.js` on an ephemeral localhost port at launch and points the window at it, so the desktop app and the website run the identical files with no build step or bundler in between.
