import type { Car } from './car';
import type { Track } from './track';

export type RaceState = 'menu' | 'countdown' | 'racing';

export class Race {
  state: RaceState = 'menu';
  totalLaps = 3; // set from the circuit being raced
  readonly weaponsDelay = 10; // seconds into the race before any weapon can be used
  countdown = 0;
  time = 0;
  finishOrder: Car[] = [];
  /** Called on each start-horn beat: short for 3, 2, 1, long for go. */
  onBeep: (long: boolean) => void = () => {};
  private lastBeat = 0;

  start(): void {
    this.state = 'countdown';
    this.countdown = 3;
    this.lastBeat = 4;
    this.time = 0;
    this.finishOrder = [];
  }

  toMenu(): void {
    this.state = 'menu';
    this.finishOrder = [];
  }

  /** Seconds of the weapons lockout left (0 once armed; the full delay before the race starts). */
  get weaponsLockedFor(): number {
    return this.state === 'racing' ? Math.max(0, this.weaponsDelay - this.time) : this.weaponsDelay;
  }

  /** Call once per physics step. */
  update(dt: number, cars: Car[]): void {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const beat = Math.ceil(this.countdown);
      if (beat >= 1 && beat < this.lastBeat) {
        this.lastBeat = beat;
        this.onBeep(false);
      }
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.time = 0;
        this.onBeep(true);
      }
    } else if (this.state === 'racing') {
      this.time += dt;
      for (const c of cars) {
        if (!c.finished && c.lap > this.totalLaps) {
          c.finished = true;
          c.finishTime = this.time;
          this.finishOrder.push(c);
        }
      }
    }
  }

  /** Cars sorted by race standing: finishers first (in finishing order), then by progress, wrecks last. */
  standings(cars: Car[], track: Track): Car[] {
    const byProgress = (a: Car, b: Car) => b.progress(track) - a.progress(track);
    const running = cars.filter((c) => !c.finished && !c.wrecked).sort(byProgress);
    const wrecks = cars.filter((c) => !c.finished && c.wrecked).sort(byProgress);
    return [...this.finishOrder, ...running, ...wrecks];
  }
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
