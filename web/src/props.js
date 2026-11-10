import * as THREE from "../vendor/three.module.js";
import { mulberry32 } from "./noise.js";

/* ---------------------------------------------------------------------------
   Low-poly props, all built from primitives with per-part vertex colours.
   Each builder returns ONE merged geometry (one draw call; easy to instance).
--------------------------------------------------------------------------- */

const TAU = Math.PI * 2;

export const UNIT = {
  box: new THREE.BoxGeometry(1, 1, 1),
  ico: new THREE.IcosahedronGeometry(1, 0),
  sphere: new THREE.SphereGeometry(1, 10, 7),
  prism: makePrism(),
};

/** Shared vertex-coloured materials. */
export const MAT = {
  solid: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  leaves: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }),
  smooth: new THREE.MeshLambertMaterial({ vertexColors: true }),
};

/** Triangular prism: ridge along X, triangle in YZ, base on y = 0 (a gable roof). */
function makePrism() {
  const v = [
    // triangle at x=-0.5 and x=+0.5: (z=-0.5,y=0) (z=0.5,y=0) (z=0,y=1)
    [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0],
    [0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0],
  ];
  const tris = [
    [0, 2, 1], [3, 4, 5],          // gable ends
    [1, 2, 5], [1, 5, 4],          // front slope (+z)
    [0, 3, 5], [0, 5, 2],          // back slope (-z)
    [0, 1, 4], [0, 4, 3],          // floor
  ];
  const pos = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Cylinder whose base sits on y = 0. */
export function cylBase(rTop, rBottom, h, seg = 6) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  g.translate(0, h / 2, 0);
  return g;
}

/** A leaf blade: base at the origin, extends up +Y and droops toward +Z. */
export function leaf(w, l, droop = 0.8) {
  const g = new THREE.PlaneGeometry(w, l, 1, 4);
  g.translate(0, l / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = y / l;
    p.setZ(i, t * t * droop * l * 0.6);
    p.setX(i, p.getX(i) * (1 - 0.55 * t * t)); // taper to a point
  }
  g.computeVertexNormals();
  return g;
}

/** Positioned, rotated, scaled, coloured piece for merge(). Rotation order YXZ: tilt, then turn. */
export function part(geo, color, o = {}) {
  const k = o.s ?? 1;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0, o.order || "YXZ")),
    new THREE.Vector3(k * (o.sx ?? 1), k * (o.sy ?? 1), k * (o.sz ?? 1))
  );
  return { geo, color, matrix: m };
}

/** Merge parts into one non-indexed geometry with a vertex colour per part. */
export function merge(parts) {
  const prepared = [];
  let count = 0;
  const c = new THREE.Color();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    g.applyMatrix4(p.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    prepared.push({ g, rgb: c.set(p.color).toArray() });
    count += g.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  for (const { g, rgb } of prepared) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < n; i++) col.set(rgb, (o + i) * 3);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/* =============================== Vegetation =============================== */

export function treeBroadleaf() {
  return merge([
    part(cylBase(0.2, 0.34, 4.6, 6), "#5b4636"),
    part(UNIT.ico, "#2f6b2f", { y: 5.7, s: 2.6, sy: 0.85 }),
    part(UNIT.ico, "#3a7d34", { x: 1.5, y: 5.0, z: 0.5, s: 2.0 }),
    part(UNIT.ico, "#2a5e2c", { x: -1.3, y: 5.1, z: -0.8, s: 1.9 }),
    part(UNIT.ico, "#356f2e", { x: 0.2, y: 4.7, z: 1.6, s: 1.6 }),
  ]);
}

/** Tall garjan / dipterocarp: long bare trunk, flat umbrella crown. */
export function treeGarjan() {
  return merge([
    part(cylBase(0.3, 0.5, 12.5, 7), "#7a6a58"),
    part(UNIT.ico, "#2c5a2a", { y: 13, s: 3.7, sy: 0.55 }),
    part(UNIT.ico, "#356a30", { x: 2.1, y: 12.2, z: 0.6, s: 2.6, sy: 0.6 }),
    part(UNIT.ico, "#2f6230", { x: -1.9, y: 12.4, z: -1.0, s: 2.4, sy: 0.55 }),
  ]);
}

export function bananaPlant() {
  const parts = [part(cylBase(0.14, 0.22, 2.1, 6), "#6f8a3a")];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * TAU + (k % 2) * 0.35;
    parts.push(part(leaf(0.8, 2.7, 0.9), k % 3 ? "#5fa83a" : "#4b9330", { y: 1.95, rx: 0.7 + (k % 3) * 0.25, ry: a }));
  }
  return merge(parts);
}

