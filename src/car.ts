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

/**
 * Extra speed scrub while rotating: speed lost per second = TURN_DECEL * yawRate * speed. Kept small: a corner should
 * cost speed because the tyres are working hard (steered front wheels drag, sliding costs speed), not by decree.
 */
export const TURN_DECEL = 0.1;

// Tyre model: each axle gives a lateral force that saturates at its grip limit.
export const AXLE_GRIP = 20; // peak lateral acceleration per axle (m/s^2) -> 40 for the whole car
const TIRE_STIFFNESS = 200; // lateral force per radian of slip, before saturation
/** Past this slip angle a tyre is sliding and its grip falls off (up to SLIDE_LOSS) -> spins can build. */
const SLIDE_START = 0.2;
const SLIDE_FULL = 0.6;
const SLIDE_LOSS = 0.3;
/**
 * All-wheel drive with a rear bias: of the engine force the rear axle takes this share, the front the rest. Braking is
 * the other way round (the front does most of it). Each axle's longitudinal force eats into its grip (a friction
 * circle), so hard throttle in a bend takes lateral grip off the rear (power oversteer) and hard braking takes it off
 * the front (it ploughs on).
 */
const DRIVE_REAR_SHARE = 0.8;
const BRAKE_FRONT_SHARE = 0.78;
const CIRCLE_FLOOR = 0.35; // an axle never loses more than this much of its lateral grip to the friction circle
/** Weight transfer: accelerating loads the rear and lightens the front, braking and lifting do the opposite. */
const LOAD_TRANSFER = 0.3; // grip change per (longitudinal accel / ACCEL) while accelerating
const LOAD_TRANSFER_BRAKING = 0.2; // ... while braking and lifting (weight shifts less than the brakes' raw force suggests)
/** Pedal response (1/s): the car does not snap between full power and none, but a tap is still a quick blip. */
const THROTTLE_RISE = 5;
const THROTTLE_FALL = 7;
const BRAKE_RISE = 9;
const BRAKE_FALL = 12;
/** Rear grip lost while the tail is knocked loose (see collision.ts). */
const BREAKAWAY_GRIP_LOSS = 0.7;
const YAW_DAMPING = 0.5; // 1/s
const REAR_GRIP_BIAS = 0.88; // rear axle grips a bit more than the front, so the car understeers before it spins
/**
 * Steering lock shrinks with speed (lock <= base + L*a/u^2). Set generously, so at speed full lock overloads the front
 * tyres: it ploughs on (understeer) instead of the car taking any input cleanly.
 */
const LOCK_BASE = 0.12;
const LOCK_SPEED_TERM = 120;

/** Handbrake: locks the rear wheels. The rear axle loses most of its grip (so the tail swings out) and slows the car. */
const HANDBRAKE_GRIP_LOSS = 0.5;
const HANDBRAKE_DECEL = 3; // m/s^2 of rear-wheel braking at full pull
const HANDBRAKE_RAMP = 10; // 1/s, how fast the pull builds and releases
/** A slide counts as a drift past this body slip angle (rad) and speed (m/s). */
/** Past this slip angle the car is turned too far sideways to hold a drift: extra yaw damping (1/s per rad over) pulls it back. */
const DRIFT_STABILIZE_FROM = 0.5;
const DRIFT_STABILIZE = 10;
const DRIFT_ANGLE = 0.3;
const DRIFT_MIN_SPEED = 9;
const DRIFT_GRACE = 0.6; // seconds a drift may be interrupted before the combo is banked

/** Driving over an oil slick: tyre grip multiplier, and how much of the braking and drive force still gets to the road. */
const OIL_GRIP = 0.15;
const OIL_TRACTION = 0.45;

const SHIELD_MAX = 12; // seconds of shield a car can hold

/**
 * Traction and wheelspin. The driven wheels (all four) have their own speed; the tyres turn the difference between that
 * and the road speed into drive force, up to what the tyres can hold. Ask for more than that (strong engine on poor
 * tyres, a standing start, nitro, a wet or oily surface) and the wheels spin: the drive force drops to the sliding value
 * and the tyres lose much of their cornering grip, so the tail steps out under steering. The limit rises with speed
 * (the tyres are pressed on harder and the engine has less to give), so it is mostly a launch problem.
 */
