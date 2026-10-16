import * as THREE from 'three';
import type { Car } from './car';

const MAX_FLAMES = 240;
const FIRE_STARTS_AT = 0.15; // health fraction below which the front of the car is on fire
const RATE_MIN = 34; // flames a second as the fire starts
const RATE_MAX = 80; // ... and at zero health

interface Flame {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
}

interface Emitter {
  carry: number;
}

/**
 * Fire at the front of a car that is nearly dead (under 15% health, and a wreck). Small flames flicker up out of the
 * engine bay, yellow-white at the root to orange to dark red at the tips, drawn with additive light so they glow. More
 * of them, and bigger, the closer to zero health. Like the smoke they live in the world, so a moving car trails them.
 */
export class FireSystem {
  readonly group = new THREE.Group();
  private readonly flames: Flame[] = [];
  private readonly free: Flame[] = [];
  private readonly emitters = new WeakMap<Car, Emitter>();
  private readonly geometry = new THREE.IcosahedronGeometry(1, 1);

  constructor() {
    for (let i = 0; i < MAX_FLAMES; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.userData.noShadow = true;
      this.group.add(mesh);
      this.free.push({ mesh, material, age: 0, life: 0.5, vx: 0, vy: 0, vz: 0, size: 0.2 });
    }
  }

  /** 0 at 15% health or better, 1 at zero (or wrecked). */
  static intensity(car: Car): number {
    if (car.wrecked) return 1;
    const fraction = car.health / car.stats.maxHealth;
    return Math.min(1, Math.max(0, (FIRE_STARTS_AT - fraction) / FIRE_STARTS_AT));
  }

  emit(car: Car, dt: number): void {
    const fire = FireSystem.intensity(car);
    let e = this.emitters.get(car);
    if (!e) this.emitters.set(car, (e = { carry: 0 }));
    if (fire <= 0) return;
    e.carry += (RATE_MIN + (RATE_MAX - RATE_MIN) * fire) * dt;
    const count = Math.floor(e.carry);
    e.carry -= count;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const v = car.worldVelocity();
    for (let i = 0; i < count; i++) {
      const flame = this.free.pop();
      if (!flame) return;
      // Across the width of the bonnet and nose: from the engine bay forward to the bumper.
      const ahead = 1.0 + Math.random() * 1.05;
      const side = (Math.random() - 0.5) * 1.2;
      flame.age = 0;
      flame.life = 0.32 + Math.random() * 0.28;
      flame.size = 0.17 + 0.16 * fire + Math.random() * 0.08;
      flame.vx = v.x * 0.5 + (Math.random() - 0.5) * 0.9;
      flame.vz = v.z * 0.5 + (Math.random() - 0.5) * 0.9;
      flame.vy = 2.2 + Math.random() * 1.6 + fire * 1.2;
      flame.mesh.position.set(car.x + fx * ahead + fz * side, car.y + 0.75 + Math.random() * 0.25, car.z + fz * ahead - fx * side);
      flame.mesh.visible = true;
      this.flames.push(flame);
    }
  }

  update(dt: number): void {
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.age += dt;
      if (f.age >= f.life) {
        f.mesh.visible = false;
        f.material.opacity = 0;
        this.flames.splice(i, 1);
        this.free.push(f);
        continue;
      }
      const t = f.age / f.life;
      f.mesh.position.x += f.vx * dt;
      f.mesh.position.y += f.vy * dt;
      f.mesh.position.z += f.vz * dt;
      // Tall and narrow, shrinking towards the tip; the shape wobbles so the fire flickers.
      const wobble = 1 + 0.25 * Math.sin((f.age + f.size * 9) * 38);
      const s = f.size * (1 - 0.75 * t);
      f.mesh.scale.set(s * wobble, s * (1.7 + 0.5 * wobble), s * wobble);
      // Yellow-white at the root, orange in the middle, dark red at the tip.
      f.material.color.setRGB(1, 0.92 - 0.72 * t, 0.55 - 0.55 * Math.min(1, t * 1.6));
      f.material.opacity = 0.85 * Math.min(1, t * 10) * (1 - t * t);
    }
  }

  clear(): void {
    for (const f of this.flames) {
      f.mesh.visible = false;
      f.material.opacity = 0;
      this.free.push(f);
    }
    this.flames.length = 0;
  }
}