export function bambooClump() {
  const rand = mulberry32(7);
  const parts = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU + rand() * 0.5;
    const tilt = 0.1 + rand() * 0.22;
    const h = 8 + rand() * 3.5;
    const bx = Math.sin(a) * 0.45;
    const bz = Math.cos(a) * 0.45;
    parts.push(part(cylBase(0.07, 0.1, h, 5), k % 2 ? "#9bb24e" : "#86a043", { x: bx, z: bz, rx: tilt, ry: a }));
    const top = new THREE.Vector3(0, h * 0.9, 0).applyEuler(new THREE.Euler(tilt, a, 0, "YXZ"));
    parts.push(part(UNIT.ico, k % 2 ? "#6f9a3a" : "#7fa645", { x: bx + top.x, y: top.y, z: bz + top.z, s: 1.0, sy: 1.7 }));
  }
  return merge(parts);
}

/** Areca (betel-nut) palm: thin straight trunk, small crown. */
export function arecaPalm() {
  const parts = [
    part(cylBase(0.1, 0.14, 8.6, 6), "#8b7f6b"),
    part(UNIT.ico, "#c98f2c", { y: 8.0, s: 0.35 }),
  ];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    parts.push(part(leaf(0.5, 2.9, 1.3), k % 2 ? "#4f8f3a" : "#5c9a40", { y: 8.4, rx: 1.0 + (k % 2) * 0.3, ry: a }));
  }
  return merge(parts);
}

export function shrub() {
  return merge([
    part(UNIT.ico, "#3f7a35", { y: 0.55, s: 1.15, sy: 0.75 }),
    part(UNIT.ico, "#4a8a3a", { x: 0.75, y: 0.45, z: 0.3, s: 0.8 }),
    part(UNIT.ico, "#356a2e", { x: -0.6, y: 0.4, z: -0.4, s: 0.7 }),
  ]);
}

/* ============================== Roadside bits ============================= */

/** Black-and-yellow striped concrete bollard (hill-road edge marker). */
export function bollard() {
  const parts = [];
  for (let k = 0; k < 4; k++) {
    parts.push(part(UNIT.box, k % 2 ? "#f2c230" : "#1f1f1f", { y: 0.11 + k * 0.22, sx: 0.34, sy: 0.22, sz: 0.34 }));
  }
  return merge(parts);
}

/** Concrete electric pole with a cross-arm (wires are drawn separately). */
export function electricPole() {
  return merge([
    part(UNIT.box, "#a3a29a", { y: 4.6, sx: 0.24, sy: 9.2, sz: 0.24 }),
    part(UNIT.box, "#6b6b66", { y: 8.7, sx: 1.9, sy: 0.14, sz: 0.14 }),
    part(UNIT.box, "#e8e8e0", { x: -0.85, y: 8.86, sx: 0.1, sy: 0.18, sz: 0.1 }),
    part(UNIT.box, "#e8e8e0", { x: 0.85, y: 8.86, sx: 0.1, sy: 0.18, sz: 0.1 }),
  ]);
}

/* ================================= People ================================= */

const SHIRTS = ["#d94f3d", "#2f6db5", "#f2c14e", "#3a9d6a", "#e8e3d9", "#8e44ad", "#e67e22", "#1abc9c", "#c0392b"];
const LOWERS = ["#2c3e70", "#3b5d3a", "#6b4b8a", "#4a4a4a", "#1f6f8b", "#7a3b2e"];
const SKINS = ["#8d5524", "#a0663a", "#7a4a24", "#b07444"];

export function person(rand = Math.random) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const saree = rand() < 0.4;
  const shirt = pick(SHIRTS);
  const lower = saree ? shirt : pick(LOWERS);
  const skin = pick(SKINS);
  const parts = [
    part(cylBase(0.2, saree ? 0.3 : 0.24, 0.86, 7), lower),
    part(cylBase(0.2, 0.24, 0.64, 7), shirt, { y: 0.86 }),
    part(UNIT.box, saree ? shirt : skin, { x: 0.29, y: 1.18, sx: 0.11, sy: 0.55, sz: 0.11, rz: 0.08 }),
    part(UNIT.box, saree ? shirt : skin, { x: -0.29, y: 1.18, sx: 0.11, sy: 0.55, sz: 0.11, rz: -0.08 }),
    part(UNIT.sphere, skin, { y: 1.66, s: 0.14 }),
    part(UNIT.sphere, "#141414", { y: 1.71, s: 0.145, sy: 0.7 }),
  ];
  if (saree) parts.push(part(UNIT.box, pick(SHIRTS), { y: 1.25, z: -0.05, sx: 0.5, sy: 0.5, sz: 0.3, rz: 0.35 }));
  const mesh = new THREE.Mesh(merge(parts), MAT.solid);
  mesh.castShadow = true;
  return mesh;
}

