import { PowlyError } from "./errors.ts";
import {
  type ListedRoom,
  REALTIME_CLOSE,
  type RealtimeInvite,
  type RoomMember,
  type RoomState,
  type ServerMessage,
} from "./realtime-protocol.ts";

// Rooms: realtime parties with other players of the game, over Powly's realtime service (one
// WebSocket, opened the first time the game uses rooms or listens for invites).
//
//   const room = await powly.rooms.create({ maxPlayers: 4 });
//   room.code;                                   // "K7QF2M": friends join with it
//   room.on("message", ({ from, event, data }) => …);
//   room.send("move", { x: 3, y: 4 });           // to everyone else in the room
//   await room.invite(friend.playerId);          // a Powly invite that carries the code
//
//   // The friend, opening the invite:
//   if (powly.launchParams.room) await powly.rooms.join(powly.launchParams.room);
//
// Rooms need Multiplayer turned on for the game in Studio (Configuration → Multiplayer); while
// it's off they fail with code "multiplayer_off", and the connection only brings invites.
//
// The connection comes back by itself after network trouble and rejoins the room (members keep
// their place for 20 seconds); messages sent meanwhile are lost.

export type { ListedRoom, RealtimeInvite, RoomMember };

export type RoomCreateOptions = {
  /** From 2 up to the game's players per room (Studio, Multiplayer), which is also the default. */
  maxPlayers?: number;
  /** Listed rooms show up in `rooms.list()` for anyone in the game to join. Default false. */
  listed?: boolean;
  /** The room's shared state (up to 4 KB of JSON); only the host changes it. */
  data?: unknown;
  /** What you share about yourself (up to 1 KB of JSON), e.g. { ready: false }. */
  me?: unknown;
};

export type RoomEvents = {
  /** Another member sent something (`room.send`). */
  message: { from: string; event: string; data: unknown };
  /** Someone joined. */
  join: RoomMember;
  /** Someone left, was kicked, or didn't come back after their connection dropped. */
  leave: { playerId: string; reason: "left" | "kicked" | "dropped" };
  /** A member's data changed, or their connection dropped (`connected: false`) or came back. */
  member: RoomMember;
  /** The host, the room's data, `locked` or `listed` changed. */
  update: Room;
  /**
   * You're out of the room: you left (or created or joined another one), were kicked, the same
   * player joined from elsewhere ("replaced"), or the connection couldn't get back in
   * ("connection", also when the launch ended).
   */
  closed: { reason: "left" | "kicked" | "replaced" | "connection" };
};

export type Room = {
  readonly id: string;
  /** What friends join with: 6 letters and digits. */
  readonly code: string;
  readonly hostId: string;
  /** Whether you're the host. */
  readonly isHost: boolean;
  readonly maxPlayers: number;
  readonly locked: boolean;
  readonly listed: boolean;
  readonly data: unknown;
  /** Everyone in the room, you included, in the order they joined. */
  readonly members: readonly RoomMember[];
  /** Whether you're still in it. */
  readonly active: boolean;
  /**
   * Sends to everyone else in the room, or to one member (`to`). `event`: 1–32 letters, digits or
   * _ . : -; `data`: up to 8 KB of JSON. Returns false when it couldn't be sent (reconnecting).
   */
  send(event: string, data?: unknown, options?: { to?: string }): boolean;
  on<K extends keyof RoomEvents>(event: K, listener: (payload: RoomEvents[K]) => void): () => void;
  /** Host only. */
  update(changes: { data?: unknown; locked?: boolean; listed?: boolean }): Promise<void>;
  /** What you share about yourself (up to 1 KB of JSON). */
  setMyData(data: unknown): Promise<void>;
  /** Host only: removes a player, who can't come back. */
  kick(playerId: string): Promise<void>;
  /** Host only: hands hosting to another member. */
  makeHost(playerId: string): Promise<void>;
  /** Invites a friend (scope invites.write); opening it launches the game with `room` = the code. */
  invite(playerId: string): Promise<void>;
  leave(): Promise<void>;
};

export type RealtimeStatus = "offline" | "connecting" | "connected" | "reconnecting";

