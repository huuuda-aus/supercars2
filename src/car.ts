import * as THREE from 'three';
import { buildCarModel, type CarStyle } from './carmodel';
import { collideWalls } from './collision';
import type { Controls } from './input';
import { HULL_HX, HULL_HZ, INERTIA, WHEEL_R, WHEEL_X, WHEEL_Z } from './spec';
import type { Track } from './track';
import { buildWreck, type Wreck } from './wreck';

const GRAVITY = 78; // 30 originally, 90 after first tuning; now 20% of the way back
export const ACCEL = 28;
const BRAKE = 45;
const CLIFF_HEIGHT = 1.0; // arriving this far below the landing ramp's lip counts as hitting its face
export const MAX_SPEED = 30;
const REVERSE_MAX = 12;
export const DRAG = 0.25;
const COAST_DECEL = 7; // m/s^2 lost as soon as the throttle is released (engine braking + rolling resistance)
const COAST_DRAG = 0.06; // extra coast deceleration per m/s
const OFFROAD_GRIP = 0.5; // tyre grip multiplier off the road
const OFFROAD_MAX = 0.55;
const AIR_YAW_DAMPING = 3; // 1/s, how fast leftover spin fades while airborne
const NITRO_TIME = 1.8; // seconds one charge burns
const NITRO_SPEED = 1.4; // top speed multiplier while it burns
const NITRO_ACCEL = 1.7; // acceleration multiplier while it burns
/** Landing harder than this (m/s of vertical speed relative to the road) leaves tyre marks. */
const LAND_SKID_SPEED = 6;
const LAND_SKID_FULL = 20;
const LAND_SKID_TIME = 0.4;
const WRECK_DECEL = 0.5; // 1/s, viscous part of how fast a destroyed car's leftover motion dies away
const WRECK_FRICTION = 12; // m/s^2 of dry scraping: with the wreck mass this out-pulls a car's engine, so pushing slowly does nothing
export const START_LOADOUT = { missiles: 5, mines: 5, nitro: 3, bullets: 100, rearMissiles: 3, oil: 3 };
export type AmmoType = keyof typeof START_LOADOUT;
/** Most a car can carry of each; pickups top up to this. */
export const AMMO_MAX: Record<AmmoType, number> = { missiles: 10, mines: 10, nitro: 5, bullets: 200, rearMissiles: 6, oil: 6 };
const STEER_RAMP = 6; // steering input slew (1/s), so a tap is a gentle turn and a hold is a sharp one
const MAX_STEER_ANGLE = 0.42; // front wheel lock (rad)

/** Extra speed scrub while rotating: speed lost per second = TURN_DECEL * yawRate * speed. */
export const TURN_DECEL = 0.6;

// Tyre model: each axle gives a lateral force that saturates at its grip limit.
export const AXLE_GRIP = 20; // peak lateral acceleration per axle (m/s^2) -> 40 for the whole car
const TIRE_STIFFNESS = 200; // lateral force per radian of slip, before saturation
/** Past this slip angle a tyre is sliding and its grip falls off (up to SLIDE_LOSS) -> spins can build. */
const SLIDE_START = 0.2;
const SLIDE_FULL = 0.6;
const SLIDE_LOSS = 0.55;
/** All-wheel drive: power and braking are shared 50/50, so each axle only loses this much grip at full load. */
const DRIVE_GRIP_LOSS = 0.08;
/** Rear grip lost while the tail is knocked loose (see collision.ts). */
const BREAKAWAY_GRIP_LOSS = 0.7;
const YAW_DAMPING = 0.8; // 1/s
const REAR_GRIP_BIAS = 1.15; // rear axle grips a bit more than the front, so the car understeers before it spins
/** Steering lock shrinks with speed so the front axle stays near its grip peak: lock <= base + L*a/u^2. */
const LOCK_BASE = 0.07;
const LOCK_SPEED_TERM = 90;

/** Handbrake: locks the rear wheels. The rear axle loses most of its grip (so the tail swings out) and slows the car. */
const HANDBRAKE_GRIP_LOSS = 0.6;
const HANDBRAKE_DECEL = 3; // m/s^2 of rear-wheel braking at full pull
const HANDBRAKE_RAMP = 10; // 1/s, how fast the pull builds and releases
/** A slide counts as a drift past this body slip angle (rad) and speed (m/s). */
/** Past this slip angle the car is turned too far sideways to hold a drift: extra yaw damping (1/s per rad over) pulls it back. */
const DRIFT_STABILIZE_FROM = 0.5;
const DRIFT_STABILIZE = 5;
const DRIFT_ANGLE = 0.3;
const DRIFT_MIN_SPEED = 9;
const DRIFT_GRACE = 0.6; // seconds a drift may be interrupted before the combo is banked