/* ================================ Vehicles ================================ */

function wheelParts(positions, r, w, color = "#151515", hub = "#9a9a9a") {
  const tire = new THREE.CylinderGeometry(r, r, w, 12);
  const cap = new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.02, 8);
  const parts = [];
  for (const [x, y, z] of positions) {
    parts.push(part(tire, color, { x, y, z, rz: Math.PI / 2, order: "XYZ" }));
    parts.push(part(cap, hub, { x, y, z, rz: Math.PI / 2, order: "XYZ" }));
  }
  return parts;
}

/** Green CNG auto-rickshaw. Forward is +Z. Returns { mesh, radius, circles }. */
export function cngAuto() {
  const g = "#1e8a3c";
  const parts = [
    part(UNIT.box, g, { y: 0.62, sx: 1.3, sy: 0.45, sz: 2.5 }),
    part(UNIT.box, g, { y: 1.32, z: -0.25, sx: 1.28, sy: 1.05, sz: 1.75 }),
    part(UNIT.box, g, { y: 1.05, z: 1.05, sx: 0.95, sy: 0.85, sz: 0.55 }),
    part(UNIT.box, "#1f2b33", { y: 1.58, z: 0.62, sx: 1.05, sy: 0.55, sz: 0.06 }),
    part(UNIT.box, "#176e30", { y: 1.89, z: -0.2, sx: 1.38, sy: 0.1, sz: 1.95 }),
    part(UNIT.box, "#121212", { y: 1.35, z: -0.55, sx: 1.31, sy: 0.55, sz: 0.9 }),
    part(UNIT.box, "#fff4c2", { y: 1.15, z: 1.34, sx: 0.22, sy: 0.14, sz: 0.04 }),
    ...wheelParts([[0, 0.27, 1.05], [0.63, 0.27, -0.75], [-0.63, 0.27, -0.75]], 0.27, 0.18),
  ];
  return { geo: merge(parts), circles: [[0, 0.7, 0.85], [0, -0.6, 0.85]] };
}

/** Chander Gari: the open-backed jeep of the Bandarban hills. */
export function chanderGari(color = "#2f6a8a") {
  const parts = [
    part(UNIT.box, color, { y: 1.0, sx: 1.8, sy: 0.75, sz: 4.3 }),
    part(UNIT.box, color, { y: 1.55, z: 1.45, sx: 1.7, sy: 0.38, sz: 1.35 }),
    part(UNIT.box, "#1f2b33", { y: 1.98, z: 0.72, sx: 1.62, sy: 0.6, sz: 0.06 }),
    part(UNIT.box, "#2f3a30", { y: 2.62, z: -0.75, sx: 1.78, sy: 0.07, sz: 2.8 }),
    part(UNIT.box, "#3a3a3a", { x: 0.86, y: 2.0, z: 0.6, sx: 0.07, sy: 1.25, sz: 0.07 }),
    part(UNIT.box, "#3a3a3a", { x: -0.86, y: 2.0, z: 0.6, sx: 0.07, sy: 1.25, sz: 0.07 }),
    part(UNIT.box, "#3a3a3a", { x: 0.86, y: 2.0, z: -2.1, sx: 0.07, sy: 1.25, sz: 0.07 }),
    part(UNIT.box, "#3a3a3a", { x: -0.86, y: 2.0, z: -2.1, sx: 0.07, sy: 1.25, sz: 0.07 }),
    part(UNIT.box, "#6b5a40", { x: 0.7, y: 1.45, z: -0.9, sx: 0.3, sy: 0.12, sz: 2.2 }),
    part(UNIT.box, "#6b5a40", { x: -0.7, y: 1.45, z: -0.9, sx: 0.3, sy: 0.12, sz: 2.2 }),
    part(UNIT.box, "#c9c9c9", { y: 0.85, z: 2.18, sx: 1.85, sy: 0.22, sz: 0.12 }),
    part(UNIT.box, "#fff4c2", { x: 0.6, y: 1.35, z: 2.15, sx: 0.25, sy: 0.16, sz: 0.04 }),
    part(UNIT.box, "#fff4c2", { x: -0.6, y: 1.35, z: 2.15, sx: 0.25, sy: 0.16, sz: 0.04 }),
    ...wheelParts([[0.88, 0.42, 1.45], [-0.88, 0.42, 1.45], [0.88, 0.42, -1.45], [-0.88, 0.42, -1.45]], 0.42, 0.3),
  ];
  return { geo: merge(parts), circles: [[0, 1.4, 1.05], [0, -1.4, 1.05]] };
}

