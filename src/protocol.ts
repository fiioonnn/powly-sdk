// The messages between a game (this SDK, inside Powly's iframe) and the Powly page that framed it.
// Shared with the host side (apps/web/components/player/sdk-host.ts).
//
// 1. The game creates a MessageChannel and posts `InitMessage` to `window.parent`, with the Powly
//    origin it expects as targetOrigin (so the port only ever reaches Powly) and port2 attached.
// 2. Powly answers only the iframe it created, from the origin it expects that frame to have,
//    with `ReadyMessage` over the port. Everything after that goes over the port.
// 3. From then on the game also reports to Powly Anti-Cheat over the port (`PacSample`, src/pac.ts).

export const PROTOCOL = "powly-sdk";
export const PROTOCOL_VERSION = 1;

/** The corners Powly's options button (its mascot, which opens the player's options) can be in. */
export const OPTIONS_BUTTON_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type OptionsButtonCorner = (typeof OPTIONS_BUTTON_CORNERS)[number];
export const isOptionsButtonCorner = (value: unknown): value is OptionsButtonCorner =>
  (OPTIONS_BUTTON_CORNERS as readonly unknown[]).includes(value);

/**
 * A kind of sound the game has (music, drawing sounds…), which Powly's sound menu shows with a
 * volume slider (`volume`, default true), an on/off switch (`toggle`, default true), or both.
 */
export type AudioChannel = { id: string; label: string; volume?: boolean; toggle?: boolean };

/** One channel's setting: its volume, 0 to 1, and whether it's on. */
export type ChannelState = { volume: number; on: boolean };

/** Channel ids: letters, digits, _ and -, starting with a letter, up to 32. */
export const AUDIO_CHANNEL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const MAX_AUDIO_CHANNELS = 8;
export const MAX_AUDIO_LABEL = 32;

/**
 * The player's sound settings from Powly's sound menu. `volume` (0 to 1) is the player's overall
 * volume, `channels` the game's own (by channel id); `muted` silences everything.
 */
export type AudioState = {
  volume: number;
  muted: boolean;
  channels: Record<string, ChannelState>;
};

/** The channels a game sent, cleaned up: valid ids, short labels, no repeats, at most 8. */
export function audioChannelsOf(value: unknown): AudioChannel[] {
  if (!Array.isArray(value)) return [];
  const channels: AudioChannel[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label, volume, toggle } = entry as Partial<AudioChannel>;
    if (typeof id !== "string" || !AUDIO_CHANNEL_ID.test(id)) continue;
    if (channels.some((channel) => channel.id === id)) continue;
    const text = typeof label === "string" ? label.trim().slice(0, MAX_AUDIO_LABEL) : "";
    const slider = volume !== false;
    // Neither a slider nor a switch would show nothing: both, then.
    const onOff = toggle !== false || !slider;
    channels.push({ id, label: text || id, volume: slider, toggle: onOff });
    if (channels.length === MAX_AUDIO_CHANNELS) break;
  }
  return channels;
}

/** What a game changes from its own sound menu; channels by id, only the fields given. */
export type AudioChanges = {
  volume?: number;
  muted?: boolean;
  channels?: Record<string, Partial<ChannelState>>;
};

/** A volume between 0 and 1, or null. */
export const volumeOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;

export type InitMessage = {
  protocol: typeof PROTOCOL;
  version: number;
  type: "init";
  sdkVersion: string;
  /**
   * The SDK reports to Powly Anti-Cheat (src/pac.ts: `PacSample` messages over the port). Older
   * SDKs leave it out.
   */
  pac?: 1;
  /**
   * Where the game wants Powly's options button to start (`Powly.init({ optionsButton })`); the
   * player's own choice wins. Left out: Powly's default (top left).
   */
  optionsButton?: OptionsButtonCorner;
  /**
   * The SDK follows Powly's sound menu (SDK 0.8.0 and later): `channels` are the game's own
   * volume controls, shown as sliders. Older SDKs leave it out.
   */
  audio?: { channels: AudioChannel[] };
};

