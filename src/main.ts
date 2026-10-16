import * as THREE from 'three';
import { AiDriver, LEVELS } from './ai';
import { Car } from './car';
import { garageCar, GARAGE, type CarId } from './garage';
import { beginCollisionStep, collideCars, onContact } from './collision';
import { Input, type Controls } from './input';
import { GameAudio } from './audio';
import { Gauges } from './gauges';
import { Minimap } from './minimap';
import { Popups } from './popups';
import { PICKUP_COLOURS, Pickups } from './pickups';
import { buildCarModel } from './carmodel';
import { cleanName, loadGame, loadSettings, newGame, prizeFor, saveGame, saveSettings, type SaveGame } from './save';
import { Screens } from './screens';
import { scoreRace, type ScoreBreakdown } from './score';
import { submitLap } from './records';
import { allTracks, THEMES, trackForRace, TRACK_LIST, type Theme, type TrackDef } from './tracks';
import { formatTime, Race } from './race';
import { applyGroundUVs, createTrees, makeGroundTexture } from './scenery';
import { Skidmarks } from './skidmarks';
import { Sky } from './sky';
import { Track } from './track';
import { aiStats, MAX_UPGRADE_LEVEL, RIVAL_CAR_TIER, starterStats, statsFor, upgradePrice, type UpgradeSlot } from './upgrades';
import { Weapons } from './weapons';

const STEP = 1 / 120; // fixed physics timestep, independent of display refresh rate
const ORTHO_SIZE = 45; // visible world units vertically in top-down mode

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3d6a37);
// Low-ish sun from one side: long shadows and strongly different shading on slopes facing it or away.
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3b4a30, 1.05));
const SUN_OFFSET = new THREE.Vector3(-45, 55, 25);
const sun = new THREE.DirectionalLight(0xfff1d8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -60;
sun.shadow.camera.right = sun.shadow.camera.top = 60;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

/** Mark every mesh under an object as shadow caster and/or receiver. */
function shade(obj: THREE.Object3D, cast: boolean, receive: boolean): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = cast && !o.userData.noShadow; // smoke and embers cast no shadow
      o.receiveShadow = receive;
    }
  });
}

const sky = new Sky();
scene.add(sky.group);

const groundTextures = new Map<Theme, THREE.CanvasTexture>();
function groundTexture(theme: Theme): THREE.CanvasTexture {
  let tex = groundTextures.get(theme);
  if (!tex) {
    tex = makeGroundTexture(theme);
    groundTextures.set(theme, tex);
  }
  return tex;
}