/** Driving over an oil slick: tyre grip multiplier, and how much of the braking and drive force still gets to the road. */
const OIL_GRIP = 0.15;
const OIL_TRACTION = 0.45;

const SHIELD_MAX = 12; // seconds of shield a car can hold

const WHEEL_SIGNS: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]]; // FL, FR, RL, RR (x sign, z sign)

/** Per-car multipliers on the base handling constants. The player's car is all 1. */
export interface CarStats {
  accel: number;
  brake: number;
  maxSpeed: number;
  grip: number;
  steer: number;
}

export const BASE_STATS: CarStats = { accel: 1, brake: 1, maxSpeed: 1, grip: 1, steer: 1 };

/** Handling attributes vary by up to +-10% around the player's car. Top speed is identical for every car. */
export function randomStats(spread = 0.1): CarStats {
  const r = () => 1 + (Math.random() * 2 - 1) * spread;
  return { accel: r(), brake: r(), maxSpeed: 1, grip: r(), steer: r() };
}

/**
 * A brick on four wheels: planar rigid body (position, heading, forward/lateral velocity, yaw rate)
 * with a two-axle tyre model, plus a height axis (y, vy) driven by the track's elevation profile.
 * No rolling; spins and slides emerge from tyre saturation and impulse collisions.
 */
export class Car {
  readonly mesh: THREE.Group;
  x = 0;
  z = 0;
  y = 0;
  vy = 0;
  heading = 0; // forward = (sin h, cos h); increasing h turns toward the lateral axis (cos h, -sin h)
  vf = 0; // forward speed (body frame)
  vl = 0; // lateral speed (body frame)
  omega = 0; // yaw rate (rad/s)
  airborne = false;
  trackIndex = 0;
  lap = 0;
  offroad = false;
  nextCheckpoint = 0;
  finished = false;
  finishTime = 0;
  breakaway = 0; // seconds of reduced rear grip left after a sideways tap behind the centre of mass
  respawns = 0; // times the car fell into the pit
  lastImpact = 0; // largest collision impulse since the AI last looked (used to stun AI drivers)

  // Weapons, damage and nitro.
  ammo = { ...START_LOADOUT };
  health = 100;
  wrecked = false; // destroyed for good: stays on the track as a smoking hulk until the race is reset
  justWrecked = false; // set when destroyed; the weapons system turns it into an explosion
  nitroTimer = 0;
  private readonly wreck: Wreck;
  private readonly shield: THREE.Mesh;
  private readonly intactParts: THREE.Object3D[];

  private steerState = 0;
  private handbrakeState = 0;
  private driftGap = 0; // time since the last drifting step
  drifting = false;
  shieldTimer = 0; // while above zero the car takes no damage (pushes and blasts still move it)
  oilTimer = 0; // seconds of slippery tyres left; refreshed by the weapons system while a wheel is on a slick
  landSkid = 0; // seconds of tyre scrub left after touching down hard (read by the skidmarks)
  landStrength = 0; // 0..1, how hard the touchdown was
  driftCombo = 0; // score of the drift in progress
  driftScore = 0; // banked this race
  private pitch = 0; // visual only
  private readonly frontPivots: THREE.Group[];
  private readonly spinners: THREE.Object3D[];
  private readonly flames: THREE.Object3D[];
  private wheelAngle = 0; // visual only

