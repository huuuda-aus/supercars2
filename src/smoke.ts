import * as THREE from 'three';
import type { Car } from './car';

const MAX_PUFFS = 440;
const LIFE = 1.7; // seconds a puff lasts
const SMOKE_STARTS_AT = 0.5; // health fraction below which an engine starts to smoke
const WRECK_SMOKE_SECONDS = 10; // a wreck's smoke tapers off to nothing over this long
const RATE_MIN = 18; // puffs a second as the engine first starts to smoke (so close together that they make a stream)
const RATE_MAX = 40; // ... and at zero health, a wreck's thick plume

interface Puff {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
  size: number; // radius at birth
  spread: number; // how much it swells as it rises
  dark: number; // 0 = white vapour, 1 = black smoke
  density: number; // 1 normally; less while a wreck's smoke dies away
}

interface Emitter {
  carry: number; // fractional puffs owed
  x: number;
  y: number;
  z: number; // where the last puff was spawned from, so a fast car still leaves an unbroken stream
  valid: boolean;
}

/**
 * Smoke from damaged engines and wrecks. Below half health a car streams white vapour from its engine bay: a steady
 * stream, not occasional puffs. The lower its health, the more it pours out, the wider the stream and the darker it
 * gets, until at zero health (a wreck) it is a thick black column. The puffs live in the world (not on the car), so a
 * moving car leaves a trail behind it.
 */
export class SmokeSystem {
  readonly group = new THREE.Group();
  private readonly puffs: Puff[] = [];
  private readonly free: Puff[] = [];
  private readonly emitters = new WeakMap<Car, Emitter>();
  private readonly geometry = new THREE.IcosahedronGeometry(1, 1);

  constructor() {
    for (let i = 0; i < MAX_PUFFS; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.userData.noShadow = true;
      this.group.add(mesh);
      this.free.push({ mesh, material, age: 0, life: LIFE, vx: 0, vy: 0, vz: 0, size: 1, spread: 1, dark: 0, density: 1 });
    }
  }

  /** How badly damaged the car is for smoke purposes: 0 at half health or better, 1 at zero (or wrecked). */
  static damage(car: Car): number {
    if (car.wrecked) return 1;
    const fraction = car.health / car.stats.maxHealth;
    return Math.min(1, Math.max(0, (SMOKE_STARTS_AT - fraction) / SMOKE_STARTS_AT));
  }

  /** 1 for a smoking car; for a wreck it falls from 1 to 0 over its first ten seconds, when the smoke has died away. */
  static fade(car: Car): number {
    return car.wrecked ? Math.max(0, 1 - car.wreckedFor / WRECK_SMOKE_SECONDS) : 1;
  }

  /** Let a car (or wreck) smoke for `dt` seconds according to its damage. */
  emit(car: Car, dt: number): void {
    const fade = SmokeSystem.fade(car);
    const damage = fade > 0 ? SmokeSystem.damage(car) : 0;
    let e = this.emitters.get(car);
    if (!e) this.emitters.set(car, (e = { carry: 0, x: 0, y: 0, z: 0, valid: false }));
    if (damage <= 0) {
      e.valid = false;
      return;
    }
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    // The engine bay: ahead of the middle, under the bonnet.
    const nx = car.x + fx * 1.3;
    const ny = car.y + 0.95;
    const nz = car.z + fz * 1.3;
    const rate = (RATE_MIN + (RATE_MAX - RATE_MIN) * damage) * fade;
    e.carry += rate * dt;
    const count = Math.floor(e.carry);
    e.carry -= count;
    const v = car.worldVelocity();
    const fromX = e.valid ? e.x : nx;
    const fromY = e.valid ? e.y : ny;
    const fromZ = e.valid ? e.z : nz;
    for (let i = 0; i < count; i++) {
      const puff = this.free.pop();
      if (!puff) break;
      // Spread the new puffs along the path the engine took since last time: an unbroken stream, however fast it goes.
      const f = (i + 1) / count;
      puff.age = 0;
      puff.life = LIFE * (0.85 + Math.random() * 0.3) * (0.9 + 0.3 * damage);
      puff.dark = damage;
      puff.density = fade;
      puff.size = 0.22 + 0.3 * damage; // a narrow stream at the source, wider the worse the damage
      puff.spread = 1.6 + 2.2 * damage; // and it swells more as it rises
      puff.vx = v.x * 0.7 + (Math.random() - 0.5) * (0.6 + damage);
      puff.vz = v.z * 0.7 + (Math.random() - 0.5) * (0.6 + damage);
      puff.vy = 1.6 + Math.random() * 0.8 + damage * 1.2;
      const jitter = 0.12 + 0.22 * damage;
      puff.mesh.position.set(
        fromX + (nx - fromX) * f + (Math.random() - 0.5) * jitter,
        fromY + (ny - fromY) * f,
        fromZ + (nz - fromZ) * f + (Math.random() - 0.5) * jitter,
      );
      puff.mesh.visible = true;
      this.puffs.push(puff);
    }
    e.x = nx;
    e.y = ny;
    e.z = nz;
    e.valid = true;
  }

  update(dt: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.mesh.visible = false;
        p.material.opacity = 0;
        this.puffs.splice(i, 1);
        this.free.push(p);
        continue;
      }
      const t = p.age / p.life;
      const drag = Math.exp(-1.4 * dt);
      p.vx *= drag;
      p.vz *= drag;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt * (1 - t * 0.55);
      p.mesh.position.z += p.vz * dt;
      p.mesh.scale.setScalar(p.size * (1 + p.spread * Math.sqrt(t)));
      // White vapour thickening to black smoke; each puff thins as it rises, so the stream fades out above the car.
      p.material.opacity = (0.32 + 0.45 * p.dark) * p.density * Math.min(1, t * 8) * (1 - t * t);
      p.material.color.setScalar(0.97 - 0.86 * Math.pow(p.dark, 0.85) + 0.12 * t * p.dark);
    }
  }

  clear(): void {
    for (const p of this.puffs) {
      p.mesh.visible = false;
      p.material.opacity = 0;
      this.free.push(p);
    }
    this.puffs.length = 0;
  }
}
