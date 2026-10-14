import * as THREE from 'three';
import { WHEEL_R, WHEEL_X, WHEEL_Z } from './spec';

export type CarStyle = 'coupe' | 'sedan' | 'hatch';

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

/** Greenhouse outline in (z, y), front-base, rear-base, rear-top, front-top, plus per-style extras. */
const STYLES: Record<CarStyle, { cabin: [number, number][]; spoiler: boolean; lowNose: number }> = {
  // Low fastback with a big rear wing.
  coupe: { cabin: [[0.95, BELT], [-1.55, BELT], [-0.55, 1.3], [0.3, 1.31]], spoiler: true, lowNose: 0 },
  // Upright three-box saloon.
  sedan: { cabin: [[0.95, BELT], [-1.3, BELT], [-0.85, 1.4], [0.35, 1.42]], spoiler: false, lowNose: 0.02 },
  // Short hatchback with a tall tail.
  hatch: { cabin: [[0.95, BELT], [-1.8, BELT], [-1.5, 1.47], [0.4, 1.49]], spoiler: false, lowNose: 0.04 },
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
  s.lineTo(2.12, 0.52);
  s.lineTo(2.05, 0.7 - nose);
  s.lineTo(1.4, 0.86 - nose);
  s.lineTo(0.95, BELT);
  s.lineTo(-1.3, BELT);
  s.lineTo(-2.0, 0.93);
  s.lineTo(-2.12, 0.62);
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

  // Body and cabin.
  group.add(new THREE.Mesh(buildBody(style), paint));
  group.add(new THREE.Mesh(buildCabin(style), glass));

  // Roof panel in body colour, following the roof's slope.
  const [, , rearTop, frontTop] = STYLES[style].cabin;
  const roofLen = frontTop[0] - rearTop[0] - 0.12;
  const roof = add(box(CABIN_WIDTH - 0.02, 0.06, roofLen), paint, 0, (rearTop[1] + frontTop[1]) / 2 + 0.02, (rearTop[0] + frontTop[0]) / 2);
  roof.rotation.x = -Math.atan2(frontTop[1] - rearTop[1], frontTop[0] - rearTop[0]);

  // Front end: lights, grille, intake and splitter.
  const noseY = 0.7 - STYLES[style].lowNose;
  for (const sx of [-1, 1]) {
    add(box(0.36, 0.1, 0.07), headlight, sx * 0.62, noseY - 0.02, 2.06);
    add(box(0.42, 0.09, 0.06), taillight, sx * 0.62, 0.78, -2.1);
  }
  add(box(0.7, 0.1, 0.05), trim, 0, noseY - 0.1, 2.1);
  add(box(1.3, 0.12, 0.06), trim, 0, 0.42, 2.11);
  add(box(1.78, 0.04, 0.3), trim, 0, 0.3, 1.98);
  add(box(1.8, 0.05, 0.12), trim, 0, 0.68, -2.1); // rear diffuser strip
  // Side skirts and door seams.
  for (const sx of [-1, 1]) {
    add(box(0.05, 0.08, 2.0), trim, sx * 0.93, 0.34, 0);
    for (const z of [0.2, -0.75]) add(box(0.012, 0.4, 0.012), trim, sx * 0.953, 0.72, z);
    // Wing mirror.
    add(box(0.14, 0.09, 0.13), paint, sx * 0.97, 1.02, 0.7);
  }
  // Dark wheel wells so the arches read as depth, not as a see-through gap.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const well = new THREE.CylinderGeometry(WHEEL_R + 0.03, WHEEL_R + 0.03, 0.5, 18);
      well.rotateZ(Math.PI / 2);
      add(well, trim, sx * (WHEEL_X - 0.12), WHEEL_R, sz * WHEEL_Z);
    }
  }

  if (STYLES[style].spoiler) {
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