// The ground reaches well past where the fog has swallowed it, so there is no visible edge. Its texture coordinates
// are scaled to keep the tiles the size they were on the old 1000 m plane (and in step with the terrain beside the road).
const groundGeometry = new THREE.PlaneGeometry(3000, 3000);
const groundUv = groundGeometry.getAttribute('uv');
for (let i = 0; i < groundUv.count; i++) groundUv.setXY(i, groundUv.getX(i) * 3, groundUv.getY(i) * 3);
const ground = new THREE.Mesh(groundGeometry, new THREE.MeshLambertMaterial({ map: groundTexture('grass') }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
shade(ground, false, true);
scene.add(ground);

// Everything that belongs to the circuit being raced; swapped as a whole by loadTrack().
let track!: Track;
let skidmarks!: Skidmarks;
let pickups!: Pickups;
let minimap!: Minimap;
let circuitObjects: THREE.Object3D[] = [];
let loadedTrackKey = '';

/** Identifies a circuit including its contents, so an edited custom track is rebuilt even though its id is the same. */
const trackKey = (def: TrackDef) => `${def.id}|${JSON.stringify([def.points, def.crossings, def.theme, def.laps, def.hills])}`;
let raceUiVisible = false;

let playerStats = starterStats();
let playerName = 'You';
let car = new Car(playerName, 0xd8352a, playerStats, 'hatch');
const rivals = [
  new Car('Blue', 0x3070e0, undefined, 'sedan'),
  new Car('Yellow', 0xe0c030, undefined, 'hatch'),
  new Car('Green', 0x30c060, undefined, 'coupe'),
  new Car('Orange', 0xe07820, undefined, 'sedan'),
  new Car('Purple', 0x9040d0, undefined, 'hatch'),
  new Car('White', 0xe8e8e8, undefined, 'coupe'),
  new Car('Cyan', 0x30c8d0, undefined, 'sedan'),
].map((car) => ({ car, ai: undefined as unknown as AiDriver }));
const allCars = [car, ...rivals.map((r) => r.car)];
allCars.forEach((c) => {
  scene.add(c.mesh);
  shade(c.mesh, true, true);
});

const weapons = new Weapons(scene);
let pickupMsg = '';
let raceCash = 0; // cash crates picked up in this race; banked when you finish it (career only)
// Lap timing for the score: the player's laps this race, and how many of them improved the track record.
let raceLapRecords = 0;
let bestLapThisRace: number | null = null;
let lapStartedAt = 0;
let lastPlayerLap = 0;
let currentTrackId = '';
let pickupMsgTime = 0;
const race = new Race();

/** Build the world for a circuit: road, walls, terrain, scenery, skid marks, power-up spots and the minimap. */
function loadTrack(def: TrackDef): void {
  if (loadedTrackKey === trackKey(def)) return;
  for (const o of circuitObjects) {
    scene.remove(o);
    o.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.InstancedMesh) c.geometry.dispose();
    });
  }
  minimap?.destroy();

  track = new Track(def);
  circuitObjects = [track.mesh, track.centreLine, track.kerbs, track.finishLine, track.walls, track.terrain, track.pit, track.deck];
  scene.add(...circuitObjects);
  shade(track.mesh, true, true);
  shade(track.centreLine, false, true);
  shade(track.kerbs, false, true);
  shade(track.finishLine, false, true);
  shade(track.pit, false, true);
  shade(track.deck, true, true);
  shade(track.walls, true, true);
  shade(track.terrain, true, true);
  applyGroundUVs(track.terrain);

  const style = THEMES[def.theme];
  const tex = groundTexture(def.theme);
  scene.background = new THREE.Color(style.background);
  sky.setTheme(def.theme);
  scene.fog = new THREE.Fog(sky.haze, 320, 900); // the far ground fades into the haze at the horizon
  (ground.material as THREE.MeshLambertMaterial).map = tex;
  (ground.material as THREE.MeshLambertMaterial).needsUpdate = true;
  (track.terrain.material as THREE.MeshLambertMaterial).map = tex;
  const trees = createTrees(track);
  scene.add(trees);
  circuitObjects.push(trees);

  skidmarks = new Skidmarks(track);
  scene.add(skidmarks.mesh);
  circuitObjects.push(skidmarks.mesh);

  pickups = new Pickups(track);
  scene.add(pickups.group);
  circuitObjects.push(pickups.group);
  pickups.onCollect = (c, kind, text, value) => {
    audio.playEvent({ type: 'pickup', x: c.x, z: c.z, kind });
    if (c !== car) return;
    if (kind === 'cash') raceCash += value;
    popups.spawn(PICKUP_NAMES[kind] ?? kind, text, PICKUP_COLOURS[kind]);
    pickupMsg = text;
    pickupMsgTime = 2;
  };

  minimap = new Minimap(track);
  minimap.setVisible(raceUiVisible);
  weapons.setTrack(track);
  race.totalLaps = def.laps;
  loadedTrackKey = trackKey(def);
  currentTrackId = def.id;
}
let levelIndex = loadSettings().difficulty;
let weaponsEnabled = loadSettings().weapons;

/** Starting grid in rows of two: slot 0 is pole position (the player), slot 1 sits beside it, slot 2 starts the next row. */
const GRID_ROW_GAP = 9; // samples between rows (about 9.6 m)
const GRID_LANE = 3.5; // metres either side of the centreline
/**
 * Where the player starts on the grid (0 = pole position, 7 = last). A first race and training start at the back;
 * after that the grid is reversed against the last result: win and you start last, finish last and you start on pole.
 */
let playerGridSlot = 7;
function gridSlotFor(game: SaveGame | null): number {
  const last = game?.lastRace?.position;
  return last ? Math.max(0, Math.min(7, allCarsCount() - last)) : 7;
}
const allCarsCount = () => rivals.length + 1;

