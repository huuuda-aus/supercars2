const LIFE = 3; // seconds a tooltip stays up, fading the whole way
const HOLD = 0.25; // ... after this much at full strength
const RISE = 70; // px it floats up in that time
const SPACING = 40; // px between tooltips shown at the same moment

interface Popup {
  element: HTMLElement;
  age: number;
  stack: number; // how many tooltips were already up when this one appeared
}

/** Floating text above the player's car (e.g. what a power-up gave): rises and fades out over three seconds. */
export class Popups {
  private readonly layer = document.createElement('div');
  private readonly items: Popup[] = [];

  constructor() {
    this.layer.id = 'popups';
    document.body.append(this.layer);
  }

  /** Show `title` (in `colour`) over a smaller `detail` line. */
  spawn(title: string, detail: string, colour: string): void {
    const element = document.createElement('div');
    element.className = 'popup';
    const head = document.createElement('div');
    head.className = 'popup-title';
    head.textContent = title;
    head.style.color = colour;
    const sub = document.createElement('div');
    sub.className = 'popup-detail';
    sub.textContent = detail;
    element.append(head, sub);
    // A second pickup right after the first starts higher, so they do not overlap.
    const stack = this.items.filter((p) => p.age < 1).length;
    this.layer.append(element);
    this.items.push({ element, age: 0, stack });
  }

  /** Advance the tooltips by `dt` seconds and put them above screen position (x, y). */
  update(dt: number, x: number, y: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.age += dt;
      if (p.age >= LIFE) {
        p.element.remove();
        this.items.splice(i, 1);
        continue;
      }
      const t = p.age / LIFE;
      const rise = RISE * (1 - (1 - t) ** 2);
      p.element.style.transform = `translate(${x}px, ${y - 60 - p.stack * SPACING - rise}px) translate(-50%, -100%)`;
      p.element.style.opacity = String(p.age < HOLD ? 1 : 1 - (p.age - HOLD) / (LIFE - HOLD));
    }
  }

  clear(): void {
    for (const p of this.items) p.element.remove();
    this.items.length = 0;
  }
}
