import * as THREE from 'three';
import type { Theme } from './tracks';

interface SkyStyle {
  top: number; // colour overhead
  horizon: number; // haze colour at the horizon (also the fog the far ground fades into)
  cloud: number;
}

const STYLES: Record<Theme, SkyStyle> = {
  grass: { top: 0x4f9be0, horizon: 0xcfe6f7, cloud: 0xffffff },
  snow: { top: 0x9bb6d0, horizon: 0xe8eef5, cloud: 0xffffff },
  mountain: { top: 0x6b86a3, horizon: 0xb8c4cc, cloud: 0xffffff },
};

const DOME_RADIUS = 1500;
const CLOUD_CLUSTERS = 26;

/** A tiny deterministic random generator, so the clouds are the same on every load. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A sky for the third-person view: a gradient dome and a ring of low-poly clouds near the horizon (the camera looks
 * down at the car, so only the band of sky around the horizon is ever on screen). It rides along with the camera, so
 * it never gets closer. Only the haze colour matters to the rest of the scene (it is the fog), see `haze`.
 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly dome: THREE.Mesh;
  private readonly clouds = new THREE.Group();
  private readonly cloudMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.72, flatShading: true, fog: false });
  readonly haze = new THREE.Color();

  constructor() {
    const geo = new THREE.SphereGeometry(DOME_RADIUS, 24, 16);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 3), 3));
    this.dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome, this.clouds);
    this.buildClouds();
    this.setTheme('grass');
  }

  /** Puffy clusters of squashed icospheres, scattered round the horizon at a few heights. */
  private buildClouds(): void {
    const rand = rng(90210);
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let c = 0; c < CLOUD_CLUSTERS; c++) {
      const cluster = new THREE.Group();
      const size = 90 + rand() * 150; // metres across
      const parts = 4 + Math.floor(rand() * 4);
      for (let p = 0; p < parts; p++) {
        const mesh = new THREE.Mesh(puff, this.cloudMaterial);
        const spread = (p / parts - 0.5) * size * 1.2;
        const r = size * (0.22 + rand() * 0.22) * (1 - Math.abs(p / parts - 0.5) * 0.8);
        mesh.scale.set(r * 1.3, r * 0.62, r);
        mesh.position.set(spread, r * 0.3 * rand(), (rand() - 0.5) * size * 0.3);
        cluster.add(mesh);
      }
      // Close to the horizon (an elevation of a few degrees), because that is the sliver of sky the camera sees.
      const angle = (c / CLOUD_CLUSTERS) * Math.PI * 2 + (rand() - 0.5) * 0.18;
      const distance = 650 + rand() * 450;
      const elevation = 0.04 + rand() * 0.12; // radians
      cluster.position.set(Math.cos(angle) * distance, Math.tan(elevation) * distance, Math.sin(angle) * distance);
      cluster.rotation.y = -angle + Math.PI / 2 + (rand() - 0.5) * 0.6; // broad side towards the camera
      this.clouds.add(cluster);
    }
  }

  setTheme(theme: Theme): void {
    const style = STYLES[theme];
    this.haze.set(style.horizon);
    this.cloudMaterial.color.set(style.cloud);
    this.cloudMaterial.emissive.set(style.cloud);
    const top = new THREE.Color(style.top);
    const horizon = new THREE.Color(style.horizon);
    const attr = this.dome.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pos = this.dome.geometry.getAttribute('position');
    const mix = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      // Below the horizon it stays haze; above it fades to the overhead colour, quickly at first (a bright band by the horizon).
      const h = Math.max(0, pos.getY(i) / DOME_RADIUS);
      mix.copy(horizon).lerp(top, Math.pow(h, 0.55));
      attr.setXYZ(i, mix.r, mix.g, mix.b);
    }
    attr.needsUpdate = true;
  }

  /** Follow the camera and let the clouds drift. */
  update(dt: number, camera: THREE.Vector3): void {
    this.group.position.set(camera.x, 0, camera.z);
    this.clouds.rotation.y += dt * 0.006;
  }
}