function gridSlot(slot: number): { index: number; lane: number } {
  return { index: track.sampleCount - 6 - Math.floor(slot / 2) * GRID_ROW_GAP, lane: (slot % 2 === 0 ? -1 : 1) * GRID_LANE };
}

function resetRace(): void {
  raceCash = 0;
  raceLapRecords = 0;
  bestLapThisRace = null;
  lapStartedAt = 0;
  lastPlayerLap = 0;
  weapons.clear();
  skidmarks.clear();
  pickups.reset();
  pickupMsgTime = 0;
  car.stats = playerStats;
  const own = gridSlot(playerGridSlot);
  car.placeOnTrack(track, own.index, own.lane);
  // The rivals fill the other slots in order.
  let next = 0;
  for (const r of rivals) {
    if (next === playerGridSlot) next++;
    const slot = gridSlot(next++);
    r.car.stats = aiStats(RIVAL_CAR_TIER);
    r.car.placeOnTrack(track, slot.index, slot.lane);
    r.ai = new AiDriver(r.car, track, slot.lane, LEVELS[levelIndex], () => allCars, () => weapons.hazards, () => pickups.spots);
  }
}
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 300);
const chase = new THREE.PerspectiveCamera(60, 1, 0.3, 2600);
let useOrtho = true;

function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  ortho.left = -ORTHO_SIZE * aspect / 2;
  ortho.right = ORTHO_SIZE * aspect / 2;
  ortho.top = ORTHO_SIZE / 2;
  ortho.bottom = -ORTHO_SIZE / 2;
  ortho.updateProjectionMatrix();
  chase.aspect = aspect;
  chase.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let chaseHeight = 5; // how high the third-person camera sits above the car (lowered under bridges)

function updateCamera(dt: number): void {
  // The shadow map only needs to cover the area around the player.
  sun.target.position.set(car.x, car.y, car.z);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);

  if (useOrtho) {
    ortho.up.set(0, 0, -1); // screen-up = -z, fixed north-up like the original
    ortho.position.set(car.x, 100, car.z);
    ortho.lookAt(car.x, 0, car.z);
  } else {
    const back = 10;
    // Under a bridge, duck below its deck so the car stays in view: look along the whole line from the car back to
    // the camera for anything overhead, and sit just beneath the lowest of it.
    let ceiling = Infinity;
    for (const f of [0, 0.35, 0.7, 1]) {
      ceiling = Math.min(ceiling, track.ceilingAt(car.x - Math.sin(car.heading) * back * f, car.z - Math.cos(car.heading) * back * f, car.y + 0.5));
    }
    const wanted = Math.max(1.8, Math.min(5, ceiling - car.y - 0.6));
    chaseHeight += (wanted - chaseHeight) * Math.min(1, dt * 6);
    chase.position.set(
      car.x - Math.sin(car.heading) * back,
      car.y + chaseHeight,
      car.z - Math.cos(car.heading) * back,
    );
    chase.lookAt(car.x, car.y + 1, car.z);
  }
}

const input = new Input();
const hud = document.getElementById('hud')!;
const gauges = new Gauges();
const audio = new GameAudio();
const popups = new Popups();
const PICKUP_NAMES: Record<string, string> = { ammo: 'Ammo crate', nitro: 'Nitro', repair: 'Repair kit', gun: 'Gun ammo', rear: 'Rear missiles', oil: 'Oil slicks', shield: 'Shield', cash: 'Cash' };
weapons.sound = (e) => audio.playEvent(e);
onContact((kind, x, z, value) => audio.playEvent({ type: kind === 'car' ? 'crash' : kind, x, z, size: value }));
const banner = document.getElementById('banner')!;
const hpBar = document.getElementById('hpbar')!;
const hpFill = document.getElementById('hpfill')!;
const hpText = document.getElementById('hptext')!;

function updateHealthBar(): void {
  const hp = Math.max(0, car.health);
  const fraction = hp / car.stats.maxHealth;
  hpBar.style.width = `${Math.min(240, 120 + car.stats.maxHealth * 0.8)}px`; // a tougher car gets a longer bar
  hpFill.style.width = `${fraction * 100}%`;
  hpFill.style.background = fraction > 0.6 ? '#3fcf5a' : fraction > 0.3 ? '#e6c230' : '#e03a2a';
  hpText.textContent = car.wrecked ? 'WRECKED' : `HP ${Math.ceil(hp)}`;
}

