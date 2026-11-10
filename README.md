# Hill Tracts Express — পাহাড়ি এক্সপ্রেস

A bus driving game set on the hill road from **Bandarban to Nilgiri** in Bangladesh's
Chittagong Hill Tracts. One bus, one level: drive the winding mountain road above the
lake, keep left, stop for passengers at every village, and get everyone to Nilgiri.

Everything — the hills, lake, road, villages, people, vehicles, signs and sounds — is
generated in code. There are no image, model or audio files, so the game works fully
offline. It runs as a website, a web app, and a native Windows desktop app from one codebase.

## Play it

**In a browser** (no install needed beyond Node.js):

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

Before this will produce a package you can submit to the Microsoft Store, edit the `build.appx` section of `package.json` and replace `publisher` / `publisherDisplayName` with the identity values from your [Partner Center](https://partner.microsoft.com/dashboard) app registration. Building `.appx` also requires the Windows SDK (`makeappx.exe`).

## The route

| Stop | | |
|---|---|---|
| Bandarban | বান্দরবান | Start — the bus terminal in town |
| Meghla | মেঘলা | Village stop beside the lake |
| Shoilo Propat | শৈলপ্রপাত | Stop by the waterfall |
| Chimbuk | চিম্বুক | Village stop high on the ridge |
| Nilgiri | নীলগিরি | Finish — the hilltop under the welcome arch |

On the way: Kaptai-style lake with country boats, bamboo and banana groves, areca palms,
tall garjan trees, stilt houses, tea stalls, black-and-yellow bollards on the drops,
electric poles, kilometre posts and road signs in Bangla, and oncoming Chander Gari
jeeps, CNG auto-rickshaws and hand-painted trucks.

## How to play

| Key | Action |
|---|---|
| **W / ↑** | Accelerate |
| **S / ↓** | Brake · hold when stopped to reverse |
| **A D / ← →** | Steer |
| **Space** | Handbrake |
| **H** | Horn |
| **C** | Chase camera / driver's-seat camera |
| **Drag** | Look around |
| **R** | Put the bus back on the road (−120 points) |
| **M** | Sound on / off |
| **Esc** | Pause |

- **Keep left.** Bangladesh drives on the left. Oncoming traffic uses the right lane — hit a vehicle and the run is over.
- **Stop at every bus stop.** Pull into the green zone on the left verge and stop completely. The doors open and passengers walk aboard. Driving past a stop leaves its passengers behind.
- **Mind the edge.** Bollards guard the drops: scraping them costs points. Leave the road completely and the bus is put back with a penalty.
- **Use the hills.** The bus slows on climbs and speeds up on descents — brake before the hairpins.

Score = 100 per passenger delivered + a time bonus − penalties (missed stops, scrapes,
recoveries, wrong-lane driving). Up to three stars per run; your best score is saved locally.

## Project structure

```
web/                  the game (serve it over http — see below)
  index.html          screens: loading, menu, how to play, HUD, pause, results
  style.css
  vendor/three.*      vendored Three.js build (no CDN dependency, works offline)
  src/
    main.js           screen flow and HUD wiring
    game.js           bus physics, stops and passengers, traffic, cameras, minimap
    world.js          the level: terrain, road, lake, villages, vegetation, sky
    bus.js            the bus model (livery, wheels, door, driver's cab)
    props.js          low-poly props: trees, houses, people, vehicles, signs
    audio.js          synthesised engine, horn, door and crash sounds (Web Audio)
    noise.js          seeded noise + small math helpers
server.js             tiny static file server (used by `npm start` and by the Electron app)
electron/main.js      Windows desktop wrapper — starts server.js on a local port and loads it
```

`web/vendor/three.module.js` and `three.core.js` are Three.js's own build output, copied from `node_modules/three/build/`, so the game has no CDN dependency and works fully offline, including when packaged as a Windows app.

## Why a local HTTP server instead of `file://`

Both the browser build and the Electron app load the game over `http://` rather than `file://`. Chromium blocks ES module imports (`<script type="module">`) from `file://` URLs. `electron/main.js` starts `server.js` on an ephemeral localhost port at launch and points the window at it, so the desktop app and the website run the identical files with no build step.
