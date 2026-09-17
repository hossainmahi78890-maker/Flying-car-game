import * as THREE from "../vendor/three.module.js";
import { buildCarMesh } from "./cars.js";
import { World, FALL_Y, SIDE_LIMIT, FLIGHT_MIN_Y, FLIGHT_MAX_Y } from "./world.js";

const GRAVITY = 9.2;
const BASE_ACCEL = 26;
const BASE_LIFT = 22;
const BASE_TURN = 1.9; // rad/s at full handling
const BOOST_MULT = 1.9;
const BOOST_DRAIN = 0.55; // per second while boosting
const BOOST_REGEN = 0.12; // per second while not boosting
const DRAG = 0.55;
const VERTICAL_DRAG = 0.9;
const MAX_SPEED_MPS = 95;

export class Game {
  constructor(canvas, onCrash) {
    this.canvas = canvas;
    this.onCrash = onCrash;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0b0d);
    this.scene.fog = new THREE.Fog(0x0a0b0d, 60, 220);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400);

    this._setupLights();
    this.world = new World(this.scene);

    this.carGroup = null;
    this.carDef = null;

    this.keys = Object.create(null);
    this._bindInput();

    this.state = "idle"; // idle | running | ended
    this.distance = 0;
    this.best = Number(localStorage.getItem("aerovolt_best") || 0);

    this._resize = this._resize.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();

    this._clock = new THREE.Clock();
    this._loopBound = this._loop.bind(this);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0x8899ff, 0x0a0a0d, 0.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(40, 70, 30);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xff5a1f, 0.25);
    fill.position.set(-30, 10, -20);
    this.scene.add(fill);
  }

  _bindInput() {
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (e.code === "KeyR" && this.state === "ended") this.onRestartKey && this.onRestartKey();
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
    });
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setCar(carDef) {
    if (this.carGroup) {
      this.scene.remove(this.carGroup);
    }
    this.carDef = carDef;
    this.carGroup = buildCarMesh(carDef);
    this.scene.add(this.carGroup);
  }

  start() {
    this.world.reset();
    this.pos = new THREE.Vector3(0, 12, 0);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.yaw = Math.PI; // face toward -Z (forward)
    this.roll = 0;
    this.pitch = 0;
    this.boost = 1;
    this.distance = 0;
    this.state = "running";
    this._camPos = new THREE.Vector3(0, 16, 12);
    this._camLook = new THREE.Vector3();
    this._shake = 0;

    if (this.carGroup) {
      this.carGroup.position.copy(this.pos);
    }

    this._clock.start();
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(this._loopBound);
  }

  stop() {
    this.state = "idle";
    cancelAnimationFrame(this._raf);
  }

  _loop() {
    if (this.state !== "running") return;
    const dt = Math.min(this._clock.getDelta(), 0.05);
    this._update(dt);
    this._render();
    this._raf = requestAnimationFrame(this._loopBound);
  }

  _update(dt) {
    const stats = this.carDef.stats;
    const mass = 0.4 + stats.mass * 1.1;

    const forwardInput = (this.keys["KeyW"] || this.keys["ArrowUp"]) ? 1 : 0;
    const backInput = (this.keys["KeyS"] || this.keys["ArrowDown"]) ? 1 : 0;
    const leftInput = (this.keys["KeyA"] || this.keys["ArrowLeft"]) ? 1 : 0;
    const rightInput = (this.keys["KeyD"] || this.keys["ArrowRight"]) ? 1 : 0;
    const liftInput = this.keys["Space"] ? 1 : 0;
    const boostHeld = (this.keys["ShiftLeft"] || this.keys["ShiftRight"]) && this.boost > 0.02;

    // Steering
    const speedFactor = THREE.MathUtils.clamp(this.vel.length() / 20, 0.3, 1.4);
    const turnRate = BASE_TURN * (0.35 + stats.handling * 0.9) * speedFactor;
    this.yaw += (leftInput - rightInput) * turnRate * dt;

    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // Thrust
    let accel = 0;
    if (forwardInput) accel += (BASE_ACCEL * (0.5 + stats.power)) / mass;
    if (backInput) accel -= (BASE_ACCEL * 0.6) / mass;
    if (boostHeld && forwardInput) {
      accel *= BOOST_MULT;
      this.boost = Math.max(0, this.boost - BOOST_DRAIN * dt);
    } else {
      this.boost = Math.min(1, this.boost + BOOST_REGEN * dt);
    }

    this.vel.addScaledVector(forward, accel * dt);

    // Lift thrusters
    if (liftInput) {
      const liftAccel = (BASE_LIFT * (0.4 + stats.lift)) / mass;
      this.vel.y += liftAccel * dt;
    }

    // Gravity pulls all cars down at the same rate (mass-independent, like reality) —
    // the "heavy" feel comes entirely from thrust/lift being divided by mass below,
    // not from also inflating gravity, which would double-penalize heavy cars and
    // make full-thrust hover mathematically impossible for them.
    this.vel.y -= GRAVITY * dt;

    // Drag
    const horizDragFactor = Math.max(0, 1 - DRAG * dt);
    this.vel.x *= horizDragFactor;
    this.vel.z *= horizDragFactor;
    this.vel.y *= Math.max(0, 1 - VERTICAL_DRAG * dt * 0.4);

    // Speed clamp
    const speed = this.vel.length();
    if (speed > MAX_SPEED_MPS) this.vel.multiplyScalar(MAX_SPEED_MPS / speed);

    // Integrate
    this.pos.addScaledVector(this.vel, dt);

    // Visual banking / pitch feedback
    const targetRoll = (rightInput - leftInput) * 0.55;
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 6);
    const targetPitch = THREE.MathUtils.clamp(-this.vel.y * 0.03, -0.5, 0.5);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 4);

    if (this.carGroup) {
      this.carGroup.position.copy(this.pos);
      this.carGroup.rotation.set(this.pitch, this.yaw, this.roll);
      const glowStrength = 0.6 + (boostHeld ? 1.8 : 0) + forwardInput * 0.6;
      if (this.carGroup.userData.thrusterRear) {
        this.carGroup.userData.thrusterRear.material.emissiveIntensity = glowStrength * 1.4;
      }
      ["thruster_-1", "thruster_1"].forEach((k) => {
        if (this.carGroup.userData[k]) {
          this.carGroup.userData[k].material.emissiveIntensity = 0.5 + liftInput * 1.5;
        }
      });
      if (this.carGroup.userData.underGlow) {
        this.carGroup.userData.underGlow.material.emissiveIntensity = 0.4 + liftInput * 1.2;
      }
    }

    this.distance = Math.max(this.distance, -this.pos.z);

    this.world.update(this.pos.z);
    const carRadius = this.carGroup ? this.carGroup.userData.collisionRadius : 1;
    const { crashed, boosted } = this.world.checkCollisions(this.pos, carRadius);
    if (boosted) this.boost = 1;

    let ended = false;
    let reason = null;
    if (crashed) {
      ended = true;
      reason = "crash";
    } else if (this.pos.y < FALL_Y) {
      ended = true;
      reason = "fall";
    } else if (Math.abs(this.pos.x) > SIDE_LIMIT) {
      ended = true;
      reason = "fall";
    }

    // Low-altitude warning
    if (this._onWarn) {
      this._onWarn(!ended && this.pos.y < FLIGHT_MIN_Y + 4 ? "LOW ALTITUDE" : "");
    }

    if (ended) {
      this._endRun(reason);
      return;
    }

    // Camera — smooth chase cam. Uses exponential smoothing (1 - e^-rate*dt) rather
    // than a flat lerp factor so it stays frame-rate independent AND keeps pace with
    // the car at high speed — a flat lerp factor falls permanently behind an
    // accelerating target, which made the car shrink to a speck once it got fast.
    const camBackDist = 7 + speed * 0.04;
    const camHeight = 3.2 + speed * 0.015;
    const desiredCam = new THREE.Vector3(
      this.pos.x - forward.x * camBackDist,
      this.pos.y + camHeight,
      this.pos.z - forward.z * camBackDist
    );
    this._shake = Math.max(0, this._shake - dt * 3);
    this._camPos.lerp(desiredCam, 1 - Math.exp(-9 * dt));
    const lookTarget = new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z);
    this._camLook.lerp(lookTarget, 1 - Math.exp(-12 * dt));
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);

    if (this._onHud) {
      this._onHud({
        speedKmh: Math.round(speed * 3.6),
        alt: Math.max(0, Math.round(this.pos.y - FLIGHT_MIN_Y)),
        distance: Math.round(this.distance),
        best: Math.round(Math.max(this.best, this.distance)),
        boost: this.boost,
        thrust: forwardInput ? (boostHeld ? 1 : 0.65) : liftInput ? 0.4 : 0,
      });
    }
  }

  _endRun(reason) {
    this.state = "ended";
    cancelAnimationFrame(this._raf);
    this.best = Math.max(this.best, Math.round(this.distance));
    localStorage.setItem("aerovolt_best", String(this.best));
    this.onCrash && this.onCrash({ reason, distance: Math.round(this.distance), best: this.best });
  }

  _render() {
    this.renderer.render(this.scene, this.camera);
  }

  onHud(fn) {
    this._onHud = fn;
  }
  onWarn(fn) {
    this._onWarn = fn;
  }
}
