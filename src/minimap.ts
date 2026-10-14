import type { Car } from './car';
import type { Track } from './track';

const PAD = 12; // css px around the circuit inside the panel
const TRIANGLE = 7; // css px, tip-to-centre

/** Top-right overview of the circuit with one triangle per car pointing where it is heading. */
export class Minimap {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly circuit = document.createElement('canvas'); // static layer, drawn once
  private readonly minX: number;
  private readonly minZ: number;
  private readonly scale: number;
  private readonly width: number;
  private readonly height: number;
  private readonly dpr = Math.min(devicePixelRatio || 1, 2);

  constructor(private readonly track: Track, width = 260) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const margin = track.wallOffset + track.wallThickness;
    for (const { p } of track.samples) {
      minX = Math.min(minX, p.x - margin);
      maxX = Math.max(maxX, p.x + margin);
      minZ = Math.min(minZ, p.z - margin);
      maxZ = Math.max(maxZ, p.z + margin);
    }
    this.minX = minX;
    this.minZ = minZ;
    this.scale = (width - PAD * 2) / (maxX - minX);
    this.width = width;
    this.height = Math.ceil((maxZ - minZ) * this.scale + PAD * 2);

    for (const c of [this.canvas, this.circuit]) {
      c.width = Math.round(this.width * this.dpr);
      c.height = Math.round(this.height * this.dpr);
    }
    Object.assign(this.canvas.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      width: `${this.width}px`,
      height: `${this.height}px`,
      borderRadius: '8px',
      background: 'rgba(10, 14, 12, 0.55)',
      border: '1px solid rgba(255, 255, 255, 0.25)',
      pointerEvents: 'none',
    });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.drawCircuit();
  }

  /** World (x, z) to panel css pixels. North-up like the main camera: +x right, +z down. */
  private toPanel(x: number, z: number): [number, number] {
    return [PAD + (x - this.minX) * this.scale, PAD + (z - this.minZ) * this.scale];
  }

  private drawCircuit(): void {
    const ctx = this.circuit.getContext('2d')!;
    ctx.scale(this.dpr, this.dpr);
    const path = new Path2D();
    this.track.samples.forEach(({ p }, i) => {
      const [x, y] = this.toPanel(p.x, p.z);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();

    const roadPx = Math.max(5, 2 * this.track.halfWidth * this.scale);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1c1e24'; // outline
    ctx.lineWidth = roadPx + 3;
    ctx.stroke(path);
    ctx.strokeStyle = '#9a9ca6'; // road
    ctx.lineWidth = roadPx;
    ctx.stroke(path);

    // Start / finish tick across the road at sample 0.
    const { p, tangent } = this.track.samples[0];
    const half = this.track.halfWidth;
    const [x0, y0] = this.toPanel(p.x - tangent.z * half, p.z + tangent.x * half);
    const [x1, y1] = this.toPanel(p.x + tangent.z * half, p.z - tangent.x * half);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  draw(cars: Car[], player: Car, markers: { x: number; z: number; color: string; size: number }[] = []): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.circuit, 0, 0);
    ctx.scale(this.dpr, this.dpr);

    // Missiles and mines.
    for (const m of markers) {
      const [mx, my] = this.toPanel(m.x, m.z);
      ctx.beginPath();
      ctx.arc(mx, my, m.size, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
    }

    // Player last so it sits on top.
    for (const car of [...cars.filter((c) => c !== player), player]) {
      const [x, y] = this.toPanel(car.x, car.z);
      const size = car === player ? TRIANGLE * 1.3 : TRIANGLE;
      ctx.save();
      ctx.translate(x, y);
      // Forward is (sin h, cos h) in (x, z); on the panel +z is down, so rotate "up" onto it.
      ctx.rotate(Math.PI - car.heading);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.7, size * 0.8);
      ctx.lineTo(-size * 0.7, size * 0.8);
      ctx.closePath();
      ctx.fillStyle = `#${car.color.toString(16).padStart(6, '0')}`;
      ctx.fill();
      ctx.lineWidth = car === player ? 2 : 1.2;
      ctx.strokeStyle = car === player ? '#ffffff' : '#101010';
      ctx.stroke();
      ctx.restore();
    }
  }
}