export type RoomsApi = {
  /** Creates a room with you as its host (leaving the one you're in). */
  create(options?: RoomCreateOptions): Promise<Room>;
  /** Joins by code (leaving the one you're in). Fails with code "not_found", "full" or "locked". */
  join(code: string, options?: { me?: unknown }): Promise<Room>;
  /** Listed rooms that still take players, newest first (up to 50). */
  list(): Promise<ListedRoom[]>;
  /** The room you're in, or null. */
  readonly current: Room | null;
  /** The connection to Powly's realtime service. */
  readonly status: RealtimeStatus;
  on(event: "status", listener: (status: RealtimeStatus) => void): () => void;
};

type Ticket = { url: string; ticket: string; expiresIn: number };

const REQUEST_TIMEOUT_MS = 10_000;
const TICKET_REFRESH_MS = 45_000;
const MAX_RETRY_MS = 30_000;
/** With no room and no invite listener, the connection closes after this (ms). */
const IDLE_CLOSE_MS = 60_000;

type Listeners = Map<string, Set<(payload: never) => void>>;

function emit(listeners: Listeners, event: string, payload: unknown) {
  for (const listener of listeners.get(event) ?? []) {
    try {
      (listener as (value: unknown) => void)(payload);
    } catch (error) {
      // A game's listener throwing mustn't break the connection.
      setTimeout(() => {
        throw error;
      });
    }
  }
}

function listen(listeners: Listeners, event: string, listener: (payload: never) => void) {
  const set = listeners.get(event) ?? new Set();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
  };
}

/**
 * The game's realtime connection. `getTicket` asks the platform API for a ticket (POST
 * /realtime); `invite` sends a Powly invite.
 */
