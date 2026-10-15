import type { Car } from './car';
import { HULL_HX, HULL_HZ, INERTIA } from './spec';
import type { Track } from './track';

interface Vec { x: number; z: number }

/** Rotational inertia seen by contacts. Higher = heavier, calmer spins. */
const IMPACT_INERTIA = INERTIA * 1.0;
/** Fraction of the closing speed removed per physics step, so a hit plays out over a few frames. */
const CONTACT_SOFTNESS = 0.25;
/** Share of the overlap pushed apart each step (walls are always pushed fully). */
const CAR_PUSH_OUT = 0.3;
const MAX_IMPACT_YAW = 5; // rad/s

// Damage per m/s of impact speed (closing speed along the contact normal when the contact starts or gets harder).
const WALL_DAMAGE = 1.0; // a 20 m/s head-on wall hit costs about 20 HP
const CAR_DAMAGE = 0.3; // each car takes this per m/s of speed difference along the contact normal
/** Closing speed that is free: engine push, leaning on a wall or nose-to-tail shoving never gets above this. */
const MIN_IMPACT_SPEED = 2.5;

/**
 * Contacts are soft (a hit plays out over several steps and a car pushing on another keeps re-creating a small
 * closing speed), so damage cannot come from the closing speed of each step. Instead each contact remembers its
 * closing speed from the previous step and only an increase over that (and over MIN_IMPACT_SPEED) counts: a fresh
 * hit is charged in full on its first step, steady pushing is free.
 */
let tick = 0;

/**
 * Told about contacts worth a sound: 'car' (a car meets a car or a wreck) and 'wall' (a car meets a barrier) carry the
 * impact speed (m/s); 'scrape' (a car rubbing along a barrier, at most ten times a second) carries the sliding speed.
 * Set by the game for the sound.
 */
export type ContactKind = 'car' | 'wall' | 'scrape';
let contactListener: ((kind: ContactKind, x: number, z: number, value: number) => void) | null = null;
export function onContact(listener: (kind: ContactKind, x: number, z: number, value: number) => void): void {
  contactListener = listener;
}
const lastScrape = new WeakMap<Car, number>();
const SCRAPE_MIN_SPEED = 5; // m/s of sliding along the barrier before it grinds
const SCRAPE_INTERVAL = 12; // physics steps between scrape sounds
const lastClosing = new WeakMap<Car, Map<Car | null, { speed: number; tick: number }>>();

/** Call once at the start of every physics step. */
export function beginCollisionStep(): void {
  tick++;
}

function impactSpeed(car: Car, other: Car | null, closing: number): number {
  let contacts = lastClosing.get(car);
  if (!contacts) lastClosing.set(car, (contacts = new Map()));
  const rec = contacts.get(other);
  const previous = rec && tick - rec.tick <= 1 ? rec.speed : 0;
  contacts.set(other, { speed: closing, tick });
  return Math.max(0, closing - Math.max(previous, MIN_IMPACT_SPEED));
}

const CAR_RESTITUTION = 0.05;
const CAR_FRICTION = 0.2;
/** A burnt-out hulk is much heavier than a running car (and drags on the road, see WRECK_FRICTION in car.ts): a fast hit shoves it a few metres, a car just leaning on it cannot move it. */
const WRECK_MASS = 2.5;
const WRECK_DAMAGE = 0.6; // per m/s of impact speed when a car hits a wreck (it is a hard, crumpled obstacle)
const invMassOf = (c: Car) => (c.wrecked ? 1 / WRECK_MASS : 1);
const WALL_RESTITUTION = 0.05;
const WALL_FRICTION = 0.2;

/**
 * Torque of a force at offset r from the centre of mass, in this game's yaw convention
 * (positive yaw turns the forward vector toward the car's +lateral axis).
 */
const cross2 = (r: Vec, f: Vec) => r.z * f.x - r.x * f.z;