// --- Screens and game flow -------------------------------------------------------------------------------------
const screens = new Screens(document.getElementById('screen')!);
screens.onSound = (kind) => audio.playUi(kind);

/** A turntable stage for the car chooser. */
const previewScene = new THREE.Scene();
previewScene.background = new THREE.Color(0x1b2a21);
previewScene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3b4a30, 1.1));
const previewKey = new THREE.DirectionalLight(0xfff1d8, 2.2);
previewKey.position.set(-6, 9, 7);
previewScene.add(previewKey);
const stage = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.2, 48), new THREE.MeshStandardMaterial({ color: 0x2d362b, roughness: 0.9 }));
stage.position.y = -0.1;
previewScene.add(stage);
const previewCam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
previewCam.position.set(7, 3.2, 7.5);
const lookRight = new THREE.Vector3(-2, 0.8, 0.5); // looks left of the car, so the car sits right of the menu panel (car chooser)
const lookLeft = new THREE.Vector3(2.8, 0.9, -2.6); // looks right of it, so the car sits in the left column (garage)
let previewSide: 'left' | 'right' = 'right';
previewCam.lookAt(lookRight);
const previewHome = previewCam.position.clone();
const previewDirection = previewHome.clone().normalize();
const CAR_RADIUS = 2.4; // metres: a circle that holds the car however it is turned
/**
 * Aim the preview camera so the spinning car fills the garage's car window (a rectangle of the screen): back off until
 * it is about 80% of the window's size, and look to one side of and above/below the car so it lands at the window's centre.
 */
function framePreviewIn(rect: DOMRect): void {
  const centre = new THREE.Vector3(0, 0.8, 0);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(previewCam.fov / 2));
  const size = Math.max(60, Math.min(rect.width, rect.height)); // the car's turning circle must fit the smaller side
  // screen length of the car's circle = 2R * H / (2 * dist * tanHalf), wanted = 0.8 * size.
  const distance = (CAR_RADIUS * 2 * innerHeight) / (2 * tanHalf * 0.8 * size);
  previewCam.position.copy(previewDirection).multiplyScalar(distance).add(centre);
  const forward = centre.clone().sub(previewCam.position).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const halfH = distance * tanHalf;
  const halfW = halfH * previewCam.aspect;
  const nx = ((rect.left + rect.width / 2) / innerWidth) * 2 - 1;
  const ny = 1 - ((rect.top + rect.height / 2) / innerHeight) * 2;
  // Shifting the look-at point one way moves the car on screen the other way.
  const target = centre.clone().addScaledVector(right, -nx * halfW).addScaledVector(up, -ny * halfH);
  previewCam.lookAt(target);
}

let previewModel: THREE.Group | null = null;
let previewing = false;

function setPreview(id: CarId, color?: number): void {
  if (previewModel) previewScene.remove(previewModel);
  const def = garageCar(id);
  previewModel = buildCarModel(color ?? def.color, def.style).group;
  previewScene.add(previewModel);
}

type Mode = 'menu' | 'race';
let mode: Mode = 'menu';
let careerGame: SaveGame | null = null; // the career being raced, or null in training
let trainingTrack = 0;
let trainingList: TrackDef[] = TRACK_LIST; // the circuits on offer in training, built-in then the editor's

function setRaceUi(on: boolean): void {
  raceUiVisible = on;
  const display = on ? '' : 'none';
  hud.style.display = hpBar.style.display = banner.style.display = display;
  minimap.setVisible(on);
  gauges.setVisible(on);
}

/** Put a different car under the player, with the stats in `playerStats`. */
function setPlayerCar(id: CarId, color?: number): void {
  const def = garageCar(id);
  scene.remove(car.mesh);
  car = new Car(playerName, color ?? def.color, playerStats, def.style);
  scene.add(car.mesh);
  shade(car.mesh, true, true);
  allCars[0] = car;
}

