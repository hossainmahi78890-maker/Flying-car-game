import * as THREE from "../vendor/three.module.js";
import { World, ROAD_HALF, SHOULDER, LANE, WATER_Y, OFFROAD_LIMIT } from "./world.js";
import { buildBus, BUS } from "./bus.js";
import * as P from "./props.js";
import { clamp, lerp, mulberry32 } from "./noise.js";
import { Sound } from "./audio.js";

const STEP = 1 / 120; // physics runs in fixed small steps
const MAX_SPEED = 22.5; // m/s ≈ 81 km/h
const MAX_REVERSE = 4;
const ENGINE = 2.9; // m/s² from rest
const BRAKE = 6.5;
const HANDBRAKE = 7;
const MAX_STEER = 0.6; // front wheel angle at walking pace
const STEER_RATE = 1.4; // how fast the wheels turn (rad/s)
const GEARS = [0, 5.5, 10.5, 16, MAX_SPEED + 0.5];
const BARRIER = ROAD_HALF + 0.75; // bus body stops here where there are bollards
const START_PASSENGERS = 8;
const BEST_KEY = "hte_best";
const TAU = Math.PI * 2;

// Body outline points (local x, z) checked against the bollards.
const OUTLINE = [[1.25, 5.6], [-1.25, 5.6], [1.25, 0], [-1.25, 0], [1.25, -5.6], [-1.25, -5.6]];

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Game {
  /** ui: { onHud(data), onMessage(title, sub, kind, ms), onEnd(result), onPause(paused) } */
  constructor(canvas, ui) {
    this.ui = ui;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.world = new World(this.scene);
    this.sound = new Sound();
    this.keys = Object.create(null);
    this.mode = "loading"; // loading | menu | driving | paused | ended
    this.camMode = "chase"; // chase | cockpit
    this.camOffset = 0; // mouse-look yaw
    this.t = 0;
    this.alighting = [];

    this._bindInput(canvas);
    this._resize = this._resize.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();
    this.lastFrame = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  async init(onProgress) {
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    await this.world.build(onProgress, { maxAniso: aniso });
    this.bus = buildBus(aniso);
    this.scene.add(this.bus.root);
    for (const s of this.world.stops) {
      for (const p of s.people) {
        p.userData.home = p.position.clone();
        p.userData.homeYaw = p.rotation.y;
      }
    }
    this._buildStopMarker();
    this._buildTraffic();
    this._buildMinimapPath();
    this.reset();
    this.mode = "menu";
    this._applyBus(0);
    this._updateCamera(0);
    this.renderer.compile(this.scene, this.camera);
  }

  setMinimap(canvas) {
    this.minimap = canvas;
  }

  /* ============================== Run control ============================== */

  reset() {
    const w = this.world;
    for (const s of w.stops) {
      s.served = false;
      for (const p of s.people) {
        p.visible = true;
        p.position.copy(p.userData.home);
        p.rotation.y = p.userData.homeYaw;
      }
    }
    for (const p of this.alighting) this.scene.remove(p);
    this.alighting = [];

    const f = w.frame(26, -LANE);
    this.pos = new THREE.Vector3(f.x, f.e + 0.06, f.z);
    this.yaw = f.yaw;
    this.v = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.accel = 0;
    this.spin = 0;
    this.slope = 0;
    this.groundPitch = 0;
    this.groundRoll = 0;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.u = 26;
    this.s = -LANE;
    this.q = w.locate(f.x, f.z, true);
    this.offRoad = false;

    this.target = 1;
    this.phase = "drive"; // drive | doors | closing
    this.phaseT = 0;
    this.closeT = 0;
    this.hold = 0;
    this.doorOpen = 0;
    this.queue = [];
    this.toldBack = false;
    this.passengers = START_PASSENGERS;
    this.stats = { time: 0, missed: 0, scrapes: 0, respawns: 0, wrongLane: 0 };
    this.scraping = false;
    this.scrapeFree = 0;
    this.wrongT = 0;
    this.wrongWarned = false;
    this.shake = 0;
    this.camYaw = this.yaw;
    this.camPos = null;
    this.endT = 0;
    this._resetTraffic();
    this._ground();
    this.pos.y = this.groundY;
    this._placeStopMarker();
  }

  start() {
    this.sound.init();
    this.reset();
    this.mode = "driving";
    this.camPos = null;
    this.lastFrame = performance.now();
    const next = this.world.stops[1];
    this.ui.onMessage(`Next stop: ${next.en}`, `${next.bn} · ${this.passengers} passengers aboard`, "info", 4000);
  }

  pause(on) {
    if (on && this.mode === "driving") this.mode = "paused";
    else if (!on && this.mode === "paused") {
      this.mode = "driving";
      this.lastFrame = performance.now();
    } else return;
    this.sound.hornOff();
    this.ui.onPause(this.mode === "paused");
  }

  toMenu() {
    this.sound.hornOff();
    this.sound.engine(false, 0, 0);
    this.reset();
    this.mode = "menu";
  }

  respawn(auto = false) {
    if (this.mode !== "driving" || this.phase !== "drive") return;
    const w = this.world;
    const q = w.locate(this.pos.x, this.pos.z, true);
    const u = clamp(q.u - 6, 12, w.length - 12);
    const f = w.frame(u, -LANE);
    this.pos.set(f.x, f.e + 0.06, f.z);
    this.yaw = f.yaw;
    this.camYaw = f.yaw;
    this.v = 0;
    this.steer = 0;
    this.camPos = null;
    this.stats.respawns++;
    this.ui.onMessage(auto ? "Back on the road" : "Bus recovered", "−120 points", "warn", 2500);
  }

  /* ================================ Input ================================= */

  _bindInput(canvas) {
    const GAME_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (this.mode === "driving" && GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (e.code === "Escape") this.pause(this.mode === "driving");
      if (this.mode !== "driving") return;
      if (e.code === "KeyC") {
        this.camMode = this.camMode === "chase" ? "cockpit" : "chase";
        this.camOffset = 0;
        this.camPos = null;
      }
      if (e.code === "KeyH") this.sound.hornOn();
      if (e.code === "KeyM") this.sound.setMuted(!this.sound.muted);
      if (e.code === "KeyR") this.respawn(false);
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
      if (e.code === "KeyH") this.sound.hornOff();
    });
    window.addEventListener("blur", () => {
      this.keys = Object.create(null);
      this.sound.hornOff();
    });
    // Drag to look around; the view eases back when you let go.
    let dragging = false;
    let lastX = 0;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
    });
    window.addEventListener("pointerup", () => (dragging = false));
    window.addEventListener("pointermove", (e) => {
      if (!dragging || this.mode !== "driving") return;
      this.camOffset = clamp(this.camOffset - (e.clientX - lastX) * 0.006, -Math.PI, Math.PI);
      lastX = e.clientX;
    });
    this._isDragging = () => dragging;
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* =============================== Main loop =============================== */

  _loop() {
    requestAnimationFrame(this._loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    if (this.mode === "loading") return;
    this.t += dt;

    if (this.mode === "driving") {
      this._ground();
      let rem = dt;
      while (rem > 1e-6 && this.mode === "driving") {
        const h = Math.min(rem, STEP);
        this._physics(h);
        rem -= h;
      }
      this.pos.y += (this.groundY - this.pos.y) * Math.min(1, dt * 25);
      if (this.mode === "driving") this._gameplay(dt);
    }
    if (this.mode === "ended") this._endUpdate(dt);
    if (this.mode !== "paused") this._updateTraffic(dt);

    this._applyBus(dt);
    this._updateStopMarker(dt);
    this._updateCamera(dt);
    this.world.update(dt, this.t, this.pos, this.camera);
    this._engineSound();
    this.renderer.render(this.scene, this.camera);
    if (this.mode === "driving" || this.mode === "paused") {
      this._hud();
      this._drawMinimap();
    }
  }

  /* =============================== Physics ================================ */

  /** Wheel heights → ride height, pitch, roll and slope (for gravity on hills). */
  _ground() {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const h = (lx, lz) => this.world.groundAt(this.pos.x + lx * cy + lz * sy, this.pos.z - lx * sy + lz * cy);
    const fl = h(1.03, BUS.frontAxle);
    const fr = h(-1.03, BUS.frontAxle);
    const rl = h(1.03, BUS.rearAxle);
    const rr = h(-1.03, BUS.rearAxle);
    const front = (fl + fr) / 2;
    const rear = (rl + rr) / 2;
    this.slope = (front - rear) / BUS.wheelbase;
    this.groundPitch = Math.atan(this.slope);
    this.groundRoll = Math.atan(((fl + rl) / 2 - (fr + rr) / 2) / BUS.track);
    this.groundY = rear + (front - rear) * (-BUS.rearAxle / BUS.wheelbase);
  }

  _physics(dt) {
    const k = this.keys;
    const up = k.KeyW || k.ArrowUp;
    const down = k.KeyS || k.ArrowDown;
    const left = k.KeyA || k.ArrowLeft;
    const right = k.KeyD || k.ArrowRight;
    const hand = k.Space;
    const locked = this.phase !== "drive"; // doors open = bus held
    const v = this.v;
    const reverseIntent = !locked && down && !up && v <= 0.3;

    let a = 0;
    if (!locked) {
      if (up) a += v < -0.3 ? BRAKE : ENGINE * Math.pow(1 - clamp(v / MAX_SPEED, 0, 1), 1.2) + 0.25;
      if (down && v > 0.3) a -= BRAKE;
      if (reverseIntent && v > -MAX_REVERSE) a -= 1.6;
    } else {
      a -= Math.sign(v) * BRAKE;
    }
    if (hand) a -= Math.sign(v) * HANDBRAKE;
    a -= 9.81 * this.slope * 0.85; // hills pull you back (or push you down)
    a -= Math.sign(v) * (0.16 + (this.offRoad ? 1.8 : 0)) + 0.0028 * v * Math.abs(v);

    let nv = v + a * dt;
    // Brakes and friction stop the bus; they never push it backwards.
    if (v !== 0 && Math.sign(nv) !== Math.sign(v) && !(up && v < 0) && !reverseIntent) nv = 0;
    // A stopped bus stays put (hill hold) unless you drive it.
    if (Math.abs(nv) < 0.12 && !up && !reverseIntent) nv = 0;
    nv = clamp(nv, -MAX_REVERSE, this.offRoad ? 8 : MAX_SPEED);
    this.accel = (nv - v) / dt;
    this.v = nv;

    // Steering: plenty of lock at low speed, very little at speed.
    const lim = MAX_STEER * lerp(1, 0.25, clamp(Math.abs(nv) / MAX_SPEED, 0, 1));
    const target = ((left ? 1 : 0) - (right ? 1 : 0)) * lim;
    this.steer += clamp(target - this.steer, -STEER_RATE * dt, STEER_RATE * dt);
    this.yawRate = (nv / BUS.wheelbase) * Math.tan(this.steer);
    this.yaw += this.yawRate * dt;
    this.pos.x += Math.sin(this.yaw) * nv * dt;
    this.pos.z += Math.cos(this.yaw) * nv * dt;
    this.spin += (nv / BUS.wheelR) * dt;

    this._barriers(dt);
    const q = this.world.locate(this.pos.x, this.pos.z, true);
    this.q = q;
    this.u = q.u;
    this.s = q.s;
    this.offRoad = q.dist > ROAD_HALF + SHOULDER + 0.2;
  }

  /** Bollards are solid: push the bus back onto the road and make it scrape. */
  _barriers(dt) {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    let hit = false;
    for (const [lx, lz] of OUTLINE) {
      const x = this.pos.x + lx * cy + lz * sy;
      const z = this.pos.z - lx * sy + lz * cy;
      const q = this.world.locate(x, z);
      if (!q) continue;
      let push = 0;
      if (q.guardR && q.s > BARRIER) push = q.s - BARRIER;
      else if (q.guardL && q.s < -BARRIER) push = q.s + BARRIER;
      if (!push) continue;
      this.pos.x += q.tz * push; // minus the road's right vector (-tz, tx) times push
      this.pos.z -= q.tx * push;
      const roadYaw = Math.atan2(q.tx, q.tz) + (this.v < 0 ? Math.PI : 0);
      this.yaw += angleDiff(roadYaw, this.yaw) * 0.06;
      hit = true;
    }
    if (hit) {
      this.v *= 0.992;
      this.scrapeFree = 0;
      // One scrape = one penalty, however long you grind along the bollards.
      if (!this.scraping && Math.abs(this.v) > 1) {
        this.scraping = true;
        this.stats.scrapes++;
        this.sound.scrape();
        this.shake = 0.5;
        this.ui.onMessage("Scraped the barrier", "−25 points", "warn", 1800);
      }
    } else if (this.scraping) {
      this.scrapeFree += dt;
      if (this.scrapeFree > 1.2) this.scraping = false;
    }
  }

  /* =============================== Gameplay =============================== */

  _gameplay(dt) {
    this.stats.time += dt;
    if (this.q.dist > OFFROAD_LIMIT || this.pos.y < WATER_Y + 0.3) {
      this.respawn(true);
      return;
    }
    // Keep left!
    if (this.s > 0.4 && this.v > 2) {
      this.wrongT += dt;
      if (this.wrongT > 2.2 && !this.wrongWarned) {
        this.stats.wrongLane++;
        this.wrongWarned = true;
        this.ui.onMessage("Keep left!", "Bangladesh drives on the left · −40 points", "warn", 2600);
      }
    } else if (this.s < 0) {
      this.wrongT = 0;
      this.wrongWarned = false;
    }
    this._stopLogic(dt);
    this._checkTraffic();
  }

  _announce() {
    const stop = this.world.stops[this.target];
    if (!stop) return;
    this._placeStopMarker();
    this.ui.onMessage(`Next stop: ${stop.en}`, stop.bn, "info", 3500);
  }

  _stopLogic(dt) {
    const stop = this.world.stops[this.target];
    if (!stop) return;
    const du = this.u - stop.u;

    if (this.phase === "drive") {
      const inZone = du > -14 && du < 7 && this.s < 0.6 && this.s > -(ROAD_HALF + SHOULDER + 2.5);
      if (inZone && Math.abs(this.v) < 0.4) {
        this.hold += dt;
        if (this.hold > 0.6) this._openDoors(stop);
      } else {
        this.hold = 0;
      }
      if (!stop.final && du > 25) {
        this.stats.missed++;
        const left = stop.people.filter((p) => p.visible).length;
        this.ui.onMessage(`Missed ${stop.en}`, `${left} passengers left behind · −150 points`, "warn", 3200);
        this.target++;
        this._announce();
      } else if (stop.final && du > 22 && !this.toldBack) {
        this.toldBack = true;
        this.ui.onMessage("You passed the Nilgiri stop", "Reverse back to the green zone (S)", "warn", 3500);
      }
      return;
    }

    if (this.phase === "doors") {
      this.doorOpen = Math.min(1, this.doorOpen + dt / 0.6);
      if (this.doorOpen < 1) return;
      if (stop.final) this._alight(dt);
      else this._board(dt);
      return;
    }

    if (this.phase === "closing") {
      this.doorOpen = Math.max(0, this.doorOpen - dt / 0.6);
      if (this.doorOpen === 0) {
        this.phase = "drive";
        this.target++;
        this._announce();
      }
    }
  }

  _openDoors(stop) {
    this.phase = "doors";
    this.phaseT = 0;
    this.v = 0;
    this.sound.door();
    this.queue = stop.people.filter((p) => p.visible);
    this.queue.forEach((p, k) => (p.userData.delay = 0.3 + k * 0.55));
    if (stop.final) {
      this.ui.onMessage("Arrived at Nilgiri!", "নীলগিরি · passengers are getting off", "good", 3500);
    } else {
      this.ui.onMessage(`${stop.en} — doors open`, this.queue.length ? `${this.queue.length} passengers boarding` : "Nobody waiting", "good", 2500);
    }
  }

  /** Point on the ground just outside the kerb-side door. */
  _doorPoint() {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const lx = BUS.width / 2 + 0.7;
    const lz = BUS.doorZ;
    return { x: this.pos.x + lx * cy + lz * sy, z: this.pos.z - lx * sy + lz * cy };
  }

  _board(dt) {
    this.phaseT += dt;
    const door = this._doorPoint();
    for (const p of [...this.queue]) {
      if (this.phaseT < p.userData.delay) continue;
      const dx = door.x - p.position.x;
      const dz = door.z - p.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) {
        p.visible = false;
        this.queue.splice(this.queue.indexOf(p), 1);
        this.passengers++;
        this.sound.tick();
        continue;
      }
      const stepLen = Math.min(d, 2.0 * dt);
      p.position.x += (dx / d) * stepLen;
      p.position.z += (dz / d) * stepLen;
      p.position.y = this.world.groundAt(p.position.x, p.position.z) + Math.abs(Math.sin(this.t * 11 + p.id)) * 0.05;
      p.rotation.y = Math.atan2(dx, dz);
    }
    if (!this.queue.length) {
      this.closeT = (this.closeT || 0) + dt;
      if (this.closeT > 0.8) {
        this.closeT = 0;
        this.phase = "closing";
        this.sound.door();
        this.world.stops[this.target].served = true;
      }
    }
  }

  _alight(dt) {
    if (!this.alighting.length) {
      const rand = mulberry32(5);
      const n = Math.min(this.passengers, 10);
      const door = this._doorPoint();
      for (let k = 0; k < n; k++) {
        const p = P.person(rand);
        p.position.set(door.x, this.world.groundAt(door.x, door.z), door.z);
        p.visible = false;
        p.userData.delay = k * 0.35;
        const a = this.yaw + Math.PI / 2 + (rand() - 0.5) * 1.6; // walk away from the kerb side
        p.userData.dir = [Math.sin(a), Math.cos(a)];
        this.scene.add(p);
        this.alighting.push(p);
      }
      this.phaseT = 0;
      this.sound.chime();
    }
    this.phaseT += dt;
    for (const p of this.alighting) {
      if (this.phaseT < p.userData.delay) continue;
      p.visible = true;
      const [dx, dz] = p.userData.dir;
      p.position.x += dx * 1.5 * dt;
      p.position.z += dz * 1.5 * dt;
      p.position.y = this.world.groundAt(p.position.x, p.position.z) + Math.abs(Math.sin(this.t * 11 + p.id)) * 0.05;
      p.rotation.y = Math.atan2(dx, dz);
    }
    if (this.phaseT > 4.2) this._finish(true);
  }

  _finish(success, reason = "") {
    this.mode = "ended";
    this.endT = 0;
    this.sound.hornOff();
    const st = this.stats;
    const delivered = success ? this.passengers : 0;
    const waitingTotal = this.world.stops.reduce((n, s) => n + s.people.length, 0);
    const maxScore = (START_PASSENGERS + waitingTotal) * 100 + 600;
    const timeBonus = success ? Math.max(0, Math.round((480 - st.time) * 2)) : 0;
    const penalties = st.missed * 150 + st.scrapes * 25 + st.respawns * 120 + st.wrongLane * 40;
    const score = success ? Math.max(0, delivered * 100 + timeBonus - penalties) : 0;
    const stars = success ? (score >= maxScore * 0.82 ? 3 : score >= maxScore * 0.55 ? 2 : 1) : 0;
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY) || 0);
      if (score > best) {
        best = score;
        localStorage.setItem(BEST_KEY, String(score));
      }
    } catch {}
    const result = { success, reason, delivered, time: st.time, timeBonus, penalties, score, stars, best, stats: { ...st } };
    setTimeout(() => this.ui.onEnd(result), success ? 400 : 1300);
  }

  _endUpdate(dt) {
    this.endT += dt;
    // let the bus roll to a stop after a crash
    this.v *= Math.max(0, 1 - dt * 3);
    this.pos.x += Math.sin(this.yaw) * this.v * dt;
    this.pos.z += Math.cos(this.yaw) * this.v * dt;
    this.doorOpen = Math.max(0, this.doorOpen - dt);
    for (const p of this.alighting) {
      const [dx, dz] = p.userData.dir;
      p.position.x += dx * 1.5 * dt;
      p.position.z += dz * 1.5 * dt;
      p.position.y = this.world.groundAt(p.position.x, p.position.z);
    }
  }

  /* =============================== Traffic ================================ */

  _buildTraffic() {
    const defs = [
      P.chanderGari("#2f6a8a"), P.cngAuto(), P.paintedTruck(), P.chanderGari("#7a3b2e"),
      P.cngAuto(), P.chanderGari("#3c6e57"), P.paintedTruck(),
    ];
    this.traffic = defs.map((d) => {
      const mesh = new THREE.Mesh(d.geo, P.MAT.solid);
      mesh.castShadow = true;
      mesh.rotation.order = "YXZ";
      this.scene.add(mesh);
      return { mesh, circles: d.circles, cruise: 10, v: 10, u: 0, honked: false };
    });
  }

  _resetTraffic() {
    const L = this.world.length;
    const r = mulberry32(99);
    const n = this.traffic.length;
    this.traffic.forEach((c, k) => {
      c.u = 300 + ((L - 360) * (k + r() * 0.5)) / n;
      c.cruise = 9 + r() * 3.5;
      c.v = c.cruise;
      c.mesh.visible = true;
      c.honked = false;
    });
  }

  /** Oncoming traffic in the right-hand lane, heading down toward Bandarban. */
  _updateTraffic(dt) {
    const w = this.world;
    const busActive = this.mode === "driving" || this.mode === "ended";
    for (const c of this.traffic) {
      if (!c.mesh.visible) continue;
      let target = c.cruise;
      for (const o of this.traffic) {
        if (o !== c && o.mesh.visible && o.u < c.u && c.u - o.u < 24) target = Math.min(target, o.v * 0.9);
      }
      // Slow down (and honk) if the bus is sitting in their lane ahead of them.
      if (busActive) {
        const gap = c.u - this.u;
        if (gap > 0 && gap < 50 && this.s > -0.4) {
          target = Math.min(target, Math.max(0, (gap - 15) * 0.45));
          if (!c.honked && gap < 40 && this.mode === "driving") {
            c.honked = true;
            this.ui.onMessage("Oncoming traffic!", "Get back into the left lane", "warn", 1800);
          }
        } else if (gap < 0 || gap > 60) {
          c.honked = false;
        }
      }
      c.v += clamp(target - c.v, -7 * dt, 2 * dt);
      c.u -= c.v * dt;
      if (c.u < 40) {
        // Respawn far up the road — unless the bus is up there already.
        if (this.u > w.length - 260) {
          c.mesh.visible = false;
          continue;
        }
        c.u = w.length - 30 - Math.random() * 80;
        c.v = c.cruise;
      }
      const f = w.frame(c.u, LANE);
      const ahead = w.frame(c.u - 3).e;
      const behind = w.frame(c.u + 3).e;
      c.mesh.position.set(f.x, f.e + 0.05, f.z);
      c.mesh.rotation.set(-Math.atan2(ahead - behind, 6), f.yaw + Math.PI, 0);
    }
  }

  _checkTraffic() {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    for (const c of this.traffic) {
      if (!c.mesh.visible) continue;
      const m = c.mesh.position;
      if ((m.x - this.pos.x) ** 2 + (m.z - this.pos.z) ** 2 > 22 * 22) continue;
      const ry = c.mesh.rotation.y;
      const cc = Math.cos(ry);
      const cs = Math.sin(ry);
      for (const bz of [4.2, 1.4, -1.4, -4.2]) {
        const bx = this.pos.x + bz * sy;
        const bzz = this.pos.z + bz * cy;
        for (const [ox, oz, r] of c.circles) {
          const x = m.x + ox * cc + oz * cs;
          const z = m.z - ox * cs + oz * cc;
          if ((x - bx) ** 2 + (z - bzz) ** 2 < (r + 1.3) ** 2) {
            this._accident();
            return;
          }
        }
      }
    }
  }

  _accident() {
    this.sound.crash();
    this.shake = 1.4;
    this.v *= 0.3;
    this.ui.onMessage("Accident!", "You hit oncoming traffic", "bad", 3000);
    this._finish(false, "accident");
  }

  /* =========================== Stop marker & map =========================== */

  _buildStopMarker() {
    const tex = P.canvasTexture(128, 512, (ctx, w, h) => {
      ctx.fillStyle = "rgba(40, 200, 110, 0.35)";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(220, 255, 230, 0.95)";
      ctx.lineWidth = 8;
      ctx.setLineDash([26, 18]);
      ctx.strokeRect(6, 6, w - 12, h - 12);
    });
    this.zoneMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.zone = new THREE.Mesh(new THREE.BufferGeometry(), this.zoneMat);
    this.zone.renderOrder = 2;
    this.scene.add(this.zone);

    // Floating green beacon above the stop.
    this.beacon = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 4), new THREE.MeshBasicMaterial({ color: 0x3ddc84 }));
    cone.rotation.x = Math.PI;
    this.beacon.add(cone);
    this.scene.add(this.beacon);
  }

  _placeStopMarker() {
    const stop = this.world.stops[this.target];
    if (!this.zone) return;
    this.zone.visible = this.beacon.visible = !!stop;
    if (!stop) return;
    const w = this.world;
    const pos = [];
    const uv = [];
    const idx = [];
    const u0 = stop.u - 14;
    const u1 = stop.u + 7;
    const n = 22;
    for (let k = 0; k <= n; k++) {
      const u = lerp(u0, u1, k / n);
      for (const [s, uu] of [[-LANE - 1.45, 0], [-LANE + 1.45, 1]]) {
        const f = w.frame(u, s);
        pos.push(f.x, f.e + 0.1, f.z);
        uv.push(uu, k / n);
      }
      if (k < n) {
        const a = k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.zone.geometry.dispose();
    this.zone.geometry = g;
    const f = w.frame(stop.u - 3, -LANE);
    this.beacon.position.set(f.x, f.e + 7, f.z);
  }

  _updateStopMarker(dt) {
    if (!this.beacon) return;
    const show = this.mode === "driving" || this.mode === "paused";
    this.zone.visible = this.beacon.visible = show && !!this.world.stops[this.target] && this.phase === "drive";
    this.beacon.rotation.y += dt * 1.6;
    this.beacon.children[0].position.y = Math.sin(this.t * 2.4) * 0.35;
    this.zoneMat.opacity = 0.65 + Math.sin(this.t * 4) * 0.3;
  }

  _buildMinimapPath() {
    const w = this.world;
    const path = new Path2D();
    for (let i = 0; i < w.n; i += 2) {
      if (i === 0) path.moveTo(w.px[i], w.pz[i]);
      else path.lineTo(w.px[i], w.pz[i]);
    }
    this.routePath = path;
  }

  _drawMinimap() {
    const cv = this.minimap;
    if (!cv || !this.routePath) return;
    const ctx = cv.getContext("2d");
    const S = cv.width;
    const k = S / 2 / 200; // 200 m radius
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, TAU);
    ctx.clip();
    ctx.fillStyle = "rgba(22, 38, 28, 0.85)";
    ctx.fillRect(0, 0, S, S);
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    // Heading-up: the bus always points to the top of the map.
    ctx.setTransform(-c * k, -s * k, s * k, -c * k, S / 2, S / 2);
    ctx.translate(-this.pos.x, -this.pos.z);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 16 / k;
    ctx.stroke(this.routePath);
    ctx.strokeStyle = "#e9e3cf";
    ctx.lineWidth = 7 / k;
    ctx.stroke(this.routePath);
    this.world.stops.forEach((stop, i) => {
      const f = this.world.frame(stop.u, -6);
      ctx.fillStyle = i === this.target ? "#3ddc84" : i < this.target ? "#8a8f8c" : "#ffd23f";
      ctx.beginPath();
      ctx.arc(f.x, f.z, (i === this.target ? 9 : 6) / k, 0, TAU);
      ctx.fill();
    });
    ctx.fillStyle = "#ff5a4f";
    for (const t of this.traffic) {
      if (!t.mesh.visible) continue;
      ctx.beginPath();
      ctx.arc(t.mesh.position.x, t.mesh.position.z, 5 / k, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // the bus
    ctx.setTransform(1, 0, 0, 1, S / 2, S / 2);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#0f6b3c";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ========================== Visuals & camera ========================== */

  _applyBus(dt) {
    const b = this.bus;
    if (!b) return;
    b.root.position.copy(this.pos);
    b.root.rotation.set(-this.groundPitch, this.yaw, this.groundRoll);
    const lateral = this.v * this.yawRate;
    const ease = Math.min(1, dt * 4);
    this.bodyRoll += (clamp(lateral * 0.011, -0.07, 0.07) - this.bodyRoll) * ease;
    this.bodyPitch += (clamp(-this.accel * 0.006, -0.035, 0.035) - this.bodyPitch) * ease;
    b.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    for (const w of Object.values(b.wheels)) w.spinner.rotation.x = this.spin;
    b.wheels.fl.group.rotation.y = this.steer;
    b.wheels.fr.group.rotation.y = this.steer;
    b.steeringWheel.rotation.y = this.steer * 7;
    b.door.position.z = BUS.doorZ - this.doorOpen * 0.88;
    b.door.position.x = BUS.width / 2 + 0.03 + this.doorOpen * 0.07;
    b.interior.visible = this.camMode === "cockpit" && (this.mode === "driving" || this.mode === "paused");
  }

  _updateCamera(dt) {
    const cam = this.camera;
    const p = this.pos;
    let fov = 58;

    if (this.mode === "menu" || this.mode === "ended") {
      const a = this.t * 0.05 + 2.4;
      const r = this.mode === "ended" ? 22 : 30;
      cam.position.set(p.x + Math.sin(a) * r, p.y + (this.mode === "ended" ? 9 : 13), p.z + Math.cos(a) * r);
      const floor = this.world.terrainAt(cam.position.x, cam.position.z) + 2;
      if (cam.position.y < floor) cam.position.y = floor;
      cam.lookAt(p.x, p.y + 2.2, p.z);
      fov = 50;
    } else if (this.camMode === "cockpit") {
      const body = this.bus.body;
      body.updateMatrixWorld(true);
      cam.position.copy(body.localToWorld(BUS.eye.clone()));
      const look = new THREE.Vector3(BUS.eye.x + Math.sin(this.camOffset) * 10, BUS.eye.y - 0.4, BUS.eye.z + Math.cos(this.camOffset) * 10);
      cam.lookAt(body.localToWorld(look));
      fov = 72;
    } else {
      // Chase cam: swings round behind the bus a little after it turns.
      this.camYaw += angleDiff(this.yaw, this.camYaw) * Math.min(1, dt * 3);
      const yaw = this.camYaw + this.camOffset;
      const dist = 15 + Math.abs(this.v) * 0.12;
      const desired = new THREE.Vector3(p.x - Math.sin(yaw) * dist, p.y + 5.4 + Math.abs(this.v) * 0.04, p.z - Math.cos(yaw) * dist);
      if (!this.camPos) this.camPos = desired.clone();
      this.camPos.lerp(desired, Math.min(1, dt * 6));
      const floor = this.world.terrainAt(this.camPos.x, this.camPos.z) + 1.8;
      if (this.camPos.y < floor) this.camPos.y = floor;
      cam.position.copy(this.camPos);
      cam.lookAt(p.x + Math.sin(this.yaw) * 4, p.y + 2.4, p.z + Math.cos(this.yaw) * 4);
    }
    if (!this._isDragging()) this.camOffset *= Math.max(0, 1 - dt * 2.5);

    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.25;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.25;
      this.shake = Math.max(0, this.shake - dt * 1.6);
    }
    if (cam.fov !== fov) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  _gear() {
    const v = this.v;
    if (v < -0.2) return { label: "R", rpm: clamp(-v / MAX_REVERSE, 0, 1) };
    if (v < 0.2) return { label: "N", rpm: 0 };
    let g = 1;
    while (g < GEARS.length - 1 && v > GEARS[g]) g++;
    const lo = GEARS[g - 1];
    const hi = GEARS[g];
    return { label: `D${g}`, rpm: clamp(0.3 + (0.7 * (v - lo)) / (hi - lo), 0, 1) };
  }

  _engineSound() {
    const driving = this.mode === "driving";
    const { rpm } = this._gear();
    const up = this.keys.KeyW || this.keys.ArrowUp;
    this.sound.engine(driving, rpm, driving && up ? 1 : 0);
  }

  _hud() {
    const stop = this.world.stops[this.target];
    const gear = this._gear();
    this.ui.onHud({
      speed: Math.round(Math.abs(this.v) * 3.6),
      gear: gear.label,
      rpm: gear.rpm,
      next: stop ? { en: stop.en, bn: stop.bn, dist: Math.max(0, Math.round(stop.u - this.u)) } : null,
      phase: this.phase,
      passengers: this.passengers,
      time: this.stats.time,
      progress: clamp(this.u / this.world.stops[this.world.stops.length - 1].u, 0, 1),
      stopFracs: this.world.stops.map((s) => s.u / this.world.stops[this.world.stops.length - 1].u),
      target: this.target,
      offRoad: this.offRoad,
      wrongLane: this.s > 0.4 && this.v > 2,
      cam: this.camMode,
      muted: this.sound.muted,
    });
  }
}
