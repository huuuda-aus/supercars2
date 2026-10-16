import * as THREE from 'three';
import type { Car } from './car';
import { HULL_HX, HULL_HZ } from './spec';
import { Explosions } from './explosion';
import type { Track } from './track';

const MISSILE_SPEED = 65; // m/s over the ground
const MISSILE_LIFE = 2.2; // seconds
const MISSILE_OWNER_GRACE = 0.35; // the shooter cannot be hit by its own missile right away
const MISSILE_HIT_RADIUS = 1.7;
const MISSILE_BLAST = { radius: 6.5, power: 11, damage: 14, lift: 3 };

const GUN_RATE = 11; // shots per second
const GUN_SPEED = 120; // m/s
const GUN_LIFE = 0.7; // seconds, so about 80 m of range
const GUN_SPREAD = 0.045; // rad, half-angle of the random cone
const GUN_DAMAGE = 1.2; // HP per bullet that hits
const GUN_MUZZLE = { forward: 2.0, side: 0.5 };
const MAX_BULLETS = 200;

const UP = new THREE.Vector3(0, 1, 0);

const OIL_RADIUS = 2.3; // a wheel inside this is on the slick
const OIL_LIFE = 20; // seconds
const OIL_FADE = 3; // the slick shrinks away over its last seconds
const OIL_SPREAD_TIME = 0.4; // it spreads out after being dropped
const OIL_MAX = 12; // oldest slicks disappear beyond this
const OIL_LINGER = 0.5; // seconds the tyres stay slippery after leaving it

const MINE_ARM_TIME = 1.0; // seconds before a dropped mine goes live (for everyone, its owner included)
const MINE_TRIGGER_RADIUS = 1.8;
const MINE_LIFE = 45;
const MINE_MAX = 14; // oldest mines disappear beyond this
const MINE_BLAST = { radius: 7.5, power: 13, damage: 18, lift: 8 };

/** Something that makes a noise, for the audio to turn into sound at its place in the world. */
export interface SoundEvent {
  type: 'gun' | 'hit' | 'missile' | 'explosion' | 'mineDrop' | 'oil' | 'crash' | 'wall' | 'scrape' | 'pickup';
  x: number;
  z: number;
  size?: number; // explosions: the blast radius; crashes and wall hits: the impact speed (m/s); scrapes: the sliding speed
  onCar?: boolean; // hits: a car (otherwise a wall)
  kind?: string; // pickups: which kind of crate
}

export interface Missile { owner: Car; x: number; z: number; y: number; heading: number; age: number; index: number; mesh: THREE.Object3D }
export interface Mine { owner: Car; x: number; z: number; y: number; index: number; age: number; mesh: THREE.Object3D }
interface Bullet { owner: Car; x: number; z: number; y: number; vx: number; vz: number; age: number; index: number }
interface Spark { mesh: THREE.Mesh; age: number; life: number; size: number }
export interface Oil { owner: Car; x: number; z: number; y: number; age: number; mesh: THREE.Mesh }

/** Forward missiles, rear mines and their explosions. Ammo lives on the cars. */
export class Weapons {
  readonly missiles: Missile[] = [];
  readonly mines: Mine[] = [];
  readonly oils: Oil[] = [];
  /** While true every weapon refuses to fire or drop (the start-of-race lockout). Set by the game loop. */
  locked = false;
  /** Called for every sound-making event. Set by the game. */
  sound: (e: SoundEvent) => void = () => {};
  /** Mines and slicks as plain points, for drivers who steer around them. Rebuilt every step. */
  hazards: { x: number; z: number }[] = [];
  private readonly fx = new Explosions();
  readonly stats = { missilesFired: 0, rearMissilesFired: 0, missileCarHits: 0, missileWallHits: 0, minesLaid: 0, mineHits: 0, oilsLaid: 0, bulletsFired: 0, bulletHits: 0 };
  private time = 0;
  private readonly bullets: Bullet[] = [];
  private readonly sparks: Spark[] = [];
  private readonly freeSparks: THREE.Mesh[] = []; // pooled flash meshes, hidden until reused
  private readonly nextShot = new Map<Car, number>();
  private muzzleSide = 1;
  private cars: Car[] = [];