const TRACTION = 15; // m/s^2 of drive force per unit of grip stat, from standstill
const TRACTION_SPEED = 14; // m/s: the limit doubles by this speed
const WHEEL_STIFFNESS = 10; // 1/s: drive force per m/s of wheel slip, until it hits the limit
const WHEEL_LAG = 0.25; // wheel inertia relative to the car: light wheels race ahead the moment the tyres let go
const SLIDING_DRIVE = 0.78; // drive force kept once spinning (sliding friction is lower than peak grip)
const SPIN_LATERAL_LOSS = 0.5; // cornering grip lost at full wheelspin (the tail steps out)
const SPIN_RANGE = 6; // m/s of slip beyond the point where the tyres let go that counts as full wheelspin
const SPIN_ENGINE_FADE = 8; // m/s of such slip over which the engine's push dies away (a spinning engine hits its revs)

/**
 * High-speed looseness: the rear end gives up grip when the car is going fast AND steered hard, whatever the engine is
 * doing. Flat out into a bend with the wheel hard over, the tail steps out unless the driver backs off or eases the
 * steering, or the tyres are good enough (better tyres shrink the effect, see tyreFactor in drive()). It follows the
 * driver's input, not the car's yaw, so it cannot feed on itself.
 */
const HS_SPEED_FROM = 12; // m/s where it starts
const HS_SPEED_FULL = 25; // m/s where it is at full effect
const HS_STEER_FROM = 0.45; // steering input (0..1) where it starts: throwing the car in hard
const HS_STEER_RANGE = 0.55; // ... and the extra input until full effect
const HS_LOSS = 0.22; // rear grip lost at full effect (stock tyres)

/**
 * Sliding sideways scrubs speed (rubber on tarmac): past this body slip angle the sideways velocity bleeds away at up
 * to SLIDE_SCRUB (1/s). Without it a car could hold a 50 degree broadside slide at full speed indefinitely.
 */
const SLIDE_SCRUB_FROM = 0.25;
const SLIDE_SCRUB_RANGE = 0.45;
const SLIDE_SCRUB = 3;

/** Hands off the wheel in a slide: the car straightens itself with this yaw acceleration (rad/s^2 per rad of body slip). */
const DRIFT_CATCH = 9;
const DRIFT_CATCH_DAMP = 3; // 1/s of extra yaw damping while it does so, so it does not swing back past straight

const WHEEL_SIGNS: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]]; // FL, FR, RL, RR (x sign, z sign)

/**
 * Per-car multipliers on the base handling constants (about 1 is a good car), plus hit points. Where they come from
 * (stock car, upgrades, AI class) is upgrades.ts.
 */
export interface CarStats {
  accel: number;
  brake: number;
  maxSpeed: number;
  grip: number;
  steer: number;
  maxHealth: number; // hit points when repaired
  nitro: number; // how hard a nitro charge kicks (scales its speed and acceleration bonus)
}

