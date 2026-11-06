import { MargoError } from '@margoengine/math/errors';
import { Input, type Binding, type InputOptions } from './index.js';

/**
 * A device a player can own, and one player at a time does:
 * - `'keyboard'`: the key, mouse and pointer bindings of the actions.
 * - `'keyboard:<scheme>'`: the bindings of that entry of the `schemes` option, for two players on one keyboard.
 * - `'gamepad:<n>'`: the gamepad bindings of the actions, pointed at gamepad `n`.
 * - `'touch'`: the touch bindings of the actions.
 * - `'control:<id>'`: the bindings of the actions to that control, such as a `Gyro` attached to this player's `Input`.
 */
export type PlayerDevice = 'keyboard' | 'touch' | `keyboard:${string}` | `gamepad:${number}` | `control:${string}`;

/** What a {@link LocalPlayers} handler hears. */
export type PlayerEventType = 'join' | 'leave' | 'lost' | 'regained';

/** One event of {@link LocalPlayers}. */
export interface PlayerEvent {
  type: PlayerEventType;
  player: Player;
  /** The device that joined, or that was lost or came back. Absent when `add` had no device, and on `leave`. */
  device?: PlayerDevice;
}

/** Options for {@link LocalPlayers}. `target`, `gamepads`, `deadzone` and `contexts` go to every player's `Input`. */
export interface LocalPlayersOptions extends InputOptions {
  /** Most players at once, an integer >= 1. Default 4. */
  maxPlayers?: number;
  /**
   * Keyboard layouts for players sharing a keyboard, by name: action to bindings. Device `'keyboard:<name>'` uses them
   * in place of the actions' own key bindings. Default none.
   */
  schemes?: Readonly<Record<string, Readonly<Record<string, readonly Binding[]>>>>;
  /**
   * An action whose press on a device nobody owns adds a player on that device, for a "press Start to join" screen.
   * Default none: only {@link LocalPlayers.add} adds players.
   */
  joinAction?: string;
  /** Gamepad indices `joinAction` watches, from 0. An integer >= 1. Default 4. */
  gamepadSlots?: number;
}

// An action needs a binding; this one reads 0, because no control has this id.
const UNBOUND: readonly Binding[] = [{ type: 'touch', id: 'unbound' }];
const KEYBOARD = new Set(['key', 'mouse', 'pointer']);

/** One local player. Read `input` as any `Input`: state, contexts, rebinding and touch controls are this player's own. */
export class Player {
  /** @internal */
  readonly owned = new Set<PlayerDevice>();
  /** @internal */
  readonly missing = new Set<PlayerDevice>();
  /** @internal */
  constructor(
    /** Slot number from 0, kept for as long as the player stays: player 1 is still 1 when player 0 leaves. */
    readonly index: number,
    /** This player's actions, reading only this player's devices. */
    readonly input: Input,
  ) {}
  /** The devices this player owns. */
  get devices(): readonly PlayerDevice[] {
    return [...this.owned];
  }
  /** False while a gamepad of this player is unplugged. */
  get connected(): boolean {
    return this.missing.size === 0;
  }
  /**
   * Rumble this player's gamepads. Resolves false when none has a vibration actuator.
   * @param duration Milliseconds, in [0, 10000].
   * @param strength Magnitude in [0, 1]. Default 1.
   */
  async rumble(duration: number, strength = 1): Promise<boolean> {
    const pads = this.devices.filter((device) => device.startsWith('gamepad:'));
    const results = await Promise.all(pads.map((pad) => this.input.rumble(duration, strength, +pad.slice(8))));
    return results.includes(true);
  }
}

/**
 * Local multiplayer: each player owns devices and has an `Input` of their own, made from one shared action map.
 *
 * ```ts
 * const party = new LocalPlayers(actions, { joinAction: 'start' });
 * party.on('join', ({ player }) => spawn(player));
 * party.update(); // once per tick
 * for (const player of party.players) move(player.index, player.input.state('move').value);
 * ```
 */
