import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WHEEL_R, WHEEL_X, WHEEL_Z } from './spec';

export type CarStyle = 'coupe' | 'sedan' | 'hatch' | 'beetle' | 'jeep';

export interface CarModel {
  group: THREE.Group;
  /** Groups the front wheels sit in; rotate about y to steer. */
  frontPivots: THREE.Group[];
  /** Objects that roll with the wheels; rotate about x. */
  spinners: THREE.Object3D[];
  /** Exhaust flames, shown while the nitro burns. */
  flames: THREE.Object3D[];
}

const BELT = 0.94; // beltline height: where the painted body ends and the glass begins
const BODY_WIDTH = 1.9;
const CABIN_WIDTH = 1.56;

interface StyleSpec {
  /** Greenhouse outline in (z, y): front-base, rear-base, rear-top, front-top (more points for a rounded roof). */
  cabin: [number, number][];
  spoiler: boolean;
  lowNose: number;
  /** Upper silhouette of the lower body from the front bumper to the tail, (z, y); the default is a plain saloon line. */
  top?: [number, number][];
  /** Cabin is painted body colour with separate windows, not one glass block (a rounded roof). */
  paintedCabin?: boolean;
  roundLights?: boolean;
  /** Bulging separate wheel arches over the wheels (an old-fashioned fender line). */
  fenders?: boolean;
  /** Boxy off-roader parts: black bumpers and flares, slatted grille, spare wheel on the tail. */
  offroad?: boolean;
}

const STYLES: Record<CarStyle, StyleSpec> = {
  // Low fastback with a big rear wing.
  coupe: { cabin: [[0.95, BELT], [-1.55, BELT], [-0.55, 1.3], [0.3, 1.31]], spoiler: true, lowNose: 0 },
  // Upright three-box saloon.
  sedan: { cabin: [[0.95, BELT], [-1.3, BELT], [-0.85, 1.4], [0.35, 1.42]], spoiler: false, lowNose: 0.02 },
  // Short hatchback with a tall tail (a Corolla-style five-door).
  hatch: { cabin: [[0.95, BELT], [-1.8, BELT], [-1.5, 1.47], [0.4, 1.49]], spoiler: false, lowNose: 0.04 },
  // Rounded bug: short sloping bonnet and tail, a domed painted roof, bulging fenders, round bulb headlights.
  beetle: {
    cabin: [[0.85, 1.05], [-1.35, 1.05], [-1.25, 1.36], [-0.8, 1.68], [-0.1, 1.77], [0.45, 1.62], [0.75, 1.3]],
    spoiler: false,
    lowNose: 0,
    top: [[2.14, 0.5], [2.08, 0.76], [1.75, 0.95], [1.25, 1.03], [0.9, 1.05], [-1.2, 1.05], [-1.8, 0.95], [-2.1, 0.76], [-2.14, 0.5]],
    paintedCabin: true,
    roundLights: true,
    fenders: true,
  },
  // Square-rigged off-roader: flat bonnet, upright windscreen, slab sides, round lights, spare wheel.
  jeep: {
    cabin: [[0.85, 1.02], [-1.9, 1.05], [-1.9, 1.8], [0.68, 1.84]],
    spoiler: false,
    lowNose: 0,
    top: [[2.14, 0.5], [2.14, 1.0], [0.85, 1.02], [-1.9, 1.05], [-2.14, 1.0], [-2.14, 0.5]],
    roundLights: true,
    offroad: true,
  },
};

/** Side silhouette of the lower body (z along the car, y up) with wheel arch cut-outs, extruded across the car. */
function buildBody(style: CarStyle): THREE.BufferGeometry {
  const floor = 0.3;
  const archR = WHEEL_R + 0.1;
  const dy = floor - WHEEL_R;
  const a = Math.asin(-dy / archR);
  const half = Math.sqrt(archR * archR - dy * dy);
  const nose = STYLES[style].lowNose;

  const s = new THREE.Shape();
  s.moveTo(-2.1, floor);
  for (const cz of [-WHEEL_Z, WHEEL_Z]) {
    s.lineTo(cz - half, floor);
    s.absarc(cz, WHEEL_R, archR, Math.PI + a, -a, true); // over the top of the wheel
  }
  s.lineTo(2.1, floor);
  const top: [number, number][] = STYLES[style].top ?? [[2.12, 0.52], [2.05, 0.7 - nose], [1.4, 0.86 - nose], [0.95, BELT], [-1.3, BELT], [-2.0, 0.93], [-2.12, 0.62]];
  for (const [z, y] of top) s.lineTo(z, y);
  s.closePath();

  const depth = BODY_WIDTH - 0.1;
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 2, curveSegments: 12 });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2); // shape x -> car z (forward), extrusion -> car x (sideways)
  geo.computeVertexNormals();
  return geo;
}