  constructor(
    readonly name: string,
    readonly color = 0xe03030,
    public stats: CarStats = BASE_STATS,
    style: CarStyle = 'coupe',
  ) {
    const model = buildCarModel(color, style);
    this.mesh = model.group;
    this.frontPivots = model.frontPivots;
    this.spinners = model.spinners;
    this.flames = model.flames;
    this.mesh.rotation.order = 'YXZ';
    this.intactParts = [...this.mesh.children];
    this.wreck = buildWreck();
    this.wreck.group.visible = false;
    this.mesh.add(this.wreck.group);
    // A translucent bubble around the car while the shield is up.
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 12).scale(1.05, 0.8, 1.9),
      new THREE.MeshBasicMaterial({ color: 0x55d0ff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    this.shield.position.y = 0.7;
    this.shield.visible = false;
    this.shield.userData.noShadow = true;
    this.mesh.add(this.shield);
  }

  placeOnTrack(track: Track, index: number, lateral = 0): void {
    const s = track.samples[index];
    const side = track.sideVector(index);
    this.x = s.p.x + side.x * lateral;
    this.z = s.p.z + side.y * lateral;
    this.y = s.p.y;
    this.heading = Math.atan2(s.tangent.x, s.tangent.z);
    this.trackIndex = index;
    this.lap = 0;
    this.nextCheckpoint = 0;
    this.finished = false;
    this.finishTime = 0;
    this.vf = this.vl = this.vy = this.omega = 0;
    this.breakaway = 0;
    this.steerState = 0;
    this.handbrakeState = 0;
    this.landSkid = 0;
    this.oilTimer = 0;
    this.drifting = false;
    this.driftGap = 0;
    this.driftCombo = this.driftScore = 0;
    this.airborne = false;
    this.resetLoadout();
    this.syncMesh();
  }

  resetLoadout(): void {
    this.ammo = { ...START_LOADOUT };
    this.health = 100;
    this.wrecked = false;
    this.justWrecked = false;
    this.nitroTimer = 0;
    this.shieldTimer = 0;
    this.showWreck(false);
  }

  private showWreck(on: boolean): void {
    for (const part of this.intactParts) part.visible = !on;
    this.wreck.group.visible = on;
  }

  /** Put the car back on the road before the jump (after falling into the pit), keeping lap progress. */
  respawn(track: Track): void {
    this.respawns++;
    this.respawnAt(track, track.respawnIndex);
  }

  private respawnAt(track: Track, index: number): void {
    const s = track.samples[index];
    this.x = s.p.x;
    this.z = s.p.z;
    this.y = s.p.y;
    this.heading = Math.atan2(s.tangent.x, s.tangent.z);
    this.trackIndex = index;
    this.vf = this.vl = this.vy = this.omega = 0;
    this.steerState = 0;
    this.handbrakeState = 0;
    this.landSkid = 0;
    this.oilTimer = 0;
    this.breakaway = 0;
    this.lastImpact = 0;
    this.airborne = false;
    this.syncMesh();
  }

  /** Space left in the magazine for this ammo type. */
  ammoRoom(type: AmmoType): number {
    return AMMO_MAX[type] - this.ammo[type];
  }

  /** Add ammo up to the carrying limit. Returns how much was actually taken. */
  give(type: AmmoType, amount: number): number {
    const taken = Math.max(0, Math.min(amount, this.ammoRoom(type)));
    this.ammo[type] += taken;
    return taken;
  }

  /** Restore health (never past 100, never for a wreck). Returns how much was restored. */
  repair(amount: number): number {
    if (this.wrecked) return 0;
    const restored = Math.max(0, Math.min(amount, 100 - this.health));
    this.health += restored;
    return restored;
  }

  /** Raise the shield for `seconds` more (capped). Returns how much was added. */
  giveShield(seconds: number): number {
    if (this.wrecked) return 0;
    const added = Math.max(0, Math.min(seconds, SHIELD_MAX - this.shieldTimer));
    this.shieldTimer += added;
    return added;
  }

  /** Fire one nitro charge. Returns false if there is none left or one is already burning. */
  useNitro(): boolean {
    if (this.wrecked || this.ammo.nitro <= 0 || this.nitroTimer > 0) return false;
    this.ammo.nitro--;
    this.nitroTimer = NITRO_TIME;
    return true;
  }

  /** 0..1, how far the handbrake is pulled. */
  get handbrakePull(): number { return this.handbrakeState; }

  get nitroActive(): boolean { return this.nitroTimer > 0; }

  damage(amount: number): void {
    if (this.wrecked || this.shieldTimer > 0) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.wrecked = true;
      this.justWrecked = true;
      this.nitroTimer = 0;
      this.showWreck(true);
    }
  }

  /**
   * Explosion at (cx, cz): shoves the car away (the closer, the harder), kicks its tail loose so it spins,
   * can pop it into the air, and damages it. `falloff` is 1 at the centre and 0 at the edge of `radius`.
   */
  applyBlast(cx: number, cz: number, radius: number, power: number, damage: number, lift: number): void {
    if (this.wrecked) return;
    const dx = this.x - cx;
    const dz = this.z - cz;
    const d = Math.hypot(dx, dz);
    if (d > radius) return;
    const falloff = 1 - d / radius;
    const nx = d > 0.2 ? dx / d : Math.sin(this.heading);
    const nz = d > 0.2 ? dz / d : Math.cos(this.heading);
    const v = this.worldVelocity();
    this.setWorldVelocity(v.x + nx * power * falloff, v.z + nz * power * falloff);
    // Spin direction follows which side of the car the blast is on.
    const side = nx * Math.cos(this.heading) - nz * Math.sin(this.heading);
    this.omega += (side >= 0 ? -1 : 1) * (1.5 + 3 * falloff);
    this.breakaway = Math.max(this.breakaway, 1.0);
    if (lift > 0) this.vy += lift * falloff;
    this.lastImpact = Math.max(this.lastImpact, 1.5 + 4 * falloff);
    this.damage(damage * (0.25 + 0.75 * falloff));
  }