/** Leave the race (if any), reset the track for the backdrop and show a menu screen. */
function enterMenu(show: () => void): void {
  mode = 'menu';
  previewing = false;
  race.toMenu();
  setRaceUi(false);
  popups.clear();
  resetRace();
  input.clear();
  show();
}

function startRace(): void {
  levelIndex = loadSettings().difficulty;
  weaponsEnabled = loadSettings().weapons;
  playerGridSlot = gridSlotFor(careerGame);
  loadTrack(careerGame ? trackForRace(careerGame.racesDone) : trainingList[trainingTrack]);
  if (careerGame) {
    playerStats = statsFor(careerGame.levels);
    playerName = careerGame.name;
    setPlayerCar(careerGame.carId, careerGame.color);
  } else {
    playerStats = starterStats();
    const saved = loadGame();
    playerName = saved?.name ?? 'You';
    setPlayerCar(saved?.carId ?? GARAGE[GARAGE.length - 1].id, saved?.color);
  }
  pickups.weaponsEnabled = weaponsEnabled;
  resetRace();
  race.start();
  mode = 'race';
  screens.hide();
  setRaceUi(true);
  input.clear();
}

function raceTrackName(): string {
  return careerGame ? trackForRace(careerGame.racesDone).name : TRACK_LIST[trainingTrack].name;
}

/** The player is done with the race results: bank the result (career) and move on. */
function finishRace(): void {
  if (!careerGame) {
    showTrainingTracks();
    return;
  }
  const position = race.standings(allCars, track).indexOf(car) + 1;
  const prize = prizeFor(position);
  const score = currentScore();
  careerGame.money += prize + raceCash;
  careerGame.score += score.total;
  careerGame.lastRace = { track: raceTrackName(), position, finished: car.finished, prize, cash: raceCash, score: score.total };
  careerGame.racesDone++;
  saveGame(careerGame);
  showShop(careerGame);
}

function quitRace(): void {
  if (careerGame) showTitle();
  else showTrainingTracks();
}

function showTitle(): void {
  enterMenu(() =>
    screens.showTitle({
      canResume: loadGame() !== null,
      onNew: () => {
        if (loadGame() && !confirm('Start a new game? Your saved progress will be lost.')) return;
        showNameEntry();
      },
      onResume: () => {
        const game = loadGame();
        if (game) showShop(game);
      },
      onTraining: showTrainingTracks,
      onSettings: showSettings,
    }),
  );
}

function showNameEntry(): void {
  enterMenu(() =>
    screens.showName({
      initial: loadGame()?.name ?? '',
      onDone: (name) => showCarSelect(cleanName(name)),
      onBack: showTitle,
    }),
  );
}

function showCarSelect(name: string): void {
  enterMenu(() => {
    previewing = true;
    previewSide = 'right';
    screens.showCarSelect({
      onPreview: setPreview,
      onPick: (id) => {
        careerGame = newGame(id, name);
        saveGame(careerGame);
        startRace();
      },
      onBack: showTitle,
    });
  });
}

function showTrainingTracks(): void {
  careerGame = null;
  trainingList = allTracks();
  enterMenu(() =>
    screens.showTracks({
      tracks: trainingList,
      onPick: (i) => {
        trainingTrack = i;
        startRace();
      },
      onBack: showTitle,
    }),
  );
}

function showSettings(): void {
  enterMenu(() =>
    screens.showSettings({
      levels: LEVELS.map((l) => l.name),
      difficulty: loadSettings().difficulty,
      onDifficulty: (i) => {
        saveSettings({ ...loadSettings(), difficulty: i });
        levelIndex = i;
      },
      weapons: loadSettings().weapons,
      onWeapons: (on) => saveSettings({ ...loadSettings(), weapons: on }),
      onEditor: () => {
        location.href = 'editor.html';
      },
      onBack: showTitle,
    }),
  );
}

/** Buy the next level of an upgrade if there is one and it is affordable, then redraw the shop. */
function buyUpgrade(game: SaveGame, slot: UpgradeSlot): void {
  const level = game.levels[slot];
  if (level >= MAX_UPGRADE_LEVEL) return;
  const price = upgradePrice(level + 1);
  if (game.money < price) return;
  game.money -= price;
  game.levels[slot] = level + 1;
  saveGame(game);
  showShop(game, slot);
}

