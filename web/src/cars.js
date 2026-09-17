import * as THREE from "../vendor/three.module.js";

// Stats are normalized 0..1 and drive both the physics model and the UI bars.
// Heavier / more powerful cars are harder to dodge with (bigger hitbox, slower
// turning, fall faster) — that's the "heavy powerful" trade-off the game is built around.
export const CARS = [
  {
    id: "titan",
    name: "TITAN",
    color: 0xff5a1f,
    trim: 0x1a1a1a,
    desc: "Full steel plating. Brutal acceleration, falls like a stone the moment you let off the thrusters.",
    stats: { power: 0.95, mass: 0.95, handling: 0.25, lift: 0.35 },
    scale: 1.25,
  },
  {
    id: "viper",
    name: "VIPER",
    color: 0x23e0c7,
    trim: 0x0d0d0d,
    desc: "Stripped-down racer. Light, nimble, easy to thread through gaps — but it can't take a hit.",
    stats: { power: 0.55, mass: 0.3, handling: 0.9, lift: 0.7 },
    scale: 0.85,
  },
  {
    id: "hammerhead",
    name: "HAMMERHEAD",
    color: 0xffd23f,
    trim: 0x1a1a1a,
    desc: "Balanced all-rounder. No weakness, no standout strength — built for consistency.",
    stats: { power: 0.65, mass: 0.6, handling: 0.6, lift: 0.55 },
    scale: 1.0,
  },
  {
    id: "ghost",
    name: "GHOST",
    color: 0xb46bff,
    trim: 0x14141a,
    desc: "Thruster-heavy glider frame. Hovers beautifully, but has almost nothing in reserve for straight-line power.",
    stats: { power: 0.4, mass: 0.2, handling: 0.7, lift: 0.95 },
    scale: 0.8,
  },
  {
    id: "juggernaut",
    name: "JUGGERNAUT",
    color: 0xff3b6b,
    trim: 0x1a1a1a,
    desc: "Maximum mass, maximum power. The biggest hitbox in the field — dodge with extreme care.",
    stats: { power: 1.0, mass: 1.0, handling: 0.15, lift: 0.3 },
    scale: 1.4,
  },
];

/**
 * Builds a minimalist low-poly car mesh from primitives.
 * Returns a THREE.Group with a `.collisionRadius` sized off the car's scale.
 */
export function buildCarMesh(carDef) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: carDef.color,
    metalness: 0.4,
    roughness: 0.35,
    emissive: carDef.color,
    emissiveIntensity: 0.08,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: carDef.trim,
    metalness: 0.6,
    roughness: 0.4,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: carDef.color,
    emissive: carDef.color,
    emissiveIntensity: 2.0,
    metalness: 0,
    roughness: 1,
  });

  // Lower chassis
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.32, 3.2), bodyMat);
  chassis.position.y = 0.28;
  group.add(chassis);

  // Upper cabin (wedge via scaled box for a low-poly "sliced" look)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.42, 1.5), trimMat);
  cabin.position.set(0, 0.62, -0.15);
  cabin.rotation.x = -0.05;
  group.add(cabin);

  // Nose — two stepped-down boxes taper the front of the chassis into a low
  // blunt wedge. Plain boxes keep the silhouette unambiguous at any angle,
  // which matters more for readability here than a true pointed taper.
  const noseA = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.24, 0.9), bodyMat);
  noseA.position.set(0, 0.22, -1.75);
  group.add(noseA);
  const noseB = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 0.5), bodyMat);
  noseB.position.set(0, 0.16, -2.25);
  group.add(noseB);

  // Side thruster pods
  [-1, 1].forEach((side) => {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.4, 8), trimMat);
    pod.rotation.z = Math.PI / 2;
    pod.position.set(side * 0.95, 0.28, 0.4);
    group.add(pod);

    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8), glowMat);
    glow.rotation.z = Math.PI / 2;
    glow.position.set(side * 0.95, 0.28, 1.12);
    group.add(glow);
    group.userData["thruster_" + side] = glow;
  });

  // Rear main thruster
  const rearGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.08, 10), glowMat);
  rearGlow.rotation.x = Math.PI / 2;
  rearGlow.position.set(0, 0.28, 1.65);
  group.add(rearGlow);
  group.userData.thrusterRear = rearGlow;

  // Underglow strip (lift indicator)
  const underGlow = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.04, 2.6), glowMat);
  underGlow.position.set(0, 0.1, 0);
  group.add(underGlow);
  group.userData.underGlow = underGlow;

  group.scale.setScalar(carDef.scale);
  group.userData.collisionRadius = 1.15 * carDef.scale;
  group.castShadow = true;
  group.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });

  return group;
}
