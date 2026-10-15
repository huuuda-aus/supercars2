export interface Controls {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number; // +1 = left, -1 = right
  readonly handbrake: number; // locks the rear wheels: the car's tail steps out for a drift
}

/** True when a key event comes from a text box. */
export function typingInField(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

export class Input implements Controls {
  private down = new Set<string>();
  private pressed = new Set<string>();

  constructor() {
    addEventListener('keydown', (e) => {
      if (typingInField(e)) return; // typing a name is not driving
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }

  /** Forget key presses that nobody read (e.g. made on a menu screen). */
  clear(): void {
    this.pressed.clear();
  }

  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True once per key press; consumed on read. */
  tapped(code: string): boolean {
    return this.pressed.delete(code);
  }

  get throttle(): number { return +this.held('ArrowUp', 'KeyW'); }
  get brake(): number { return +this.held('ArrowDown', 'KeyS'); }
  get handbrake(): number { return +this.held('Space'); }
  get steer(): number { return +this.held('ArrowLeft', 'KeyA') - +this.held('ArrowRight', 'KeyD'); }
}
