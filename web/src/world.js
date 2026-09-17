import * as THREE from "../vendor/three.module.js";

export const CORRIDOR_HALF_WIDTH = 26;
export const FLIGHT_MIN_Y = 2;
export const FLIGHT_MAX_Y = 34;
export const FALL_Y = -22; // dropping below this = "you fell"
export const SIDE_LIMIT = 42; // drifting past this on X = "flew off the map"

const CHUNK_LENGTH = 70;
const CHUNKS_AHEAD = 6;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2d36, metalness: 0.2, roughness: 0.8 });
const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1e2027, metalness: 0.3, roughness: 0.7 });
const edgeMat = new THREE.MeshStandardMaterial({
  color: 0xff5a1f,
  emissive: 0xff5a1f,
  emissiveIntensity: 1.4,
});
const ringMat = new THREE.MeshStandardMaterial({
  color: 0x23e0c7,
  emissive: 0x23e0c7,
  emissiveIntensity: 1.6,
  metalness: 0.2,
  roughness: 0.3,
});

export class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map(); // chunkIndex -> { group, obstacles: [] }
    this.rings = [];
    this.pillars = [];
    this.walls = [];
    this._farthestChunk = -1;
  }

  reset() {
    for (const { group } of this.chunks.values()) {
      this.scene.remove(group);
      disposeGroup(group);
    }
    this.chunks.clear();
    this.rings = [];
    this.pillars = [];
    this.walls = [];
    this._farthestChunk = -1;
    this._ensureChunksAhead(0);
  }

  update(carZ) {
    this._ensureChunksAhead(carZ);
    this._cullBehind(carZ);
  }

  _ensureChunksAhead(carZ) {
    const currentChunk = Math.floor(-carZ / CHUNK_LENGTH);
    const target = currentChunk + CHUNKS_AHEAD;
    for (let i = Math.max(0, this._farthestChunk + 1); i <= target; i++) {
      this._spawnChunk(i);
      this._farthestChunk = i;
    }
  }

  _cullBehind(carZ) {
    const currentChunk = Math.floor(-carZ / CHUNK_LENGTH);
    for (const [idx, entry] of this.chunks) {
      if (idx < currentChunk - 2) {
        this.scene.remove(entry.group);
        disposeGroup(entry.group);
        this.chunks.delete(idx);
        this.rings = this.rings.filter((r) => r.chunk !== idx);
        this.pillars = this.pillars.filter((p) => p.chunk !== idx);
        this.walls = this.walls.filter((w) => w.chunk !== idx);
      }
    }
  }

  _spawnChunk(index) {
    const rand = mulberry32(index * 7919 + 1337);
    const group = new THREE.Group();
    const zStart = -index * CHUNK_LENGTH;
    const difficulty = Math.min(1, index / 18); // ramps up over ~18 chunks

    // Chunk 0 is a safe runway — no obstacles, just space to get airborne.
    if (index > 0) {
      const obstacleCount = 2 + Math.floor(difficulty * 4 + rand() * 2);
      for (let i = 0; i < obstacleCount; i++) {
        const z = zStart - (i / obstacleCount) * CHUNK_LENGTH - rand() * 8 - 6;
        const roll = rand();
        if (roll < 0.4) {
          this._addPillar(group, index, z, rand, difficulty);
        } else if (roll < 0.7) {
          this._addGateWall(group, index, z, rand, difficulty);
        } else {
          this._addBoostRing(group, index, z, rand);
        }
      }
    } else {
      // Always give the player one early boost ring to teach the mechanic.
      this._addBoostRing(group, index, zStart - 30, rand);
    }

    // Ground marker strip far below for depth/void cue (purely visual).
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(SIDE_LIMIT * 2.4, CHUNK_LENGTH),
      new THREE.MeshBasicMaterial({ color: 0x0d0e12 })
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, FALL_Y - 4, zStart - CHUNK_LENGTH / 2);
    group.add(strip);

    const grid = new THREE.GridHelper(SIDE_LIMIT * 2.4, 24, 0x2a2d36, 0x1a1c22);
    grid.position.set(0, FALL_Y - 3.9, zStart - CHUNK_LENGTH / 2);
    group.add(grid);

    this.scene.add(group);
    this.chunks.set(index, { group });
  }

  _addPillar(group, chunkIdx, z, rand, difficulty) {
    const radius = 1.4 + rand() * (1.6 - difficulty * 0.6);
    const x = (rand() * 2 - 1) * (CORRIDOR_HALF_WIDTH - radius - 2);
    const yBase = FLIGHT_MIN_Y - 6;
    const height = FLIGHT_MAX_Y - yBase + 6 + rand() * 6;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.05, height, 10), pillarMat);
    mesh.position.set(x, yBase + height / 2, z);
    group.add(mesh);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius + 0.06, 0.05, 6, 16), edgeMat);
    ring.position.set(x, yBase + height - 2, z);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    this.pillars.push({ chunk: chunkIdx, x, z, radius, yMin: yBase, yMax: yBase + height });
  }

  _addGateWall(group, chunkIdx, z, rand, difficulty) {
    const gapW = 8 - difficulty * 2.5 + rand() * 2;
    const gapH = 8 - difficulty * 2 + rand() * 2;
    const gapX = (rand() * 2 - 1) * (CORRIDOR_HALF_WIDTH - gapW);
    const gapY = FLIGHT_MIN_Y + 3 + rand() * (FLIGHT_MAX_Y - FLIGHT_MIN_Y - gapH - 3);
    const wallHeight = FLIGHT_MAX_Y + 10;
    const wallWidth = CORRIDOR_HALF_WIDTH * 2 + 6;
    const thickness = 1.2;

    const bars = [];
    // left bar
    const leftW = gapX - gapW / 2 + wallWidth / 2;
    bars.push({ w: leftW, h: wallHeight, x: -wallWidth / 2 + leftW / 2, y: wallHeight / 2 - 6 });
    // right bar
    const rightStart = gapX + gapW / 2;
    const rightW = wallWidth / 2 - rightStart;
    bars.push({ w: rightW, h: wallHeight, x: rightStart + rightW / 2, y: wallHeight / 2 - 6 });
    // bottom bar (within gap column)
    const bottomH = gapY - (-6);
    bars.push({ w: gapW, h: bottomH, x: gapX, y: -6 + bottomH / 2 });
    // top bar (within gap column)
    const topStart = gapY + gapH;
    const topH = wallHeight - 6 - topStart;
    bars.push({ w: gapW, h: topH, x: gapX, y: topStart + topH / 2 });

    for (const b of bars) {
      if (b.w <= 0.05 || b.h <= 0.05) continue;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, thickness), wallMat);
      mesh.position.set(b.x, b.y, z);
      group.add(mesh);
    }

    // glowing frame around the gap so it reads clearly at speed
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.08, 4, 4), edgeMat);
    const frameOutline = new THREE.EdgesGeometry(new THREE.BoxGeometry(gapW, gapH, 0.1));
    const outlineMesh = new THREE.LineSegments(frameOutline, new THREE.LineBasicMaterial({ color: 0xff5a1f }));
    outlineMesh.position.set(gapX, gapY + gapH / 2, z);
    group.add(outlineMesh);
    frame.visible = false;
    group.add(frame);

    this.walls.push({
      chunk: chunkIdx,
      z,
      thickness,
      gapX,
      gapY,
      gapW,
      gapH,
      wallWidth,
      wallHeight,
    });
  }

  _addBoostRing(group, chunkIdx, z, rand) {
    const x = (rand() * 2 - 1) * (CORRIDOR_HALF_WIDTH - 4);
    const y = FLIGHT_MIN_Y + 4 + rand() * (FLIGHT_MAX_Y - FLIGHT_MIN_Y - 8);
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.28, 10, 24), ringMat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    const ringData = { chunk: chunkIdx, x, y, z, radius: 2.6, mesh, collected: false };
    this.rings.push(ringData);
  }

  /**
   * Checks the car (treated as a sphere) against all nearby obstacles.
   * Returns { crashed, boosted } — boosted rings are consumed and hidden.
   */
  checkCollisions(carPos, carRadius) {
    let crashed = false;
    let boosted = false;

    for (const p of this.pillars) {
      if (Math.abs(p.z - carPos.z) > 6) continue;
      const dx = carPos.x - p.x;
      const dz = carPos.z - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < p.radius + carRadius && carPos.y > p.yMin && carPos.y < p.yMax) {
        crashed = true;
      }
    }

    for (const w of this.walls) {
      if (Math.abs(w.z - carPos.z) > w.thickness / 2 + carRadius) continue;
      const insideGapX = Math.abs(carPos.x - w.gapX) < w.gapW / 2 - carRadius * 0.3;
      const insideGapY = carPos.y > w.gapY + carRadius * 0.3 && carPos.y < w.gapY + w.gapH - carRadius * 0.3;
      if (!(insideGapX && insideGapY)) {
        crashed = true;
      }
    }

    for (const r of this.rings) {
      if (r.collected) continue;
      if (Math.abs(r.z - carPos.z) > 4) continue;
      const dx = carPos.x - r.x;
      const dy = carPos.y - r.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < r.radius) {
        r.collected = true;
        r.mesh.visible = false;
        boosted = true;
      }
    }

    return { crashed, boosted };
  }
}

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
    }
  });
}
