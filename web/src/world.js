import * as THREE from "../vendor/three.module.js";
import { createNoise2D, fbm, ridged, smoothstep, clamp, lerp, mulberry32, bnDigits } from "./noise.js";
import * as P from "./props.js";

/* ---------------------------------------------------------------------------
   The one level: the hill road from Bandarban town up to Nilgiri.
   Everything is generated from fixed seeds, so the level is identical every run.
--------------------------------------------------------------------------- */

export const ROAD_HALF = 3.75; // half the road width (two 3.75 m lanes)
export const SHOULDER = 1.5;
export const LANE = 1.85; // lane centre offset from the road centre (we drive on the LEFT)
export const WATER_Y = 8;
export const OFFROAD_LIMIT = 13.5; // further than this from the centre line = respawn

const HALF = 1300; // terrain extends ±1300 m
const STEP = 5; // terrain grid spacing
const GN = (HALF * 2) / STEP + 1;
const FLAT = ROAD_HALF + 8.5; // flat verge beside the road
const FALL = 34; // distance over which cut/fill slopes blend back into the hills
const DS = 2; // road sample spacing
const CELL = 12; // spatial hash cell for road lookups

// Hand-placed road through the hills (x, z) — winding, with a few hairpins.
const ROUTE = [
  [-780, 700], [-620, 700], [-470, 655], [-370, 545], [-405, 405], [-300, 300],
  [-140, 320], [10, 255], [70, 110], [-30, -10], [40, -150], [200, -170],
  [330, -265], [255, -425], [380, -525], [545, -480], [650, -600], [705, -730],
];

export const STOPS = [
  { en: "Bandarban", bn: "বান্দরবান", frac: 0.0, terminal: true },
  { en: "Meghla", bn: "মেঘলা", frac: 0.24 },
  { en: "Shoilo Propat", bn: "শৈলপ্রপাত", frac: 0.49, waterfall: true },
  { en: "Chimbuk", bn: "চিম্বুক", frac: 0.73 },
  { en: "Nilgiri", bn: "নীলগিরি", frac: 0.965, final: true },
];

export const SUN_DIR = new THREE.Vector3(-0.42, 0.66, 0.55).normalize();
const HORIZON = new THREE.Color("#cddde2");
const ZENITH = new THREE.Color("#5f9fd6");
const STOP_SIDE = -(ROAD_HALF + SHOULDER + 2.4); // shelters sit on the left verge

export class World {
  constructor(scene) {
    this.scene = scene;
    this.noiseA = createNoise2D(20251110);
    this.noiseB = createNoise2D(4411);
    this.noiseC = createNoise2D(93);
    this.rand = mulberry32(1971);
    this.exclusions = []; // [x, z, r] circles that vegetation keeps out of
    this.animated = []; // callbacks (dt, t) for the waterfall, boats…
    this.stops = [];
  }

  async build(onProgress, { maxAniso = 4 } = {}) {
    this.maxAniso = maxAniso;
    const step = async (p, label) => {
      onProgress && onProgress(p, label);
      await new Promise((r) => setTimeout(r, 0));
    };
    await step(0.03, "Surveying the hill road…");
    this._buildRoute();
    await step(0.08, "Raising the hills…");
    this._buildTerrainData();
    await step(0.42, "Shaping the valleys…");
    this._buildTerrainMesh();
    await step(0.55, "Laying the road…");
    this._buildRoad();
    this._buildGuards();
    this._buildPolesAndSigns();
    await step(0.64, "Building villages and bus stops…");
    this._buildSettlements();
    await step(0.74, "Growing bamboo and banana groves…");
    this._buildVegetation();
    await step(0.9, "Filling the lake…");
    this._buildEnvironment();
    await step(1, "Ready");
  }

  /* ============================== Road path ============================== */

  _baseHeight(x, z) {
    let h = 14 + 26 * fbm(this.noiseA, x / 260, z / 260, 5);
    h += 40 * ridged(this.noiseB, x / 340 + 7.1, z / 820 - 3.3, 4); // long N–S ridges
    const t = clamp((x - z + 1550) / 3100, 0, 1);
    h += 85 * t * t * (3 - 2 * t); // the land climbs toward Nilgiri
    h -= 55 * Math.exp(-((x + 470) ** 2 + (z - 880) ** 2) / (2 * 230 * 230)); // lake basin
    h += 70 * smoothstep(950, 1300, Math.max(Math.abs(x), Math.abs(z))); // hills close the horizon
    return h;
  }