function buildCabin(style: CarStyle): THREE.BufferGeometry {
  const s = new THREE.Shape(STYLES[style].cabin.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = CABIN_WIDTH - 0.06;
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

function buildWheel(rimColor: number): THREE.Group {
  const wheel = new THREE.Group();
  const axisX = (g: THREE.BufferGeometry) => g.rotateZ(Math.PI / 2);
  const tyre = new THREE.Mesh(
    axisX(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 24)),
    new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.95 }),
  );
  const rim = new THREE.Mesh(
    axisX(new THREE.CylinderGeometry(WHEEL_R * 0.68, WHEEL_R * 0.68, 0.29, 20)),
    new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.35, metalness: 0.5 }),
  );
  const dish = new THREE.Mesh(
    axisX(new THREE.CylinderGeometry(WHEEL_R * 0.44, WHEEL_R * 0.44, 0.3, 16)),
    new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 }),
  );
  const hub = new THREE.Mesh(
    axisX(new THREE.CylinderGeometry(0.06, 0.06, 0.32, 10)),
    new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.3, metalness: 0.6 }),
  );
  wheel.add(tyre, rim, dish, hub);
  // Five spokes so the rolling wheel reads as rotating.
  const spokeMat = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.35, metalness: 0.5 });
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.07, WHEEL_R * 0.62), spokeMat);
    spoke.position.set(0, 0, 0);
    const holder = new THREE.Group();
    holder.rotation.x = (i / 5) * Math.PI * 2;
    spoke.position.z = WHEEL_R * 0.3;
    holder.add(spoke);
    wheel.add(holder);
  }
  return wheel;
}