export class LocalPlayers {
  private readonly actions: Readonly<Record<string, readonly Binding[]>>;
  private readonly schemes: Readonly<Record<string, Readonly<Record<string, readonly Binding[]>>>>;
  private readonly options: InputOptions;
  private readonly maxPlayers: number;
  private readonly slots: (Player | undefined)[] = [];
  private readonly owners = new Map<PlayerDevice, Player>();
  private readonly handlers = new Map<PlayerEventType, Set<(event: PlayerEvent) => void>>();
  private readonly gamepads: () => readonly (Gamepad | null)[];
  private lobby: Input | undefined;
  private disposed = false;
  /**
   * @throws RangeError for a `maxPlayers` or `gamepadSlots` that is not an integer >= 1.
   * @throws TypeError for a `joinAction` or scheme action that is not an action, or an invalid binding.
   */
  constructor(
    actions: Readonly<Record<string, readonly Binding[]>>,
    {
      maxPlayers = 4,
      schemes = {},
      joinAction,
      gamepadSlots = 4,
      target = window,
      gamepads = () => navigator.getGamepads?.() ?? [],
      deadzone,
      contexts,
    }: LocalPlayersOptions = {},
  ) {
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || !Number.isInteger(gamepadSlots) || gamepadSlots < 1)
      throw new RangeError('LocalPlayers maxPlayers and gamepadSlots must be integers of at least 1');
    if (joinAction !== undefined && !Object.hasOwn(actions, joinAction))
      throw new TypeError('LocalPlayers joinAction must be one of the actions');
    this.actions = actions;
    this.schemes = schemes;
    this.maxPlayers = maxPlayers;
    this.gamepads = gamepads;
    this.options = { target, gamepads, deadzone, contexts };
    // Building an Input checks every binding, and any mistake surfaces here rather than when a player joins.
    new Input(actions, this.options).dispose();
    for (const [name, scheme] of Object.entries(schemes)) {
      for (const action of Object.keys(scheme))
        if (!Object.hasOwn(actions, action)) throw new TypeError(`Scheme ${name} binds an unknown action, ${action}; add it to the actions`);
      new Input(scheme, { target, gamepads }).dispose();
    }
    if (joinAction !== undefined) {
      const watched: Record<string, readonly Binding[]> = {},
        devices: PlayerDevice[] = ['keyboard', 'touch', ...Object.keys(schemes).map((s) => `keyboard:${s}` as const)];
      for (let i = 0; i < gamepadSlots; i++) devices.push(`gamepad:${i}`);
      for (const device of devices) {
        const bindings = this.bindings(joinAction, [device]);
        if (bindings !== UNBOUND) watched[device] = bindings;
      }
      this.lobby = new Input(watched, { target, gamepads, deadzone });
    }
  }
  /** Current players, in slot order. */
  get players(): readonly Player[] {
    return this.slots.filter((player) => player !== undefined);
  }
  /** The player who owns `device`, if any. */
  owner(device: PlayerDevice): Player | undefined {
    return this.owners.get(device);
  }
  /** Listen for `join`, `leave`, `lost` or `regained`; returns the function that stops listening. */
  on(type: PlayerEventType, handler: (event: PlayerEvent) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  }
  /**
   * Add a player in the lowest free slot, with `device` if given. The press that made them join does not read as
   * `pressed`, so a Start button that is also an action does nothing on arrival.
   * @throws RangeError when `maxPlayers` are already playing.
   * @throws TypeError for an unknown device or one another player owns.
   * @throws MargoError `'disposed'` after {@link LocalPlayers.dispose}.
   */
  add(device?: PlayerDevice): Player {
    this.alive();
    let index = 0;
    while (this.slots[index]) index++;
    if (index >= this.maxPlayers) throw new RangeError('The party is full; raise maxPlayers or remove a player');
    if (device !== undefined) this.check(device);
    const actions: Record<string, readonly Binding[]> = {};
    for (const action of Object.keys(this.actions)) actions[action] = UNBOUND;
    const player = new Player(index, new Input(actions, this.options));
    this.slots[index] = player;
    if (device !== undefined) this.assign(player, device);
    player.input.update();
    this.emit({ type: 'join', player, ...(device === undefined ? {} : { device }) });
    return player;
  }
  /** Remove a player, free their devices and dispose their `Input`. Does nothing for a player no longer here. */
  remove(player: Player): void {
    if (this.slots[player.index] !== player) return;
    for (const device of player.owned) this.owners.delete(device);
    this.slots[player.index] = undefined;
    player.input.dispose();
    this.emit({ type: 'leave', player });
  }
  /**
   * Give `device` to `player` as well as what they own. Rebuilds their bindings from the shared actions, so changes
   * made with `player.input.rebind` end here; apply saved bindings after it.
   * @throws TypeError for an unknown device, one another player owns, or a player no longer here.
   */
  assign(player: Player, device: PlayerDevice): void {
    this.alive();
    if (this.slots[player.index] !== player) throw new TypeError('That player has left; add a new one');
    this.check(device, player);
    player.owned.add(device);
    this.owners.set(device, player);
    this.rebuild(player);
  }
  /** Take `device` from its owner, who stays in the game. Does nothing for a device nobody owns. */
  unassign(device: PlayerDevice): void {
    const player = this.owners.get(device);
    if (!player) return;
    this.owners.delete(device);
    player.owned.delete(device);
    player.missing.delete(device);
    this.rebuild(player);
  }
  /**
   * Add players from `joinAction`, notice gamepads coming and going, and update every player's `Input`. Call once per
   * tick, in place of `input.update()`.
   * @throws MargoError `'disposed'` after {@link LocalPlayers.dispose}.
   */
  update(): void {
    this.alive();
    const lobby = this.lobby;
    if (lobby) {
      lobby.update();
      for (const device of Object.keys(lobby.actions) as PlayerDevice[])
        if (lobby.state(device).pressed && !this.owners.has(device) && this.players.length < this.maxPlayers)
          this.add(device);
    }
    const pads = this.gamepads();
    for (const [device, player] of [...this.owners]) {
      if (!device.startsWith('gamepad:')) continue;
      const pad = pads[+device.slice(8)],
        here = !!pad && pad.connected !== false;
      if (here === !player.missing.has(device)) continue;
      if (here) player.missing.delete(device);
      else player.missing.add(device);
      this.emit({ type: here ? 'regained' : 'lost', player, device });
    }
    for (const player of this.players) player.input.update();
  }
  /** Dispose every player's `Input`. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const player of this.players) player.input.dispose();
    this.slots.length = 0;
    this.owners.clear();
    this.lobby?.dispose();
    this.handlers.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'LocalPlayers is disposed; create a new one');
  }
  private emit(event: PlayerEvent): void {
    for (const handler of [...(this.handlers.get(event.type) ?? [])]) handler(event);
  }
  private check(device: PlayerDevice, player?: Player): void {
    const scheme = /^keyboard:(.+)$/.exec(device)?.[1];
    if (
      !(scheme !== undefined ? Object.hasOwn(this.schemes, scheme) : /^(keyboard|touch|gamepad:\d+|control:.+)$/.test(device))
    )
      throw new TypeError(`Unknown device ${device}; use keyboard, keyboard:<scheme>, gamepad:<n>, control:<id> or touch`);
    const owner = this.owners.get(device);
    if (owner && owner !== player) throw new TypeError(`Player ${owner.index} already owns ${device}; unassign it first`);
  }
  private rebuild(player: Player): void {
    const devices = player.devices;
    for (const action of Object.keys(this.actions)) player.input.rebind(action, this.bindings(action, devices));
  }
  /** Bindings of `action` on these devices, or {@link UNBOUND}, compared by identity, when there are none. */
  private bindings(action: string, devices: readonly PlayerDevice[]): readonly Binding[] {
    const all = this.actions[action],
      out: Binding[] = [];
    for (const device of devices) {
      if (device === 'keyboard') out.push(...all.filter((binding) => KEYBOARD.has(binding.type)));
      else if (device === 'touch') out.push(...all.filter((binding) => binding.type === 'touch'));
      else if (device.startsWith('control:'))
        out.push(...all.filter((binding) => binding.type === 'control' && binding.id === device.slice(8)));
      else if (device.startsWith('keyboard:')) out.push(...(this.schemes[device.slice(9)][action] ?? []));
      else
        for (const binding of all)
          if (binding.type === 'gamepad-axis' || binding.type === 'gamepad-button')
            out.push({ ...binding, gamepad: +device.slice(8) });
    }
    return out.length ? out : UNBOUND;
  }
}
