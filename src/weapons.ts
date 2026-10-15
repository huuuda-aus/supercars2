import * as THREE from 'three';
import type { Car } from './car';
import { HULL_HX, HULL_HZ } from './spec';
import type { Track } from './track';

const MISSILE_SPEED = 65; // m/s over the ground
const MISSILE_LIFE = 2.2; // seconds
const MISSILE_OWNER_GRACE = 0.35; // the shooter cannot be hit by its own missile right away
const MISSILE_HIT_RADIUS = 1.7;
const MISSILE_BLAST = { radius: 6.5, power: 11, damage: 30, lift: 3 };

const GUN_RATE = 11; // shots per second
const GUN_SPEED = 120; // m/s
const GUN_LIFE = 0.7; // seconds, so about 80 m of range
const GUN_SPREAD = 0.045; // rad, half-angle of the random cone
const GUN_DAMAGE = 1.2; // HP per bullet that hits
const GUN_MUZZLE = { forward: 2.0, side: 0.5 };
const MAX_BULLETS = 200;

const MINE_ARM_TIME = 1.0; // seconds before a dropped mine goes live (for everyone, its owner included)
const MINE_TRIGGER_RADIUS = 1.8;
const MINE_LIFE = 45;
const MINE_MAX = 14; // oldest mines disappear beyond this
const MINE_BLAST = { radius: 7.5, power: 13, damage: 36, lift: 8 };

export interface Missile { owner: Car; x: number; z: number; y: number; heading: number; age: number; index: number; mesh: THREE.Object3D }
export interface Mine { owner: Car; x: number; z: number; y: number; age: number; mesh: THREE.Object3D }
interface Bullet { owner: Car; x: number; z: number; y: number; vx: number; vz: number; age: number; index: number }
interface Spark { mesh: THREE.Mesh; age: number; life: number; size: number }
interface Explosion { mesh: THREE.Mesh; age: number; life: number; radius: number }

/** Forward missiles, rear mines and their explosions. Ammo lives on the cars. */
export class Weapons {
  readonly missiles: Missile[] = [];
  readonly mines: Mine[] = [];
  private readonly explosions: Explosion[] = [];
  readonly stats = { missilesFired: 0, rearMissilesFired: 0, missileCarHits: 0, missileWallHits: 0, minesLaid: 0, mineHits: 0, bulletsFired: 0, bulletHits: 0 };
  private time = 0;
  private readonly bullets: Bullet[] = [];
  private readonly sparks: Spark[] = [];
  private readonly nextShot = new Map<Car, number>();
  private muzzleSide = 1;
  private cars: Car[] = [];

