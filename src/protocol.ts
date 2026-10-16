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

export type HostMethod =
  | "getSessionToken"
  | "purchases.open"
  | "fullscreen.toggle"
  | "invites.open";

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
};

/** What "invites.open" answers once Powly's dialog closed: the friends the player invited. */
export type InvitesOpenResult = { invited: string[] };

export type ResponseMessage =
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string };

export type HostEventName = "pause" | "resume" | "ended";

export type EventMessage = { type: "event"; event: HostEventName };

export type HostMessage = ReadyMessage | FailedMessage | ResponseMessage | EventMessage;

export const isInitMessage = (data: unknown): data is InitMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as InitMessage).protocol === PROTOCOL &&
  (data as InitMessage).type === "init" &&
  (data as InitMessage).version === PROTOCOL_VERSION;

export const isRequestMessage = (data: unknown): data is RequestMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as RequestMessage).type === "request" &&
  Number.isInteger((data as RequestMessage).id) &&
  ["getSessionToken", "purchases.open", "fullscreen.toggle", "invites.open"].includes(
    (data as RequestMessage).method,
  );