  get topSpeed(): number { return MAX_SPEED * this.stats.maxSpeed * (this.nitroTimer > 0 ? NITRO_SPEED : 1); }

  get speed(): number { return Math.hypot(this.vf, this.vl); }

  worldVelocity(): { x: number; z: number } {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    return { x: fx * this.vf + fz * this.vl, z: fz * this.vf - fx * this.vl };
  }

  setWorldVelocity(vx: number, vz: number): void {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    this.vf = vx * fx + vz * fz;
    this.vl = vx * fz - vz * fx;
  }

  /** World-space xz positions of the four wheel contact points (FL, FR, RL, RR). */
  wheelPoints(): { x: number; z: number }[] {
    return this.localPoints(WHEEL_SIGNS.map(([sx, sz]) => [sx * WHEEL_X, sz * WHEEL_Z]));
  }

  /** Corners of the collision footprint (wheel contact points plus margin). */
  hullCorners(): { x: number; z: number }[] {
    return this.localPoints(WHEEL_SIGNS.map(([sx, sz]) => [sx * HULL_HX, sz * HULL_HZ]));
  }

  private localPoints(pts: number[][]): { x: number; z: number }[] {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    return pts.map(([lx, lz]) => ({ x: this.x + fz * lx + fx * lz, z: this.z - fx * lx + fz * lz }));
  }

  /** Race progress in samples; larger = further ahead. Reversing back over the line counts as behind it. */
  progress(track: Track): number {
    const n = track.sampleCount;
    const i = this.nextCheckpoint === 1 && this.trackIndex > n / 2 ? this.trackIndex - n : this.trackIndex;
    return this.lap * n + i;
  }

  step(dt: number, input: Controls, track: Track): void {
    if (this.nitroTimer > 0) this.nitroTimer = Math.max(0, this.nitroTimer - dt);
    this.landSkid = Math.max(0, this.landSkid - dt);
    this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    this.oilTimer = Math.max(0, this.oilTimer - dt);
    if (this.wrecked) this.wreck.update(dt);

    const q = track.query(this.x, this.z, this.trackIndex);
    this.offroad = Math.abs(q.lateral) > track.halfWidth;
    this.trackIndex = q.index;

    // Checkpoints must be passed in order; crossing checkpoint 0 completes a lap. A wreck sliding over the
    // line does not count.
    if (!this.wrecked && track.inCheckpoint(this.trackIndex, this.nextCheckpoint)) {
      if (this.nextCheckpoint === 0) this.lap++;
      this.nextCheckpoint = (this.nextCheckpoint + 1) % track.checkpointCount;
    }

    // Mid-air there is no control: no tyre grip, no engine, no steering. The velocity stays fixed in the
    // world (the body-frame components would rotate with the car and bend the flight path), and any spin
    // carried off the lip dies away quickly instead of turning the car round.
    const airVelocity = this.airborne ? this.worldVelocity() : null;
    if (this.airborne) this.omega *= Math.exp(-AIR_YAW_DAMPING * dt);
    else if (this.wrecked) this.slideToStop(dt);
    else this.drive(dt, input);

    this.updateDrift(dt);

    this.heading += this.omega * dt;
    if (airVelocity) this.setWorldVelocity(airVelocity.x, airVelocity.z);
    const v = this.worldVelocity();
    this.x += v.x * dt;
    this.z += v.z * dt;

    collideWalls(this, track);

    // Vertical: free fall, snap to the ground, inherit the slope's vertical speed on contact.
    const gq = track.query(this.x, this.z, this.trackIndex);
    const ground = gq.gap ? track.pitFloor : gq.height;
    if (!this.wrecked && !gq.gap && this.airborne && this.y < ground - CLIFF_HEIGHT) {
      this.respawn(track); // arrived far below the landing ramp and hit its face
      return;
    }
    this.vy -= GRAVITY * dt;
    this.y += this.vy * dt;
    if (gq.gap && this.y <= track.pitFloor + 0.05) {
      if (!this.wrecked) {
        this.respawn(track); // dropped into the pit
        return;
      }
      // A wreck stays where it fell.
      this.y = track.pitFloor + 0.05;
      this.vy = 0;
      this.vf = this.vl = this.omega = 0;
      this.airborne = false;
    }
    if (this.y <= ground) {
      this.y = ground;
      const t = track.samples[gq.index].tangent;
      const v = this.worldVelocity();
      const roadVy = gq.slope * (v.x * t.x + v.z * t.z);
      const impact = roadVy - this.vy; // how fast we came down onto the road
      if (this.airborne && !this.wrecked && impact > LAND_SKID_SPEED) {
        this.landSkid = LAND_SKID_TIME;
        this.landStrength = Math.min(1, (impact - LAND_SKID_SPEED) / (LAND_SKID_FULL - LAND_SKID_SPEED));
      }
      this.vy = roadVy;
      this.airborne = false;
    } else {
      this.airborne = this.y - ground > 0.15;
    }

    // Visual pitch: follow the road under the front/rear wheels, or the flight path in the air.
    let targetPitch: number;
    if (this.airborne) {
      targetPitch = Math.max(-0.5, Math.min(0.5, Math.atan2(this.vy, Math.max(Math.abs(this.vf), 5))));
    } else {
      const w = this.wheelPoints();
      const front = track.query(w[0].x, w[0].z, this.trackIndex).height;
      const rear = track.query(w[2].x, w[2].z, this.trackIndex).height;
      targetPitch = Math.atan2(front - rear, 2 * WHEEL_Z);
    }
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 12);
    this.wheelAngle += (this.vf * dt) / WHEEL_R;