function pointVelocity(c: Car, r: Vec): Vec {
  const v = c.worldVelocity();
  return { x: v.x + c.omega * r.z, z: v.z - c.omega * r.x };
}

/**
 * A sideways shove behind the centre of mass (a PIT tap) makes the rear tyres break loose for a
 * while: breakaway seconds added per unit of lateral impulse, capped.
 */
const BREAKAWAY_PER_IMPULSE = 1.6;
const BREAKAWAY_MAX = 1.2;

function applyImpulse(c: Car, r: Vec, j: Vec, tailTap = false, invMass = 1): void {
  const v = c.worldVelocity();
  c.setWorldVelocity(v.x + j.x * invMass, v.z + j.z * invMass);
  const dOmega = (cross2(r, j) * invMass) / IMPACT_INERTIA;
  c.omega = Math.max(-MAX_IMPACT_YAW, Math.min(MAX_IMPACT_YAW, c.omega + dOmega));
  c.lastImpact = Math.max(c.lastImpact, Math.hypot(j.x, j.z) + Math.abs(dOmega));

  if (tailTap) {
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    const behind = r.x * fx + r.z * fz < -0.6;
    const sideways = Math.abs(j.x * fz - j.z * fx);
    if (behind) c.breakaway = Math.min(BREAKAWAY_MAX, c.breakaway + sideways * BREAKAWAY_PER_IMPULSE);
  }
}

/**
 * Impulse-based contact response between car `a` and car `b` (or a static wall when `b` is null).
 * `n` is the unit contact normal pointing from a toward b (toward the wall). Unit masses.
 */
function resolveContact(a: Car, b: Car | null, p: Vec, n: Vec, restitution: number, friction: number): void {
  const ra = { x: p.x - a.x, z: p.z - a.z };
  const rb = b ? { x: p.x - b.x, z: p.z - b.z } : { x: 0, z: 0 };
  const relVel = (): Vec => {
    const va = pointVelocity(a, ra);
    const vb = b ? pointVelocity(b, rb) : { x: 0, z: 0 };
    return { x: vb.x - va.x, z: vb.z - va.z };
  };
  const ia = invMassOf(a);
  const ib = b ? invMassOf(b) : 0; // a wall never moves
  const inverseMass = (dir: Vec) =>
    ia * (1 + cross2(ra, dir) ** 2 / IMPACT_INERTIA) + (b ? ib * (1 + cross2(rb, dir) ** 2 / IMPACT_INERTIA) : 0);
  const push = (j: Vec) => {
    applyImpulse(a, ra, { x: -j.x, z: -j.z }, !!b, ia);
    if (b) applyImpulse(b, rb, j, true, ib);
  };

  const vn = (() => { const v = relVel(); return v.x * n.x + v.z * n.z; })();
  if (vn >= 0) return; // already separating
  const jn = (-(1 + restitution) * vn * CONTACT_SOFTNESS) / inverseMass(n);
  push({ x: n.x * jn, z: n.z * jn });

  // Both cars (or the one against a wall or wreck) are hurt in proportion to the impact speed.
  const impact = impactSpeed(a, b, -vn);
  if (impact > 0) {
    const hurt = impact * (!b ? WALL_DAMAGE : a.wrecked || b.wrecked ? WRECK_DAMAGE : CAR_DAMAGE);
    a.damage(hurt);
    b?.damage(hurt);
    contactListener?.(b ? 'car' : 'wall', p.x, p.z, impact);
  }

  // Coulomb friction on the tangential slip, limited by the normal impulse.
  const v = relVel();
  const vn2 = v.x * n.x + v.z * n.z;
  const tx = v.x - vn2 * n.x;
  const tz = v.z - vn2 * n.z;
  const vt = Math.hypot(tx, tz);
  if (!b && vt > SCRAPE_MIN_SPEED && tick - (lastScrape.get(a) ?? -SCRAPE_INTERVAL) >= SCRAPE_INTERVAL) {
    lastScrape.set(a, tick);
    contactListener?.('scrape', p.x, p.z, vt);
  }
  if (vt < 1e-6) return;
  const t = { x: tx / vt, z: tz / vt };
  const jt = Math.min((vt * CONTACT_SOFTNESS) / inverseMass(t), friction * jn);
  push({ x: -t.x * jt, z: -t.z * jt });
}

