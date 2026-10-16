// The wire protocol of Powly's realtime service (apps/realtime): JSON text frames over one
// WebSocket. Games use it through the SDK (`powly.rooms`, src/rooms.ts); Powly's own pages use it
// for live notifications (apps/web/lib/realtime-client.ts). Shared as types only: the service
// validates every frame itself.
//
// 1. The client gets a ticket from Powly (games: POST /api/platform/v1/realtime with a session
//    token; Powly's pages: POST /api/realtime/ticket with the session cookie) and connects to the
//    ticket's URL.
// 2. Its first frame is `{ op: "auth", ticket }`; the service answers `welcome`. Tickets live two
//    minutes: the client sends a fresh one (`auth` again) before that, or the service closes the
//    connection. That is how ended launches, bans and sign-outs reach open connections.
// 3. Requests carry an `id` and get one `reply`; `room.send` has none (fire and forget).

export const REALTIME_PROTOCOL_VERSION = 1;

/** Close codes the service uses (4000–4999 are free for applications). */
export const REALTIME_CLOSE = {
  /** The ticket was invalid, or expired without a fresh one. Get a new ticket to reconnect. */
  unauthorized: 4001,
  /** The same player connected too many times; the oldest connection is closed. */
  replaced: 4002,
  /** Too many messages, or the client couldn't keep up with what it was sent. */
  overloaded: 4008,
  /** A frame that isn't valid JSON or protocol. */
  invalid: 4009,
} as const;

export type RoomMember = {
  playerId: string;
  username: string;
  avatarUrl: string | null;
  /** What the member shares about themselves (ready, character…), set with `room.me`. */
  data: unknown;
  /** False for a few seconds after their connection dropped, while they may come back. */
  connected: boolean;
  joinedAt: string;
};

export type RoomState = {
  id: string;
  /** What friends type (or get in an invite) to join: 6 letters and digits. */
  code: string;
  hostId: string;
  maxPlayers: number;
  /** Locked rooms take nobody new (members who dropped can still come back). */
  locked: boolean;
  /** Listed by `room.list` for anyone in the game to join. */
  listed: boolean;
  /** The room's shared state, set by the host. */
  data: unknown;
  members: RoomMember[];
  createdAt: string;
};

/** A listed room, as `room.list` shows it. */
export type ListedRoom = {
  code: string;
  host: string;
  players: number;
  maxPlayers: number;
  data: unknown;
};

export type RealtimeInvite = {
  id: string;
  from: { playerId: string; username: string };
  params: Record<string, string>;
  createdAt: string;
};

export type ClientMessage =
  | { op: "auth"; id?: number; ticket: string }
  | {
      op: "room.create";
      id: number;
      maxPlayers?: number;
      listed?: boolean;
      data?: unknown;
      me?: unknown;
    }
  | { op: "room.join"; id: number; code: string; me?: unknown }
  | { op: "room.leave"; id: number }
  | { op: "room.list"; id: number }
  | { op: "room.update"; id: number; data?: unknown; locked?: boolean; listed?: boolean }
  | { op: "room.me"; id: number; data: unknown }
  | { op: "room.kick"; id: number; playerId: string }
  | { op: "room.host"; id: number; playerId: string }
  | { op: "room.send"; event: string; data?: unknown; to?: string };

export type RealtimeErrorCode =
  | "invalid"
  | "unauthorized"
  | "not_found"
  | "full"
  | "locked"
  | "forbidden"
  | "not_in_room"
  | "too_large"
  | "rate_limited"
  | "unavailable"
  /** The game's Multiplayer setting is off (Studio): no rooms, only invites. */
  | "multiplayer_off";

export type ServerMessage =
  | {
      type: "welcome";
      protocol: number;
      /** "game": a player in a game; "site": Powly's own pages. */
      kind: "game" | "site";
      /** Seconds the ticket is still good for. */
      expiresIn: number;
    }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: { code: RealtimeErrorCode; message: string } }
  | { type: "room.message"; from: string; event: string; data: unknown }
  | { type: "room.member_joined"; member: RoomMember }
  | { type: "room.member_updated"; member: RoomMember }
  | { type: "room.member_left"; playerId: string; reason: "left" | "kicked" | "dropped" }
  | {
      type: "room.updated";
      hostId: string;
      data: unknown;
      locked: boolean;
      listed: boolean;
    }
  /** You're no longer in the room. */
  | { type: "room.left"; reason: "kicked" | "replaced" | "closed" }
  /** A friend invited the player to this game while they're playing it. */
  | { type: "invite"; invite: RealtimeInvite }
  /** Powly's pages: a platform event (apps/web/lib/social/types.ts RealtimeEvent). */
  | { type: "event"; event: unknown }
  | { type: "error"; code: RealtimeErrorCode; message: string };
