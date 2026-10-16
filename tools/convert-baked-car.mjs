// Converter for textured Sketchfab cars (the Toyota AE86, the Toyota Hilux and the low-poly Jeep): the car's texture colours are baked per
// triangle into plain per-colour materials, so there are no textures to ship and the body paint can be tinted.
//   node tools/convert-baked-car.mjs <input folder> <output .glb> <ae86|hilux|jeep>
// The input folder holds scene.gltf, scene.bin and the textures decoded to raw RGB (see TEXTURES in each profile).
// Triangles the profile calls paint become one material called Paint (the game tints it). The wheels are cut out into
// Wheel_FL/FR/RL/RR objects with their origin at the hub, the ground plane is dropped, and the car is scaled to 4.2 m
// (nose +Z, up +Y, standing on the ground).
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

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

const PROFILES = {
  // One 256 x 256 palette texture; the light panels of the main body shell are the paint.
  ae86: {
    nose: '+z',
    skip: (mesh) => mesh.parent.name === 'Plane008', // the flat ground plane
    textures: { Body: { file: 'palette.rgb', size: 256 } },
    isPaint: (mesh, rgb) => mesh.parent.name === 'Plane' && Math.min(...rgb) >= 0xd0,
    wheelOf: (mesh, box, centre) => (Math.abs(centre.x) > 2.8 && box.max.y < 2.7 && mesh.parent.name !== 'Plane' ? wheelName(centre) : null),
  },
  // The paint is the flat dark area of the body texture; the wheels are four Cylinder meshes. The model's nose is -Z.
  hilux: {
    nose: '-z',
    textures: { Material_126: { file: 'Material_126.rgb', size: 2048 }, Material_128: { file: 'Material_128.rgb', size: 1024 } },
    isPaint: (mesh, rgb) => /^Box01_Material/.test(mesh.name) && Math.max(...rgb) <= 0x30 && Math.max(...rgb) - Math.min(...rgb) < 12,
    wheelOf: (mesh, box, centre) => (/^Cylinder0[2567]_/.test(mesh.name) ? wheelName(centre) : null),
  },
  // The whole model is turned about the up axis (yaw); the texture is one atlas whose red parts are the paint and whose
  // paler pink parts are panels too; the four wheels are one mesh, told apart by where they are.
  jeep: {
    nose: process.env.JEEP_NOSE ?? '+z',
    yaw: -Math.atan2(0.8, 1.48),
    textures: { 'Material.009': { file: 'base.rgba', size: 1024, channels: 4 }, 'Material.000': { file: 'base.rgba', size: 1024, channels: 4 }, 'Material.003': { file: 'base.rgba', size: 1024, channels: 4 } },
    isPaint: (mesh, rgb) => rgb[0] > 1.06 * rgb[1] && rgb[0] > 1.06 * rgb[2] && rgb[0] > 60, // red and the paler pink panels
    wheelOf: (mesh) => (mesh.name === 'Object_8' ? 'split' : null),
  },
};
const wheelName = (centre) => (centre.z > 0 ? 'F' : 'R') + (centre.x > 0 ? 'L' : 'R'); // +X is the car's left, the nose is +Z

const [, , inputDir, outputFile, profileName = 'ae86'] = process.argv;
const profile = PROFILES[profileName];
const textures = {};
for (const [material, { file, size, channels = 3 }] of Object.entries(profile.textures)) textures[material] = { data: fs.readFileSync(path.join(inputDir, file)), size, channels };
const json = JSON.parse(fs.readFileSync(path.join(inputDir, 'scene.gltf'), 'utf8'));
const factors = Object.fromEntries(json.materials.map((m) => [m.name, m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]]));
// The texture is replaced by baked colours, so the loader does not need it (or the spec/gloss extension).
delete json.images;
delete json.textures;
delete json.samplers;
for (const m of json.materials) {
  delete m.extensions;
  delete m.pbrMetallicRoughness;
  delete m.normalTexture;
  delete m.occlusionTexture;
  delete m.emissiveTexture;
}
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
const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), '');
gltf.scene.updateMatrixWorld(true);

// The colour of a triangle: from its material's texture at the triangle's centre (the texture repeats), else the
// material's base colour. Returned as sRGB bytes plus alpha.
const linearToByte = (c) => Math.round(new THREE.Color().setRGB(c, c, c, THREE.LinearSRGBColorSpace).getRGB(new THREE.Color(), THREE.SRGBColorSpace).r * 255);
const colourOf = (materialName, u, v) => {
  const texture = textures[materialName];
  const factor = factors[materialName];
  if (!texture) return { rgb: factor.slice(0, 3).map(linearToByte), alpha: factor[3] };
  const wrap = (x) => x - Math.floor(x);
  const x = Math.min(texture.size - 1, Math.floor(wrap(u) * texture.size));
  const y = Math.min(texture.size - 1, Math.floor(wrap(v) * texture.size));
  const q = (y * texture.size + x) * texture.channels;
  return { rgb: [texture.data[q], texture.data[q + 1], texture.data[q + 2]], alpha: texture.channels === 4 ? texture.data[q + 3] / 255 : 1 };
};
const flip = profile.nose === '-z'; // turn the car half way round about the up axis so the nose points to +Z