/** Car-vs-car: SAT on the two oriented footprints, then contact point, positional fix and impulses. */
export function collideCars(a: Car, b: Car): void {
  if (a.wrecked && b.wrecked && a.speed + b.speed < 0.05) return; // two hulks at rest
  if (Math.abs(a.y - b.y) > 1.5) return;
  if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 > 36) return;

  const axes: Vec[] = [];
  for (const c of [a, b]) {
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    axes.push({ x: fx, z: fz }, { x: fz, z: -fx });
  }
  let depth = Infinity;
  let n: Vec = { x: 0, z: 0 };
  let owner = 0;
  for (let i = 0; i < 4; i++) {
    const ax = axes[i];
    const ra = hullRadius(a, ax);
    const rb = hullRadius(b, ax);
    const dist = (b.x - a.x) * ax.x + (b.z - a.z) * ax.z;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return; // separating axis found
    if (overlap < depth) {
      depth = overlap;
      const sgn = dist >= 0 ? 1 : -1;
      n = { x: ax.x * sgn, z: ax.z * sgn };
      owner = i < 2 ? 0 : 1;
    }
  }

  // Contact point: the incident box's corners that dig deepest into the reference box.
  const incident = owner === 0 ? b : a;
  const ref = owner === 0 ? a : b;
  const depthOf = (c: Vec) => (c.x - ref.x) * n.x + (c.z - ref.z) * n.z;
  const corners = incident.hullCorners();
  const sign = owner === 0 ? -1 : 1; // deepest = smallest projection for b's corners, largest for a's
  const best = Math.max(...corners.map((c) => sign * depthOf(c)));
  const deep = corners.filter((c) => sign * depthOf(c) > best - 0.25);
  const p = {
    x: deep.reduce((s, c) => s + c.x, 0) / deep.length,
    z: deep.reduce((s, c) => s + c.z, 0) / deep.length,
  };

  // Positional fix, shared by inverse mass: the lighter body gives way more.
  const ia = invMassOf(a);
  const ib = invMassOf(b);
  const push = depth * CAR_PUSH_OUT;
  a.x -= (n.x * push * ia) / (ia + ib);
  a.z -= (n.z * push * ia) / (ia + ib);
  b.x += (n.x * push * ib) / (ia + ib);
  b.z += (n.z * push * ib) / (ia + ib);
  resolveContact(a, b, p, n, CAR_RESTITUTION, CAR_FRICTION);
}

function hullRadius(c: Car, axis: Vec): number {
  const fx = Math.sin(c.heading);
  const fz = Math.cos(c.heading);
  return Math.abs(axis.x * fx + axis.z * fz) * HULL_HZ + Math.abs(axis.x * fz - axis.z * fx) * HULL_HX;
}

/** Keep the car's footprint corners inside the barriers; each corner that pokes through takes an impulse. */
export function collideWalls(car: Car, track: Track): void {
  for (const corner of car.hullCorners()) {
    const q = track.query(corner.x, corner.z, car.trackIndex);
    const over = Math.abs(q.lateral) - track.wallOffset;
    if (over <= 0) continue;
    const side = track.sideVector(q.index);
    const s = Math.sign(q.lateral);
    const n = { x: side.x * s, z: side.y * s }; // outward, from the car into the wall
    car.x -= n.x * over;
    car.z -= n.z * over;
    const p = { x: corner.x - n.x * over, z: corner.z - n.z * over };
    resolveContact(car, null, p, n, WALL_RESTITUTION, WALL_FRICTION);
  }
}