/** Hand-painted Bangladeshi truck with a decorated wooden "crown" over the cab. */
export function paintedTruck() {
  const parts = [
    part(UNIT.box, "#2a2a2a", { y: 0.8, z: -0.2, sx: 2.1, sy: 0.35, sz: 7.4 }),
    part(UNIT.box, "#f2b705", { y: 1.75, z: 2.65, sx: 2.3, sy: 1.75, sz: 1.9 }),
    part(UNIT.box, "#1f2b33", { y: 2.15, z: 3.61, sx: 2.0, sy: 0.75, sz: 0.06 }),
    part(UNIT.box, "#d6402f", { y: 2.95, z: 3.15, sx: 2.45, sy: 0.6, sz: 0.5 }),
    part(UNIT.box, "#2e86c1", { y: 3.32, z: 3.2, sx: 1.6, sy: 0.25, sz: 0.3 }),
    part(UNIT.box, "#27ae60", { x: 0.9, y: 3.35, z: 3.2, sx: 0.3, sy: 0.35, sz: 0.32 }),
    part(UNIT.box, "#27ae60", { x: -0.9, y: 3.35, z: 3.2, sx: 0.3, sy: 0.35, sz: 0.32 }),
    part(UNIT.box, "#b5651d", { y: 2.15, z: -1.0, sx: 2.45, sy: 2.4, sz: 5.0 }),
    part(UNIT.box, "#e74c3c", { y: 1.35, z: -1.0, sx: 2.48, sy: 0.22, sz: 5.02 }),
    part(UNIT.box, "#2e86c1", { y: 1.85, z: -1.0, sx: 2.48, sy: 0.16, sz: 5.02 }),
    part(UNIT.box, "#27ae60", { y: 2.75, z: -1.0, sx: 2.48, sy: 0.16, sz: 5.02 }),
    part(UNIT.box, "#f1c40f", { y: 3.25, z: -1.0, sx: 2.48, sy: 0.12, sz: 5.02 }),
    part(UNIT.box, "#c9c9c9", { y: 0.95, z: 3.7, sx: 2.35, sy: 0.25, sz: 0.15 }),
    part(UNIT.box, "#fff4c2", { x: 0.8, y: 1.25, z: 3.62, sx: 0.3, sy: 0.2, sz: 0.04 }),
    part(UNIT.box, "#fff4c2", { x: -0.8, y: 1.25, z: 3.62, sx: 0.3, sy: 0.2, sz: 0.04 }),
    ...wheelParts([[1.05, 0.5, 2.6], [-1.05, 0.5, 2.6], [1.05, 0.5, -1.4], [-1.05, 0.5, -1.4], [1.05, 0.5, -2.6], [-1.05, 0.5, -2.6]], 0.5, 0.36),
  ];
  return { geo: merge(parts), circles: [[0, 2.5, 1.3], [0, 0, 1.3], [0, -2.6, 1.3]] };
}

/** Wooden country boat with a curved bamboo canopy, for the lake. */
export function countryBoat() {
  return merge([
    part(UNIT.prism, "#5b3b22", { y: 0.55, rx: Math.PI, order: "XYZ", sx: 1.3, sy: 0.6, sz: 5.5, ry: 0 }),
    part(UNIT.box, "#6e4a2c", { y: 0.52, sx: 1.25, sy: 0.08, sz: 4.2 }),
    part(UNIT.prism, "#b59a5a", { y: 0.55, sx: 1.2, sy: 0.75, sz: 2.0, ry: Math.PI / 2 }),
  ]);
}

/* ================================ Buildings =============================== */

