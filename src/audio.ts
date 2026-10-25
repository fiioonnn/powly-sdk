// Powly's sound menu for games (`powly.audio`): the player's overall volume, a mute (Powly's M
// key), and the kinds of sound the game registers (channels: music, drawing sounds…), each with a
// volume slider and an on/off switch, or one of them. The player sets them in Powly's options
// bar; the game hears "change".
//
//   const powly = await Powly.init({
//     audio: { channels: [{ id: "music", label: "Music" }] },
//   });
//   await powly.audio.register({ id: "drawing", label: "Drawing sounds", volume: false });
//   music.volume = powly.audio.level("music");
//   powly.audio.on("change", () => { music.volume = powly.audio.level("music"); });
//   if (powly.audio.level("drawing") > 0) playScribble();
//
// The overall volume and mute apply by themselves (`auto`, on by default): the SDK puts a volume
// control in front of the page's speakers, for Web Audio (every connection to an AudioContext's
// destination goes through it) and for <audio>/<video> (their volume is scaled). So every game
// on this SDK follows Powly's volume, and channels only need the channel's own value:
// `level(channel)` is what to play at either way.

import type { AudioChanges, AudioChannel, AudioState, ChannelState } from "./protocol.ts";

export type AudioOptions = {
  /**
   * The game's kinds of sound, shown in Powly's sound menu (up to 8): `{ id, label }`, with a
   * volume slider (`volume: false` leaves it out) and an on/off switch (`toggle: false`).
   */
  channels?: AudioChannel[];
  /**
   * Apply the overall volume and mute to the page's sound by itself. Default true; turn it off
   * when the game applies `level()` to everything itself.
   */
  auto?: boolean;
};

export type AudioApi = {
  /** The player's overall volume, 0 to 1. */
  readonly volume: number;
  /** Everything silenced (Powly's mute, or its M key). */
  readonly muted: boolean;
  /** The game's channels by id: their volume (0 to 1) and whether they're on. */
  readonly channels: Record<string, ChannelState>;
  /**
   * What to play at, 0 to 1: a channel's volume (0 while it's off), or (no channel) full volume.
   * With `auto` off, the overall volume and mute are in it too.
   */
  level(channel?: string): number;
  /**
   * Adds a channel to Powly's sound menu after init (or changes its label or controls), e.g.
   * once a mode with its own sounds starts. Up to 8 channels.
   */
  register(channel: AudioChannel): Promise<void>;
  /**
   * Changes the settings from the game's own sound menu, so Powly's stays the same:
   * `{ volume, muted, channels: { music: { volume: 0.5 }, drawing: { on: false } } }`. Unknown
   * channels are ignored.
   */
  set(changes: AudioChanges): Promise<void>;
  /**
   * Opens Powly's sound menu over the game (in its options bar), e.g. from a Sound button in
   * the game's own menu. Resolves when the player closes it; "change" tells what they set.
   */
  open(): Promise<void>;
  /** The settings changed (in Powly's sound menu, or with `set`). */
  on(event: "change", listener: (audio: AudioState) => void): () => void;
};

/** Volume of the page's sound overall: 0 when muted. */
export const masterLevel = (state: AudioState) => (state.muted ? 0 : state.volume);

type Connect = (this: AudioNode, ...args: unknown[]) => unknown;

/** Live references to objects, for walking them later without keeping them alive. */
function weakList<T extends object>() {
  const seen = new WeakSet<T>();
  const refs = new Set<WeakRef<T>>();
  return {
    add(item: T) {
      if (seen.has(item)) return false;
      seen.add(item);
      refs.add(new WeakRef(item));
      return true;
    },
    has: (item: T) => seen.has(item),
    *[Symbol.iterator]() {
      for (const ref of refs) {
        const item = ref.deref();
        if (item) yield item;
        else refs.delete(ref);
      }
    },
  };
}

