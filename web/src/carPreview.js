import * as THREE from "../vendor/three.module.js";
import { buildCarMesh } from "./cars.js";

export class CarPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    this.camera.position.set(0, 2.4, 6.5);
    this.camera.lookAt(0, 0.6, 0);

    const hemi = new THREE.HemisphereLight(0x8899ff, 0x0a0a0d, 0.8);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff5a1f, 0.6);
    rim.position.set(-5, 2, -4);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(20, 20, 0x2a2d36, 0x1a1c22);
    grid.position.y = -0.02;
    this.scene.add(grid);

    this.carGroup = null;
    this._raf = null;
    this._resize = this._resize.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();
    this._animate = this._animate.bind(this);
  }

  _resize() {
    const w = this.canvas.clientWidth || 400;
    const h = this.canvas.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setCar(carDef) {
    if (this.carGroup) this.scene.remove(this.carGroup);
    this.carGroup = buildCarMesh(carDef);
    this.carGroup.position.y = -0.3;
    // The car's forward/nose faces -Z (matching in-game travel direction), but this
    // preview camera sits on +Z — without this the showroom would stare at the tail.
    // Rotate to a flattering 3/4 front angle instead of a dead-on nose view.
    this.carGroup.rotation.y = Math.PI * 0.85;
    this.scene.add(this.carGroup);
  }

  start() {
    if (this._raf) return;
    this._animate();
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _animate() {
    if (this.carGroup) this.carGroup.rotation.y += 0.012;
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._animate);
  }
}
