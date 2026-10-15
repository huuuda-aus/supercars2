import * as THREE from 'three';

const DEBRIS_COUNT = 9;
const SMOKE_COUNT = 5;
const CORE_LIFE = 0.22;
const FIRE_LIFE = 0.6;
const RING_LIFE = 0.45;
const DEBRIS_LIFE = 0.85;
const SMOKE_LIFE = 1.4;
const TOTAL_LIFE = Math.max(CORE_LIFE, FIRE_LIFE, RING_LIFE, DEBRIS_LIFE, SMOKE_LIFE);
const GRAVITY = 26;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

interface Debris { mesh: THREE.Mesh; vx: number; vy: number; vz: number; size: number }
interface Puff { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; rise: number; dx: number; dz: number; delay: number }
interface Blast {
  age: number;
  radius: number;
  groundY: number;
  group: THREE.Group;
  core: THREE.Mesh;
  fire: THREE.Mesh;
  ring: THREE.Mesh;
  debris: Debris[];
  puffs: Puff[];
}

/**
 * Explosions made of layers: a quick white core, an orange fireball that cools to red, a shockwave ring lying on the
 * road, glowing debris thrown out in arcs and a few puffs of dark smoke that rise and thin out. Geometry is shared;
 * only the fading materials are per-explosion and disposed when it ends.
 */
export class Explosions {
  readonly group = new THREE.Group();
  private readonly blasts: Blast[] = [];
  private readonly ball = new THREE.IcosahedronGeometry(1, 2);
  private readonly ringGeo = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);
  private readonly chunkGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly debrisMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
  private readonly up = new THREE.Vector3(0, 1, 0);

  /**
   * `radius` is the blast radius (the shockwave ring grows to roughly it). `groundY` is the road height under it and
   * `normal` the road's surface normal, so the ring lies on slopes instead of cutting into them.
   */
  spawn(x: number, y: number, z: number, radius: number, groundY = y, normal?: THREE.Vector3): void {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const additive = (color: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

    const core = new THREE.Mesh(this.ball, additive(0xffffff));
    core.position.y = y;
    const fire = new THREE.Mesh(this.ball, additive(0xffb030));
    fire.position.y = y;
    const ring = new THREE.Mesh(this.ringGeo, additive(0xffd9a0));
    ring.position.y = groundY + 0.12;
    if (normal) ring.quaternion.setFromUnitVectors(this.up, normal);
    group.add(core, fire, ring);

    const debris: Debris[] = [];
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (5 + Math.random() * 7) * (radius / 6.5);
      const mesh = new THREE.Mesh(this.chunkGeo, this.debrisMat);
      mesh.position.set(0, y, 0);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      group.add(mesh);
      debris.push({ mesh, vx: Math.cos(a) * speed, vy: 5 + Math.random() * 6, vz: Math.sin(a) * speed, size: 0.14 + Math.random() * 0.14 });
    }

    const puffs: Puff[] = [];
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const a = (i / SMOKE_COUNT) * Math.PI * 2 + Math.random();
      const material = new THREE.MeshBasicMaterial({ color: 0x2b2b2f, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(this.ball, material);
      mesh.position.set(Math.cos(a) * radius * 0.25, y, Math.sin(a) * radius * 0.25);
      group.add(mesh);
      puffs.push({ mesh, material, rise: 2 + Math.random() * 2.5, dx: Math.cos(a) * 0.5, dz: Math.sin(a) * 0.5, delay: 0.08 + Math.random() * 0.15 });
    }

    for (const m of group.children) m.userData.noShadow = true;
    this.group.add(group);
    this.blasts.push({ age: 0, radius, groundY, group, core, fire, ring, debris, puffs });
  }

  update(dt: number): void {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.age += dt;
      if (b.age >= TOTAL_LIFE) {
        this.dispose(b);
        this.blasts.splice(i, 1);
        continue;
      }
      this.animate(b, dt);
    }
  }

  clear(): void {
    for (const b of this.blasts) this.dispose(b);
    this.blasts.length = 0;
  }

  private animate(b: Blast, dt: number): void {
    const R = b.radius;

    // Core: a bright white flash that swells and vanishes almost at once.
    const tc = clamp01(b.age / CORE_LIFE);
    b.core.visible = tc < 1;
    b.core.scale.setScalar(Math.max(0.01, R * 0.3 * easeOut(tc)));
    (b.core.material as THREE.MeshBasicMaterial).opacity = 1 - tc;

    // Fireball: grows fast then slowly, cooling from yellow-orange to dark red as it fades.
    const tf = clamp01(b.age / FIRE_LIFE);
    b.fire.visible = tf < 1;
    b.fire.scale.setScalar(Math.max(0.01, R * (0.12 + 0.34 * easeOut(tf))));
    const fireMat = b.fire.material as THREE.MeshBasicMaterial;
    fireMat.color.setRGB(1, 0.72 - 0.55 * tf, 0.19 - 0.17 * tf);
    fireMat.opacity = 0.95 * (1 - tf * tf);

    // Shockwave ring on the road.
    const tr = clamp01(b.age / RING_LIFE);
    b.ring.visible = tr < 1;
    b.ring.scale.setScalar(Math.max(0.01, R * 0.95 * easeOut(tr)));
    (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - tr);

    // Debris: ballistic arcs that stop on the road, then shrink away.
    const td = clamp01(b.age / DEBRIS_LIFE);
    for (const d of b.debris) {
      d.vy -= GRAVITY * dt;
      const p = d.mesh.position;
      p.x += d.vx * dt;
      p.z += d.vz * dt;
      p.y += d.vy * dt;
      if (p.y < b.groundY + 0.1) {
        p.y = b.groundY + 0.1;
        d.vx *= 0.6;
        d.vz *= 0.6;
        d.vy = 0;
      }
      d.mesh.rotation.x += dt * 9;
      d.mesh.rotation.z += dt * 7;
      d.mesh.scale.setScalar(Math.max(0.001, d.size * (1 - td * td)));
    }

    // Smoke: dark puffs that rise, swell and thin out.
    for (const s of b.puffs) {
      const ts = clamp01((b.age - s.delay) / SMOKE_LIFE);
      s.mesh.visible = ts > 0 && ts < 1;
      s.mesh.scale.setScalar(Math.max(0.01, R * (0.14 + 0.3 * easeOut(ts))));
      s.mesh.position.y += (s.rise / SMOKE_LIFE) * dt * (1 - ts * 0.6);
      s.mesh.position.x += s.dx * dt;
      s.mesh.position.z += s.dz * dt;
      s.material.opacity = 0.55 * Math.min(1, ts * 6) * (1 - ts);
    }
  }

  private dispose(b: Blast): void {
    this.group.remove(b.group);
    for (const m of [b.core, b.fire, b.ring]) (m.material as THREE.Material).dispose();
    for (const s of b.puffs) s.material.dispose();
  }
}