// Each triangle: world-space corners and normals, a palette colour, and which wheel (or none) it belongs to.
const tris = [];
let inverted = 0; // triangles whose winding disagrees with their normals
const wheelBoxes = { FL: new THREE.Box3(), FR: new THREE.Box3(), RL: new THREE.Box3(), RR: new THREE.Box3() };
const p = new THREE.Vector3();
const yaw = profile.yaw ?? 0;
const orient = (v) => {
  if (yaw) v.set(v.x * Math.cos(yaw) + v.z * Math.sin(yaw), v.y, -v.x * Math.sin(yaw) + v.z * Math.cos(yaw));
  return flip ? v.set(-v.x, v.y, -v.z) : v;
};
gltf.scene.traverse((object) => {
  if (!object.isMesh) return;
  const geo = object.geometry;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const index = geo.index;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
  const mirrored = object.matrixWorld.determinant() < 0; // a mirrored node turns the triangles inside out once baked
  const worldPoints = [];
  for (let i = 0; i < pos.count; i++) worldPoints.push(orient(p.fromBufferAttribute(pos, i).applyMatrix4(object.matrixWorld).clone()));
  const box = new THREE.Box3().setFromPoints(worldPoints);
  if (profile.skip?.(object)) return;
  const centre = box.getCenter(new THREE.Vector3());
  const meshWheel = profile.wheelOf(object, box, centre);
  const count = (index ? index.count : pos.count) / 3;
  for (let t = 0; t < count; t++) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
    if (mirrored) ids.reverse();
    const { rgb, alpha } = colourOf(object.material.name, ids.reduce((s, i) => s + (uv ? uv.getX(i) : 0), 0) / 3, ids.reduce((s, i) => s + (uv ? uv.getY(i) : 0), 0) / 3);
    const corners = ids.map((i) => worldPoints[i].clone());
    const wheel = meshWheel === 'split' ? wheelName(corners[0].clone().add(corners[1]).add(corners[2]).multiplyScalar(1 / 3).sub(centre)) : meshWheel;
    const normals = ids.map((i) => orient(new THREE.Vector3().fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize()));
    const face = new THREE.Vector3().crossVectors(corners[1].clone().sub(corners[0]), corners[2].clone().sub(corners[0]));
    if (face.dot(normals[0].clone().add(normals[1]).add(normals[2])) < 0) inverted++;
    tris.push({ corners, normals, rgb, alpha, wheel, paint: profile.isPaint(object, rgb, alpha) });
    if (wheel) for (const c of corners) wheelBoxes[wheel].expandByPoint(c);
  }
});

// Scale to 4.2 m, centre it and stand it on the ground.
const all = new THREE.Box3();
for (const t of tris) for (const c of t.corners) all.expandByPoint(c);
const size = all.getSize(new THREE.Vector3());
const scale = 4.2 / size.z;
const centre = all.getCenter(new THREE.Vector3());
const shift = new THREE.Vector3(-centre.x, -all.min.y, -centre.z);
const place = (v) => v.add(shift).multiplyScalar(scale);
for (const t of tris) t.corners.forEach(place);
const hubs = {};
for (const [name, box] of Object.entries(wheelBoxes)) {
  place(box.min);
  place(box.max);
  // The wheel's own box also holds the brake hardware: take the hub from the tyre's height and length instead.
  hubs[name] = box.getCenter(new THREE.Vector3());
  console.log(name, 'hub', hubs[name].toArray().map((x) => x.toFixed(3)), 'size', box.getSize(new THREE.Vector3()).toArray().map((x) => x.toFixed(3)));
}
console.log('inverted triangles', inverted);
if (process.env.PREVIEW) fs.writeFileSync(process.env.PREVIEW, JSON.stringify(tris.map((t) => ({ c: t.corners.map((v) => v.toArray()), rgb: t.rgb, paint: t.paint, wheel: t.wheel, a: t.alpha }))));
console.log('size', size.toArray().map((x) => (x * scale).toFixed(3)), 'scale', scale.toFixed(4), 'triangles', tris.length);

// One material per colour (3 bits per channel), plus Paint.
const materials = new Map();
const materialFor = (t) => {
  const key = t.paint ? 'Paint' : `${t.rgb.map((c) => (c >> 5).toString(8)).join('')}_${t.alpha < 1 ? 'glass' : 'solid'}`;
  if (!materials.has(key)) {
    const colour = t.paint ? new THREE.Color(1, 1, 1) : new THREE.Color().setRGB(...t.rgb.map((c) => (c >> 5) / 7), THREE.SRGBColorSpace);
    materials.set(key, new THREE.MeshStandardMaterial({ name: t.paint ? 'Paint' : `Trim_${key}`, color: colour, roughness: t.paint ? 0.35 : 0.65, metalness: 0.1, transparent: !t.paint && t.alpha < 1, opacity: t.paint ? 1 : t.alpha }));
  }
  return materials.get(key);
};
const buildGroup = (list, offset, name) => {
  const group = new THREE.Group();
  group.name = name;
  const byMaterial = new Map();
  for (const t of list) {
    const material = materialFor(t);
    if (!byMaterial.has(material)) byMaterial.set(material, { positions: [], normals: [] });
    const part = byMaterial.get(material);
    t.corners.forEach((c, k) => {
      part.positions.push(c.x - offset.x, c.y - offset.y, c.z - offset.z);
      part.normals.push(t.normals[k].x, t.normals[k].y, t.normals[k].z);
    });
  }
  for (const [material, part] of byMaterial) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals, 3));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material.name;
    group.add(mesh);
  }
  return group;
};

const root = new THREE.Group();
root.add(buildGroup(tris.filter((t) => !t.wheel), new THREE.Vector3(), 'Body'));
for (const name of ['FL', 'FR', 'RL', 'RR']) {
  const wheel = buildGroup(tris.filter((t) => t.wheel === name), hubs[name], `Wheel_${name}`);
  wheel.position.copy(hubs[name]);
  root.add(wheel);
}
const result = await new GLTFExporter().parseAsync(root, { binary: true });
fs.writeFileSync(outputFile, Buffer.from(result));
console.log('wrote', outputFile, result.byteLength, 'bytes,', materials.size, 'materials');