    this.syncMesh();
  }

  /** Detect a drift (a sustained slide at speed) and score it; the combo is banked a moment after the slide ends. */
  private updateDrift(dt: number): void {
    const slip = Math.abs(Math.atan2(this.vl, Math.max(Math.abs(this.vf), 1)));
    this.drifting = !this.wrecked && !this.airborne && this.speed > DRIFT_MIN_SPEED && slip > DRIFT_ANGLE;
    if (this.drifting) {
      this.driftGap = 0;
      // Faster and sideways-er pays more.
      this.driftCombo += this.speed * Math.min(slip, 1.2) * dt * 4;
    } else if (this.driftCombo > 0) {
      this.driftGap += dt;
      if (this.wrecked || this.driftGap > DRIFT_GRACE) {
        if (!this.wrecked) this.driftScore += this.driftCombo;
        this.driftCombo = 0; // a crash or wreck loses the combo
      }
    }
  }

  /** A destroyed car just skids to a halt. */
  private slideToStop(dt: number): void {
    const k = Math.exp(-WRECK_DECEL * dt);
    this.vf *= k;
    this.vl *= k;
    this.omega *= k;
    const speed = this.speed;
    if (speed < WRECK_FRICTION * dt + 0.05) {
      this.vf = this.vl = this.omega = 0;
    } else {
      const scale = 1 - (WRECK_FRICTION * dt) / speed;
      this.vf *= scale;
      this.vl *= scale;
    }
  }

  /** Engine, brakes, drag and the two tyre axles; updates body-frame velocity and yaw rate. */
  private drive(dt: number, input: Controls): void {
    const st = this.stats;
    const u = this.vf;
    const v = this.vl;
    const w = this.omega;

    // Longitudinal acceleration.
    const maxSpeed = this.topSpeed * (this.offroad ? OFFROAD_MAX : 1);
    let ax = 0;
    const boost = this.nitroTimer > 0 ? NITRO_ACCEL : 1;
    if (input.throttle && u < maxSpeed) ax += ACCEL * st.accel * boost;
    if (input.brake) ax -= u > 0.5 ? BRAKE * st.brake : u > -REVERSE_MAX ? ACCEL * st.accel * 0.6 : 0;
    if (!input.throttle && !input.brake) {
      const coast = COAST_DECEL + COAST_DRAG * Math.abs(u);
      ax -= Math.abs(u) <= coast * dt ? u / dt : Math.sign(u) * coast;
    }
    if (u > maxSpeed) ax -= (u - maxSpeed) * 2;
    ax -= u * DRAG;
    const oiled = this.oilTimer > 0;
    if (oiled) ax *= OIL_TRACTION; // wheels spin or lock instead of gripping

    // Steering: ramp toward the input, then convert to a front wheel angle.
    const dSteer = input.steer - this.steerState;
    this.steerState += Math.sign(dSteer) * Math.min(Math.abs(dSteer), STEER_RAMP * dt);
    const lock = Math.min(MAX_STEER_ANGLE, LOCK_BASE + LOCK_SPEED_TERM / Math.max(u * u, 1));
    const delta = this.steerState * lock * st.steer;

    // AWD: the drive/brake force is split evenly; both axles lose a little grip under load.
    const load = Math.min(1, Math.abs(ax) / ACCEL);
    const grip = AXLE_GRIP * st.grip * (this.offroad ? OFFROAD_GRIP : 1) * (1 - DRIVE_GRIP_LOSS * load) * (oiled ? OIL_GRIP : 1);
    const fFront = tyreForce(u, v + WHEEL_Z * w, delta, grip);
    this.breakaway = Math.max(0, this.breakaway - dt);
    const looseness = 1 - BREAKAWAY_GRIP_LOSS * Math.min(1, this.breakaway / 0.4);
    const pull = Math.sign(input.handbrake - this.handbrakeState) * Math.min(Math.abs(input.handbrake - this.handbrakeState), HANDBRAKE_RAMP * dt);
    this.handbrakeState += pull;
    const hbGrip = 1 - HANDBRAKE_GRIP_LOSS * this.handbrakeState;
    const fRear = tyreForce(u, v - WHEEL_Z * w, 0, grip * REAR_GRIP_BIAS * looseness * hbGrip);
    const axFront = ax / 2; // drive force of the front axle, along the wheels
    const fxFront = axFront * Math.cos(delta) - fFront * Math.sin(delta);
    const fyFront = axFront * Math.sin(delta) + fFront * Math.cos(delta);
    // Locked rear wheels deliver no drive; they brake instead.
    const hbBrake = Math.min(HANDBRAKE_DECEL * this.handbrakeState, Math.abs(u) / dt) * Math.sign(u);
    const fxRear = ax / 2 * (1 - this.handbrakeState) - hbBrake;

    this.vf = u + (fxRear + fxFront + v * w) * dt;
    this.vl = v + (fyFront + fRear - u * w) * dt;
    this.omega = w + ((WHEEL_Z * fyFront - WHEEL_Z * fRear) / INERTIA) * dt;
    this.omega *= Math.exp(-YAW_DAMPING * dt);
    const slip = Math.abs(Math.atan2(this.vl, Math.max(Math.abs(this.vf), 1)));
    if (slip > DRIFT_STABILIZE_FROM) this.omega *= Math.exp(-DRIFT_STABILIZE * (slip - DRIFT_STABILIZE_FROM) * dt);
    this.vf *= Math.max(0, 1 - TURN_DECEL * Math.abs(this.omega) * dt);
  }

  syncMesh(): void {
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.heading;
    this.mesh.rotation.x = -this.pitch; // +z is forward, so a positive x rotation would lower the nose
    for (const p of this.frontPivots) p.rotation.y = this.steerState * 0.45;
    for (const w of this.spinners) w.rotation.x = this.wheelAngle;
    // The bubble pulses, and flickers in its last two seconds as a warning.
    const shielded = this.shieldTimer > 0 && !this.wrecked;
    this.shield.visible = shielded && (this.shieldTimer > 2 || Math.floor(this.shieldTimer * 8) % 2 === 0);
    if (shielded) (this.shield.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.08 * Math.sin(this.shieldTimer * 9);
    const burning = this.nitroTimer > 0;
    for (const f of this.flames) {
      f.visible = burning;
      if (burning) f.scale.set(1, 1, 0.8 + Math.random() * 0.5);
    }
  }
}

/**
 * Lateral force on one axle (in the wheel's own lateral direction) from the velocity of the axle
 * in the car frame and the wheel angle. Saturates smoothly at `grip`.
 */
function tyreForce(u: number, vAxle: number, delta: number, grip: number): number {
  const along = u * Math.cos(delta) + vAxle * Math.sin(delta);
  const across = -u * Math.sin(delta) + vAxle * Math.cos(delta);
  const slip = Math.atan2(across, Math.max(Math.abs(along), 2));
  const sliding = Math.min(1, Math.max(0, (Math.abs(slip) - SLIDE_START) / (SLIDE_FULL - SLIDE_START)));
  const limit = grip * (1 - SLIDE_LOSS * sliding);
  return -limit * Math.tanh((TIRE_STIFFNESS * slip) / limit);
}
