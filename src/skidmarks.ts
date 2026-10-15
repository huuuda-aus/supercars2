import * as THREE from 'three';
import type { Car } from './car';
import type { Track } from './track';

const MAX_SEGMENTS = 6000; // ring buffer: the oldest marks are overwritten first
const SEGMENT_LENGTH = 0.35; // a new quad is laid after the wheel has moved this far (m)
const MARK_WIDTH = 0.3;
const MARK_LIFT = 0.045; // above the road surface
const MARK_ALPHA = 0.6;
const RESET_DISTANCE = 3; // a bigger jump than this (respawn, lost contact) starts a new stroke
const SKID_MIN_SPEED = 4;
const DRIFT_SLIP_FROM = 0.2; // body slip angle (rad) where tyres start to leave marks
const DRIFT_SLIP_FULL = 0.5;

interface Stroke { x: number; y: number; z: number; alpha: number }

/**
 * Black tyre marks on the tarmac. One preallocated mesh holds a ring buffer of quads; a wheel that is skidding
 * (handbrake lock-up, a sideways drift, or touching down after a jump) lays a ribbon behind it.
 */
export class Skidmarks {
  readonly mesh: THREE.Mesh;
  private readonly position = new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 4 * 3), 3);
  private readonly colour = new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 4 * 4), 4);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly strokes = new WeakMap<Car, (Stroke | null)[]>();
  private head = 0;
  private count = 0;
  private dirty = false;

  constructor(private readonly track: Track) {
    const index = new Uint32Array(MAX_SEGMENTS * 6);
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('color', this.colour);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  clear(): void {
    this.head = this.count = 0;
    this.geometry.setDrawRange(0, 0);
    this.position.needsUpdate = this.colour.needsUpdate = false;
  }

  /** Call once per physics step, after the cars have moved. */
  update(cars: Car[]): void {
    for (const car of cars) this.updateCar(car);
    if (this.dirty) {
      this.position.needsUpdate = this.colour.needsUpdate = true;
      this.geometry.setDrawRange(0, this.count * 6);
      this.dirty = false;
    }
  }

  /** Mark strength 0..1 for each wheel (FL, FR, RL, RR). */
  private intensities(car: Car): number[] {
    if (car.wrecked || car.airborne) return [0, 0, 0, 0];
    // Burning rubber: all four driven wheels leave marks, even from a standstill.
    const burn = car.burnout;
    if (car.speed < SKID_MIN_SPEED) return [burn * 0.7, burn * 0.7, burn, burn];
    const slip = Math.abs(Math.atan2(car.vl, Math.max(Math.abs(car.vf), 1)));
    const drift = Math.min(1, Math.max(0, (slip - DRIFT_SLIP_FROM) / (DRIFT_SLIP_FULL - DRIFT_SLIP_FROM)));
    const lock = car.handbrakePull; // locked rear wheels smear even without any sideways slip
    const rear = Math.max(drift, lock * 0.9, burn);
    const front = Math.max(drift * 0.6, burn * 0.7);
    // Touching down after a jump: all four tyres scrub for a moment.
    const land = car.landSkid > 0 ? car.landStrength * Math.min(1, car.landSkid / 0.15) : 0;
    return [Math.max(front, land), Math.max(front, land), Math.max(rear, land), Math.max(rear, land)];
  }

  private updateCar(car: Car): void {
    let strokes = this.strokes.get(car);
    if (!strokes) this.strokes.set(car, (strokes = [null, null, null, null]));
    const strength = this.intensities(car);
    const wheels = car.wheelPoints();
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const q = strength[i] > 0.05 ? this.track.query(w.x, w.z, car.trackIndex) : null;
      // Only on the road itself, not over the pit or the grass.
      if (!q || q.gap || Math.abs(q.lateral) > this.track.halfWidth) {
        strokes[i] = null;
        continue;
      }
      const y = q.height + MARK_LIFT;
      const alpha = MARK_ALPHA * strength[i];
      const prev = strokes[i];
      if (!prev) {
        strokes[i] = { x: w.x, y, z: w.z, alpha: 0 }; // starts invisible and fades in
        continue;
      }
      const dx = w.x - prev.x;
      const dz = w.z - prev.z;
      const d = Math.hypot(dx, dz);
      if (d > RESET_DISTANCE) {
        strokes[i] = { x: w.x, y, z: w.z, alpha: 0 };
      } else if (d >= SEGMENT_LENGTH) {
        this.addSegment(prev, { x: w.x, y, z: w.z, alpha }, dx / d, dz / d);
        strokes[i] = { x: w.x, y, z: w.z, alpha };
      }
    }
  }

  private addSegment(a: Stroke, b: Stroke, dirX: number, dirZ: number): void {
    const half = MARK_WIDTH / 2;
    const nx = -dirZ * half; // sideways, perpendicular to the direction of travel
    const nz = dirX * half;
    const v = this.head * 4;
    const corners: [Stroke, number][] = [[a, 1], [a, -1], [b, 1], [b, -1]];
    corners.forEach(([p, side], k) => {
      this.position.setXYZ(v + k, p.x + nx * side, p.y, p.z + nz * side);
      this.colour.setXYZW(v + k, 0.03, 0.03, 0.035, p.alpha);
    });
    this.head = (this.head + 1) % MAX_SEGMENTS;
    this.count = Math.min(this.count + 1, MAX_SEGMENTS);
    this.dirty = true;
  }
}