export function createRooms(options: {
  playerId: string;
  getTicket: () => Promise<Ticket>;
  invite: (playerId: string, params: Record<string, string>) => Promise<void>;
}): {
  rooms: RoomsApi;
  onInvite(listener: (invite: RealtimeInvite) => void): () => void;
  stop(): void;
} {
  let socket: WebSocket | null = null;
  let status: RealtimeStatus = "offline";
  let ready: Promise<void> | null = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const statusListeners: Listeners = new Map();
  const inviteListeners = new Set<(invite: RealtimeInvite) => void>();
  let current: ReturnType<typeof createRoom> | null = null;

  const setStatus = (next: RealtimeStatus) => {
    if (status === next) return;
    status = next;
    emit(statusListeners, "status", next);
  };

  /** Whether anything still needs the connection. */
  const needed = () => !stopped && (current !== null || inviteListeners.size > 0);

  const failPending = (message: string) => {
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new PowlyError(message, undefined, "unavailable"));
      pending.delete(id);
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        const fresh = await options.getTicket();
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: "auth", ticket: fresh.ticket }));
        }
      } catch {
        // The launch ended, or Powly is unreachable: the service closes the connection when the
        // ticket runs out, and reconnecting asks again.
      }
      if (socket) scheduleRefresh();
    }, TICKET_REFRESH_MS);
  };

  const onMessage = (message: ServerMessage) => {
    if (message.type === "reply") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new PowlyError(message.error.message, undefined, message.error.code));
    } else if (message.type === "invite") {
      for (const listener of inviteListeners) listener(message.invite);
    } else if (message.type.startsWith("room.")) {
      current?.apply(message);
    }
  };

  const connect = (): Promise<void> => {
    if (stopped) return Promise.reject(new PowlyError("The launch has ended.", 401));
    clearTimeout(idleTimer);
    ready ??= new Promise<void>((resolve, reject) => {
      setStatus(attempt === 0 && status === "offline" ? "connecting" : "reconnecting");
      let welcomed = false;
      options
        .getTicket()
        .then((ticket) => {
          if (stopped) throw new PowlyError("The launch has ended.", 401);
          const ws = new WebSocket(ticket.url);
          socket = ws;
          ws.onopen = () => ws.send(JSON.stringify({ op: "auth", ticket: ticket.ticket }));
          ws.onmessage = (event) => {
            let message: ServerMessage;
            try {
              message = JSON.parse(String(event.data)) as ServerMessage;
            } catch {
              return;
            }
            if (message.type === "welcome") {
              welcomed = true;
              attempt = 0;
              setStatus("connected");
              scheduleRefresh();
              resolve();
            } else {
              onMessage(message);
            }
          };
          ws.onclose = (event) => {
            if (socket !== ws) return;
            socket = null;
            ready = null;
            clearTimeout(refreshTimer);
            failPending("The connection to Powly was lost.");
            if (!welcomed)
              reject(new PowlyError("Couldn’t connect to Powly.", undefined, "unavailable"));
            onDisconnected(event.code);
          };
        })
        .catch((error: unknown) => {
          ready = null;
          setStatus("offline");
          reject(
            error instanceof PowlyError ? error : new PowlyError("Couldn’t connect to Powly."),
          );
          // The ticket was refused (launch over): nothing to retry.
          if (error instanceof PowlyError && error.status === 401) return;
          if (needed()) retry();
        });
    });
    return ready;
  };

  const retry = () => {
    clearTimeout(retryTimer);
    const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    attempt += 1;
    setStatus("reconnecting");
    retryTimer = setTimeout(() => {
      if (!needed()) return setStatus("offline");
      connect()
        .then(rejoin)
        .catch(() => {});
    }, delay);
  };

  const onDisconnected = (code: number) => {
    if (code === REALTIME_CLOSE.replaced) {
      // This player connected again elsewhere (another tab): that one has the room now.
      current?.close("replaced");
      setStatus("offline");
      return;
    }
    if (!needed()) return setStatus("offline");
    retry();
  };

  /** Back after a dropped connection: take the seat in the room again. */
  const rejoin = async () => {
    const room = current;
    if (!room) return;
    try {
      const state = (await request({
        op: "room.join",
        code: room.code,
        me: room.myData(),
      })) as RoomState;
      if (current === room) room.reset(state);
    } catch (error) {
      if (current === room && !(error instanceof PowlyError && error.code === "unavailable")) {
        room.close("connection");
      }
    }
  };

  const request = async (message: Record<string, unknown>) => {
    await connect();
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new PowlyError("Not connected to Powly.", undefined, "unavailable");
    }
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PowlyError("Powly didn’t answer in time.", undefined, "unavailable"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...message, id }));
    });
  };

  const disconnect = () => {
    clearTimeout(retryTimer);
    clearTimeout(refreshTimer);
    clearTimeout(idleTimer);
    const ws = socket;
    socket = null;
    ready = null;
    ws?.close(1000);
    setStatus("offline");
  };

  /** Closes the connection once nothing has needed it for a minute. */
  const disconnectIfIdle = () => {
    clearTimeout(idleTimer);
    if (needed()) return;
    if (stopped) return disconnect();
    idleTimer = setTimeout(() => {
      if (!needed()) disconnect();
    }, IDLE_CLOSE_MS);
  };

  function createRoom(initial: RoomState) {
    let state = initial;
    let active = true;
    const listeners: Listeners = new Map();

    const view: Room = {
      get id() {
        return state.id;
      },
      get code() {
        return state.code;
      },
      get hostId() {
        return state.hostId;
      },
      get isHost() {
        return state.hostId === options.playerId;
      },
      get maxPlayers() {
        return state.maxPlayers;
      },
      get locked() {
        return state.locked;
      },
      get listed() {
        return state.listed;
      },
      get data() {
        return state.data;
      },
      get members() {
        return state.members;
      },
      get active() {
        return active;
      },
      send(event, data, sendOptions) {
        if (!active || socket?.readyState !== WebSocket.OPEN || status !== "connected")
          return false;
        socket.send(
          JSON.stringify({
            op: "room.send",
            event,
            data,
            ...(sendOptions?.to !== undefined && { to: sendOptions.to }),
          }),
        );
        return true;
      },
      on: (event, listener) => listen(listeners, event, listener as (payload: never) => void),
      update: async (changes) => {
        handle.reset((await request({ op: "room.update", ...changes })) as RoomState);
      },
      setMyData: async (data) => {
        const member = (await request({ op: "room.me", data })) as RoomMember;
        state = {
          ...state,
          members: state.members.map((entry) =>
            entry.playerId === member.playerId ? member : entry,
          ),
        };
      },
      kick: async (playerId) => {
        await request({ op: "room.kick", playerId });
      },
      makeHost: async (playerId) => {
        handle.reset((await request({ op: "room.host", playerId })) as RoomState);
      },
      invite: (playerId) => options.invite(playerId, { room: state.code }),
      leave: async () => {
        if (!active) return;
        const open = socket?.readyState === WebSocket.OPEN;
        handle.close("left");
        if (open) await request({ op: "room.leave" });
      },
    };

    const replaceMember = (member: RoomMember) => {
      const known = state.members.some((entry) => entry.playerId === member.playerId);
      state = {
        ...state,
        members: known
          ? state.members.map((entry) => (entry.playerId === member.playerId ? member : entry))
          : [...state.members, member],
      };
    };

    const handle = {
      view,
      get code() {
        return state.code;
      },
      /** What you share in the room, to keep it when rejoining. */
      myData() {
        return state.members.find((entry) => entry.playerId === options.playerId)?.data ?? null;
      },
      reset(next: RoomState) {
        const changed =
          next.hostId !== state.hostId ||
          next.locked !== state.locked ||
          next.listed !== state.listed ||
          JSON.stringify(next.data) !== JSON.stringify(state.data);
        state = next;
        if (changed) emit(listeners, "update", view);
      },
      apply(message: ServerMessage) {
        if (!active) return;
        switch (message.type) {
          case "room.message":
            emit(listeners, "message", {
              from: message.from,
              event: message.event,
              data: message.data,
            });
            break;
          case "room.member_joined":
            replaceMember(message.member);
            emit(listeners, "join", message.member);
            break;
          case "room.member_updated":
            replaceMember(message.member);
            emit(listeners, "member", message.member);
            break;
          case "room.member_left":
            state = {
              ...state,
              members: state.members.filter((entry) => entry.playerId !== message.playerId),
            };
            emit(listeners, "leave", { playerId: message.playerId, reason: message.reason });
            break;
          case "room.updated":
            state = {
              ...state,
              hostId: message.hostId,
              data: message.data,
              locked: message.locked,
              listed: message.listed,
            };
            emit(listeners, "update", view);
            break;
          case "room.left":
            handle.close(message.reason === "closed" ? "connection" : message.reason);
            break;
        }
      },
      close(reason: RoomEvents["closed"]["reason"]) {
        if (!active) return;
        active = false;
        if (current === handle) current = null;
        emit(listeners, "closed", { reason });
        disconnectIfIdle();
      },
    };
    return handle;
  }

  const enter = (state: RoomState) => {
    // Creating or joining a room left the one before.
    current?.close("left");
    const handle = createRoom(state);
    current = handle;
    return handle.view;
  };

  return {
    rooms: {
      create: async (createOptions = {}) =>
        enter((await request({ op: "room.create", ...createOptions })) as RoomState),
      join: async (code, joinOptions = {}) => {
        if (typeof code !== "string" || !code.trim()) {
          throw new PowlyError("Give a room code.", undefined, "invalid");
        }
        if (current && current.code === code.replace(/[\s-]/g, "").toUpperCase()) {
          return current.view;
        }
        return enter((await request({ op: "room.join", code, me: joinOptions.me })) as RoomState);
      },
      list: async () => {
        try {
          return (await request({ op: "room.list" })) as ListedRoom[];
        } finally {
          disconnectIfIdle();
        }
      },
      get current() {
        return current?.view ?? null;
      },
      get status() {
        return status;
      },
      on: (event, listener) => listen(statusListeners, event, listener as (payload: never) => void),
    },
    onInvite(listener) {
      inviteListeners.add(listener);
      connect().catch(() => {});
      return () => {
        inviteListeners.delete(listener);
        disconnectIfIdle();
      };
    },
    stop() {
      stopped = true;
      current?.close("connection");
      inviteListeners.clear();
      failPending("The launch has ended.");
      disconnectIfIdle();
    },
  };
}