/** Bamboo stilt house ("machang ghor"). Platform floor at y = 0, posts reach down 7 m. */
export function stiltHouse(rand) {
  const W = 5 + rand() * 2;
  const D = 4 + rand() * 1.5;
  const roofTin = rand() < 0.55;
  const roof = roofTin ? (rand() < 0.5 ? "#8d9aa3" : "#7d6a5a") : "#b59a5a";
  const wall = rand() < 0.5 ? "#c9ab6b" : "#bf9d5e";
  const parts = [];
  for (const px of [-W / 2, 0, W / 2]) {
    for (const pz of [-D / 2, D / 2 + 0.8]) {
      parts.push(part(UNIT.box, "#6b5135", { x: px, y: -3.5, z: pz, sx: 0.18, sy: 7, sz: 0.18 }));
    }
  }
  parts.push(
    part(UNIT.box, "#8b6b45", { y: 0.09, z: 0.4, sx: W + 0.6, sy: 0.18, sz: D + 1.6 }),
    part(UNIT.box, wall, { y: 1.33, sx: W, sy: 2.3, sz: D }),
    part(UNIT.box, "#a8894f", { y: 0.62, sx: W + 0.03, sy: 0.08, sz: D + 0.03 }),
    part(UNIT.box, "#a8894f", { y: 2.2, sx: W + 0.03, sy: 0.08, sz: D + 0.03 }),
    part(UNIT.box, "#4a3523", { x: -W * 0.18, y: 1.05, z: D / 2 + 0.03, sx: 0.9, sy: 1.7, sz: 0.06 }),
    part(UNIT.box, "#2a2a22", { x: W * 0.25, y: 1.5, z: D / 2 + 0.03, sx: 0.85, sy: 0.6, sz: 0.06 }),
    part(UNIT.box, "#7b5d3a", { y: 0.75, z: D / 2 + 1.15, sx: W + 0.4, sy: 0.07, sz: 0.07 }),
    part(UNIT.prism, roof, { y: 2.45, sx: W + 0.9, sy: 1.35, sz: D + 1.2 })
  );
  return { geo: merge(parts), width: W + 1, depth: D + 2 };
}

/** Roadside tea stall with a tin lean-to roof, counter and bench. */
export function teaStall() {
  return merge([
    part(UNIT.box, "#6b5135", { x: -1.6, y: 1.25, z: -1.1, sx: 0.12, sy: 2.5, sz: 0.12 }),
    part(UNIT.box, "#6b5135", { x: 1.6, y: 1.25, z: -1.1, sx: 0.12, sy: 2.5, sz: 0.12 }),
    part(UNIT.box, "#6b5135", { x: -1.6, y: 1.05, z: 1.1, sx: 0.12, sy: 2.1, sz: 0.12 }),
    part(UNIT.box, "#6b5135", { x: 1.6, y: 1.05, z: 1.1, sx: 0.12, sy: 2.1, sz: 0.12 }),
    part(UNIT.box, "#8d9aa3", { y: 2.35, sx: 3.8, sy: 0.07, sz: 3.0, rx: 0.17 }),
    part(UNIT.box, "#a07a4a", { y: 0.55, z: -0.4, sx: 3.0, sy: 1.1, sz: 0.8 }),
    part(UNIT.box, "#c8b48a", { y: 1.12, z: -0.4, sx: 3.1, sy: 0.05, sz: 0.9 }),
    part(cylBase(0.18, 0.2, 0.3, 8), "#9a9a9a", { x: 0.8, y: 1.15, z: -0.4 }),
    part(UNIT.box, "#e74c3c", { x: -0.6, y: 1.35, z: -0.4, sx: 0.5, sy: 0.4, sz: 0.4 }),
    part(UNIT.box, "#7a5a3a", { y: 0.42, z: 1.7, sx: 2.8, sy: 0.08, sz: 0.4 }),
    part(UNIT.box, "#5b4636", { x: -1.2, y: 0.2, z: 1.7, sx: 0.08, sy: 0.4, sz: 0.35 }),
    part(UNIT.box, "#5b4636", { x: 1.2, y: 0.2, z: 1.7, sx: 0.08, sy: 0.4, sz: 0.35 }),
  ]);
}

const SHOP_WALLS = ["#e8c39e", "#9ccfd8", "#f2d16b", "#e6a1a1", "#c9d8a6", "#d7c4e6"];