function showShop(game: SaveGame, focus?: UpgradeSlot): void {
  careerGame = game;
  playerStats = statsFor(game.levels);
  playerName = game.name;
  setPlayerCar(game.carId, game.color);
  enterMenu(() => {
    previewing = true;
    previewSide = 'left';
    setPreview(game.carId, game.color);
    screens.showShop({
      game,
      carName: garageCar(game.carId).name,
      nextTrack: trackForRace(game.racesDone),
      gridPosition: gridSlotFor(game) + 1,
      focus,
      onBuy: (slot) => buyUpgrade(game, slot),
      color: game.color,
      onColor: (color) => {
        game.color = color;
        saveGame(game);
        setPreview(game.carId, color);
      },
      onNextRace: startRace,
      onMenu: showTitle,
    });
  });
}

/** Menu frames: no simulation, just a slowly circling view of the track (or the turntable in the car chooser). */
function renderMenu(now: number): void {
  if (previewing && previewModel) {
    previewModel.rotation.y = now / (previewSide === 'left' ? 4200 : 1700); // the garage car turns slowly
    previewCam.aspect = innerWidth / innerHeight;
    previewCam.updateProjectionMatrix();
    const window3d = previewSide === 'left' ? document.querySelector('.car-window') : null;
    if (window3d) framePreviewIn(window3d.getBoundingClientRect());
    else {
      previewCam.position.copy(previewHome);
      previewCam.lookAt(previewSide === 'left' ? lookLeft : lookRight);
    }
    renderer.render(previewScene, previewCam);
    return;
  }
  const a = now / 14000;
  const { centre, extent } = track;
  sun.target.position.set(centre.x, 0, centre.y);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  chase.position.set(centre.x + Math.cos(a) * extent * 1.1, extent * 0.6, centre.y + Math.sin(a) * extent * 1.1);
  chase.lookAt(centre.x, 0, centre.y);
  sky.update(1 / 60, chase.position);
  renderer.render(scene, chase);
}

let acc = 0;
let last = performance.now();

const IDLE: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const coast = (c: Car): Controls => ({ throttle: 0, brake: c.vf > 1 ? 1 : 0, steer: 0, handbrake: 0 });

/** What a rival does with the throttle while waiting for the lights: idle, then blips, then flat out. */
function rivalRev(index: number): number {
  const t = race.countdown;
  if (t > 2.3) return 0;
  if (t < 0.7) return 1;
  return Math.floor(t * (3 + (index % 3))) % 2 === 0 ? 1 : 0;
}

function controlsFor(c: Car, live: Controls, rev = 0): Controls {
  // On the grid you can rev the engine (the cars are held in place until the lights change).
  if (race.state === 'countdown') return { throttle: c === car ? live.throttle : rev, brake: 0, steer: 0, handbrake: 0 };
  if (race.state !== 'racing') return IDLE;
  return c.finished ? coast(c) : live;
}

/** Keys that only matter during a race. */
function raceKeys(): void {
  if (input.tapped('Escape')) {
    quitRace();
    return;
  }
  if (input.tapped('Enter') && (car.finished || car.wrecked)) {
    finishRace();
    return;
  }
  if (input.tapped('KeyR')) {
    resetRace();
    race.start();
  }
}

/** The score for the race as it stands (final once you have finished or been wrecked). */
function currentScore(): ScoreBreakdown {
  const position = race.standings(allCars, track).indexOf(car) + 1;
  const destroyed = rivals.filter((r) => r.car.wrecked && r.car.killedBy === car).length;
  return scoreRace(position, allCars.length, destroyed, raceLapRecords, bestLapThisRace, car.driftScore + (car.wrecked ? 0 : car.driftCombo), car.airSeconds);
}

