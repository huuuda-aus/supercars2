// Converter for Sketchfab-style cars -> a static glTF binary the game can use. Handles two layouts: a skinned car whose
// wheels are bones (the Alpine) and a plain one whose wheels are nodes named FL_Wheel, FR_Wheel, BL_Wheel, BR_Wheel (the Lada).
//   node tools/convert-car.mjs <input folder with scene.gltf + its .bin> <output .glb> [nose axis, default +z] [up axis, default +y]
// It bakes the rest pose into plain meshes, cuts the wheel triangles out into Wheel_FL/FR/RL/RR objects (origin at the hub,
// axle along X), turns the car so the nose points to +Z with +Y up, and writes a binary glTF with no skins.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter wants a browser FileReader.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

const [, , inputDir, outputFile] = process.argv;
// Pack scene.gltf + scene.bin into one binary glTF in memory so the loader needs no file access.
const json = JSON.parse(fs.readFileSync(path.join(inputDir, 'scene.gltf'), 'utf8'));
const bin = fs.readFileSync(path.join(inputDir, json.buffers[0].uri));
delete json.buffers[0].uri;
const pad = (buffer, byte) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, byte)]);
const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
const binChunk = pad(bin, 0);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(length, 0);
  h.writeUInt32LE(type, 4);
  return h;
};
const glb = Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]);
const arrayBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length);
const loader = new GLTFLoader();
const gltf = await loader.parseAsync(arrayBuffer, '');
const scene = gltf.scene;
scene.updateMatrixWorld(true);

// The loader strips dots from node names, so F_wheel.L_4 arrives as F_wheelL_4.
const WHEEL_BONES = new Proxy({}, {
  get: (_, name) => ({ F_wheelL_4: 'FL', F_wheelR_5: 'FR', B_wheelL_6: 'RL', B_wheelR_7: 'RR' })[name],
});
const WHEEL_NODES = { FL_Wheel: 'FL', FR_Wheel: 'FR', BL_Wheel: 'RL', BR_Wheel: 'RR' };

// Bake every mesh into world-space triangle soup, tagged with the wheel it belongs to (or null).
const parts = []; // { material, positions[], normals[], wheel }
const v = new THREE.Vector3();
const n = new THREE.Vector3();
scene.traverse((object) => {
  if (!object.isMesh) return;
  const geo = object.geometry;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const index = geo.index;
  const skinned = object.isSkinnedMesh;
  const bones = skinned ? object.skeleton.bones : null;
  const dominant = (i) => {
    const w = geo.getAttribute('skinWeight');
    const j = geo.getAttribute('skinIndex');
    let best = -1;
    let bestW = 0;
    for (let k = 0; k < 4; k++) {
      const weight = [w.getX, w.getY, w.getZ, w.getW][k].call(w, i);
      if (weight > bestW) {
        bestW = weight;
        best = [j.getX, j.getY, j.getZ, j.getW][k].call(j, i);
      }
    }
    return bones[best]?.name;
  };
  const world = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  object.updateMatrixWorld(true);
  world.copy(object.matrixWorld);
  normalMatrix.getNormalMatrix(world);
  const vertexWorld = [];
  const normalWorld = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    if (skinned) {
      object.applyBoneTransform(i, v);
      const tip = new THREE.Vector3().fromBufferAttribute(pos, i).addScaledVector(n, 0.01);
      object.applyBoneTransform(i, tip);
      n.copy(tip).sub(v).normalize();
    }
    vertexWorld.push(v.clone().applyMatrix4(world));
    normalWorld.push(n.clone().applyMatrix3(normalMatrix).normalize());
  }
  // A mesh that hangs under a wheel node belongs to that wheel as a whole.
  let wheelOfNode = null;
  for (let o = object.parent; o && !wheelOfNode; o = o.parent) wheelOfNode = WHEEL_NODES[o.name] ?? null;
  const triCount = (index ? index.count : pos.count) / 3;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
  for (const group of groups) {
    const material = materials[group.materialIndex ?? 0];
    const buckets = new Map();
    for (let t = group.start; t < group.start + group.count; t += 3) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
      let wheel = wheelOfNode;
      if (skinned) {
        const votes = ids.map(dominant).filter((name) => WHEEL_BONES[name]);
        if (votes.length >= 2) wheel = WHEEL_BONES[votes[0]];
      }
      if (!buckets.has(wheel)) buckets.set(wheel, { material, positions: [], normals: [], wheel });
      const bucket = buckets.get(wheel);
      for (const id of ids) {
        bucket.positions.push(vertexWorld[id].x, vertexWorld[id].y, vertexWorld[id].z);
        bucket.normals.push(normalWorld[id].x, normalWorld[id].y, normalWorld[id].z);
      }
    }
    parts.push(...buckets.values());
  }
});

