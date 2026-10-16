import * as THREE from 'three';
import type { Track } from './track';
import { THEMES, type Theme } from './tracks';

const GROUND_SIZE = 1000;
const GRASS_TILE = 10; // metres per grass texture tile

/** Tileable ground for a theme: a noisy base colour plus short blades (grass) or specks (snow, rock), drawn wrapped so edges tile. */
export function makeGroundTexture(theme: Theme): THREE.CanvasTexture {
  const style = THEMES[theme].ground;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const weights = style.blade ? [0.6, 1, 0.5] : [1, 1, 1];
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * style.noise;
    img.data[i * 4] = style.base[0] + n * weights[0];
    img.data[i * 4 + 1] = style.base[1] + n * weights[1];
    img.data[i * 4 + 2] = style.base[2] + n * weights[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  ctx.lineCap = 'round';
  const marks = style.blade ? 1800 : 900;
  for (let i = 0; i < marks; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
    const len = style.blade ? 3 + Math.random() * 5 : 1 + Math.random() * 3;
    ctx.strokeStyle = style.fleck[Math.min(style.fleck.length - 1, Math.floor(Math.random() * style.fleck.length))];
    ctx.lineWidth = 1 + Math.random() * (style.blade ? 1 : 1.5);
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GROUND_SIZE / GRASS_TILE, GROUND_SIZE / GRASS_TILE);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Give a mesh UVs from world position, using the same mapping as the ground plane, so the grass
 * on road shoulders and embankments lines up with the grass around them.
 */
export function applyGroundUVs(mesh: THREE.Mesh): void {
  const pos = mesh.geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + GROUND_SIZE / 2) / GROUND_SIZE;
    uv[i * 2 + 1] = (GROUND_SIZE / 2 - pos.getZ(i)) / GROUND_SIZE;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Small deterministic PRNG so the forest looks the same on every load. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Low-poly trees scattered around the circuit, never closer than `clearance` metres to the
 * road centreline (plus the embankment width on raised sections), so they stay clear of the barriers. One InstancedMesh per part.
 */
export function createTrees(track: Track, clearance = 16.5): THREE.Group {
  const style = THEMES[track.def.theme].trees;
  const count = style.count;
  const rand = mulberry32(20260714);
  const group = new THREE.Group();

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { p } of track.samples) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const spread = 110;

  // Choose positions: away from the road, and not stacked on each other.
  const spots: { x: number; z: number; pine: boolean; scale: number; rot: number }[] = [];
  for (let attempts = 0; spots.length < count && attempts < count * 40; attempts++) {
    const x = minX - spread + rand() * (maxX - minX + spread * 2);
    const z = minZ - spread + rand() * (maxZ - minZ + spread * 2);
    // Raised road sections have a 45 degree embankment as wide as they are high; keep clear of that too.
    let blocked = false;
    for (const { p } of track.samples) {
      const need = clearance + p.y;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < need * need) { blocked = true; break; }
    }
    if (blocked) continue;
    if (spots.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 16)) continue;
    spots.push({ x, z, pine: rand() < style.pineShare, scale: 0.8 + rand() * 0.9, rot: rand() * Math.PI * 2 });
  }

  const pines = spots.filter((s) => s.pine);
  const rounds = spots.filter((s) => !s.pine);

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1.7, 6);
  trunkGeo.translate(0, 0.85, 0);
  const pineLow = new THREE.ConeGeometry(2.1, 3.0, 7);
  pineLow.translate(0, 1.5 + 1.5, 0);
  const pineHigh = new THREE.ConeGeometry(1.5, 2.6, 7);
  pineHigh.translate(0, 3.4 + 1.3, 0);
  const crown = new THREE.IcosahedronGeometry(1.9, 0);
  crown.translate(0, 3.5, 0);

  const flat = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const trunkMat = flat(0x6b4a2f);
  const leafMat = flat(0xffffff); // tinted per instance

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const place = (mesh: THREE.InstancedMesh, list: typeof spots, hueShift: number) => {
    list.forEach((s, i) => {
      dummy.position.set(s.x, -0.05, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.scale, s.scale * (0.9 + rand() * 0.3), s.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tint.setHSL(style.hue + hueShift + (rand() - 0.5) * 0.06, style.saturation + rand() * 0.2, style.lightness + rand() * 0.1);
      mesh.setColorAt(i, tint);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  };
  const trunks = (list: typeof spots) => {
    const mesh = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    list.forEach((s, i) => {
      dummy.position.set(s.x, -0.05, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.scale, s.scale, s.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  };

  trunks(spots);
  place(new THREE.InstancedMesh(pineLow, leafMat, pines.length), pines, -0.02);
  place(new THREE.InstancedMesh(pineHigh, leafMat, pines.length), pines, -0.02);
  place(new THREE.InstancedMesh(crown, leafMat, rounds.length), rounds, 0.03);
  return group;
}