  _buildRoute() {
    const curve = new THREE.CatmullRomCurve3(
      ROUTE.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      false,
      "centripetal"
    );
    curve.arcLengthDivisions = 4000;
    const L = curve.getLength();
    const segs = Math.round(L / DS);
    const n = segs + 1;
    this.length = L;
    this.ds = L / segs;
    this.n = n;
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = i / segs;
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t);
      const len = Math.hypot(t.x, t.z) || 1;
      this.px[i] = p.x;
      this.pz[i] = p.z;
      this.tx[i] = t.x / len;
      this.tz[i] = t.z / len;
    }

    // Elevation: follow the land, but smoothed and grade-limited like a real hill road.
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) e[i] = this._baseHeight(this.px[i], this.pz[i]);
    for (let k = 0; k < 3; k++) boxBlur(e, 35);
    gradeLimit(e, 0.1 * this.ds);
    for (let i = 0; i < n; i++) e[i] = Math.max(e[i], WATER_Y + 3.5);
    boxBlur(e, 6);
    gradeLimit(e, 0.1 * this.ds);
    this.elev = e;

    // Spatial hash of samples for fast "where am I on the road?" lookups.
    this.hash = new Map();
    for (let i = 0; i < n; i++) {
      const key = hashKey(Math.floor(this.px[i] / CELL), Math.floor(this.pz[i] / CELL));
      let list = this.hash.get(key);
      if (!list) this.hash.set(key, (list = []));
      list.push(i);
    }
    this.guardL = new Uint8Array(n);
    this.guardR = new Uint8Array(n);

    this.stops = STOPS.map((s) => ({ ...s, u: s.frac * L }));
    this.stops[0].u = 34; // terminal shelter, a little way into town
  }

  /** Point on the road at distance u (m) and lateral offset s (+ = right of travel). */
  frame(u, s = 0) {
    const f = clamp(u / this.ds, 0, this.n - 1.001);
    const i = Math.floor(f);
    const a = f - i;
    const tx = lerp(this.tx[i], this.tx[i + 1], a);
    const tz = lerp(this.tz[i], this.tz[i + 1], a);
    const l = Math.hypot(tx, tz) || 1;
    const fx = tx / l;
    const fz = tz / l;
    const rx = -fz;
    const rz = fx;
    const x = lerp(this.px[i], this.px[i + 1], a) + rx * s;
    const z = lerp(this.pz[i], this.pz[i + 1], a) + rz * s;
    return { i, x, z, e: lerp(this.elev[i], this.elev[i + 1], a), tx: fx, tz: fz, rx, rz, yaw: Math.atan2(fx, fz) };
  }

  /**
   * Nearest point on the road centre line: { u, s, dist, e, tx, tz, guardL, guardR }.
   * Returns null when far from the road, unless `force` is set.
   */
  locate(x, z, force = false) {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bd = Infinity;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const list = this.hash.get(hashKey(cx + dx, cz + dz));
        if (!list) continue;
        for (const i of list) {
          const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    if (best < 0) {
      if (!force) return null;
      for (let i = 0; i < this.n; i++) {
        const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    }
    let res = null;
    for (const j of [best - 1, best]) {
      if (j < 0 || j >= this.n - 1) continue;
      const ax = this.px[j];
      const az = this.pz[j];
      const dx = this.px[j + 1] - ax;
      const dz = this.pz[j + 1] - az;
      const len2 = dx * dx + dz * dz;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1);
      const qx = ax + dx * t;
      const qz = az + dz * t;
      const d = Math.hypot(x - qx, z - qz);
      if (!res || d < res.dist) {
        const len = Math.sqrt(len2);
        const rx = -dz / len;
        const rz = dx / len;
        res = {
          u: (j + t) * this.ds,
          s: (x - qx) * rx + (z - qz) * rz,
          dist: d,
          e: lerp(this.elev[j], this.elev[j + 1], t),
          tx: dx / len,
          tz: dz / len,
          guardL: !!(this.guardL[j] || this.guardL[j + 1]),
          guardR: !!(this.guardR[j] || this.guardR[j + 1]),
        };
      }
    }
    return res;
  }

  /* =============================== Terrain =============================== */

  _buildTerrainData() {
    const { px, pz, elev, n } = this;

    // Coarse distance-to-road field (20 m grid) — hills grow taller away from the road.
    const CS = 20;
    const CN = (HALF * 2) / CS + 1;
    const cd = new Float32Array(CN * CN).fill(1e6);
    const rc = Math.ceil(320 / CS);
    for (let i = 0; i < n; i += 3) {
      const ci = Math.round((px[i] + HALF) / CS);
      const cj = Math.round((pz[i] + HALF) / CS);
      for (let dj = -rc; dj <= rc; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= CN) continue;
        for (let di = -rc; di <= rc; di++) {
          const ii = ci + di;
          if (ii < 0 || ii >= CN) continue;
          const d = Math.hypot(-HALF + ii * CS - px[i], -HALF + j * CS - pz[i]);
          const k = j * CN + ii;
          if (d < cd[k]) cd[k] = d;
        }
      }
    }
    this.coarse = { cd, CS, CN };

    // Fine field: distance to the road + the road height there.
    const N = GN * GN;
    const minD = new Float32Array(N).fill(1e6);
    const relev = new Float32Array(N);
    const r = Math.ceil((FLAT + FALL + 3) / STEP);
    for (let i = 0; i < n; i++) {
      const ci = Math.round((px[i] + HALF) / STEP);
      const cj = Math.round((pz[i] + HALF) / STEP);
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= GN) continue;
        for (let di = -r; di <= r; di++) {
          const ii = ci + di;
          if (ii < 0 || ii >= GN) continue;
          const d = Math.hypot(-HALF + ii * STEP - px[i], -HALF + j * STEP - pz[i]);
          const k = j * GN + ii;
          if (d < minD[k]) {
            minD[k] = d;
            relev[k] = elev[i];
          }
        }
      }
    }

    // Final height: natural hills, carved/filled into a flat verge where the road runs.
    const H = new Float32Array(N);
    const cut = new Float32Array(N);
    for (let j = 0; j < GN; j++) {
      const z = -HALF + j * STEP;
      for (let i = 0; i < GN; i++) {
        const x = -HALF + i * STEP;
        const k = j * GN + i;
        const far = smoothstep(40, 280, this.roadDistCoarse(x, z));
        const natural = this._baseHeight(x, z) + 55 * ridged(this.noiseC, x / 300 - 11, z / 300 + 5, 3) * far;
        const d = minD[k];
        const w = d <= FLAT ? 1 : 1 - smoothstep(FLAT, FLAT + FALL, d);
        const target = relev[k] - 0.4;
        H[k] = lerp(natural, target, w);
        cut[k] = (natural - target) * w;
      }
    }
    this.H = H;
    this.minD = minD;
    this.cut = cut;
  }

  roadDistCoarse(x, z) {
    const { cd, CS, CN } = this.coarse;
    const fx = clamp((x + HALF) / CS, 0, CN - 1.001);
    const fz = clamp((z + HALF) / CS, 0, CN - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const a = fx - i;
    const b = fz - j;
    const k = j * CN + i;
    return lerp(lerp(cd[k], cd[k + 1], a), lerp(cd[k + CN], cd[k + CN + 1], a), b);
  }

  /** Distance to the road: precise near it, approximate far away. */
  roadDist(x, z) {
    const i = Math.round((x + HALF) / STEP);
    const j = Math.round((z + HALF) / STEP);
    if (i >= 0 && j >= 0 && i < GN && j < GN) {
      const d = this.minD[j * GN + i];
      if (d < 1e5) return d;
    }
    return this.roadDistCoarse(x, z);
  }

  /** Terrain height, matching the rendered triangles exactly. */
  terrainAt(x, z) {
    const fx = clamp((x + HALF) / STEP, 0, GN - 1.001);
    const fz = clamp((z + HALF) / STEP, 0, GN - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const a = fx - i;
    const b = fz - j;
    const H = this.H;
    const h00 = H[j * GN + i];
    const h10 = H[j * GN + i + 1];
    const h01 = H[(j + 1) * GN + i];
    const h11 = H[(j + 1) * GN + i + 1];
    if (a + b <= 1) return h00 + (h10 - h00) * a + (h01 - h00) * b;
    return h11 + (h01 - h11) * (1 - a) + (h10 - h11) * (1 - b);
  }

  /** Height a wheel rests at: the road surface on the road, terrain elsewhere. */
  groundAt(x, z) {
    const q = this.locate(x, z);
    if (q) {
      const as = Math.abs(q.s);
      if (as <= ROAD_HALF) return q.e + 0.06;
      if (as <= ROAD_HALF + SHOULDER) return q.e + 0.06 - ((as - ROAD_HALF) / SHOULDER) * 0.09;
    }
    return this.terrainAt(x, z);
  }

  _buildTerrainMesh() {
    const N = GN * GN;
    const pos = new Float32Array(N * 3);
    for (let j = 0; j < GN; j++) {
      for (let i = 0; i < GN; i++) {
        const k = j * GN + i;
        pos[k * 3] = -HALF + i * STEP;
        pos[k * 3 + 1] = this.H[k];
        pos[k * 3 + 2] = -HALF + j * STEP;
      }
    }
    const idx = new Uint32Array((GN - 1) * (GN - 1) * 6);
    let o = 0;
    for (let j = 0; j < GN - 1; j++) {
      for (let i = 0; i < GN - 1; i++) {
        const a = j * GN + i;
        const b = (j + 1) * GN + i;
        const c = j * GN + i + 1;
        const d = (j + 1) * GN + i + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = c;
        idx[o++] = b; idx[o++] = d; idx[o++] = c;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // Paddy-green valleys, darker forested hills, jhum patches, red laterite in road cuttings.
    const nor = geo.attributes.normal.array;
    const col = new Float32Array(N * 3);
    const C = {
      valley: new THREE.Color("#6f9a3c"),
      forest: new THREE.Color("#3b6b2c"),
      deep: new THREE.Color("#2b5223"),
      jhum: new THREE.Color("#a5a04a"),
      soil: new THREE.Color("#9a5b36"),
      mud: new THREE.Color("#7d7150"),
      verge: new THREE.Color("#7da447"),
    };
    const c = new THREE.Color();
    for (let k = 0; k < N; k++) {
      const x = pos[k * 3];
      const h = pos[k * 3 + 1];
      const z = pos[k * 3 + 2];
      const slope = 1 - nor[k * 3 + 1];
      c.copy(C.valley).lerp(C.forest, smoothstep(14, 60, h));
      c.lerp(C.deep, smoothstep(0.1, 0.6, this.noiseA(x / 90, z / 90)) * 0.6);
      const jhum = smoothstep(0.42, 0.6, this.noiseB(x / 160 + 3, z / 160 - 8));
      if (jhum > 0 && slope > 0.06 && slope < 0.45 && this.minD[k] > 30) c.lerp(C.jhum, jhum * 0.8);
      if (this.minD[k] < FLAT + 1.5) c.lerp(C.verge, 0.7);
      if (this.cut[k] > 2.5) c.lerp(C.soil, smoothstep(0.18, 0.45, slope) * smoothstep(2.5, 6, this.cut[k]));
      if (h < WATER_Y + 1.6) c.lerp(C.mud, smoothstep(WATER_Y + 1.6, WATER_Y - 0.5, h));
      const v = 1 + this.noiseC(x / 14, z / 14) * 0.07;
      col[k * 3] = c.r * v;
      col[k * 3 + 1] = c.g * v;
      col[k * 3 + 2] = c.b * v;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /* ================================ Road ================================= */

  _buildRoad() {
    const { n, px, pz, tx, tz, elev, ds } = this;

    // Asphalt with edge lines and a dashed yellow centre line, repeating every 10 m.
    const tex = P.canvasTexture(256, 512, (ctx, w, h) => {
      ctx.fillStyle = "#4b4b4b";
      ctx.fillRect(0, 0, w, h);
      const r = mulberry32(5);
      for (let k = 0; k < 9000; k++) {
        const g = 55 + r() * 40;
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.fillRect(r() * w, r() * h, 1.5, 1.5);
      }
      ctx.fillStyle = "rgba(30,30,30,0.18)";
      for (const x of [44, 84, 172, 212]) ctx.fillRect(x - 10, 0, 20, h);
      ctx.fillStyle = "#e9e7df";
      ctx.fillRect(9, 0, 7, h);
      ctx.fillRect(w - 16, 0, 7, h);
      ctx.fillStyle = "#e8b72c";
      ctx.fillRect(w / 2 - 4, 0, 8, h * 0.42);
    }, this.maxAniso);
    tex.wrapT = THREE.RepeatWrapping;

    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i++) {
      const rx = -tz[i];
      const rz = tx[i];
      const y = elev[i] + 0.06;
      pos.set([px[i] - rx * ROAD_HALF, y, pz[i] - rz * ROAD_HALF, px[i] + rx * ROAD_HALF, y, pz[i] + rz * ROAD_HALF], i * 6);
      const v = (i * ds) / 10;
      uv.set([0, v, 1, v], i * 4);
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const road = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    road.receiveShadow = true;
    this.scene.add(road);

    // Gravel shoulders + an earth skirt that hides any gap down to the terrain.
    const sp = [];
    const sc = [];
    const sIdx = [];
    const gravel = new THREE.Color("#8c7b62");
    const dirt = new THREE.Color("#6e5a44");
    for (const side of [-1, 1]) {
      const base = sp.length / 3;
      for (let i = 0; i < n; i++) {
        const rx = -tz[i] * side;
        const rz = tx[i] * side;
        const e = elev[i];
        for (const [off, dy, color] of [
          [ROAD_HALF - 0.05, 0.04, gravel],
          [ROAD_HALF + SHOULDER, -0.03, gravel],
          [ROAD_HALF + SHOULDER + 0.5, -2.4, dirt],
        ]) {
          sp.push(px[i] + rx * off, e + dy, pz[i] + rz * off);
          sc.push(color.r, color.g, color.b);
        }
      }
      for (let i = 0; i < n - 1; i++) {
        for (let k = 0; k < 2; k++) {
          const a = base + i * 3 + k;
          const b = a + 1;
          const c = a + 3;
          const d = a + 4;
          if (side > 0) sIdx.push(a, b, c, b, d, c);
          else sIdx.push(a, c, b, b, c, d);
        }
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute("color", new THREE.Float32BufferAttribute(sc, 3));
    sg.setIndex(sIdx);
    sg.computeVertexNormals();
    const shoulders = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    shoulders.receiveShadow = true;
    this.scene.add(shoulders);
  }

  /** Striped bollards where the hillside drops away or the lake is close; the bus can't pass them. */
  _buildGuards() {
    const { n, px, pz, tx, tz, elev } = this;
    const raw = { L: new Uint8Array(n), R: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      for (const [side, key] of [[-1, "L"], [1, "R"]]) {
        const rx = -tz[i] * side;
        const rz = tx[i] * side;
        const at = (d) => this.terrainAt(px[i] + rx * d, pz[i] + rz * d);
        const drop = at(FLAT + 14) < elev[i] - 7 || at(FLAT + 26) < elev[i] - 12;
        const lake = at(FLAT + 6) < WATER_Y + 1 || at(FLAT + 18) < WATER_Y + 0.5;
        if (drop || lake) raw[key][i] = 1;
      }
    }
    this.guardL = cleanRuns(dilate(raw.L, 5), 12);
    this.guardR = cleanRuns(dilate(raw.R, 5), 12);
    // Keep the kerb open at bus stops (left side).
    for (const s of this.stops) {
      const i0 = Math.round(s.u / this.ds);
      for (let i = Math.max(0, i0 - 25); i < Math.min(n, i0 + 15); i++) this.guardL[i] = 0;
    }

    const list = [];
    for (let i = 0; i < n; i += 2) {
      for (const [side, arr] of [[-1, this.guardL], [1, this.guardR]]) {
        if (!arr[i]) continue;
        const off = (ROAD_HALF + 1.0) * side;
        list.push([px[i] - tz[i] * off, elev[i] - 0.03, pz[i] + tx[i] * off, Math.atan2(tx[i], tz[i])]);
      }
    }
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(P.bollard(), P.MAT.solid, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const v = new THREE.Vector3();
    list.forEach(([x, y, z, yaw], k) => {
      q.setFromAxisAngle(up, yaw);
      m.compose(v.set(x, y, z), q, one);
      mesh.setMatrixAt(k, m);
    });
    mesh.castShadow = true;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
  }

  _buildPolesAndSigns() {
    const { n, ds } = this;
    const maxAniso = this.maxAniso;

    // Electric poles along the right verge with sagging wires.
    const poles = [];
    for (let i = 8; i < n; i += 22) poles.push(this.frame(i * ds, ROAD_HALF + SHOULDER + 3.2));
    const pm = new THREE.InstancedMesh(P.electricPole(), P.MAT.solid, poles.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const wires = [];
    const sag = (t) => -0.7 * 4 * t * (1 - t);
    poles.forEach((f, k) => {
      f.y = this.terrainAt(f.x, f.z) - 0.3;
      q.setFromAxisAngle(up, f.yaw);
      m.compose(new THREE.Vector3(f.x, f.y, f.z), q, one);
      pm.setMatrixAt(k, m);
      if (k === 0) return;
      const a = poles[k - 1];
      for (const arm of [-0.85, 0.85]) {
        const ax = a.x + Math.cos(a.yaw) * arm;
        const az = a.z - Math.sin(a.yaw) * arm;
        const bx = f.x + Math.cos(f.yaw) * arm;
        const bz = f.z - Math.sin(f.yaw) * arm;
        const ay = a.y + 8.92;
        const by = f.y + 8.92;
        const segs = 6;
        for (let s = 0; s < segs; s++) {
          const t0 = s / segs;
          const t1 = (s + 1) / segs;
          wires.push(lerp(ax, bx, t0), lerp(ay, by, t0) + sag(t0), lerp(az, bz, t0));
          wires.push(lerp(ax, bx, t1), lerp(ay, by, t1) + sag(t1), lerp(az, bz, t1));
        }
      }
    });
    pm.castShadow = true;
    pm.computeBoundingSphere();
    this.scene.add(pm);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.Float32BufferAttribute(wires, 3));
    this.scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x2a2a2a })));

    const final = this.stops[this.stops.length - 1];

    // Kilometre posts on the left verge: "নীলগিরি  x.x কিমি".
    for (let u = 250; u < final.u - 100; u += 500) {
      const km = ((final.u - u) / 1000).toFixed(1);
      const post = P.signBoard({
        w: 0.6, h: 0.75, postH: 0.05, posts: 1, maxAniso,
        draw: (ctx, w, h) => {
          ctx.fillStyle = "#f4f1e8";
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = "#e7b416";
          ctx.fillRect(0, 0, w, h * 0.34);
          ctx.fillStyle = "#1d1d1d";
          ctx.textAlign = "center";
          P.fitText(ctx, "নীলগিরি", w / 2, h * 0.26, w * 0.9, 44);
          P.fitText(ctx, `${bnDigits(km)} কিমি`, w / 2, h * 0.72, w * 0.9, 58);
        },
      });
      this._placeFacing(post, u, -(ROAD_HALF + SHOULDER + 1.0), "toward");
    }

    // Direction sign leaving town.
    const dir = P.signBoard({
      w: 4.6, h: 2.2, postH: 2.3, maxAniso,
      draw: (ctx, w, h) => {
        ctx.fillStyle = "#0f6b3c";
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 6;
        ctx.strokeRect(8, 8, w - 16, h - 16);
        ctx.fillStyle = "#ffffff";
        const rows = [
          ["মেঘলা  ·  Meghla", this.stops[1].u],
          ["শৈলপ্রপাত  ·  Shoilo Propat", this.stops[2].u],
          ["নীলগিরি  ·  Nilgiri", final.u],
        ];
        rows.forEach(([name, u], k) => {
          const y = 66 + k * 72;
          ctx.textAlign = "left";
          P.fitText(ctx, name, 30, y, w * 0.64, 42);
          ctx.textAlign = "right";
          P.fitText(ctx, `${((u - 70) / 1000).toFixed(1)} km`, w - 30, y, w * 0.26, 42, 700, "'Segoe UI', sans-serif");
        });
      },
    });
    this._placeFacing(dir, 70, -(ROAD_HALF + SHOULDER + 2.2), "toward");

    // Yellow curve warnings before sharp bends.
    const head = (i) => Math.atan2(this.tx[i], this.tz[i]);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    for (let i = 60; i < n - 30; i++) {
      const turn = wrap(head(Math.min(n - 1, i + 22)) - head(i));
      if (Math.abs(turn) < 0.62) continue;
      const u = Math.max(0, (i - 24) * ds);
      if (this.stops.some((s) => Math.abs(s.u - u) < 60)) {
        i += 40;
        continue;
      }
      const left = turn > 0;
      const sign = P.signBoard({
        w: 1.0, h: 1.0, postH: 1.9, posts: 1, maxAniso,
        draw: (ctx, w, h) => {
          ctx.fillStyle = "#5a5f63";
          ctx.fillRect(0, 0, w, h);
          ctx.save();
          ctx.translate(w / 2, h / 2);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = "#f2c230";
          ctx.fillRect(-88, -88, 176, 176);
          ctx.strokeStyle = "#1d1d1d";
          ctx.lineWidth = 8;
          ctx.strokeRect(-80, -80, 160, 160);
          ctx.restore();
          ctx.strokeStyle = "#1d1d1d";
          ctx.lineWidth = 16;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          const dx = left ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(w / 2 - dx * 10, h * 0.78);
          ctx.lineTo(w / 2 - dx * 10, h * 0.48);
          ctx.quadraticCurveTo(w / 2 - dx * 10, h * 0.36, w / 2 + dx * 30, h * 0.36);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(w / 2 + dx * 18, h * 0.24);
          ctx.lineTo(w / 2 + dx * 44, h * 0.36);
          ctx.lineTo(w / 2 + dx * 18, h * 0.48);
          ctx.stroke();
        },
      });
      this._placeFacing(sign, u, -(ROAD_HALF + SHOULDER + 1.2), "toward");
      i += 70;
    }
  }

  /**
   * Put a Group beside the road. "toward": its +Z faces the bus as it approaches (readable);
   * "road": its +Z faces the road centre.
   */
  _placeFacing(obj, u, s, facing = "road") {
    const f = this.frame(u, s);
    obj.position.set(f.x, this.terrainAt(f.x, f.z), f.z);
    obj.rotation.y = facing === "toward" ? f.yaw + Math.PI : Math.atan2(-Math.sign(s) * f.rx, -Math.sign(s) * f.rz);
    this.scene.add(obj);
    return f;
  }

  /* ============================ Villages & stops =========================== */

  _addMesh(geo, x, y, z, yaw, { shadow = true, mat = P.MAT.solid } = {}) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  _addPerson(x, z, yaw, rand) {
    const pp = P.person(rand);
    pp.position.set(x, this.terrainAt(x, z) - 0.02, z);
    pp.rotation.y = yaw;
    this.scene.add(pp);
    return pp;
  }

  /** Stilt house on the hillside at road distance u, side offset s. Returns false if the spot is bad. */
  _tryHouse(u, s, rand) {
    const f = this.frame(u, s);
    const { geo, width, depth } = P.stiltHouse(rand);
    const yaw = Math.atan2(-Math.sign(s) * f.rx, -Math.sign(s) * f.rz); // veranda faces the road
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [lx, lz] of [[0, 0], [-width / 2, -depth / 2], [width / 2, -depth / 2], [-width / 2, depth / 2], [width / 2, depth / 2]]) {
      const h = this.terrainAt(f.x + lx * ca + lz * sa, f.z - lx * sa + lz * ca);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const tooClose = this.roadDist(f.x, f.z) < FLAT + 1;
    if (tooClose || hi - lo > 5 || lo < WATER_Y + 0.5 || this._blocked(f.x, f.z, Math.max(width, depth) * 0.6)) {
      geo.dispose();
      return false;
    }
    this._addMesh(geo, f.x, hi + 0.9, f.z, yaw);
    this.exclusions.push([f.x, f.z, Math.max(width, depth) * 0.75]);
    return true;
  }

  _blocked(x, z, r) {
    return this.exclusions.some(([ex, ez, er]) => (ex - x) ** 2 + (ez - z) ** 2 < (er + r) ** 2);
  }

  _stopSign(stop) {
    return P.signBoard({
      w: 1.5, h: 1.0, postH: 2.0, posts: 1, maxAniso: this.maxAniso,
      draw: (ctx, w, h) => {
        ctx.fillStyle = "#1f5fa8";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        P.fitText(ctx, "বাস স্টপ", w / 2, h * 0.3, w * 0.9, 56);
        P.fitText(ctx, stop.bn, w / 2, h * 0.62, w * 0.9, 50);
        P.fitText(ctx, stop.en.toUpperCase(), w / 2, h * 0.86, w * 0.9, 30, 700, "'Segoe UI', sans-serif");
      },
    });
  }

  _shelter(stop) {
    const f = this.frame(stop.u, STOP_SIDE);
    this._addMesh(P.busShelter(), f.x, this.terrainAt(f.x, f.z) - 0.05, f.z, Math.atan2(f.rx, f.rz));
    this.exclusions.push([f.x, f.z, 6]);
    this._placeFacing(this._stopSign(stop), stop.u + 4, -(ROAD_HALF + SHOULDER + 0.7), "toward");
    return f;
  }

  _buildSettlements() {
    const rand = this.rand;

    for (const stop of this.stops) {
      const u = stop.u;
      stop.people = [];
      stop.served = false;
      const sf = this._shelter(stop);
      const faceRoad = Math.atan2(sf.rx, sf.rz);

      // Passengers waiting by the shelter (the terminal's are already aboard).
      if (!stop.terminal && !stop.final) {
        const count = 3 + Math.floor(rand() * 4);
        for (let k = 0; k < count; k++) {
          const pf = this.frame(u - 1.6 + k * 0.9 + (rand() - 0.5) * 0.4, STOP_SIDE + 0.9 + (rand() - 0.5) * 0.5);
          stop.people.push(this._addPerson(pf.x, pf.z, faceRoad + (rand() - 0.5) * 0.8, rand));
        }
      }

      // A tea stall just past the shelter, with a couple of regulars.
      if (!stop.final) {
        const tf = this.frame(u + 11, STOP_SIDE - 1.5);
        if (!this._blocked(tf.x, tf.z, 2.5)) {
          this._addMesh(P.teaStall(), tf.x, this.terrainAt(tf.x, tf.z) - 0.05, tf.z, Math.atan2(tf.rx, tf.rz));
          this.exclusions.push([tf.x, tf.z, 4]);
          for (let k = 0; k < 2; k++) {
            const pf = this.frame(u + 10 + k * 1.2, STOP_SIDE + 0.4);
            this._addPerson(pf.x, pf.z, faceRoad + Math.PI + (rand() - 0.5), rand);
          }
        }
      }

      if (stop.terminal) {
        // Bandarban town: concrete shop-houses on both sides, parked CNGs, people about.
        for (let k = 0; k < 10; k++) {
          const side = k % 2 ? 1 : -1;
          const su = 4 + Math.floor(k / 2) * 14 + rand() * 3;
          if (side < 0 && Math.abs(su - u) < 10) continue;
          const f = this.frame(su, side * (ROAD_HALF + SHOULDER + 7.5 + rand() * 2));
          if (this._blocked(f.x, f.z, 4)) continue;
          this._addMesh(P.shopHouse(rand), f.x, this.terrainAt(f.x, f.z) - 0.2, f.z, Math.atan2(-side * f.rx, -side * f.rz));
          this.exclusions.push([f.x, f.z, 6]);
        }
        const cng = P.cngAuto();
        for (let k = 0; k < 3; k++) {
          const f = this.frame(u + 16 + k * 3.4, -(ROAD_HALF + SHOULDER + 1.3));
          this._addMesh(cng.geo, f.x, f.e - 0.05, f.z, f.yaw + 0.35);
        }
        for (let k = 0; k < 7; k++) {
          const f = this.frame(8 + rand() * 70, (rand() < 0.5 ? -1 : 1) * (ROAD_HALF + SHOULDER + 2 + rand() * 3));
          this._addPerson(f.x, f.z, rand() * Math.PI * 2, rand);
        }
      } else {
        // Hill village: stilt houses on both sides around the stop.
        let placed = 0;
        for (let attempt = 0; attempt < 40 && placed < 6; attempt++) {
          const side = rand() < 0.5 ? -1 : 1;
          if (this._tryHouse(u + (rand() - 0.45) * 110, side * (FLAT + 4 + rand() * 12), rand)) placed++;
        }
      }

      if (stop.waterfall) this._buildWaterfall(u);
      if (stop.final) this._buildNilgiri(stop);
    }

    // A few lone houses along the way.
    for (let k = 0; k < 16; k++) {
      const u = 120 + rand() * (this.length - 300);
      if (this.stops.some((s) => Math.abs(s.u - u) < 90)) continue;
      this._tryHouse(u, (rand() < 0.5 ? -1 : 1) * (FLAT + 5 + rand() * 14), rand);
    }
  }

  _buildWaterfall(u) {
    // Hang the falls on whichever side the hill rises steeply beside the road.
    let best = null;
    for (const side of [1, -1]) {
      for (let d = FLAT + 2; d < 70; d += 2) {
        const f = this.frame(u + 18, side * d);
        const h = this.terrainAt(f.x, f.z);
        if (h > f.e + 14) {
          if (!best || d < best.d) best = { d, side, h, e: f.e };
          break;
        }
      }
    }
    if (!best) return;
    const { side } = best;
    const base = best.e - 0.5;
    const height = Math.min(best.h, best.e + 24) - base;
    const tex = P.canvasTexture(64, 256, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const r = mulberry32(3);
      for (let k = 0; k < 140; k++) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.6})`;
        ctx.fillRect(r() * w, r() * h, 2 + r() * 4, 10 + r() * 40);
      }
    });
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, height / 8);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, color: 0xe8f4ff });
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(4.5, height), mat);
    const back = this.frame(u + 18, side * (best.d - 1.5));
    fall.position.set(back.x, base + height / 2, back.z);
    fall.rotation.y = Math.atan2(-side * back.rx, -side * back.rz);
    this.scene.add(fall);
    const pf = this.frame(u + 18, side * (best.d - 4));
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 18),
      new THREE.MeshPhongMaterial({ color: 0x5f8f96, shininess: 80, transparent: true, opacity: 0.9 })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(pf.x, Math.max(this.terrainAt(pf.x, pf.z), base) + 0.15, pf.z);
    this.scene.add(pool);
    this.exclusions.push([pf.x, pf.z, 7]);
    this.animated.push((dt) => {
      tex.offset.y -= dt * 0.9;
    });
  }

  _buildNilgiri(stop) {
    const u = stop.u;
    // Welcome arch over the road.
    const af = this.frame(u - 45, 0);
    const arch = new THREE.Group();
    const stone = new THREE.MeshLambertMaterial({ color: 0xd9d2c3 });
    for (const x of [-6.2, 6.2]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1, 7, 1), stone);
      p.position.set(x, 3.5, 0);
      p.castShadow = true;
      arch.add(p);
    }
    const tex = P.canvasTexture(1024, 160, (ctx, w, h) => {
      ctx.fillStyle = "#0f6b3c";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#c8102e";
      ctx.fillRect(0, h - 16, w, 16);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      P.fitText(ctx, "নীলগিরিতে স্বাগতম  ·  Welcome to Nilgiri", w / 2, h * 0.62, w * 0.94, 72);
    }, this.maxAniso);
    const face = new THREE.MeshLambertMaterial({ map: tex });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(13.4, 2.0, 0.6), [stone, stone, stone, stone, face, face]);
    beam.position.y = 7.6;
    beam.castShadow = true;
    arch.add(beam);
    arch.position.set(af.x, af.e, af.z);
    arch.rotation.y = af.yaw + Math.PI;
    this.scene.add(arch);

    // Hilltop cottages and visitors.
    const rand = this.rand;
    let placed = 0;
    for (let attempt = 0; attempt < 40 && placed < 5; attempt++) {
      const side = rand() < 0.5 ? -1 : 1;
      if (this._tryHouse(u - 30 + rand() * 70, side * (FLAT + 3 + rand() * 10), rand)) placed++;
    }
    for (let k = 0; k < 5; k++) {
      const pf = this.frame(u + 6 + k * 1.4, STOP_SIDE - 1);
      this._addPerson(pf.x, pf.z, rand() * Math.PI * 2, rand);
    }
  }

  /* ============================== Vegetation ============================== */

  _buildVegetation() {
    const rand = mulberry32(2024);
    const TILE = 650;
    const tiles = Math.ceil((HALF * 2) / TILE);
    const nearRoad = (lim) => (x, z, f, d) => d < lim || this._nearVillage(x, z);
    const types = [
      { geo: P.treeBroadleaf(), mat: P.MAT.solid, count: 2300, minRoad: 16, scale: [0.8, 1.35], shadow: true, test: (x, z, f) => f > -0.35 },
      { geo: P.treeGarjan(), mat: P.MAT.solid, count: 420, minRoad: 22, scale: [0.85, 1.25], shadow: true, test: (x, z, f) => f > 0 },
      { geo: P.bambooClump(), mat: P.MAT.solid, count: 420, minRoad: 13, scale: [0.8, 1.2], shadow: true, test: (x, z, f, d) => d < 160 },
      { geo: P.bananaPlant(), mat: P.MAT.leaves, count: 650, minRoad: 10.5, scale: [0.8, 1.3], shadow: false, test: nearRoad(90) },
      { geo: P.arecaPalm(), mat: P.MAT.leaves, count: 380, minRoad: 12, scale: [0.85, 1.2], shadow: false, test: nearRoad(110) },
      { geo: P.shrub(), mat: P.MAT.solid, count: 2000, minRoad: 9, scale: [0.6, 1.5], shadow: false, test: () => true },
    ];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, "YXZ");
    const v = new THREE.Vector3();
    const sv = new THREE.Vector3();
    const c = new THREE.Color();

    for (const type of types) {
      const buckets = new Map();
      let placed = 0;
      for (let attempt = 0; attempt < type.count * 6 && placed < type.count; attempt++) {
        const x = (rand() * 2 - 1) * (HALF - 20);
        const z = (rand() * 2 - 1) * (HALF - 20);
        const d = this.roadDist(x, z);
        if (d < type.minRoad) continue;
        const h = this.terrainAt(x, z);
        if (h < WATER_Y + 0.8) continue;
        const slope = Math.hypot(this.terrainAt(x + 2, z) - this.terrainAt(x - 2, z), this.terrainAt(x, z + 2) - this.terrainAt(x, z - 2)) / 4;
        if (slope > 1.15) continue;
        const forest = fbm(this.noiseC, x / 250 + 40, z / 250, 3);
        if (!type.test(x, z, forest, d)) continue;
        if (this._blocked(x, z, 1.5)) continue;
        const s = lerp(type.scale[0], type.scale[1], rand());
        e.set((rand() - 0.5) * 0.12, rand() * Math.PI * 2, (rand() - 0.5) * 0.12);
        q.setFromEuler(e);
        m.compose(v.set(x, h - 0.25, z), q, sv.set(s, s * lerp(0.9, 1.15, rand()), s));
        const b = lerp(0.82, 1.15, rand());
        c.setRGB(b * lerp(0.92, 1.08, rand()), b, b * lerp(0.88, 1.05, rand()));
        const key = Math.floor((x + HALF) / TILE) * tiles + Math.floor((z + HALF) / TILE);
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = []));
        bucket.push([m.clone(), c.clone()]);
        placed++;
      }
      // One instanced mesh per tile, so tiles out of view are skipped entirely.
      for (const bucket of buckets.values()) {
        const mesh = new THREE.InstancedMesh(type.geo, type.mat, bucket.length);
        bucket.forEach(([mm, cc], k) => {
          mesh.setMatrixAt(k, mm);
          mesh.setColorAt(k, cc);
        });
        mesh.castShadow = type.shadow;
        mesh.computeBoundingSphere();
        this.scene.add(mesh);
      }
    }
  }

  _nearVillage(x, z) {
    return this.exclusions.some(([ex, ez]) => (ex - x) ** 2 + (ez - z) ** 2 < 45 * 45);
  }

  /* =========================== Sky, lake, lights =========================== */

  _buildEnvironment() {
    const scene = this.scene;
    scene.fog = new THREE.FogExp2(HORIZON, 0.00062);
    scene.background = HORIZON.clone();

    // Sky dome with a soft sun glow.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(4000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: ZENITH },
          horizon: { value: HORIZON },
          sunDir: { value: SUN_DIR },
          sunColor: { value: new THREE.Color("#fff3d6") },
        },
        vertexShader: `
          varying vec3 vWorld;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor;
          varying vec3 vWorld;
          void main() {
            vec3 d = normalize(vWorld - cameraPosition);
            float h = max(d.y, 0.0);
            vec3 col = mix(horizon, top, pow(h, 0.5));
            float s = max(dot(d, sunDir), 0.0);
            col += sunColor * (pow(s, 900.0) * 2.0 + pow(s, 12.0) * 0.22);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      })
    );
    sky.renderOrder = -1;
    this.sky = sky;
    scene.add(sky);

    // Distant ranges fading into the haze.
    const layers = [
      { r: 1950, base: 120, amp: 170, color: "#5c7d6c", seed: 1 },
      { r: 2400, base: 170, amp: 230, color: "#7f9c98", seed: 2 },
      { r: 3000, base: 240, amp: 300, color: "#a3b9bc", seed: 3 },
    ];
    for (const L of layers) {
      const nz = createNoise2D(L.seed * 101);
      const pos = [];
      const segs = 240;
      for (let k = 0; k <= segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        const top = L.base + L.amp * (0.5 + 0.5 * fbm(nz, Math.cos(a) * 3, Math.sin(a) * 3, 4));
        pos.push(Math.cos(a) * L.r, top, Math.sin(a) * L.r, Math.cos(a) * L.r, -200, Math.sin(a) * L.r);
      }
      const idx = [];
      for (let k = 0; k < segs; k++) {
        const a = k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: L.color, fog: false, side: THREE.DoubleSide })));
    }

    // Clouds.
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9aa7ad, fog: false, flatShading: true });
    const cr = mulberry32(11);
    for (let k = 0; k < 16; k++) {
      const a = cr() * Math.PI * 2;
      const r = 900 + cr() * 1700;
      const geo = P.merge(Array.from({ length: 5 }, (_, j) =>
        P.part(P.UNIT.ico, "#ffffff", { x: (j - 2) * 38 + cr() * 20, y: cr() * 14, z: cr() * 30, s: 30 + cr() * 22, sy: 0.55 })
      ));
      const cloud = new THREE.Mesh(geo, cloudMat);
      cloud.position.set(Math.cos(a) * r, 380 + cr() * 220, Math.sin(a) * r);
      cloud.rotation.y = cr() * Math.PI;
      scene.add(cloud);
    }

    // The lake, with a few country boats bobbing on it.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF * 2, HALF * 2),
      new THREE.MeshPhongMaterial({ color: 0x3f6f6c, specular: 0xbfd6d6, shininess: 70, transparent: true, opacity: 0.92 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_Y;
    water.receiveShadow = true;
    scene.add(water);
    const boatGeo = P.countryBoat();
    const br = mulberry32(17);
    let boats = 0;
    for (let k = 0; k < 600 && boats < 5; k++) {
      const x = -470 + (br() - 0.5) * 560;
      const z = 880 + (br() - 0.5) * 460;
      if (this.terrainAt(x, z) > WATER_Y - 2 || this.roadDist(x, z) < 25) continue;
      const boat = this._addMesh(boatGeo, x, WATER_Y - 0.05, z, br() * Math.PI * 2);
      const phase = br() * 10;
      this.animated.push((dt, t) => {
        boat.position.y = WATER_Y - 0.05 + Math.sin(t * 1.3 + phase) * 0.06;
        boat.rotation.z = Math.sin(t * 0.9 + phase) * 0.03;
      });
      boats++;
    }

    // Light: soft sky fill + a warm afternoon sun whose shadow box follows the action.
    scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x55663a, 1.25));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -75;
    sc.right = 75;
    sc.top = 75;
    sc.bottom = -75;
    sc.near = 10;
    sc.far = 500;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.4;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;
  }

  update(dt, t, focus, camera) {
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 260);
    this.sun.target.position.copy(focus);
    this.sky.position.copy(camera.position);
    for (const fn of this.animated) fn(dt, t);
  }
}

function hashKey(cx, cz) {
  return (cx + 4096) * 8192 + (cz + 4096);
}

function boxBlur(a, r) {
  const n = a.length;
  const src = Float32Array.from(a);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += src[clamp(i, 0, n - 1)];
  for (let i = 0; i < n; i++) {
    a[i] = sum / (2 * r + 1);
    sum += src[clamp(i + r + 1, 0, n - 1)] - src[clamp(i - r, 0, n - 1)];
  }
}

function gradeLimit(e, maxStep) {
  for (let i = 1; i < e.length; i++) e[i] = clamp(e[i], e[i - 1] - maxStep, e[i - 1] + maxStep);
  for (let i = e.length - 2; i >= 0; i--) e[i] = clamp(e[i], e[i + 1] - maxStep, e[i + 1] + maxStep);
}

function dilate(a, r) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) out[k] = 1;
  }
  return out;
}

function cleanRuns(a, minLen) {
  let start = -1;
  for (let i = 0; i <= a.length; i++) {
    if (i < a.length && a[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start < minLen) for (let k = start; k < i; k++) a[k] = 0;
      start = -1;
    }
  }
  return a;
}
