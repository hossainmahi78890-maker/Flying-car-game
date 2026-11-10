import * as THREE from "../vendor/three.module.js";
import { canvasTexture, fitText, part, merge, UNIT, cylBase } from "./props.js";

/* ---------------------------------------------------------------------------
   The one bus: a Bangladeshi intercity bus, right-hand drive, doors on the
   left (kerb) side. Forward is local +Z, origin on the ground under the middle.
--------------------------------------------------------------------------- */

export const BUS = {
  length: 11.2,
  width: 2.5,
  wheelbase: 6.3,
  track: 2.06,
  frontAxle: 3.3,
  rearAxle: -3.0,
  wheelR: 0.52,
  doorZ: 4.55,
  eye: new THREE.Vector3(-0.62, 2.62, 4.3), // driver sits on the right (local -X)
};

const L = BUS.length;
const W = BUS.width;
const BOTTOM = 0.75;
const TOP = 3.55;
const H = TOP - BOTTOM;
const PX = 100; // canvas pixels per metre

const CREAM = "#f3eee0";
const GREEN = "#0f6b3c";
const RED = "#c8102e";

/** z (metres, +front) → canvas x for a side panel. Left side: front at x=0. Right side: rear at x=0. */
function sideX(z, left) {
  return left ? (L / 2 - z) * PX : (z + L / 2) * PX;
}
/** y (metres) → canvas y. */
function sideY(y) {
  return (TOP - y) * PX;
}

