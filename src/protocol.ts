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

export type EventMessage = { type: "event"; event: HostEventName };

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
