import type { UiSound } from './audio';
import { GARAGE, type CarId } from './garage';
import { MAX_NAME_LENGTH, type SaveGame } from './save';
import type { TrackInfo } from './tracks';
import { formatSlotValue, MAX_UPGRADE_LEVEL, SLOT_INFO, upgradePrice, UPGRADE_SLOTS, type UpgradeSlot } from './upgrades';

type Handler = () => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/**
 * The menu screens: a DOM overlay on top of the 3D view. Each `show*` call replaces the whole screen. Up/Down move
 * between the buttons, Enter presses one, Escape goes back where a screen has a back action, Left/Right where a
 * screen uses them (the car chooser).
 */
export class Screens {
  private readonly root: HTMLElement;
  private keys: Record<string, Handler> = {};
  /** Told when a button wants a sound (hovered, chosen, backed out of, bought). Set by the game. */
  onSound: (kind: UiSound) => void = () => {};
  private quiet = false; // no hover tick while a screen is just being opened
  private keyboard = false; // the last input was the keyboard, so focus moves should tick

  constructor(root: HTMLElement) {
    this.root = root;
    addEventListener('pointerdown', () => (this.keyboard = false));
    addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      this.keyboard = true;
      const handler = this.keys[e.code];
      if (handler) {
        if (e.code === 'Escape') this.onSound('back');
        e.preventDefault();
        handler();
      }
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') this.moveFocus(e.code === 'ArrowDown' ? 1 : -1);
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  hide(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
    this.keys = {};
  }

  private moveFocus(step: number): void {
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + step + buttons.length) % buttons.length].focus();
  }

  /** Swap in a new screen, focus its first button, and register Escape as "back". */
  private open(content: HTMLElement, back?: Handler, keys: Record<string, Handler> = {}): void {
    this.root.hidden = false;
    this.root.replaceChildren(content);
    this.keys = back ? { Escape: back, ...keys } : keys;
    this.quiet = true;
    content.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    this.quiet = false;
  }

  private button(label: string, onClick: Handler, opts: { disabled?: boolean; hint?: string; selected?: boolean; sound?: UiSound } = {}): HTMLButtonElement {
    const b = el('button', opts.selected ? 'selected' : '');
    b.append(el('span', 'label', label));
    if (opts.hint) b.append(el('span', 'hint', opts.hint));
    b.disabled = !!opts.disabled;
    b.addEventListener('mouseenter', () => {
      if (!b.disabled) this.onSound('hover');
    });
    b.addEventListener('focus', () => {
      if (this.keyboard && !this.quiet && !b.disabled) this.onSound('hover');
    });
    b.addEventListener('click', () => {
      this.onSound(opts.sound ?? 'select');
      onClick();
    });
    return b;
  }

  showTitle(o: { canResume: boolean; onNew: Handler; onResume: Handler; onTraining: Handler; onSettings: Handler }): void {
    const page = el('div', 'screen centre');
    page.append(el('h1', 'logo', 'SUPER CARS'), el('p', 'tagline', 'Race. Wreck. Upgrade. Repeat.'));
    const menu = el('div', 'menu');
    menu.append(
      this.button('New game', o.onNew),
      this.button('Resume game', o.onResume, { disabled: !o.canResume, hint: o.canResume ? '' : 'no saved game' }),
      this.button('Training', o.onTraining),
      this.button('Hall of fame', () => {}, { disabled: true, hint: 'coming soon' }),
      this.button('Settings', o.onSettings),
    );
    page.append(menu);
    this.open(page);
  }

  /** Ask for the player's name before a new game. */
  showName(o: { initial: string; onDone: (name: string) => void; onBack: Handler }): void {
    const page = el('div', 'screen centre');
    page.append(el('h2', '', 'What is your name, driver?'));
    const field = el('input', 'name-field');
    field.type = 'text';
    field.maxLength = MAX_NAME_LENGTH;
    field.value = o.initial;
    field.placeholder = 'Your name';
    field.autocomplete = 'off';
    field.spellcheck = false;
    const done = () => o.onDone(field.value);
    field.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        this.onSound('select');
        done();
      }
    });
    const menu = el('div', 'menu');
    const go = this.button('Continue', done);
    go.classList.add('primary');
    menu.append(field, go, this.button('Back', o.onBack, { sound: 'back' }));
    page.append(menu, el('p', 'note', `Up to ${MAX_NAME_LENGTH} characters. It goes on the results board.`));
    this.open(page, o.onBack);
    field.focus();
    field.select();
  }

  showCarSelect(o: { onPreview: (id: CarId) => void; onPick: (id: CarId) => void; onBack: Handler }): void {
    let index = 0;
    const page = el('div', 'screen carselect');
    const side = el('div', 'panel');
    side.append(el('h2', '', 'Choose your car'));
    const cards = GARAGE.map((car, i) => {
      const b = this.button(car.name, () => select(i), { hint: car.blurb });
      side.append(b);
      return b;
    });
    const note = el('p', 'note', 'All three start with the same stock performance. Win races, buy upgrades.');
    const pick = this.button('Start racing', () => o.onPick(GARAGE[index].id));
    pick.classList.add('primary');
    side.append(note, pick, this.button('Back', o.onBack, { sound: 'back' }));
    page.append(side);
    const select = (i: number) => {
      index = (i + GARAGE.length) % GARAGE.length;
      cards.forEach((c, k) => c.classList.toggle('selected', k === index));
      o.onPreview(GARAGE[index].id);
    };
    this.open(page, o.onBack, { ArrowLeft: () => select(index - 1), ArrowRight: () => select(index + 1) });
    select(0);
  }

  showTracks(o: { tracks: TrackInfo[]; onPick: (index: number) => void; onBack: Handler }): void {
    const page = el('div', 'screen centre');
    page.append(el('h2', '', 'Training: choose a track'));
    const menu = el('div', 'menu');
    o.tracks.forEach((t, i) => menu.append(this.button(t.name, () => o.onPick(i), { hint: t.description })));
    menu.append(this.button('Back', o.onBack, { sound: 'back' }));
    page.append(menu, el('p', 'note', 'A practice race in a stock car. Nothing is saved.'));
    this.open(page, o.onBack);
  }

  showSettings(o: { levels: string[]; difficulty: number; onDifficulty: (index: number) => void; onBack: Handler }): void {
    const page = el('div', 'screen centre');
    page.append(el('h2', '', 'Settings'), el('p', 'note', 'AI difficulty: how well the rival drivers drive and fight. Their cars are the same at every level.'));
    const menu = el('div', 'menu');
    const buttons = o.levels.map((name, i) => {
      const b = this.button(name, () => {
        o.onDifficulty(i);
        buttons.forEach((x, k) => x.classList.toggle('selected', k === i));
      }, { selected: i === o.difficulty });
      menu.append(b);
      return b;
    });
    menu.append(this.button('Back', o.onBack, { sound: 'back' }));
    page.append(menu);
    this.open(page, o.onBack);
  }

  /** The shop between races: one tile per upgrade slot, a picture, its level and what the next level costs. */
  showShop(o: {
    game: SaveGame;
    carName: string;
    nextTrack: TrackInfo;
    onBuy: (slot: UpgradeSlot) => void;
    onNextRace: Handler;
    onMenu: Handler;
    focus?: UpgradeSlot;
  }): void {
    const g = o.game;
    const page = el('div', 'screen shop');

    const header = el('div', 'shop-head');
    const title = el('div', 'shop-title');
    title.append(el('h2', '', 'Garage & shop'), el('div', 'sub', `${g.name}  ·  ${o.carName}  ·  ${g.racesDone} race${g.racesDone === 1 ? '' : 's'} done`));
    const wallet = el('div', 'wallet');
    wallet.append(el('div', 'amount', money(g.money)));
    if (g.lastRace) {
      wallet.append(
        el('div', 'sub', `last: ${g.lastRace.finished ? `P${g.lastRace.position}` : 'DNF'} at ${g.lastRace.track}${g.lastRace.prize + g.lastRace.cash ? `  +${money(g.lastRace.prize + g.lastRace.cash)}` : ''}`),
      );
    }
    header.append(title, wallet);

    const tiles = el('div', 'tiles');
    let focusTarget: HTMLButtonElement | null = null;
    for (const slot of UPGRADE_SLOTS) {
      const info = SLOT_INFO[slot];
      const level = g.levels[slot];
      const maxed = level >= MAX_UPGRADE_LEVEL;
      const tile = el('div', maxed ? 'tile maxed' : 'tile');

      const art = el('div', 'art');
      art.innerHTML = `<svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${ICONS[slot]}</svg>`;
      const pips = el('div', 'pips');
      for (let i = 1; i <= MAX_UPGRADE_LEVEL; i++) pips.append(el('span', i <= level ? 'pip on' : 'pip'));

      const effect = el('div', 'effect');
      effect.append(
        el('span', 'stat', info.stat),
        el('span', 'change', maxed ? formatSlotValue(slot, level) : `${formatSlotValue(slot, level)} → ${formatSlotValue(slot, level + 1)}`),
      );

      let action: HTMLButtonElement;
      if (maxed) {
        action = this.button('Maxed out', () => {}, { disabled: true });
      } else {
        const price = upgradePrice(level + 1);
        action = this.button(`Buy · ${money(price)}`, () => o.onBuy(slot), { disabled: g.money < price, sound: 'buy' });
        if (g.money >= price) action.classList.add('primary');
      }
      if (o.focus === slot && !action.disabled) focusTarget = action;

      tile.append(art, el('div', 'name', info.title), pips, effect, el('div', 'blurb', info.blurb), action);
      tiles.append(tile);
    }

    const footer = el('div', 'shop-foot');
    const next = this.button(`Next race: ${o.nextTrack.name}`, o.onNextRace, { hint: `race ${g.racesDone + 1}` });
    next.classList.add('primary');
    footer.append(this.button('Main menu', o.onMenu, { sound: 'back' }), next);

    page.append(header, tiles, footer);
    const step = (n: number) => () => this.moveFocus(n);
    this.open(page, o.onMenu, { ArrowLeft: step(-1), ArrowRight: step(1) });
    // Land on the tile that was just bought from, or else on the first thing you can afford.
    (focusTarget ?? page.querySelector<HTMLButtonElement>('.tile button.primary:not(:disabled)') ?? next).focus();
  }
}