function drawSide(ctx, w, h, left) {
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, w, h);
  // roof edge
  ctx.fillStyle = "#d4d0c6";
  ctx.fillRect(0, 0, w, 14);
  // window band
  const wy0 = sideY(3.3);
  const wy1 = sideY(2.15);
  ctx.fillStyle = "#1d2a33";
  ctx.fillRect(0, wy0, w, wy1 - wy0);
  const grad = ctx.createLinearGradient(0, wy0, 0, wy1);
  grad.addColorStop(0, "rgba(160,190,205,0.35)");
  grad.addColorStop(1, "rgba(160,190,205,0.05)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, wy0, w, wy1 - wy0);
  // window pillars
  ctx.fillStyle = "#bfc3c6";
  for (let z = -L / 2 + 0.15; z < L / 2; z += 1.22) {
    ctx.fillRect(sideX(z, left) - 5, wy0, 10, wy1 - wy0);
  }
  ctx.fillRect(0, wy0 - 4, w, 6);
  ctx.fillRect(0, wy1 - 2, w, 6);
  // livery: name band, swoosh, red stripe, green skirt
  ctx.fillStyle = "#f2b705";
  ctx.beginPath();
  ctx.moveTo(0, sideY(1.72));
  for (let x = 0; x <= w; x += 20) ctx.lineTo(x, sideY(1.72) + Math.sin(x / 70) * 6);
  ctx.lineTo(w, sideY(1.62));
  for (let x = w; x >= 0; x -= 20) ctx.lineTo(x, sideY(1.62) + Math.sin(x / 70) * 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = RED;
  ctx.fillRect(0, sideY(1.5), w, 12);
  ctx.fillStyle = GREEN;
  ctx.fillRect(0, sideY(1.38), w, h - sideY(1.38));
  // name
  ctx.fillStyle = GREEN;
  ctx.textAlign = "center";
  const mid = left ? w * 0.5 : w * 0.46;
  fitText(ctx, "পাহাড়ি এক্সপ্রেস", mid, sideY(1.84), w * 0.4, 48);
  ctx.fillStyle = "#ffffff";
  fitText(ctx, "HILL TRACTS EXPRESS  ·  BANDARBAN — NILGIRI", mid, sideY(0.98), w * 0.5, 26, 700, "'Segoe UI', sans-serif");
  // wheel arches
  ctx.fillStyle = "#151515";
  for (const z of [BUS.frontAxle, BUS.rearAxle]) {
    ctx.beginPath();
    ctx.arc(sideX(z, left), h + 8, 66, Math.PI, 0);
    ctx.fill();
  }
  // doors (kerb side) or the driver's window (right side)
  const door = (z0, z1) => {
    const x0 = Math.min(sideX(z0, left), sideX(z1, left));
    const x1 = Math.max(sideX(z0, left), sideX(z1, left));
    ctx.fillStyle = "#26343d";
    ctx.fillRect(x0, sideY(3.32), x1 - x0, sideY(0.82) - sideY(3.32));
    ctx.strokeStyle = "#bfc3c6";
    ctx.lineWidth = 5;
    ctx.strokeRect(x0, sideY(3.32), x1 - x0, sideY(0.82) - sideY(3.32));
    ctx.beginPath();
    ctx.moveTo((x0 + x1) / 2, sideY(3.32));
    ctx.lineTo((x0 + x1) / 2, sideY(0.82));
    ctx.stroke();
    ctx.fillStyle = "#3b4a54";
    ctx.fillRect(x0 + 6, sideY(1.45), x1 - x0 - 12, sideY(0.85) - sideY(1.45));
  };
  if (left) {
    door(BUS.doorZ - 0.46, BUS.doorZ + 0.46);
    door(-1.1, -1.95);
  } else {
    ctx.fillStyle = "#26343d";
    ctx.fillRect(sideX(4.3, left), sideY(3.3), 120, sideY(2.0) - sideY(3.3));
  }
}

function drawFront(ctx, w, h) {
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, w, h);
  // windshield
  ctx.fillStyle = "#1a2730";
  ctx.fillRect(10, 16, w - 20, 150);
  const g = ctx.createLinearGradient(0, 16, w, 166);
  g.addColorStop(0, "rgba(190,215,230,0.35)");
  g.addColorStop(0.5, "rgba(190,215,230,0.06)");
  g.addColorStop(1, "rgba(190,215,230,0.22)");
  ctx.fillStyle = g;
  ctx.fillRect(10, 16, w - 20, 150);
  ctx.fillStyle = "#bfc3c6";
  ctx.fillRect(w / 2 - 3, 16, 6, 150);
  // destination board (LED style)
  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(22, 20, w - 44, 34);
  ctx.fillStyle = "#ff9b1f";
  ctx.textAlign = "center";
  fitText(ctx, "নীলগিরি", w / 2, 47, w - 60, 28);
  // livery
  ctx.fillStyle = "#f2b705";
  ctx.fillRect(0, sideY(1.72) - 2, w, 12);
  ctx.fillStyle = RED;
  ctx.fillRect(0, sideY(1.5), w, 12);
  ctx.fillStyle = GREEN;
  ctx.fillRect(0, sideY(1.38), w, h);
  // grille + lights
  ctx.fillStyle = "#202020";
  ctx.fillRect(70, sideY(1.32), w - 140, 46);
  ctx.fillStyle = "#3a3a3a";
  for (let k = 0; k < 6; k++) ctx.fillRect(74, sideY(1.32) + 4 + k * 7, w - 148, 3);
  ctx.fillStyle = "#fff6d6";
  ctx.fillRect(16, sideY(1.3), 46, 26);
  ctx.fillRect(w - 62, sideY(1.3), 46, 26);
  ctx.fillStyle = "#ffb11f";
  ctx.fillRect(16, sideY(1.3) + 30, 46, 10);
  ctx.fillRect(w - 62, sideY(1.3) + 30, 46, 10);
  // number plate
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(w / 2 - 60, sideY(0.98), 120, 28);
  ctx.fillStyle = "#111";
  fitText(ctx, "বান্দরবান-ব ১১-০০২৭", w / 2, sideY(0.98) + 21, 112, 18);
}

function drawBack(ctx, w, h) {
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#1a2730";
  ctx.fillRect(18, 22, w - 36, 92);
  ctx.fillStyle = "#f2b705";
  ctx.fillRect(0, sideY(1.72) - 2, w, 12);
  ctx.fillStyle = RED;
  ctx.fillRect(0, sideY(1.5), w, 12);
  ctx.fillStyle = GREEN;
  ctx.fillRect(0, sideY(1.38), w, h);
  ctx.fillStyle = GREEN;
  ctx.textAlign = "center";
  fitText(ctx, "পাহাড়ি এক্সপ্রেস", w / 2, sideY(2.0), w - 30, 30);
  ctx.fillStyle = "#e01b24";
  ctx.fillRect(10, sideY(1.3), 30, 40);
  ctx.fillRect(w - 40, sideY(1.3), 30, 40);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(w / 2 - 60, sideY(1.05), 120, 28);
  ctx.fillStyle = "#111";
  fitText(ctx, "বান্দরবান-ব ১১-০০২৭", w / 2, sideY(1.05) + 21, 112, 18);
}

