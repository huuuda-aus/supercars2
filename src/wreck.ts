import * as THREE from 'three';

const PUFFS = 10;
const PUFF_LIFE = 2.4; // seconds a smoke puff takes to rise and fade

export interface Wreck {
  group: THREE.Group;
  /** Animate smoke and embers. */
  update(dt: number): void;
}

/** Shove every vertex by a hash of its own position, so shared corners move together and the mesh stays closed. */
function crumple(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const noise = (k: number) => {
    const s = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = x * 12.9 + y * 78.2 + z * 37.7;
    pos.setXYZ(i, x + noise(k) * amount, y + noise(k + 1) * amount, z + noise(k + 2) * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Burnt-out, low-poly car hulk (dark grey and black) with a plume of smoke and a few glowing embers. */
export function buildWreck(): Wreck {
  const group = new THREE.Group();
  const flat = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true });
  const charred = flat(0x2b2c2f);
  const soot = flat(0x111112);
  const ash = flat(0x3c3d41);

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    group.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, amount: number, seed: number) =>
    crumple(new THREE.BoxGeometry(w, h, d, 2, 1, 3), amount, seed);

  // Sagging chassis, buckled hood, caved-in cabin and a collapsed rear.
  add(box(1.92, 0.5, 4.2, 0.12, 1), charred, 0, 0.5, 0, 0, 0, 0.03);
  add(box(1.8, 0.16, 1.5, 0.14, 2), soot, 0, 0.82, 1.35, -0.12, 0, 0.05);
  add(box(1.55, 0.42, 1.7, 0.16, 3), soot, 0, 0.98, -0.25, 0.04, 0, -0.06);
  add(box(1.5, 0.1, 1.5, 0.12, 4), ash, 0, 1.2, -0.3, 0.1, 0, -0.1);
  add(box(1.8, 0.2, 0.9, 0.1, 5), charred, 0, 0.75, -1.65, 0.15, 0, 0);
  // Bare, blackened wheels; the front-left one has torn off and lies beside the car.
  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 7).rotateZ(Math.PI / 2);
  for (const [x, z, tilt] of [[1, 1.35, 0.08], [-1, -1.35, -0.1], [1, -1.35, 0.05]] as const) {
    add(wheelGeo, soot, x * 0.74, 0.34, z, 0, 0, tilt);
  }
  add(wheelGeo, soot, -1.9, 0.14, 1.6, 0.1, 0, Math.PI / 2 - 0.2);
  // Debris.
  add(box(0.7, 0.05, 0.5, 0.08, 6), ash, 1.5, 0.05, -2.3, 0, 0.6, 0.05);
  add(box(0.5, 0.05, 0.9, 0.08, 7), soot, -1.4, 0.05, -1.2, 0, -0.4, -0.04);

  // Embers glowing in the engine bay.
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff5a1a });
  const embers = [[-0.35, 0.95, 1.4], [0.4, 0.92, 1.2], [0.05, 0.9, 1.9]].map(([x, y, z]) => {
    const e = add(new THREE.IcosahedronGeometry(0.16, 0), emberMat, x, y, z);
    e.userData.noShadow = true;
    return e;
  });

  // Smoke: a pool of dark puffs that rise from the engine bay, swell and fade, then start over.
  const puffGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const puffs = Array.from({ length: PUFFS }, (_, i) => {
    const material = new THREE.MeshBasicMaterial({ color: 0x2a2a2d, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(puffGeo, material);
    mesh.userData.noShadow = true;
    group.add(mesh);
    return { mesh, material, age: (i / PUFFS) * PUFF_LIFE, drift: [0, 0] as [number, number] };
  });
  const rerollDrift = (p: (typeof puffs)[number]) => {
    p.drift = [(Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6];
  };
  puffs.forEach(rerollDrift);

  let time = 0;
  return {
    group,
    update(dt: number): void {
      time += dt;
      embers.forEach((e, i) => e.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(time * 7 + i * 2.1))));
      for (const p of puffs) {
        p.age += dt;
        if (p.age >= PUFF_LIFE) {
          p.age -= PUFF_LIFE;
          rerollDrift(p);
        }
        const t = p.age / PUFF_LIFE;
        p.mesh.position.set(p.drift[0] * t + 0.1, 1.1 + t * 3.8, 1.3 + p.drift[1] * t);
        p.mesh.scale.setScalar(0.7 + t * 2.2);
        p.mesh.rotation.y = time * 0.5 + p.age;
        p.material.opacity = 0.6 * (1 - t) * Math.min(1, t * 6);
        p.material.color.setScalar(0.12 + 0.2 * t); // fresh smoke is black, thins to grey
      }
    },
  };
}