/** Two-storey concrete shop-house for the town at the start. Front faces +Z. */
export function shopHouse(rand) {
  const wall = SHOP_WALLS[Math.floor(rand() * SHOP_WALLS.length)];
  const w = 6 + rand() * 2.5;
  const h = 6 + rand() * 1.5;
  return merge([
    part(UNIT.box, wall, { y: h / 2, sx: w, sy: h, sz: 6.5 }),
    part(UNIT.box, "#5e6266", { y: 1.3, z: 3.27, sx: w - 1, sy: 2.4, sz: 0.06 }),
    part(UNIT.box, "#3c4a55", { x: -w * 0.22, y: h * 0.68, z: 3.27, sx: 1.2, sy: 1.1, sz: 0.06 }),
    part(UNIT.box, "#3c4a55", { x: w * 0.22, y: h * 0.68, z: 3.27, sx: 1.2, sy: 1.1, sz: 0.06 }),
    part(UNIT.box, "#d9d2c3", { y: h + 0.3, sx: w + 0.2, sy: 0.6, sz: 6.7 }),
    part(UNIT.box, rand() < 0.5 ? "#2e86c1" : "#c0392b", { y: 2.75, z: 3.7, sx: w, sy: 0.08, sz: 1.2, rx: -0.2 }),
  ]);
}

/** Bus-stop shelter. Front (open side) faces +Z. */
export function busShelter() {
  return merge([
    part(UNIT.box, "#8a8a84", { x: -2, y: 1.3, z: 0.95, sx: 0.12, sy: 2.6, sz: 0.12 }),
    part(UNIT.box, "#8a8a84", { x: 2, y: 1.3, z: 0.95, sx: 0.12, sy: 2.6, sz: 0.12 }),
    part(UNIT.box, "#8a8a84", { x: -2, y: 1.3, z: -0.95, sx: 0.12, sy: 2.6, sz: 0.12 }),
    part(UNIT.box, "#8a8a84", { x: 2, y: 1.3, z: -0.95, sx: 0.12, sy: 2.6, sz: 0.12 }),
    part(UNIT.box, "#1f7a4a", { y: 2.66, sx: 4.4, sy: 0.14, sz: 2.4 }),
    part(UNIT.box, "#c8102e", { y: 2.56, z: 1.2, sx: 4.4, sy: 0.12, sz: 0.04 }),
    part(UNIT.box, "#d9d2c3", { y: 1.05, z: -0.95, sx: 4.0, sy: 1.7, sz: 0.08 }),
    part(UNIT.box, "#7a5a3a", { y: 0.5, z: -0.6, sx: 3.4, sy: 0.1, sz: 0.45 }),
    part(UNIT.box, "#5b4636", { x: -1.4, y: 0.25, z: -0.6, sx: 0.08, sy: 0.5, sz: 0.4 }),
    part(UNIT.box, "#5b4636", { x: 1.4, y: 0.25, z: -0.6, sx: 0.08, sy: 0.5, sz: 0.4 }),
  ]);
}

/* ============================== Text & signs ============================== */

export const BN_FONT = "'Nirmala UI', 'Vrinda', 'Noto Sans Bengali', 'Segoe UI', sans-serif";

export function canvasTexture(w, h, draw, maxAniso = 4) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

/** Fit text into a width by shrinking the font. */
export function fitText(ctx, text, x, y, maxW, size, weight = 700, family = BN_FONT) {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px ${family}`;
    s -= 2;
  } while (ctx.measureText(text).width > maxW && s > 8);
  ctx.fillText(text, x, y);
}

/**
 * Sign board on posts. `draw(ctx, w, h)` paints the face. Front faces +Z.
 * Returns a Group whose origin is at ground level under the board's centre.
 */
export function signBoard({ w, h, postH = 2.2, draw, posts = 2, maxAniso }) {
  const group = new THREE.Group();
  const tex = canvasTexture(Math.round(256 * (w / h)), 256, draw, maxAniso);
  const edge = new THREE.MeshLambertMaterial({ color: 0x5a5f63 });
  const face = new THREE.MeshLambertMaterial({ map: tex });
  const board = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), [edge, edge, edge, edge, face, edge]);
  board.position.y = postH + h / 2;
  board.castShadow = true;
  group.add(board);
  const postMat = new THREE.MeshLambertMaterial({ color: 0x8a8f93 });
  const xs = posts === 1 ? [0] : [-w * 0.35, w * 0.35];
  for (const x of xs) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, postH + h * 0.5, 0.1), postMat);
    post.position.set(x, (postH + h * 0.5) / 2, -0.06);
    group.add(post);
  }
  return group;
}
