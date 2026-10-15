import * as THREE from 'three';
import { AiDriver, LEVELS } from './ai';
import { Car } from './car';
import { garageCar, GARAGE, type CarId } from './garage';
import { beginCollisionStep, collideCars } from './collision';
import { Input, type Controls } from './input';
import { Minimap } from './minimap';
import { PICKUP_COLOURS, Pickups } from './pickups';
import { buildCarModel } from './carmodel';
import { loadGame, loadSettings, newGame, prizeFor, saveGame, saveSettings, type SaveGame } from './save';
import { Screens } from './screens';
import { trackForRace, TRACK_LIST } from './tracks';
import { formatTime, Race } from './race';
import { applyGroundUVs, createTrees, makeGrassTexture } from './scenery';
import { Skidmarks } from './skidmarks';
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

const grass = makeGrassTexture();
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1000, 1000),
  new THREE.MeshLambertMaterial({ map: grass }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
shade(ground, false, true);
scene.add(ground);

const track = new Track();
scene.add(track.mesh, track.centreLine, track.kerbs, track.finishLine, track.walls, track.terrain, track.pit);
shade(track.mesh, true, true);
shade(track.centreLine, false, true);
shade(track.kerbs, false, true);
shade(track.finishLine, false, true);
shade(track.pit, false, true);
shade(track.walls, true, true);
shade(track.terrain, true, true);
applyGroundUVs(track.terrain);
(track.terrain.material as THREE.MeshLambertMaterial).map = grass;
const trees = createTrees(track);
scene.add(trees);

let playerStats = starterStats();
let car = new Car('You', 0xd8352a, playerStats, 'hatch');
const rivals = [
  { car: new Car('Blue', 0x3070e0, undefined, 'sedan'), lane: 3.5, grid: 14 },
  { car: new Car('Yellow', 0xe0c030, undefined, 'hatch'), lane: -3.5, grid: 24 },
  { car: new Car('Green', 0x30c060, undefined, 'coupe'), lane: 3.5, grid: 34 },
  { car: new Car('Orange', 0xe07820, undefined, 'sedan'), lane: -3.5, grid: 44 },
  { car: new Car('Purple', 0x9040d0, undefined, 'hatch'), lane: 3.5, grid: 54 },
  { car: new Car('White', 0xe8e8e8, undefined, 'coupe'), lane: -3.5, grid: 64 },
  { car: new Car('Cyan', 0x30c8d0, undefined, 'sedan'), lane: 3.5, grid: 74 },
].map((r) => ({ ...r, ai: undefined as unknown as AiDriver }));
const allCars = [car, ...rivals.map((r) => r.car)];
allCars.forEach((c) => {
  scene.add(c.mesh);
  shade(c.mesh, true, true);
});

const skidmarks = new Skidmarks(track);
scene.add(skidmarks.mesh);
const weapons = new Weapons(scene, track);
const pickups = new Pickups(track);
scene.add(pickups.group);
let pickupMsg = '';
let pickupMsgTime = 0;
pickups.onCollect = (c, _kind, text) => {
  if (c !== car) return;
  pickupMsg = text;
  pickupMsgTime = 2;
};
const race = new Race();
let levelIndex = loadSettings().difficulty;

function resetRace(): void {
  weapons.clear();
  skidmarks.clear();
  pickups.reset();
  pickupMsgTime = 0;
  car.stats = playerStats;
  car.placeOnTrack(track, track.sampleCount - 6);
  for (const r of rivals) {
    r.car.stats = aiStats(RIVAL_CAR_TIER);
    r.car.placeOnTrack(track, track.sampleCount - r.grid, r.lane);
    r.ai = new AiDriver(r.car, track, r.lane, LEVELS[levelIndex], () => allCars, () => weapons.hazards, () => pickups.spots);
  }
}
resetRace();

const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 300);
const chase = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
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