  private readonly missileMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.4, metalness: 0.4 });
  private readonly noseMat = new THREE.MeshStandardMaterial({ color: 0xd22020, roughness: 0.5 });
  private readonly flameMat = new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly mineBodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.5 });
  private readonly mineLightMat = new THREE.MeshStandardMaterial({ color: 0x500000, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.3 });
  private readonly sphere = new THREE.SphereGeometry(1, 18, 14);
  private readonly sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  private readonly sparkGeo = new THREE.IcosahedronGeometry(1, 0);
  private readonly tracers: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  // Shared by every missile and mine, so firing does not allocate GPU geometry.
  private readonly missileBodyGeo = new THREE.CylinderGeometry(0.13, 0.13, 1.3, 10).rotateX(Math.PI / 2);
  private readonly missileNoseGeo = new THREE.ConeGeometry(0.13, 0.45, 10).rotateX(Math.PI / 2).translate(0, 0, 0.85);
  private readonly missileFlameGeo = new THREE.ConeGeometry(0.11, 0.9, 8).rotateX(-Math.PI / 2).translate(0, 0, -1.1);
  private readonly missileFinGeo = new THREE.BoxGeometry(0.03, 0.3, 0.3);
  private readonly mineDiscGeo = new THREE.CylinderGeometry(0.6, 0.7, 0.2, 18);
  private readonly mineLightGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 10);

  constructor(private readonly scene: THREE.Scene, private readonly track: Track) {
    // One instanced mesh draws every bullet in flight as a short glowing streak.
    const tracerGeo = new THREE.BoxGeometry(0.07, 0.07, 1.5).translate(0, 0, -0.6);
    this.tracers = new THREE.InstancedMesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xffe36a }), MAX_BULLETS);
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    this.tracers.userData.noShadow = true;
    scene.add(this.tracers);
  }

  /** Remove everything (race restart). */
  clear(): void {
    for (const m of this.missiles) this.scene.remove(m.mesh);
    for (const m of this.mines) this.scene.remove(m.mesh);
    for (const e of this.explosions) {
      this.scene.remove(e.mesh);
      (e.mesh.material as THREE.Material).dispose();
    }
    for (const s of this.sparks) this.scene.remove(s.mesh);
    this.missiles.length = this.mines.length = this.explosions.length = this.sparks.length = this.bullets.length = 0;
    this.nextShot.clear();
    this.tracers.count = 0;
  }

  /** Launch a missile out of the nose, or (rear = true) out of the tail, flying backwards along the car's heading. */
  fireMissile(car: Car, rear = false): boolean {
    const type = rear ? 'rearMissiles' : 'missiles';
    if (car.wrecked || car.ammo[type] <= 0) return false;
    car.ammo[type]--;
    this.stats.missilesFired++;
    if (rear) this.stats.rearMissilesFired++;
    const heading = car.heading + (rear ? Math.PI : 0);
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(this.missileBodyGeo, this.missileMat);
    const nose = new THREE.Mesh(this.missileNoseGeo, this.noseMat);
    const flame = new THREE.Mesh(this.missileFlameGeo, this.flameMat);
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const fin = new THREE.Mesh(this.missileFinGeo, this.missileMat);
      fin.position.set(Math.sin(a) * 0.15, Math.cos(a) * 0.15, -0.5);
      fin.rotation.z = -a;
      mesh.add(fin);
    }
    mesh.add(body, nose, flame);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const missile: Missile = {
      owner: car, x: car.x + fx * 2.5, z: car.z + fz * 2.5, y: car.y + 0.7, heading, age: 0, index: car.trackIndex, mesh,
    };
    this.missiles.push(missile);
    this.syncMissile(missile);
    return true;
  }

  /** Hold-to-fire machine gun: call every step while the trigger is down; the fire rate limits it. */
  fireGun(car: Car): boolean {
    if (car.wrecked || car.airborne || car.ammo.bullets <= 0 || this.bullets.length >= MAX_BULLETS) return false;
    if (this.time < (this.nextShot.get(car) ?? 0)) return false;
    this.nextShot.set(car, this.time + 1 / GUN_RATE);
    car.ammo.bullets--;
    this.stats.bulletsFired++;
    // Twin guns, firing alternately from either side of the nose.
    this.muzzleSide = -this.muzzleSide;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const x = car.x + fx * GUN_MUZZLE.forward + fz * GUN_MUZZLE.side * this.muzzleSide;
    const z = car.z + fz * GUN_MUZZLE.forward - fx * GUN_MUZZLE.side * this.muzzleSide;
    const dir = car.heading + (Math.random() * 2 - 1) * GUN_SPREAD;
    this.bullets.push({
      owner: car, x, z, y: car.y + 0.6, vx: Math.sin(dir) * GUN_SPEED, vz: Math.cos(dir) * GUN_SPEED, age: 0, index: car.trackIndex,
    });
    this.spark(x, car.y + 0.6, z, 0.4, 0.05); // muzzle flash
    return true;
  }

  dropMine(car: Car): boolean {
    if (car.wrecked || car.airborne || car.ammo.mines <= 0) return false;
    car.ammo.mines--;
    this.stats.minesLaid++;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const x = car.x - fx * 2.9;
    const z = car.z - fz * 2.9;
    const mesh = new THREE.Group();
    const disc = new THREE.Mesh(this.mineDiscGeo, this.mineBodyMat);
    const light = new THREE.Mesh(this.mineLightGeo, this.mineLightMat);
    light.position.y = 0.13;
    mesh.add(disc, light);
    mesh.position.set(x, car.y + 0.1, z);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.mines.push({ owner: car, x, z, y: car.y, age: 0, mesh });
    if (this.mines.length > MINE_MAX) this.removeMine(0);
    return true;
  }

  update(dt: number, cars: Car[]): void {
    this.time += dt;
    this.cars = cars;
    this.mineLightMat.emissiveIntensity = 0.6 + 0.6 * Math.abs(Math.sin(this.time * 6));

    for (const car of cars) {
      if (car.justWrecked) {
        car.justWrecked = false;
        this.explode(car.x, car.z, car.y + 0.6, { radius: 5, power: 0, damage: 0, lift: 0 }, 1.6);
      }
    }

    this.updateBullets(dt, cars);
    this.updateSparks(dt);

    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.age += dt;
      m.x += Math.sin(m.heading) * MISSILE_SPEED * dt;
      m.z += Math.cos(m.heading) * MISSILE_SPEED * dt;
      const q = this.track.query(m.x, m.z, m.index);
      m.index = q.index;
      if (!q.gap) m.y = q.height + 0.8;
      this.syncMissile(m);

      const wall = Math.abs(q.lateral) > this.track.wallOffset - 0.2;
      let hit = wall || m.age > MISSILE_LIFE;
      if (wall) this.stats.missileWallHits++;
      if (!hit) {
        for (const c of cars) {
          if (c.wrecked || (c === m.owner && m.age < MISSILE_OWNER_GRACE)) continue;
          if (Math.hypot(c.x - m.x, c.z - m.z) < MISSILE_HIT_RADIUS && Math.abs(c.y + 0.7 - m.y) < 1.6) { hit = true; this.stats.missileCarHits++; break; }
        }
      }
      if (hit) {
        this.removeMissile(i);
        if (m.age <= MISSILE_LIFE) this.explode(m.x, m.z, m.y, MISSILE_BLAST, 1);
      }
    }

    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.age += dt;
      let hit = false;
      if (m.age >= MINE_ARM_TIME) {
        for (const c of cars) {
          if (c.wrecked) continue;
          if (Math.hypot(c.x - m.x, c.z - m.z) < MINE_TRIGGER_RADIUS && Math.abs(c.y - m.y) < 1.4) { hit = true; this.stats.mineHits++; break; }
        }
      }
      if (hit) {
        this.removeMine(i);
        this.explode(m.x, m.z, m.y + 0.3, MINE_BLAST, 1.25);
      } else if (m.age > MINE_LIFE) this.removeMine(i);
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.age += dt;
      const t = e.age / e.life;
      if (t >= 1) {
        this.scene.remove(e.mesh);
        (e.mesh.material as THREE.Material).dispose();
        this.explosions.splice(i, 1);
        continue;
      }
      e.mesh.scale.setScalar(Math.max(0.1, e.radius * 0.55 * Math.sqrt(t)));
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
    }
  }

  private updateBullets(dt: number, cars: Car[]): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.age += dt;
      let hit = b.age > GUN_LIFE;
      // Two checks per step (halfway and at the end) so a fast bullet cannot skip over a car.
      for (const frac of [0.5, 1]) {
        if (hit) break;
        const px = b.x + b.vx * dt * frac;
        const pz = b.z + b.vz * dt * frac;
        const q = this.track.query(px, pz, b.index);
        if (Math.abs(q.lateral) > this.track.wallOffset - 0.1) {
          this.spark(px, b.y, pz, 0.35, 0.12);
          hit = true;
          break;
        }
        for (const c of cars) {
          if (c === b.owner || c.wrecked || Math.abs(c.y + 0.6 - b.y) > 1.4) continue;
          const dx = px - c.x;
          const dz = pz - c.z;
          const fx = Math.sin(c.heading);
          const fz = Math.cos(c.heading);
          if (Math.abs(dx * fx + dz * fz) < HULL_HZ + 0.15 && Math.abs(dx * fz - dz * fx) < HULL_HX + 0.15) {
            c.damage(GUN_DAMAGE);
            this.stats.bulletHits++;
            this.spark(px, b.y, pz, 0.5, 0.14);
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        this.bullets.splice(i, 1);
        continue;
      }
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      const q = this.track.query(b.x, b.z, b.index);
      b.index = q.index;
      if (!q.gap) b.y = q.height + 0.6;
    }
    this.tracers.count = this.bullets.length;
    this.bullets.forEach((b, i) => {
      this.dummy.position.set(b.x, b.y, b.z);
      this.dummy.rotation.set(0, Math.atan2(b.vx, b.vz), 0);
      this.dummy.updateMatrix();
      this.tracers.setMatrixAt(i, this.dummy.matrix);
    });
    this.tracers.instanceMatrix.needsUpdate = true;
  }

  /** A brief flash: muzzle flashes and bullet impacts. They share one material and shrink away. */
  private spark(x: number, y: number, z: number, size: number, life: number): void {
    const mesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(size);
    mesh.userData.noShadow = true;
    this.scene.add(mesh);
    this.sparks.push({ mesh, age: 0, life, size });
  }

  private updateSparks(dt: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.scene.remove(s.mesh);
        this.sparks.splice(i, 1);
      } else {
        s.mesh.scale.setScalar(Math.max(0.01, s.size * (1 - s.age / s.life)));
      }
    }
  }

  private explode(x: number, z: number, y: number, blast: typeof MISSILE_BLAST, size: number): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(this.sphere, mat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.explosions.push({ mesh, age: 0, life: 0.55, radius: blast.radius * size });
    if (blast.power > 0) for (const c of this.cars) c.applyBlast(x, z, blast.radius, blast.power, blast.damage, blast.lift);
  }

  private removeMissile(i: number): void {
    this.scene.remove(this.missiles[i].mesh);
    this.missiles.splice(i, 1);
  }

  private removeMine(i: number): void {
    this.scene.remove(this.mines[i].mesh);
    this.mines.splice(i, 1);
  }

  private syncMissile(m: Missile): void {
    m.mesh.position.set(m.x, m.y, m.z);
    m.mesh.rotation.set(0, m.heading, 0);
  }
}