function bannerText(): string {
  if (race.state === 'countdown') return `${Math.ceil(race.countdown)}\n\nhold ↑ to rev`;
  if (car.finished || car.wrecked) {
    const standings = race.standings(allCars, track);
    const width = Math.max(7, ...standings.map((c) => c.name.length));
    const rows = standings.map((c, i) => {
      const t = c.finished ? formatTime(c.finishTime) : c.wrecked ? 'wrecked' : 'racing…';
      const prize = careerGame ? `  $${prizeFor(i + 1)}` : '';
      return `${i + 1}. ${c.name.padEnd(width)} ${t.padEnd(8)}${prize}${c === car ? '  <' : ''}`;
    });
    const sc = currentScore();
    const points = [
      `Place ${sc.position}`.padEnd(22) + `+${sc.placement}`,
      `Destroyed ${sc.destroyed} x 50`.padEnd(22) + `+${sc.destroyedPoints}`,
      `Lap records ${sc.lapRecords} x 10`.padEnd(22) + `+${sc.lapRecordPoints}`,
      'Drifting'.padEnd(22) + `+${sc.driftPoints}`,
      `Air time ${sc.airSeconds.toFixed(1)} s`.padEnd(22) + `+${sc.airPoints}`,
    ];
    const best = sc.bestLap !== null ? `Best lap ${formatTime(sc.bestLap)}\n` : '';
    return `${car.wrecked ? 'WRECKED' : 'FINISHED'}\n\n${rows.join('\n')}\n\nSCORE\n${points.join('\n')}\n${best}TOTAL ${sc.total}${careerGame ? '' : ' (training: not saved)'}\n\n${careerGame ? `Cash picked up: $${raceCash}\n` : ''}Enter: continue · R: restart · Esc: quit`;
  }
  return race.time < 1 ? 'GO!' : '';
}