function updateCamera(): void {
  // The shadow map only needs to cover the area around the player.
  sun.target.position.set(car.x, car.y, car.z);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);

  if (useOrtho) {
    ortho.up.set(0, 0, -1); // screen-up = -z, fixed north-up like the original
    ortho.position.set(car.x, 100, car.z);
    ortho.lookAt(car.x, 0, car.z);
  } else {
    const back = 10;
    chase.position.set(
      car.x - Math.sin(car.heading) * back,
      car.y + 5,
      car.z - Math.cos(car.heading) * back,
    );
    chase.lookAt(car.x, car.y + 1, car.z);
  }
}

const input = new Input();
const hud = document.getElementById('hud')!;
const minimap = new Minimap(track);
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
previewCam.lookAt(-2, 0.8, 0.5); // looks left of the car, so the car sits right of the menu panel
let previewModel: THREE.Group | null = null;
let previewing = false;

function setPreview(id: CarId): void {
  if (previewModel) previewScene.remove(previewModel);
  const def = garageCar(id);
  previewModel = buildCarModel(def.color, def.style).group;
  previewScene.add(previewModel);
}

type Mode = 'menu' | 'race';
let mode: Mode = 'menu';
let careerGame: SaveGame | null = null; // the career being raced, or null in training
let trainingTrack = 0;

function setRaceUi(on: boolean): void {
  const display = on ? '' : 'none';
  hud.style.display = hpBar.style.display = banner.style.display = display;
  minimap.setVisible(on);
}

/** Put a different car under the player, with the stats in `playerStats`. */
function setPlayerCar(id: CarId): void {
  const def = garageCar(id);
  scene.remove(car.mesh);
  car = new Car('You', def.color, playerStats, def.style);
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
  resetRace();
  input.clear();
  show();
}