export const BASE_STATS: CarStats = { accel: 1, brake: 1, maxSpeed: 1, grip: 1, steer: 1, maxHealth: 100, nitro: 1 };

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
  health: number;
  wrecked = false; // destroyed for good: stays on the track as a smoking hulk until the race is reset
  justWrecked = false; // set when destroyed; the weapons system turns it into an explosion
  nitroTimer = 0;
  private readonly wreck: Wreck;
  private readonly shield: THREE.Mesh;
  private readonly intactParts: THREE.Object3D[];

  private steerState = 0;
  private handbrakeState = 0;
  private throttleState = 0;
  private wheelSpeed = 0; // m/s at the tyre contact patch; above the road speed means spinning
  private spinAmount = 0;
  private brakeState = 0;
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
    this.health = stats.maxHealth;
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
    this.throttleState = this.brakeState = 0;
    this.wheelSpeed = 0;
    this.spinAmount = 0;
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
    this.health = this.stats.maxHealth;
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
    this.throttleState = this.brakeState = 0;
    this.wheelSpeed = 0;
    this.spinAmount = 0;
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

  /** Restore health (never past the car's maximum, never for a wreck). Returns how much was restored. */
  repair(amount: number): number {
    if (this.wrecked) return 0;
    const restored = Math.max(0, Math.min(amount, this.stats.maxHealth - this.health));
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

  /** 0..1: how hard the driven wheels are spinning (a burnout), 0 while they grip. For the skid marks. */
  get burnout(): number { return this.spinAmount; }

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

  get topSpeed(): number { return MAX_SPEED * this.stats.maxSpeed * (this.nitroTimer > 0 ? 1 + (NITRO_SPEED - 1) * this.stats.nitro : 1); }

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

  /**
   * Drive force that actually reaches the road. Advances the wheel speed: the engine pushes the wheels, the tyres push
   * back (and so push the car), and when the engine asks for more than the tyres hold the wheels run away.
   */
  private driveForce(engine: number, u: number, surface: number, dt: number): number {
    const road = Math.max(u, 0);
    if (engine <= 0.01) {
      // No power: the wheels simply roll with the road again.
      this.wheelSpeed += (road - this.wheelSpeed) * Math.min(1, 14 * dt);
      this.spinAmount = 0;
      return 0;
    }
    const limit = TRACTION * this.stats.grip * surface * (1 + road / TRACTION_SPEED);
    const slip = this.wheelSpeed - road;
    const raw = WHEEL_STIFFNESS * slip;
    const spinning = raw > limit;
    // Gripping: the tyres deliver what the slip asks for. Past the limit they let go and deliver less.
    const force = spinning ? limit * SLIDING_DRIVE : Math.max(-limit, raw);
    const over = spinning ? slip - limit / WHEEL_STIFFNESS : 0;
    this.spinAmount = Math.min(1, over / SPIN_RANGE);
    const fade = spinning ? Math.max(0.2, 1 - over / SPIN_ENGINE_FADE) : 1;
    this.wheelSpeed = Math.max(0, this.wheelSpeed + (((engine * fade * (1 + WHEEL_LAG)) - force) / WHEEL_LAG) * dt);
    return force;
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

    // Pedals ramp toward the keys, so a tap is a quick blip and lifting off fades the power instead of cutting it.
    const slew = (state: number, target: number, rise: number, fall: number) =>
      state + Math.sign(target - state) * Math.min(Math.abs(target - state), (target > state ? rise : fall) * dt);
    this.throttleState = slew(this.throttleState, input.throttle, THROTTLE_RISE, THROTTLE_FALL);
    this.brakeState = slew(this.brakeState, input.brake, BRAKE_RISE, BRAKE_FALL);

    // Longitudinal acceleration.
    const maxSpeed = this.topSpeed * (this.offroad ? OFFROAD_MAX : 1);
    let ax = 0;
    const boost = this.nitroTimer > 0 ? 1 + (NITRO_ACCEL - 1) * st.nitro : 1;
    const engine = u < maxSpeed && u > -1 ? ACCEL * st.accel * boost * this.throttleState : 0;
    const surface = (this.offroad ? OFFROAD_GRIP : 1) * (this.oilTimer > 0 ? OIL_GRIP : 1);
    ax += this.driveForce(engine, u, surface, dt);
    if (this.brakeState > 0) ax -= (u > 0.5 ? BRAKE * st.brake : u > -REVERSE_MAX ? ACCEL * st.accel * 0.6 : 0) * this.brakeState;
    const pedal = Math.max(this.throttleState, this.brakeState);
    if (pedal < 1) {
      const coast = COAST_DECEL + COAST_DRAG * Math.abs(u);
      ax -= (Math.abs(u) <= coast * dt ? u / dt : Math.sign(u) * coast) * (1 - pedal);
    }
    if (u > maxSpeed) ax -= (u - maxSpeed) * 2;
    ax -= u * DRAG;
    const oiled = this.oilTimer > 0;
    if (oiled && ax < 0) ax *= OIL_TRACTION; // brakes lock instead of gripping (driving wheels just spin, see driveForce)

    // Steering: ramp toward the input, then convert to a front wheel angle.
    const dSteer = input.steer - this.steerState;
    this.steerState += Math.sign(dSteer) * Math.min(Math.abs(dSteer), STEER_RAMP * dt);
    const lock = Math.min(MAX_STEER_ANGLE, LOCK_BASE + LOCK_SPEED_TERM / Math.max(u * u, 1));
    const delta = this.steerState * lock * st.steer;

    // Split the longitudinal force between the axles and shift weight with it.
    const frontShare = ax > 0 ? 1 - DRIVE_REAR_SHARE : BRAKE_FRONT_SHARE;
    const axFront = ax * frontShare; // force of the front axle, along the wheels
    this.breakaway = Math.max(0, this.breakaway - dt);
    const looseness = 1 - BREAKAWAY_GRIP_LOSS * Math.min(1, this.breakaway / 0.4);
    const pull = Math.sign(input.handbrake - this.handbrakeState) * Math.min(Math.abs(input.handbrake - this.handbrakeState), HANDBRAKE_RAMP * dt);
    this.handbrakeState += pull;
    const hbGrip = 1 - HANDBRAKE_GRIP_LOSS * this.handbrakeState;
    // Locked rear wheels deliver no drive; they brake instead.
    const hbBrake = Math.min(HANDBRAKE_DECEL * this.handbrakeState, Math.abs(u) / dt) * Math.sign(u);
    const fxRear = (ax - axFront) * (1 - this.handbrakeState) - hbBrake;

    const transfer = Math.max(-1.5, Math.min(1.5, ax / ACCEL)) * (ax > 0 ? LOAD_TRANSFER : LOAD_TRANSFER_BRAKING);
    // Spinning wheels have little left for cornering: steer while burning rubber and the tail swings out.
    const spin = this.spinAmount;
    const base = AXLE_GRIP * st.grip * (this.offroad ? OFFROAD_GRIP : 1) * (oiled ? OIL_GRIP : 1) * (1 - SPIN_LATERAL_LOSS * spin);
    const gripFront = base * (1 - transfer);
    const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
    const tyreFactor = Math.min(1, Math.max(0.1, 1 - (st.grip - 0.7) * 2.1)); // stock tyres 1, the best tyres 0.1
    const looseAtSpeed =
      1 - HS_LOSS * tyreFactor * clamp01((u - HS_SPEED_FROM) / (HS_SPEED_FULL - HS_SPEED_FROM)) * clamp01((Math.abs(this.steerState) - HS_STEER_FROM) / HS_STEER_RANGE);
    const gripRear = base * REAR_GRIP_BIAS * (1 + transfer) * looseness * hbGrip * looseAtSpeed;
    // Friction circle: what the axle spends pushing or braking is not left over for cornering.
    const circle = (fx: number, g: number) => Math.max(CIRCLE_FLOOR, Math.sqrt(Math.max(0, 1 - (fx / g) ** 2)));
    const fFront = tyreForce(u, v + WHEEL_Z * w, delta, gripFront * circle(axFront, gripFront));
    const fRear = tyreForce(u, v - WHEEL_Z * w, 0, gripRear * circle(fxRear, gripRear));
    const fxFront = axFront * Math.cos(delta) - fFront * Math.sin(delta);
    const fyFront = axFront * Math.sin(delta) + fFront * Math.cos(delta);

    this.vf = u + (fxRear + fxFront + v * w) * dt;
    this.vl = v + (fyFront + fRear - u * w) * dt;
    this.omega = w + ((WHEEL_Z * fyFront - WHEEL_Z * fRear) / INERTIA) * dt;
    this.omega *= Math.exp(-YAW_DAMPING * dt);
    const slip = Math.abs(Math.atan2(this.vl, Math.max(Math.abs(this.vf), 1)));
    this.vl *= Math.exp(-SLIDE_SCRUB * Math.min(1, Math.max(0, (slip - SLIDE_SCRUB_FROM) / SLIDE_SCRUB_RANGE)) * dt);
    if (slip > DRIFT_STABILIZE_FROM) this.omega *= Math.exp(-DRIFT_STABILIZE * (slip - DRIFT_STABILIZE_FROM) * dt);
    // Let go of the steering in a slide and the car straightens itself (a tap of the handbrake is then a flick, not a
    // spin). Hold the wheel in or against the slide and you are in charge: no help.
    if (this.handbrakeState < 0.3 && Math.abs(u) > 4) {
      const hands = 1 - Math.min(1, Math.abs(this.steerState));
      const slipAngle = Math.atan2(this.vl, Math.max(Math.abs(this.vf), 1));
      this.omega += DRIFT_CATCH * slipAngle * hands * hands * dt;
      this.omega *= Math.exp(-DRIFT_CATCH_DAMP * Math.min(1, Math.abs(slipAngle) * 2) * hands * hands * dt);
    }
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
