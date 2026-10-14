import * as THREE from 'three';
import type { Car } from './car';
import type { Track } from './track';

const MISSILE_SPEED = 65; // m/s over the ground
const MISSILE_LIFE = 2.2; // seconds
const MISSILE_OWNER_GRACE = 0.35; // the shooter cannot be hit by its own missile right away
const MISSILE_HIT_RADIUS = 1.7;
const MISSILE_BLAST = { radius: 6.5, power: 11, damage: 30, lift: 3 };

const MINE_ARM_TIME = 1.0; // seconds before a dropped mine goes live (for everyone, its owner included)
const MINE_TRIGGER_RADIUS = 1.8;
const MINE_LIFE = 45;
const MINE_MAX = 14; // oldest mines disappear beyond this
const MINE_BLAST = { radius: 7.5, power: 13, damage: 36, lift: 8 };

export interface Missile { owner: Car; x: number; z: number; y: number; heading: number; age: number; index: number; mesh: THREE.Object3D }
export interface Mine { owner: Car; x: number; z: number; y: number; age: number; mesh: THREE.Object3D }
interface Explosion { mesh: THREE.Mesh; age: number; life: number; radius: number }

/** Forward missiles, rear mines and their explosions. Ammo lives on the cars. */
export class Weapons {
  readonly missiles: Missile[] = [];
  readonly mines: Mine[] = [];
  private readonly explosions: Explosion[] = [];
  readonly stats = { missilesFired: 0, missileCarHits: 0, missileWallHits: 0, minesLaid: 0, mineHits: 0 };
  private time = 0;
  private cars: Car[] = [];

  private readonly missileMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.4, metalness: 0.4 });
  private readonly noseMat = new THREE.MeshStandardMaterial({ color: 0xd22020, roughness: 0.5 });
  private readonly flameMat = new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly mineBodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.5 });
  private readonly mineLightMat = new THREE.MeshStandardMaterial({ color: 0x500000, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.3 });
  private readonly sphere = new THREE.SphereGeometry(1, 18, 14);

  constructor(private readonly scene: THREE.Scene, private readonly track: Track) {}

  /** Remove everything (race restart). */
  clear(): void {
    for (const m of this.missiles) this.scene.remove(m.mesh);
    for (const m of this.mines) this.scene.remove(m.mesh);
    for (const e of this.explosions) this.scene.remove(e.mesh);
    this.missiles.length = this.mines.length = this.explosions.length = 0;
  }

  fireMissile(car: Car): boolean {
    if (car.wrecked || car.ammo.missiles <= 0) return false;
    car.ammo.missiles--;
    this.stats.missilesFired++;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.3, 10).rotateX(Math.PI / 2), this.missileMat);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.45, 10).rotateX(Math.PI / 2).translate(0, 0, 0.85), this.noseMat);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.9, 8).rotateX(-Math.PI / 2).translate(0, 0, -1.1), this.flameMat);
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.3), this.missileMat);
      fin.position.set(Math.sin(a) * 0.15, Math.cos(a) * 0.15, -0.5);
      fin.rotation.z = -a;
      mesh.add(fin);
    }
    mesh.add(body, nose, flame);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const missile: Missile = {
      owner: car, x: car.x + fx * 2.5, z: car.z + fz * 2.5, y: car.y + 0.7, heading: car.heading, age: 0, index: car.trackIndex, mesh,
    };
    this.missiles.push(missile);
    this.syncMissile(missile);
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
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.2, 18), this.mineBodyMat);
    const light = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 10), this.mineLightMat);
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