function startRace(): void {
  levelIndex = loadSettings().difficulty;
  if (careerGame) {
    playerStats = statsFor(careerGame.levels);
    setPlayerCar(careerGame.carId);
  } else {
    playerStats = starterStats();
    setPlayerCar(loadGame()?.carId ?? GARAGE[GARAGE.length - 1].id);
  }
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
  careerGame.money += prize;
  careerGame.lastRace = { track: raceTrackName(), position, finished: car.finished, prize };
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
        showCarSelect();
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

function showCarSelect(): void {
  enterMenu(() => {
    previewing = true;
    screens.showCarSelect({
      onPreview: setPreview,
      onPick: (id) => {
        careerGame = newGame(id);
        saveGame(careerGame);
        startRace();
      },
      onBack: showTitle,
    });
  });
}

function showTrainingTracks(): void {
  careerGame = null;
  enterMenu(() =>
    screens.showTracks({
      tracks: TRACK_LIST,
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
        saveSettings({ difficulty: i });
        levelIndex = i;
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
  setPlayerCar(game.carId);
  enterMenu(() =>
    screens.showShop({
      game,
      carName: garageCar(game.carId).name,
      nextTrack: trackForRace(game.racesDone),
      focus,
      onBuy: (slot) => buyUpgrade(game, slot),
      onNextRace: startRace,
      onMenu: showTitle,
    }),
  );
}

/** Menu frames: no simulation, just a slowly circling view of the track (or the turntable in the car chooser). */
function renderMenu(now: number): void {
  if (previewing && previewModel) {
    previewModel.rotation.y = now / 1700;
    previewCam.aspect = innerWidth / innerHeight;
    previewCam.updateProjectionMatrix();
    renderer.render(previewScene, previewCam);
    return;
  }
  const a = now / 14000;
  sun.target.position.set(0, 0, 0);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  chase.position.set(Math.cos(a) * 150, 85, Math.sin(a) * 150);
  chase.lookAt(0, 0, 0);
  renderer.render(scene, chase);
}

let acc = 0;
let last = performance.now();

const IDLE: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const coast = (c: Car): Controls => ({ throttle: 0, brake: c.vf > 1 ? 1 : 0, steer: 0, handbrake: 0 });

function controlsFor(c: Car, live: Controls): Controls {
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

function bannerText(): string {
  if (race.state === 'countdown') return String(Math.ceil(race.countdown));
  if (car.finished || car.wrecked) {
    const rows = race.standings(allCars, track).map((c, i) => {
      const t = c.finished ? formatTime(c.finishTime) : c.wrecked ? 'wrecked' : 'racing…';
      const prize = careerGame ? `  $${prizeFor(i + 1)}` : '';
      return `${i + 1}. ${c.name.padEnd(7)} ${t.padEnd(8)}${prize}${c === car ? '  <' : ''}`;
    });
    return `${car.wrecked ? 'WRECKED' : 'FINISHED'}\n\n${rows.join('\n')}\n\nEnter: continue · R: restart · Esc: quit`;
  }
  return race.time < 1 ? 'GO!' : '';
}

function frame(now: number): void {
  if (mode === 'menu') {
    last = now;
    acc = 0;
    input.clear();
    renderMenu(now);
    requestAnimationFrame(frame);
    return;
  }
  acc += Math.min((now - last) / 1000, 0.1);
  pickupMsgTime = Math.max(0, pickupMsgTime - (now - last) / 1000);
  last = now;
  weapons.locked = race.weaponsLockedFor > 0; // also here, so keys read below see the current lockout
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
    weapons.locked = race.weaponsLockedFor > 0;
    if (race.state === 'racing' && !car.finished && input.held('KeyF')) weapons.fireGun(car);
    race.update(STEP, allCars);
    car.step(STEP, controlsFor(car, input), track);
    for (const r of rivals) {
      r.ai.update(STEP, race.state === 'racing');
      if (race.state === 'racing' && !r.car.finished) {
        if (r.ai.fireMissile) weapons.fireMissile(r.car);
        if (r.ai.fireRearMissile) weapons.fireMissile(r.car, true);
        if (r.ai.dropMine) weapons.dropMine(r.car);
        if (r.ai.dropOil) weapons.dropOil(r.car);
        if (r.ai.useNitro) r.car.useNitro();
        if (r.ai.fireGun) weapons.fireGun(r.car);
      }
      r.car.step(STEP, controlsFor(r.car, r.ai), track);
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
  updateCamera();
  renderer.render(scene, useOrtho ? ortho : chase);
  const place = race.standings(allCars, track).indexOf(car) + 1;
  const lap = Math.max(1, Math.min(car.lap, race.totalLaps));
  hud.textContent =
    `P${place}/${allCars.length}   lap ${lap}/${race.totalLaps}   ${formatTime(race.time)}\n` +
    `${(car.speed * 3.6).toFixed(0)} km/h   height ${car.y.toFixed(1)}${car.airborne ? '  AIR' : ''}${car.drifting ? `  DRIFT ${Math.round(car.driftCombo)}` : ''}${car.offroad ? '  OFFROAD' : ''}${car.nitroActive ? '  NITRO' : ''}${car.shieldTimer > 0 ? `  SHIELD ${Math.ceil(car.shieldTimer)}s` : ''}${race.state === 'racing' && race.weaponsLockedFor > 0 ? `  WEAPONS LOCKED ${Math.ceil(race.weaponsLockedFor)}s` : ''}\n` +
    `[Z] missile ${car.ammo.missiles} · [B] rear ${car.ammo.rearMissiles} · [F] gun ${car.ammo.bullets} · [X] mine ${car.ammo.mines} · [O] oil ${car.ammo.oil} · [Shift] nitro ${car.ammo.nitro}\n` +
    `drift pts ${Math.round(car.driftScore)}${pickupMsgTime > 0 ? `   ${pickupMsg}` : ''}\n` +
    `arrows/WASD drive · Space handbrake · C camera · R restart · ${LEVELS[levelIndex].name} AI`;
  updateHealthBar();
  banner.textContent = bannerText();
  requestAnimationFrame(frame);
}
showTitle();
requestAnimationFrame(frame);
