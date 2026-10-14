export interface Controls {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number; // +1 = left, -1 = right
}

export class Input implements Controls {
  private down = new Set<string>();
  private pressed = new Set<string>();

  constructor() {
    addEventListener('keydown', (e) => {
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
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
  get steer(): number { return +this.held('ArrowLeft', 'KeyA') - +this.held('ArrowRight', 'KeyD'); }
}