/**
 * Puts a volume control in front of the page's speakers: Web Audio connections to a real-time
 * AudioContext's destination go through a gain node per context, and media elements' volume is
 * scaled (the volume the game set still reads back unchanged; elements played through Web Audio
 * are left to the gain node). Returns how to set it.
 */
export function installMasterGain(win: Window & typeof globalThis = window): {
  set(level: number): void;
} {
  let level = 1;

  // Web Audio.
  const gainOf = new WeakMap<BaseAudioContext, GainNode>();
  const gains = weakList<GainNode>();
  const Destination = win.AudioDestinationNode;
  const Offline = win.OfflineAudioContext;
  const nodeProto = win.AudioNode?.prototype;
  const connect = nodeProto?.connect as Connect | undefined;
  const disconnect = nodeProto?.disconnect as Connect | undefined;
  /** The gain node standing in for `target` when it's a real-time context's destination. */
  const standIn = (target: unknown): GainNode | null => {
    if (!Destination || !(target instanceof Destination)) return null;
    const context = target.context;
    if (Offline && context instanceof Offline) return null;
    let gain = gainOf.get(context);
    if (!gain) {
      gain = context.createGain();
      gain.gain.value = level;
      gains.add(gain);
      connect?.call(gain, target);
      gainOf.set(context, gain);
    }
    return gain;
  };
  if (nodeProto && connect && disconnect) {
    nodeProto.connect = function (this: AudioNode, target: unknown, ...rest: unknown[]) {
      const gain = gains.has(this as GainNode) ? null : standIn(target);
      if (!gain) return connect.call(this, target, ...rest);
      connect.call(this, gain, ...rest);
      // Chaining keeps working: connect() answers what it was given.
      return target;
    } as AudioNode["connect"];
    nodeProto.disconnect = function (this: AudioNode, ...args: unknown[]) {
      const gain = gains.has(this as GainNode) ? null : standIn(args[0]);
      return gain ? disconnect.call(this, gain, ...args.slice(1)) : disconnect.apply(this, args);
    } as AudioNode["disconnect"];
  }

  // Media elements: the volume the game set, and the one played (times `level`).
  const media = win.HTMLMediaElement?.prototype;
  const volume = media ? Object.getOwnPropertyDescriptor(media, "volume") : undefined;
  const wanted = new WeakMap<HTMLMediaElement, number>();
  const elements = weakList<HTMLMediaElement>();
  const routed = new WeakSet<HTMLMediaElement>();
  const apply = (element: HTMLMediaElement) => {
    const own = wanted.get(element) ?? 1;
    volume?.set?.call(element, routed.has(element) ? own : own * level);
  };
  const track = (element: HTMLMediaElement) => {
    if (!wanted.has(element)) wanted.set(element, (volume?.get?.call(element) as number) ?? 1);
    elements.add(element);
    apply(element);
  };
  if (media && volume?.get && volume.set) {
    const { get, set } = volume;
    Object.defineProperty(media, "volume", {
      configurable: true,
      enumerable: volume.enumerable,
      get(this: HTMLMediaElement) {
        return wanted.get(this) ?? get.call(this);
      },
      set(this: HTMLMediaElement, value: number) {
        // Out of range throws, like the browser's own setter.
        set.call(this, value);
        wanted.set(this, value);
        track(this);
      },
    });
    const play = media.play;
    media.play = function (this: HTMLMediaElement) {
      track(this);
      return play.call(this);
    };
  }
  const createSource = win.AudioContext?.prototype.createMediaElementSource;
  if (createSource) {
    win.AudioContext.prototype.createMediaElementSource = function (
      this: AudioContext,
      element: HTMLMediaElement,
    ) {
      routed.add(element);
      track(element);
      return createSource.call(this, element);
    };
  }

  return {
    set(next) {
      level = next;
      for (const gain of gains) gain.gain.value = level;
      for (const element of elements) apply(element);
    },
  };
}