function wheel(width) {
  const g = new THREE.Group();
  const spinner = new THREE.Group();
  g.add(spinner);
  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(BUS.wheelR, BUS.wheelR, width, 20),
    new THREE.MeshLambertMaterial({ color: 0x161616 })
  );
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  spinner.add(tire);
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(BUS.wheelR * 0.55, BUS.wheelR * 0.55, width + 0.02, 10),
    new THREE.MeshLambertMaterial({ color: 0xb8b8b8, flatShading: true })
  );
  rim.rotation.z = Math.PI / 2;
  spinner.add(rim);
  // a few lug bumps so the spin is visible
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const lug = new THREE.Mesh(new THREE.BoxGeometry(width + 0.05, 0.07, 0.07), new THREE.MeshLambertMaterial({ color: 0x555555 }));
    lug.position.set(0, Math.cos(a) * 0.18, Math.sin(a) * 0.18);
    spinner.add(lug);
  }
  return { group: g, spinner };
}

export function buildBus(maxAniso = 4) {
  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const body = new THREE.Group(); // sways on its suspension
  body.position.y = 0;
  root.add(body);

  // ---- shell with painted livery ----
  const tex = (w, h, fn) => canvasTexture(w, h, fn, maxAniso);
  const lam = (map) => new THREE.MeshLambertMaterial({ map });
  const shellMats = [
    lam(tex(L * PX, H * PX, (c, w, h) => drawSide(c, w, h, true))), // +X = left (kerb) side
    lam(tex(L * PX, H * PX, (c, w, h) => drawSide(c, w, h, false))), // -X = right (driver) side
    new THREE.MeshLambertMaterial({ color: 0xd9d9d4 }),
    new THREE.MeshLambertMaterial({ color: 0x222222 }),
    lam(tex(W * PX, H * PX, drawFront)),
    lam(tex(W * PX, H * PX, drawBack)),
  ];
  const shell = new THREE.Mesh(new THREE.BoxGeometry(W, H, L), shellMats);
  shell.position.set(0, BOTTOM + H / 2, 0);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  // ---- details: bumpers, roof rack with luggage, mirrors, lights ----
  const details = [
    part(UNIT.box, "#2d2d2d", { y: 0.92, z: L / 2 + 0.1, sx: W + 0.06, sy: 0.32, sz: 0.24 }),
    part(UNIT.box, "#2d2d2d", { y: 0.92, z: -L / 2 - 0.1, sx: W + 0.06, sy: 0.32, sz: 0.24 }),
    part(UNIT.box, "#1b1b1b", { y: 0.62, sx: W - 0.3, sy: 0.3, sz: L - 0.8 }),
  ];
  for (const x of [-1.12, 1.12]) {
    details.push(part(UNIT.box, "#7c7f82", { x, y: TOP + 0.28, z: -0.6, sx: 0.06, sy: 0.06, sz: 8.2 }));
    for (let z = -4.4; z <= 3.4; z += 1.3) details.push(part(UNIT.box, "#7c7f82", { x, y: TOP + 0.14, z, sx: 0.06, sy: 0.28, sz: 0.06 }));
  }
  for (let z = -4.4; z <= 3.4; z += 1.3) details.push(part(UNIT.box, "#7c7f82", { y: TOP + 0.28, z, sx: 2.3, sy: 0.05, sz: 0.05 }));
  const bags = ["#2e86c1", "#c0392b", "#8e6b3a", "#27ae60", "#f2c14e", "#6c3483", "#a9a9a9"];
  for (let k = 0; k < 9; k++) {
    details.push(part(UNIT.box, bags[k % bags.length], {
      x: ((k * 37) % 5 - 2) * 0.32, y: TOP + 0.3, z: -3.8 + k * 0.85,
      sx: 0.55 + (k % 3) * 0.15, sy: 0.4 + (k % 2) * 0.2, sz: 0.6, ry: (k % 4) * 0.2,
    }));
  }
  // "rabbit-ear" mirrors reaching forward from the front corners
  for (const side of [-1, 1]) {
    details.push(part(UNIT.box, "#222", { x: side * 1.45, y: 3.25, z: L / 2 + 0.15, sx: 0.06, sy: 0.06, sz: 0.6, rx: 0.4 }));
    details.push(part(UNIT.box, "#222", { x: side * 1.48, y: 2.85, z: L / 2 + 0.38, sx: 0.12, sy: 0.55, sz: 0.28 }));
  }
  const detailMesh = new THREE.Mesh(merge(details), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  detailMesh.castShadow = true;
  body.add(detailMesh);

  const glow = new THREE.MeshBasicMaterial({ color: 0xfff3cf });
  for (const x of [-0.95, 0.95]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.22, 0.04), glow);
    hl.position.set(x, 1.13, L / 2 + 0.02);
    body.add(hl);
  }

  // ---- kerb-side door (slides back to open) ----
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 2.45, 0.92),
    new THREE.MeshLambertMaterial({ color: 0x2b3a44 })
  );
  door.position.set(W / 2 + 0.03, 2.07, BUS.doorZ);
  body.add(door);

  // ---- wheels: front pair steer, rear pair are wide duals ----
  const wheels = {};
  const defs = { fl: [1.03, BUS.frontAxle, 0.34], fr: [-1.03, BUS.frontAxle, 0.34], rl: [0.98, BUS.rearAxle, 0.6], rr: [-0.98, BUS.rearAxle, 0.6] };
  for (const [key, [x, z, width]] of Object.entries(defs)) {
    const w = wheel(width);
    w.group.position.set(x, BUS.wheelR, z);
    root.add(w.group);
    wheels[key] = w;
  }

  // ---- driver's cab, only shown in the cockpit camera ----
  const interior = new THREE.Group();
  const cab = [
    part(UNIT.box, "#2b2b2b", { y: 2.0, z: 5.2, sx: 2.4, sy: 0.55, sz: 0.65 }),
    part(UNIT.box, "#3a3a3a", { y: 2.3, z: 5.05, sx: 2.4, sy: 0.06, sz: 0.4 }),
    part(UNIT.box, "#d8d0bd", { y: 3.47, z: 3.6, sx: 2.45, sy: 0.05, sz: 3.6 }),
    part(UNIT.box, "#1f1f1f", { y: 3.38, z: 5.45, sx: 2.5, sy: 0.3, sz: 0.25 }),
    part(UNIT.box, "#bfc3c6", { x: 1.19, y: 2.75, z: 5.52, sx: 0.14, sy: 1.5, sz: 0.14 }),
    part(UNIT.box, "#bfc3c6", { x: -1.19, y: 2.75, z: 5.52, sx: 0.14, sy: 1.5, sz: 0.14 }),
    part(UNIT.box, "#bfc3c6", { y: 2.75, z: 5.56, sx: 0.06, sy: 1.5, sz: 0.06 }),
    part(UNIT.box, "#2f6f73", { x: 1.2, y: 1.55, z: 3.5, sx: 0.05, sy: 1.1, sz: 3.6 }),
    part(UNIT.box, "#2f6f73", { x: -1.2, y: 1.55, z: 3.5, sx: 0.05, sy: 1.1, sz: 3.6 }),
    part(cylBase(0.04, 0.04, 0.7), "#333", { x: -0.62, y: 1.85, z: 4.95, rx: -0.9 }),
  ];
  for (let z = 2.3; z < 5.2; z += 1.22) {
    cab.push(part(UNIT.box, "#bfc3c6", { x: 1.21, y: 2.75, z, sx: 0.06, sy: 1.15, sz: 0.08 }));
    cab.push(part(UNIT.box, "#bfc3c6", { x: -1.21, y: 2.75, z, sx: 0.06, sy: 1.15, sz: 0.08 }));
  }
  // garland of tassels across the windscreen — every Bangladeshi bus has one
  const tassels = ["#e74c3c", "#f1c40f", "#27ae60", "#e67e22", "#9b59b6", "#3498db"];
  for (let k = 0; k < 13; k++) {
    const x = -1.05 + k * 0.175;
    cab.push(part(UNIT.box, tassels[k % tassels.length], { x, y: 3.15 - Math.sin((k / 12) * Math.PI) * 0.12, z: 5.38, sx: 0.06, sy: 0.18, sz: 0.04 }));
  }
  const cabMesh = new THREE.Mesh(merge(cab), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  interior.add(cabMesh);

  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(-0.62, 2.22, 4.72);
  steeringWheel.rotation.x = -0.9;
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.032, 8, 26), new THREE.MeshLambertMaterial({ color: 0x1d1d1d }));
  wheelRing.rotation.x = Math.PI / 2;
  steeringWheel.add(wheelRing);
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.04), new THREE.MeshLambertMaterial({ color: 0x2a2a2a }));
    spoke.position.set(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12);
    spoke.rotation.y = -a;
    steeringWheel.add(spoke);
  }
  const spinWheel = new THREE.Group();
  spinWheel.add(steeringWheel);
  interior.add(spinWheel);
  interior.visible = false;
  body.add(interior);

  return { root, body, shell, wheels, door, interior, steeringWheel };
}