/** Procedural car: painted body with wheel arches, glass cabin, lights, grille, mirrors, rolling wheels. */
export function buildCarModel(color: number, style: CarStyle): CarModel {
  const custom = templates.get(style);
  if (custom) return instantiateModel(custom, color);
  const group = new THREE.Group();
  const frontPivots: THREE.Group[] = [];
  const spinners: THREE.Object3D[] = [];
  const flames: THREE.Object3D[] = [];

  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.15, clearcoat: 0.7, clearcoatRoughness: 0.25 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2b3a, roughness: 0.12, metalness: 0.3 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1c4, emissiveIntensity: 1.6, roughness: 0.2 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0x7a0000, emissive: 0xff1010, emissiveIntensity: 1.4, roughness: 0.3 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

  const spec = STYLES[style];

  // Body and cabin.
  group.add(new THREE.Mesh(buildBody(style), paint));
  group.add(new THREE.Mesh(buildCabin(style), spec.paintedCabin ? paint : glass));

  if (spec.paintedCabin) {
    // A painted dome with window panes set into its sides, windscreen and tail.
    for (const sx of [-1, 1]) add(box(0.03, 0.3, 1.05), glass, sx * (CABIN_WIDTH / 2 - 0.04), 1.4, -0.2);
    add(box(1.1, 0.3, 0.03), glass, 0, 1.43, 0.66).rotation.x = -0.62;
    add(box(0.9, 0.22, 0.03), glass, 0, 1.38, -1.18).rotation.x = 0.55;
  } else {
    // Roof panel in body colour, following the roof's slope.
    const [, , rearTop, frontTop] = spec.cabin;
    const roofLen = frontTop[0] - rearTop[0] - 0.12;
    const roof = add(box(CABIN_WIDTH - 0.02, 0.06, roofLen), paint, 0, (rearTop[1] + frontTop[1]) / 2 + 0.02, (rearTop[0] + frontTop[0]) / 2);
    roof.rotation.x = -Math.atan2(frontTop[1] - rearTop[1], frontTop[0] - rearTop[0]);
  }

  // Front end: lights, grille, intake and splitter.
  const noseY = 0.7 - spec.lowNose;
  for (const sx of [-1, 1]) {
    if (spec.roundLights && spec.offroad) {
      add(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 16).rotateX(Math.PI / 2), headlight, sx * 0.62, 0.8, 2.12);
      add(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 16).rotateX(Math.PI / 2), trim, sx * 0.62, 0.8, 2.09);
    } else if (spec.roundLights) {
      // Bulb lights standing proud on the fender tops.
      add(new THREE.SphereGeometry(0.2, 14, 10).scale(1, 1, 0.8), headlight, sx * 0.68, 0.98, 1.82);
    } else {
      add(box(0.36, 0.1, 0.07), headlight, sx * 0.62, noseY - 0.02, 2.06);
    }
    add(box(0.42, 0.09, 0.06), taillight, sx * 0.62, spec.offroad ? 0.85 : 0.78, spec.offroad ? -2.16 : -2.1);
  }
  if (spec.offroad) {
    // Black bumpers front and back, slatted grille, fender flares and a spare wheel on the tail.
    add(box(2.0, 0.22, 0.28), trim, 0, 0.42, 2.18);
    add(box(2.0, 0.22, 0.28), trim, 0, 0.42, -2.18);
    add(box(0.74, 0.4, 0.05), trim, 0, 0.8, 2.15);
    for (let i = -3; i <= 3; i++) add(box(0.05, 0.36, 0.03), paint, i * 0.1, 0.8, 2.18);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box(0.2, 0.08, 1.05), trim, sx * 0.97, 0.88, sz * WHEEL_Z);
    const spare = add(new THREE.CylinderGeometry(0.42, 0.42, 0.26, 18).rotateX(Math.PI / 2), trim, 0, 1.1, -2.42);
    spare.castShadow = true;
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.28, 12).rotateX(Math.PI / 2), paint, 0, 1.1, -2.42);
  } else if (spec.fenders) {
    // Bulging fenders over each wheel.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.SphereGeometry(0.62, 14, 10).scale(0.38, 0.75, 1.55), paint, sx * 0.84, 0.72, sz * WHEEL_Z);
  } else {
    add(box(0.7, 0.1, 0.05), trim, 0, noseY - 0.1, 2.1);
    add(box(1.3, 0.12, 0.06), trim, 0, 0.42, 2.11);
    add(box(1.78, 0.04, 0.3), trim, 0, 0.3, 1.98);
    add(box(1.8, 0.05, 0.12), trim, 0, 0.68, -2.1); // rear diffuser strip
  }
  // Side skirts and door seams.
  for (const sx of [-1, 1]) {
    add(box(0.05, 0.08, 2.0), trim, sx * 0.93, 0.34, 0);
    for (const z of [0.2, -0.75]) add(box(0.012, 0.4, 0.012), trim, sx * 0.953, 0.72, z);
    // Wing mirror.
    add(box(0.14, 0.09, 0.13), paint, sx * 0.97, spec.paintedCabin || spec.offroad ? 1.14 : 1.02, 0.7);
  }
  // Dark wheel wells so the arches read as depth, not as a see-through gap.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const well = new THREE.CylinderGeometry(WHEEL_R + 0.03, WHEEL_R + 0.03, 0.5, 18);
      well.rotateZ(Math.PI / 2);
      add(well, trim, sx * (WHEEL_X - 0.12), WHEEL_R, sz * WHEEL_Z);
    }
  }

  if (spec.spoiler) {
    add(box(1.6, 0.05, 0.3), paint, 0, 1.2, -1.95);
    for (const sx of [-1, 1]) add(box(0.06, 0.2, 0.2), trim, sx * 0.55, 1.08, -1.95);
  }

  // Wheels.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = buildWheel(0xc9ccd2);
      spinners.push(wheel);
      if (sz > 0) {
        const pivot = new THREE.Group();
        pivot.position.set(sx * WHEEL_X, WHEEL_R, sz * WHEEL_Z);
        pivot.add(wheel);
        frontPivots.push(pivot);
        group.add(pivot);
      } else {
        wheel.position.set(sx * WHEEL_X, WHEEL_R, sz * WHEEL_Z);
        group.add(wheel);
      }
    }
  }
  // Nitro flames out of two exhausts at the back: a blue outer cone with a bright core.
  for (const sx of [-1, 1]) {
    const flame = new THREE.Group();
    const outer = new THREE.Mesh(
      new THREE.ConeGeometry(0.24, 2.2, 10).rotateX(-Math.PI / 2).translate(0, 0, -1.1),
      new THREE.MeshBasicMaterial({ color: 0x3f9bff, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    const core = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 1.3, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.65),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false }),
    );
    flame.add(outer, core);
    flame.position.set(sx * 0.4, 0.45, -2.15);
    flame.visible = false;
    group.add(flame);
    flames.push(flame);
  }
  return { group, frontPivots, spinners, flames };
}

// --- Models made in Blender (or any glTF tool) ----------------------------------------------------------------
//
// A file named public/models/<style>.glb replaces the procedural model of that style (beetle, jeep, hatch, coupe,
// sedan). docs/replacing-car-models.md says how to make one. Styles with no file keep the procedural model.

