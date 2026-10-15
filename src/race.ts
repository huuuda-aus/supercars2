import type { Car } from './car';
import type { Track } from './track';

export type RaceState = 'menu' | 'countdown' | 'racing';

export class Race {
  state: RaceState = 'menu';
  readonly totalLaps = 3;
  countdown = 0;
  time = 0;
  finishOrder: Car[] = [];

  start(): void {
    this.state = 'countdown';
    this.countdown = 3;
    this.time = 0;
    this.finishOrder = [];
  }

  toMenu(): void {
    this.state = 'menu';
    this.finishOrder = [];
  }

  /** Call once per physics step. */
  update(dt: number, cars: Car[]): void {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.time = 0;
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
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