function frame(now: number): void {
  if (mode === 'menu') {
    last = now;
    acc = 0;
    input.clear();
    audio.update(false, car, []);
    renderMenu(now);
    requestAnimationFrame(frame);
    return;
  }
  const frameTime = Math.min((now - last) / 1000, 0.1);
  acc += frameTime;
  pickupMsgTime = Math.max(0, pickupMsgTime - frameTime);
  last = now;
  weapons.locked = !weaponsEnabled || race.weaponsLockedFor > 0; // also here, so keys read below see the current lockout
  // Weapon keys: Z = missile, X = mine, Shift or N = nitro. Read once per frame.
  const wantMissile = input.tapped('KeyZ');
  const wantMine = input.tapped('KeyX');
  const wantRear = input.tapped('KeyB');
  const wantOil = input.tapped('KeyO');
  // Read all three so none of them is left pending by the short-circuit.
  const wantNitro = [input.tapped('ShiftLeft'), input.tapped('ShiftRight'), input.tapped('KeyN')].some(Boolean);
  if (race.state === 'racing' && !car.finished) {
    if (wantMissile) weapons.fireMissile(car);
    if (wantRear) weapons.fireMissile(car, true);
    if (wantMine) weapons.dropMine(car);
    if (wantOil) weapons.dropOil(car);
    if (wantNitro) car.useNitro();
  }
  while (acc >= STEP) {
    beginCollisionStep();
    for (const c of allCars) c.held = race.state === 'countdown';
    weapons.locked = !weaponsEnabled || race.weaponsLockedFor > 0;
    if (race.state === 'racing' && !car.finished && input.held('KeyF')) weapons.fireGun(car);
    race.update(STEP, allCars);
    car.step(STEP, controlsFor(car, input), track);
    // Lap times: a lap is complete when the lap counter ticks up (the first tick is only crossing the line to start).
    if (race.state === 'racing' && car.lap > lastPlayerLap) {
      if (lastPlayerLap >= 1) {
        const lapTime = race.time - lapStartedAt;
        if (bestLapThisRace === null || lapTime < bestLapThisRace) bestLapThisRace = lapTime;
        if (submitLap(currentTrackId, lapTime)) raceLapRecords++;
      }
      lapStartedAt = race.time;
      lastPlayerLap = car.lap;
    }
    for (const [i, r] of rivals.entries()) {
      r.ai.update(STEP, race.state === 'racing');
      if (race.state === 'racing' && !r.car.finished) {
        if (r.ai.fireMissile) weapons.fireMissile(r.car);
        if (r.ai.fireRearMissile) weapons.fireMissile(r.car, true);
        if (r.ai.dropMine) weapons.dropMine(r.car);
        if (r.ai.dropOil) weapons.dropOil(r.car);
        if (r.ai.useNitro) r.car.useNitro();
        if (r.ai.fireGun) weapons.fireGun(r.car);
      }
      r.car.step(STEP, controlsFor(r.car, r.ai, rivalRev(i)), track);
    }
    for (let i = 0; i < allCars.length; i++)
      for (let j = i + 1; j < allCars.length; j++) collideCars(allCars[i], allCars[j]);
    weapons.update(STEP, allCars);
    skidmarks.update(allCars);
    pickups.update(STEP, race.state === 'racing' ? allCars : []); // crates only spin in the menu
    acc -= STEP;
  }
  if (input.tapped('KeyC')) useOrtho = !useOrtho;
  raceKeys();

  minimap.draw(allCars, car, [
    ...weapons.missiles.map((m) => ({ x: m.x, z: m.z, color: '#ffb030', size: 2.2 })),
    ...pickups.spots.filter((p) => p.active).map((p) => ({ x: p.x, z: p.z, color: PICKUP_COLOURS[p.kind], size: 2.4 })),
    ...weapons.oils.map((o) => ({ x: o.x, z: o.z, color: '#9a7bd0', size: 3 })),
    ...weapons.mines.map((m) => ({ x: m.x, z: m.z, color: '#ff3020', size: 2.6 })),
  ]);
  updateCamera(frameTime);
  sky.update(frameTime, (useOrtho ? ortho : chase).position);
  renderer.render(scene, useOrtho ? ortho : chase);
  const place = race.standings(allCars, track).indexOf(car) + 1;
  const lap = Math.max(1, Math.min(car.lap, race.totalLaps));
  hud.textContent =
    `P${place}/${allCars.length}   lap ${lap}/${race.totalLaps}   ${formatTime(race.time)}\n` +
    `height ${car.y.toFixed(1)}${car.airborne ? '  AIR' : ''}${car.drifting ? `  DRIFT ${Math.round(car.driftCombo)}` : ''}${car.offroad ? '  OFFROAD' : ''}${car.nitroActive ? '  NITRO' : ''}${car.shieldTimer > 0 ? `  SHIELD ${Math.ceil(car.shieldTimer)}s` : ''}${weaponsEnabled && race.state === 'racing' && race.weaponsLockedFor > 0 ? `  WEAPONS LOCKED ${Math.ceil(race.weaponsLockedFor)}s` : ''}\n` +
    `${weaponsEnabled ? `[Z] missile ${car.ammo.missiles} · [B] rear ${car.ammo.rearMissiles} · [F] gun ${car.ammo.bullets} · [X] mine ${car.ammo.mines} · [O] oil ${car.ammo.oil} · ` : 'weapons off · '}[Shift] nitro ${car.ammo.nitro}\n` +
    `drift pts ${Math.round(car.driftScore)}${pickupMsgTime > 0 ? `   ${pickupMsg}` : ''}\n` +
    `arrows/WASD drive · Space handbrake · C camera · M mute · R restart · ${LEVELS[levelIndex].name} AI`;
  // Tooltips float above the car, wherever the camera has it on screen.
  const view = useOrtho ? ortho : chase;
  const above = new THREE.Vector3(car.x, car.y + 1, car.z).project(view);
  popups.update(frameTime, (above.x * 0.5 + 0.5) * innerWidth, (-above.y * 0.5 + 0.5) * innerHeight);
  updateHealthBar();
  audio.update(race.state === 'racing' || race.state === 'countdown', car, rivals.map((r) => r.car));
  gauges.update(car.rpm, car.gear, car.speed * 3.6);
  banner.textContent = bannerText();
  requestAnimationFrame(frame);
}
loadTrack(TRACK_LIST[0]);
showTitle();
// Coming from the track editor's "Test drive": go straight into a training race on that circuit.
const playId = new URLSearchParams(location.search).get('play');
if (playId) {
  const list = allTracks();
  const index = list.findIndex((t) => t.id === playId);
  history.replaceState(null, '', location.pathname);
  if (index >= 0) {
    careerGame = null;
    trainingList = list;
    trainingTrack = index;
    startRace();
  }
}
requestAnimationFrame(frame);
