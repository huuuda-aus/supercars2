const NS = 'http://www.w3.org/2000/svg';
const CX = 100;
const CY = 100;
const R = 86;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text = ''): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

/** Point at `radius` from the dial centre for a dial fraction 0..1 (0 = far left, 0.5 = straight up, 1 = far right). */
function at(fraction: number, radius: number): [number, number] {
  const a = Math.PI * (1 - fraction);
  return [CX + Math.cos(a) * radius, CY - Math.sin(a) * radius];
}

function arc(from: number, to: number, radius: number): string {
  const [x0, y0] = at(from, radius);
  const [x1, y1] = at(to, radius);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

interface DialSpec {
  title: string;
  max: number; // value at the right-hand end
  majorStep: number;
  minorStep: number;
  labelOf: (v: number) => string;
  redFrom?: number; // value where the red zone starts
}

class Dial {
  readonly element: SVGSVGElement;
  private readonly needle: SVGGElement;
  private readonly centreText: SVGTextElement;
  private readonly subText: SVGTextElement;

  constructor(private readonly spec: DialSpec) {
    this.element = svg('svg', { viewBox: '0 0 200 124', class: 'dial' });
    this.element.append(svg('path', { d: `${arc(0, 1, R + 8)} L ${CX + R + 8} ${CY + 12} L ${CX - R - 8} ${CY + 12} Z`, class: 'face' }));
    this.element.append(svg('path', { d: arc(0, 1, R), class: 'rim' }));
    if (spec.redFrom !== undefined) this.element.append(svg('path', { d: arc(spec.redFrom / spec.max, 1, R - 3), class: 'redzone' }));

    for (let v = 0; v <= spec.max + 1e-6; v += spec.minorStep) {
      const major = Math.abs(v / spec.majorStep - Math.round(v / spec.majorStep)) < 1e-6;
      const f = v / spec.max;
      const [x0, y0] = at(f, R - (major ? 12 : 7));
      const [x1, y1] = at(f, R - 1);
      const red = spec.redFrom !== undefined && v >= spec.redFrom - 1e-6;
      this.element.append(svg('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: `tick${major ? ' major' : ''}${red ? ' red' : ''}` }));
      if (major) {
        const [tx, ty] = at(f, R - 24);
        this.element.append(svg('text', { x: tx, y: ty + 4, class: `num${red ? ' red' : ''}` }, spec.labelOf(v)));
      }
    }

    this.centreText = svg('text', { x: CX, y: CY - 26, class: 'big' });
    this.subText = svg('text', { x: CX, y: CY + 8, class: 'unit' }, spec.title);
    // Drawn pointing at the far left (zero); rotating it clockwise by fraction * 180 degrees sweeps it up and over to the right.
    this.needle = svg('g');
    this.needle.append(svg('line', { x1: CX + 14, y1: CY, x2: CX - (R - 6), y2: CY, class: 'needle' }), svg('circle', { cx: CX, cy: CY, r: 6, class: 'hub' }));
    this.element.append(this.centreText, this.subText, this.needle);
  }

  /** Move the needle to `value` (clamped a little past the ends, like a real one bouncing off its stops). */
  set(value: number, centre: string): void {
    const f = Math.max(-0.02, Math.min(1.03, value / this.spec.max));
    this.needle.setAttribute('transform', `rotate(${(f * 180).toFixed(1)} ${CX} ${CY})`);
    if (this.centreText.textContent !== centre) this.centreText.textContent = centre;
  }
}

/** The two semicircular dials at the bottom corners: engine revs (with the gear) on the left, road speed on the right. */
export class Gauges {
  private readonly root = document.createElement('div');
  private readonly rpm = new Dial({ title: 'x1000 rpm', max: 8, majorStep: 1, minorStep: 0.5, labelOf: (v) => String(v), redFrom: 6.5 });
  private readonly speed = new Dial({ title: 'km/h', max: 160, majorStep: 20, minorStep: 10, labelOf: (v) => String(v) });

  constructor() {
    this.root.id = 'gauges';
    this.root.append(this.rpm.element, this.speed.element);
    document.body.append(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** `revs` is a fraction of the redline (about 0..1); `gear` is 1.., 0 for neutral, -1 for reverse. */
  update(revs: number, gear: number, kmh: number): void {
    this.rpm.set(revs * 7, gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear)); // the redline sits at 7 on the dial
    this.speed.set(kmh, String(Math.round(kmh)));
  }
}