export type PlayerProfile = {
  /** This player's ID in this game: stable, and different in every game. */
  playerId: string;
  username: string;
  avatarUrl: string | null;
};

export type ReadyMessage = {
  type: "ready";
  launchId: string;
  profile: PlayerProfile;
  scopes: string[];
  /** Why the game was opened and the player's preferences (e.g. `reason: "invite"`, `muted`). */
  params: Record<string, string>;
  /** A session token and its lifetime in seconds. */
  token: string;
  expiresIn: number;
  /** Base URL of the platform API, e.g. "https://powly.gg/api/platform/v1". */
  apiBase: string;
  /**
   * Powly Anti-Cheat: guard the game's code (src/pac.ts) in this run. Off in developer mode.
   * Missing from older Powly hosts: no guard.
   */
  pac?: { guard: boolean };
  /** The player's sound settings when the game starts. Missing from older Powly hosts. */
  audio?: AudioState;
};

export type FailedMessage = { type: "failed"; error: string };

/** What a game may ask the Powly page for. */
export const HOST_METHODS = [
  "getSessionToken",
  "purchases.open",
  "fullscreen.toggle",
  "invites.open",
  "players.open",
  "twitch.connect",
  "audio.set",
  "audio.channels",
  "audio.open",
  "quit",
] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

/** "players.open": what Powly's player dialog opens on. */
export const PLAYER_VIEWS = ["profile", "report"] as const;
export type PlayerView = (typeof PLAYER_VIEWS)[number];

export type RequestMessage = {
  type: "request";
  id: number;
  method: HostMethod;
  /** "invites.open": launch params every invite sent from Powly's dialog carries (e.g. a room). */
  params?: Record<string, string>;
  /**
   * "invites.open": player IDs already playing with the player (the room's members): Powly's
   * dialog shows them as in the party, without an Invite button.
   */
  members?: string[];
  /** "players.open": the player (their player ID in this game) to show. */
  playerId?: string;
  /** "players.open": open on the profile (the default) or straight on reporting them. */
  view?: PlayerView;
  /** "audio.set": what the game's own sound menu changed. */
  audio?: AudioChanges;
  /** "audio.channels": every channel the game has now (registered later than init). */
  channels?: AudioChannel[];
};

/** What "invites.open" answers once Powly's dialog closed: the friends the player invited. */
export type InvitesOpenResult = { invited: string[] };

/**
 * What "players.open" answers once Powly's player dialog closed: whether the player has that
 * player blocked now (the game may hide their chat, say). Whether they reported them stays private.
 */
export type PlayersOpenResult = { blocked: boolean };

/**
 * What "twitch.connect" answers once Powly's Connect Twitch dialog closed: whether the player's
 * Twitch is connected now (the SDK then reads GET /twitch again).
 */
export type TwitchConnectResult = { connected: boolean };

export type ResponseMessage =
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string };

/**
 * "shown": Powly's loading screen is gone and the game is on screen (once per launch). "pause" /
 * "resume": Powly UI covers the game or the tab is hidden, and back. "ended": the launch ended.
 */
export type HostEventName = "shown" | "pause" | "resume" | "ended";

export type EventMessage =
  | { type: "event"; event: HostEventName }
  /** The player changed the sound settings (Powly's sound menu, or its M key). */
  | { type: "event"; event: "audio"; audio: AudioState };

export type HostMessage = ReadyMessage | FailedMessage | ResponseMessage | EventMessage;

export const isInitMessage = (data: unknown): data is InitMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as InitMessage).protocol === PROTOCOL &&
  (data as InitMessage).type === "init" &&
  (data as InitMessage).version === PROTOCOL_VERSION;

/** A request with a method this Powly doesn't know (from a newer SDK): answered with an error. */
export const isRequestShaped = (data: unknown): data is { type: "request"; id: number } =>
  typeof data === "object" &&
  data !== null &&
  (data as RequestMessage).type === "request" &&
  Number.isInteger((data as RequestMessage).id);

export const isRequestMessage = (data: unknown): data is RequestMessage =>
  isRequestShaped(data) &&
  (HOST_METHODS as readonly unknown[]).includes((data as RequestMessage).method);