/** Simple line drawings for the shop tiles (64x64, drawn with the current text colour). */
const ICONS: Record<UpgradeSlot, string> = {
  // Engine block with a fan and exhaust pipes.
  engine:
    '<rect x="14" y="26" width="34" height="22" rx="3"/><path d="M20 26v-8h8v8M32 26v-8h8v8"/><path d="M48 32h6v10h-6"/><circle cx="24" cy="37" r="4"/><circle cx="38" cy="37" r="4"/><path d="M10 34v8"/>',
  // A big cog with a small one meshing.
  transmission:
    '<circle cx="26" cy="34" r="11"/><circle cx="26" cy="34" r="4"/><path d="M26 17v6M26 45v6M9 34h6M37 34h6M14 22l4 4M34 42l4 4M38 22l-4 4M18 42l-4 4"/><circle cx="48" cy="20" r="6"/><path d="M48 11v3M48 26v3M39 20h3M54 20h3"/>',
  // A tyre seen side on, with tread blocks round the edge.
  tyres:
    '<circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="12"/><circle cx="32" cy="32" r="3"/><path d="M32 10v5M32 49v5M10 32h5M49 32h5M16 16l4 4M44 44l4 4M48 16l-4 4M20 44l-4 4"/>',
  // Brake disc with a caliper clamped on.
  brakes:
    '<circle cx="30" cy="32" r="20"/><circle cx="30" cy="32" r="6"/><circle cx="30" cy="20" r="2"/><circle cx="30" cy="44" r="2"/><circle cx="18" cy="32" r="2"/><circle cx="42" cy="32" r="2"/><path d="M44 18h12v28H44a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6z"/>',
  // Steering wheel.
  steering:
    '<circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="5"/><path d="M10 32h17M37 32h17M32 37v17"/>',
  // Shield with a cross.
  armor:
    '<path d="M32 8l20 7v15c0 14-9 22-20 27C21 52 12 44 12 30V15z"/><path d="M32 20v22M22 30h20"/>',
  // Turbine: a ring of curved blades round a hub, with a spark.
  turbo:
    '<circle cx="30" cy="32" r="20"/><circle cx="30" cy="32" r="4"/><path d="M30 28c0-8 4-12 10-13M34 32c8 0 12 4 13 10M30 36c0 8-4 12-10 13M26 32c-8 0-12-4-13-10"/><path d="M52 6l-6 10h8l-6 10"/>',
};