  private readonly missileMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.4, metalness: 0.4 });
  private readonly noseMat = new THREE.MeshStandardMaterial({ color: 0xd22020, roughness: 0.5 });
  private readonly flameMat = new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly mineBodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.5 });
  private readonly mineLightMat = new THREE.MeshStandardMaterial({ color: 0x500000, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.3 });
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
  private readonly oilMat = new THREE.MeshStandardMaterial({ color: 0x07070a, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5, side: THREE.DoubleSide });
  private readonly mineLightGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 10);

  private track!: Track;

  constructor(private readonly scene: THREE.Scene) {
    // One instanced mesh draws every bullet in flight as a short glowing streak.
    const tracerGeo = new THREE.BoxGeometry(0.07, 0.07, 1.5).translate(0, 0, -0.6);
    this.tracers = new THREE.InstancedMesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xffe36a }), MAX_BULLETS);
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    this.tracers.userData.noShadow = true;
    scene.add(this.tracers);
    scene.add(this.fx.group);
  }

  /** Race on a different circuit. */
  setTrack(track: Track): void {
    this.track = track;
  }

  /** Remove everything (race restart). */
  clear(): void {
    for (const m of this.missiles) this.scene.remove(m.mesh);
    for (const m of this.mines) this.scene.remove(m.mesh);
    while (this.oils.length) this.removeOil(0);
    this.hazards = [];
    this.fx.clear();
    for (const s of this.sparks) this.recycleSpark(s.mesh);
    this.missiles.length = this.mines.length = this.sparks.length = this.bullets.length = 0;
    this.nextShot.clear();
    this.tracers.count = 0;
  }

  /** Launch a missile out of the nose, or (rear = true) out of the tail, flying backwards along the car's heading. */
  fireMissile(car: Car, rear = false): boolean {
    const type = rear ? 'rearMissiles' : 'missiles';
    if (this.locked || car.wrecked || car.ammo[type] <= 0) return false;
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
    this.sound({ type: 'missile', x: car.x, z: car.z });
    return true;
  }

  /** Hold-to-fire machine gun: call every step while the trigger is down; the fire rate limits it. */
  fireGun(car: Car): boolean {
    if (this.locked || car.wrecked || car.airborne || car.ammo.bullets <= 0 || this.bullets.length >= MAX_BULLETS) return false;
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
    this.sound({ type: 'gun', x, z });
    return true;
  }

  dropMine(car: Car): boolean {
    if (this.locked || car.wrecked || car.airborne || car.ammo.mines <= 0) return false;
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
    // Sit on the road surface and lie along its slope, not flat in the air or buried in a ramp.
    const ground = this.track.query(x, z, car.trackIndex);
    mesh.position.set(x, ground.height + 0.1, z);
    mesh.quaternion.setFromUnitVectors(UP, this.groundNormal(x, z, ground.index));
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.mines.push({ owner: car, x, z, y: ground.height, index: ground.index, age: 0, mesh });
    if (this.mines.length > MINE_MAX) this.removeMine(0);
    this.sound({ type: 'mineDrop', x, z });
    return true;
  }

  /** Spill an oil slick behind the car. Any car whose wheels run over it loses most of its grip. */
  dropOil(car: Car): boolean {
    if (this.locked || car.wrecked || car.airborne || car.ammo.oil <= 0) return false;
    car.ammo.oil--;
    this.stats.oilsLaid++;
    const x = car.x - Math.sin(car.heading) * 3.4;
    const z = car.z - Math.cos(car.heading) * 3.4;
    const y = this.track.query(x, z, car.trackIndex).height;
    const mesh = new THREE.Mesh(this.buildOilBlob(x, y, z), this.oilMat);
    mesh.position.set(x, y, z);
    mesh.scale.set(0.3, 1, 0.3);
    mesh.receiveShadow = true;
    mesh.userData.noShadow = true;
    this.scene.add(mesh);
    this.oils.push({ owner: car, x, z, y, age: 0, mesh });
    if (this.oils.length > OIL_MAX) this.removeOil(0);
    this.sound({ type: 'oil', x, z });
    return true;
  }

  /** An irregular puddle that follows the road surface (vertex heights are sampled from the track). */
  private buildOilBlob(cx: number, cy: number, cz: number): THREE.BufferGeometry {
    const SIDES = 16;
    const pos: number[] = [0, 0.07, 0];
    const idx: number[] = [];
    const phase = Math.random() * 10;
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2;
      const r = OIL_RADIUS * (0.82 + 0.18 * Math.sin(a * 3 + phase) + 0.08 * Math.sin(a * 5 + phase * 2));
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r;
      const h = this.track.query(cx + lx, cz + lz).height;
      pos.push(lx, h - cy + 0.07, lz);
      idx.push(0, 1 + i, 1 + ((i + 1) % SIDES));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  update(dt: number, cars: Car[]): void {
    this.time += dt;
    this.cars = cars;
    this.mineLightMat.emissiveIntensity = 0.6 + 0.6 * Math.abs(Math.sin(this.time * 6));

    for (const car of cars) {
      if (car.justWrecked) {
        car.justWrecked = false;
        this.explode(car.x, car.z, car.y + 0.6, { radius: 5, power: 0, damage: 0, lift: 0 }, 1.6, car.trackIndex);
      }
    }

    this.updateOils(dt, cars);
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
        if (m.age <= MISSILE_LIFE) this.explode(m.x, m.z, m.y, MISSILE_BLAST, 1, m.index, m.owner);
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
        this.explode(m.x, m.z, m.y + 0.3, MINE_BLAST, 1.25, m.index, m.owner);
      } else if (m.age > MINE_LIFE) this.removeMine(i);
    }

    this.fx.update(dt);
  }

  private updateOils(dt: number, cars: Car[]): void {
    for (let i = this.oils.length - 1; i >= 0; i--) {
      const o = this.oils[i];
      o.age += dt;
      if (o.age > OIL_LIFE) {
        this.removeOil(i);
        continue;
      }
      const spread = 0.3 + 0.7 * Math.min(1, o.age / OIL_SPREAD_TIME);
      const fade = Math.min(1, (OIL_LIFE - o.age) / OIL_FADE);
      o.mesh.scale.set(spread * fade, 1, spread * fade);
      const reach = OIL_RADIUS * spread * fade;
      for (const c of cars) {
        if (c.wrecked || c.airborne || Math.abs(c.y - o.y) > 1.2) continue;
        if (Math.hypot(c.x - o.x, c.z - o.z) > reach + 3) continue; // cheap reject before checking the wheels
        if (!c.wheelPoints().some((w) => Math.hypot(w.x - o.x, w.z - o.z) < reach)) continue;
        // Hitting the slick at speed sets the tail swinging, to either side.
        if (c.oilTimer <= 0 && c.speed > 6) c.omega += (Math.random() < 0.5 ? -1 : 1) * (0.5 + c.speed * 0.04);
        c.oilTimer = OIL_LINGER;
      }
    }
    this.hazards = [...this.mines, ...this.oils];
  }

  private removeOil(i: number): void {
    const o = this.oils[i];
    this.scene.remove(o.mesh);
    o.mesh.geometry.dispose();
    this.oils.splice(i, 1);
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
          this.sound({ type: 'hit', x: px, z: pz, onCar: false });
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
            c.damage(GUN_DAMAGE, b.owner);
            this.stats.bulletHits++;
            this.spark(px, b.y, pz, 0.5, 0.14);
            this.sound({ type: 'hit', x: px, z: pz, onCar: true });
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
    let mesh = this.freeSparks.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
      mesh.userData.noShadow = true;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(size);
    this.sparks.push({ mesh, age: 0, life, size });
  }

  private recycleSpark(mesh: THREE.Mesh): void {
    mesh.visible = false;
    this.freeSparks.push(mesh);
  }

  private updateSparks(dt: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.recycleSpark(s.mesh);
        this.sparks.splice(i, 1);
      } else {
        s.mesh.scale.setScalar(Math.max(0.01, s.size * (1 - s.age / s.life)));
      }
    }
  }

  /** Unit normal of the road surface at (x, z), from the height gradient around it. `index` picks the right strand at the crossing. */
  private groundNormal(x: number, z: number, index: number): THREE.Vector3 {
    const d = 0.8;
    const h = (px: number, pz: number) => this.track.query(px, pz, index).height;
    const dhdx = (h(x + d, z) - h(x - d, z)) / (2 * d);
    const dhdz = (h(x, z + d) - h(x, z - d)) / (2 * d);
    return new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
  }

  private explode(x: number, z: number, y: number, blast: typeof MISSILE_BLAST, size: number, index: number, owner?: Car): void {
    this.sound({ type: 'explosion', x, z, size: blast.radius * size });
    const ground = this.track.query(x, z, index);
    this.fx.spawn(x, Math.max(y, ground.height + 0.5), z, blast.radius * size, ground.height, this.groundNormal(x, z, ground.index));
    if (blast.power > 0) for (const c of this.cars) c.applyBlast(x, z, blast.radius, blast.power, blast.damage, blast.lift, owner);
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