const templates = new Map<CarStyle, THREE.Group>();
const CAR_LENGTH = 4.2; // metres: a loaded model is scaled so its nose-to-tail length is this
const STYLE_NAMES: CarStyle[] = ['coupe', 'sedan', 'hatch', 'beetle', 'jeep'];
const WHEEL_NODES = { Wheel_FL: [true, true], Wheel_FR: [true, true], Wheel_RL: [false, true], Wheel_RR: [false, true] } as const;

/**
 * Look for public/models/<style>.glb for every style and load the ones that exist. Call once, before any car is
 * built. Returns the styles that were replaced. A missing or broken file is skipped (with a warning), never fatal.
 */
export async function loadCustomCarModels(): Promise<CarStyle[]> {
  const loaded: CarStyle[] = [];
  const loader = new GLTFLoader();
  await Promise.all(
    STYLE_NAMES.map(async (style) => {
      try {
        const response = await fetch(`models/${style}.glb`);
        if (!response.ok) return;
        const data = await response.arrayBuffer();
        // A dev server answers an unknown path with its index page: only a real binary glTF starts with "glTF".
        if (data.byteLength < 12 || new DataView(data).getUint32(0, true) !== 0x46546c67) return;
        const gltf = await loader.parseAsync(data, '');
        registerCarModel(style, gltf.scene);
        loaded.push(style);
      } catch (error) {
        console.warn(`models/${style}.glb could not be used:`, error);
      }
    }),
  );
  if (loaded.length) console.info('Custom car models loaded:', loaded.join(', '));
  return loaded;
}

/** Use a loaded glTF scene as the model for a style (what loadCustomCarModels does for each file it finds). */
export function registerCarModel(style: CarStyle, scene: THREE.Group): void {
  templates.set(style, normaliseModel(scene, style));
}

/** Scale a model to the car's length, centre it between the wheels and stand it on the ground (y = 0). */
function normaliseModel(scene: THREE.Group, style: CarStyle): THREE.Group {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const scale = size.z > 0 ? CAR_LENGTH / size.z : 1;
  if (Math.abs(scale - 1) > 0.15) console.warn(`models/${style}.glb is ${size.z.toFixed(2)} m long: scaled by ${scale.toFixed(2)} to ${CAR_LENGTH} m. Check the units and the nose direction (+Z).`);
  const holder = new THREE.Group();
  holder.add(scene);
  scene.scale.multiplyScalar(scale);
  const fitted = new THREE.Box3().setFromObject(holder);
  const centre = fitted.getCenter(new THREE.Vector3());
  scene.position.set(-centre.x, -fitted.min.y, -centre.z);
  holder.name = `custom-${style}`;
  return holder;
}

/** Make a car from a loaded model: its own copy, the paint material tinted, wheels and flames hooked up. */
function instantiateModel(template: THREE.Group, color: number): CarModel {
  const group = template.clone(true);
  const frontPivots: THREE.Group[] = [];
  const spinners: THREE.Object3D[] = [];
  const flames: THREE.Object3D[] = [];
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // Each car gets its own materials, so painting one does not repaint the rest.
    const own = (m: THREE.Material) => {
      const copy = m.clone();
      if (/^paint|^body/i.test(copy.name) && 'color' in copy) (copy as THREE.MeshStandardMaterial).color.set(color);
      return copy;
    };
    object.material = Array.isArray(object.material) ? object.material.map(own) : own(object.material);
  });
  for (const [name, [front]] of Object.entries(WHEEL_NODES)) {
    const wheel = group.getObjectByName(name);
    if (!wheel || !wheel.parent) {
      console.warn(`The model has no node called ${name}: that wheel will not turn.`);
      continue;
    }
    spinners.push(wheel);
    if (front) {
      // Steering turns a pivot at the wheel's centre; the wheel inside it keeps rolling.
      const pivot = new THREE.Group();
      pivot.position.copy(wheel.position);
      pivot.quaternion.copy(wheel.quaternion);
      wheel.parent.add(pivot);
      pivot.add(wheel);
      wheel.position.set(0, 0, 0);
      wheel.quaternion.identity();
      frontPivots.push(pivot);
    }
  }
  for (const name of ['Flame_L', 'Flame_R']) {
    const flame = group.getObjectByName(name);
    if (flame) {
      flame.visible = false;
      flames.push(flame);
    }
  }
  return { group, frontPivots, spinners, flames };
}