// Orientation: find the nose. Front wheels are the ones that sit further from the car's middle along its long axis.
const all = new THREE.Box3();
for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) all.expandByPoint(v.set(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
const size = all.getSize(new THREE.Vector3());
console.log('baked size', size.toArray().map((x) => x.toFixed(3)), 'min', all.min.toArray().map((x) => x.toFixed(3)));
const hubs = {};
for (const name of ['FL', 'FR', 'RL', 'RR']) {
  const box = new THREE.Box3();
  for (const p of parts.filter((q) => q.wheel === name)) for (let i = 0; i < p.positions.length; i += 3) box.expandByPoint(v.set(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
  hubs[name] = box.getCenter(new THREE.Vector3());
  console.log(name, 'hub', hubs[name].toArray().map((x) => x.toFixed(3)), 'size', box.getSize(new THREE.Vector3()).toArray().map((x) => x.toFixed(3)));
}

// Build the output rotation from the options: which world axis is the nose, which is up.
const noseAxis = process.argv[4] ?? '+z';
const upAxis = process.argv[5] ?? '+y';
const axis = (s) => new THREE.Vector3(s[1] === 'x' ? 1 : 0, s[1] === 'y' ? 1 : 0, s[1] === 'z' ? 1 : 0).multiplyScalar(s[0] === '-' ? -1 : 1);
const nose = axis(noseAxis);
const up = axis(upAxis);
const side = new THREE.Vector3().crossVectors(up, nose); // +X of the result (three: x = y cross z)
const rotation = new THREE.Matrix4().makeBasis(side, up, nose).transpose(); // world -> car
const apply = (p) => {
  for (let i = 0; i < p.positions.length; i += 3) {
    v.set(p.positions[i], p.positions[i + 1], p.positions[i + 2]).applyMatrix4(rotation);
    p.positions[i] = v.x;
    p.positions[i + 1] = v.y;
    p.positions[i + 2] = v.z;
    n.set(p.normals[i], p.normals[i + 1], p.normals[i + 2]).transformDirection(rotation);
    p.normals[i] = n.x;
    p.normals[i + 1] = n.y;
    p.normals[i + 2] = n.z;
  }
};
parts.forEach(apply);
for (const k of Object.keys(hubs)) hubs[k].applyMatrix4(rotation);
console.log('after rotation hubs', Object.fromEntries(Object.entries(hubs).map(([k, h]) => [k, h.toArray().map((x) => +x.toFixed(3))])));

// Assemble: body meshes merged per material; each wheel an object at its hub with geometry relative to it.
const root = new THREE.Group();
const meshFor = (list, offset) => {
  const byMaterial = new Map();
  for (const p of list) {
    if (!byMaterial.has(p.material)) byMaterial.set(p.material, []);
    byMaterial.get(p.material).push(p);
  }
  const out = [];
  for (const [material, group] of byMaterial) {
    const positions = [];
    const normals = [];
    for (const p of group) {
      for (let i = 0; i < p.positions.length; i += 3) {
        positions.push(p.positions[i] - offset.x, p.positions[i + 1] - offset.y, p.positions[i + 2] - offset.z);
        normals.push(p.normals[i], p.normals[i + 1], p.normals[i + 2]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material.name;
    out.push(mesh);
  }
  return out;
};
const body = new THREE.Group();
body.name = 'Body';
meshFor(parts.filter((p) => !p.wheel), new THREE.Vector3()).forEach((m) => body.add(m));
root.add(body);
for (const name of ['FL', 'FR', 'RL', 'RR']) {
  const wheel = new THREE.Group();
  wheel.name = `Wheel_${name}`;
  wheel.position.copy(hubs[name]);
  meshFor(parts.filter((p) => p.wheel === name), hubs[name]).forEach((m) => wheel.add(m));
  root.add(wheel);
}
// The game has no environment map, so fully metallic materials (the glTF default) would render black: tone them down.
const seen = new Set();
for (const m of root.children.flatMap((c) => [c, ...c.children])) {
  if (!m.material || seen.has(m.material)) continue;
  seen.add(m.material);
  m.material.metalness = Math.min(m.material.metalness, 0.25);
  if (m.material.name === 'CarPaint') m.material.name = 'Paint'; // the game tints materials called Paint
}

const exporter = new GLTFExporter();
const result = await exporter.parseAsync(root, { binary: true });
fs.writeFileSync(outputFile, Buffer.from(result));
console.log('wrote', outputFile, result.byteLength, 'bytes');
