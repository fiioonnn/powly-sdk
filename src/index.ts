import { type AudioApi, type AudioOptions, installMasterGain, masterLevel } from "./audio.ts";
import { PowlyError } from "./errors.ts";
import { POWLY_ORIGINS } from "./origins.ts";
import { startPacSensor } from "./pac.ts";
import {
  type AudioChanges,
  type AudioChannel,
  type AudioState,
  audioChannelsOf,
  type ChannelState,
  type EventMessage,
  type HostEventName,
  type HostMessage,
  type HostMethod,
  type InitMessage,
  type InvitesOpenResult,
  isOptionsButtonCorner,
  MAX_AUDIO_CHANNELS,
  type OptionsButtonCorner,
  type PlayerProfile,
  type PlayersOpenResult,
  type PlayerView,
  PROTOCOL,
  PROTOCOL_VERSION,
  type ReadyMessage,
  type RequestMessage,
  type TwitchConnectResult,
  volumeOf,
} from "./protocol.ts";
import { createRooms, type RoomsApi } from "./rooms.ts";
import {
  type ConnectOptions,
  createTwitch,
  type TwitchApi,
  type TwitchChatMessage,
  type TwitchChatState,
  type TwitchInfo,
} from "./twitch.ts";
import { SDK_VERSION } from "./version.ts";

// The Powly SDK for games. `Powly.init()` handshakes with the Powly page that framed the game and
// refuses to start anywhere else; afterwards the game gets the player's profile, short-lived
// session tokens (refreshed automatically) and the platform services.
//
//   const powly = await Powly.init();
//   powly.profile.username;
//   await powly.leaderboards.submit("high-score", 1200);
//   const token = await powly.getSessionToken(); // send it to your backend, which verifies it
//   const room = await powly.rooms.create();    // realtime parties (src/rooms.ts)
//   await powly.twitch.connect();                // the streamer's Twitch chat (src/twitch.ts)
//   await powly.players.open(playerId);          // Powly's profile dialog: add, block, report
//   powly.audio.level("music");                  // Powly's sound menu (src/audio.ts)
//
// Nothing here is a security boundary: the game runs in the player's browser. Your backend must
// verify session tokens (JWKS) or exchange them, and Powly checks everything server-side.
//
// Powly Anti-Cheat starts with the session (src/pac.ts): the SDK reports the game's clocks,
// replaced browser functions, automation traces and input timing to the Powly page. Runs it flags
// can't submit scores, unlock achievements or write saves.
//
// Saves are created in Studio (game → Saves); other keys and values of another type can't be
// written.
// Saves and leaderboard scores are written by your backend by default (an access token from the
// token exchange), because players can change anything the browser sends. `saves.set`/`delete`
// only work on saves the studio lets the browser write, and `leaderboards.submit` only on boards created with `clientSubmissions: true`; otherwise they
// fail with a 403 PowlyError. Reading saves and leaderboards always works.

export { PowlyError, SDK_VERSION };

export type InitOptions = {
  /**
   * Powly origins the game accepts, e.g. ["https://powly.gg"]. Defaults to the Powly origins
   * built into the SDK (POWLY_SDK_ORIGINS at build time, see src/origins.ts); the launch URL's
   * `powly_origin` only picks one of those, and is ignored otherwise.
   */
  powlyOrigin?: string | string[];
  /** How long to wait for Powly to answer (ms). Default 10 s. */
  timeoutMs?: number;
  /**
   * Which corner Powly's options button (its mascot, which opens the player's options) starts in:
   * "top-left" (the default), "top-right", "bottom-left" or "bottom-right". Pick the one your own
   * UI leaves free. Players can still move it, and their choice wins.
   */
  optionsButton?: OptionsButtonCorner;
  /**
   * Powly's sound menu (src/audio.ts): the game's own volume `channels` (sliders next to the
   * player's overall volume), and whether the SDK applies the overall volume and mute to the
   * page's sound itself (`auto`, default true).
   */
  audio?: AudioOptions;
};

export type LeaderboardEntry = { rank: number; playerId: string; username: string; score: number };
export type Friend = {
  playerId: string;
  username: string;
  /** Their picture (by player ID), or null; missing from older Powly servers. */
  avatarUrl?: string | null;
};
export type Achievement = {
  key: string;
  /** "Hidden achievement" for hidden ones the player hasn't unlocked. */
  name: string;
  description: string;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  hidden: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
};
export type Ownership = { owned: boolean; since: string | null; addOns: string[] };
export type Invite = {
  id: string;
  from: Friend;
  params: Record<string, string>;
  createdAt: string;
};

export type PowlySession = {
  profile: PlayerProfile;
  scopes: string[];
  /** Why the game was opened (`reason: "invite"`, `invitedBy`…) and the player's preferences. */
  launchParams: Record<string, string>;
  launchId: string;
  /** The platform API's base URL, e.g. "https://powly.gg/api/platform/v1". */
  apiBase: string;
  /** A valid session token (refreshed automatically, valid for at least 10 more seconds). */
  getSessionToken(): Promise<string>;
  /** Calls the platform API with a session token: `api("/me")`. */
  api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  friends: { list(): Promise<Friend[]> };
  presence: { set(text: string | null): Promise<void> };
  invites: {
    list(): Promise<Invite[]>;
    send(playerId: string, params?: Record<string, string>): Promise<void>;
    /** A friend invited the player to this game while they're playing it (live, realtime). */
    on(event: "received", listener: (invite: Invite) => void): () => void;
    /**
     * Opens Powly's own invite dialog over the game (drawn by Powly, not the game): the player's
     * friends who play it, each with an Invite button. Every invite sent from it carries `params`
     * (e.g. `{ room: code }`), like `send`. With the code of the room the player is in, its members
     * show as already in the party (no Invite button). Resolves when the player closes it, with
     * the player IDs they invited. Needs the friends.read and invites.write scopes.
     */
    open(params?: Record<string, string>): Promise<{ invited: string[] }>;
  };
  /**
   * Other players of this game, by their player ID (from rooms, leaderboards, friends…).
   * `open` shows Powly's own dialog over the game (drawn by Powly, not the game) with their
   * profile, where the player can add them as a friend, block or report them; with
   * `{ view: "report" }` it opens straight on reporting them. Games can't file reports
   * themselves: the player always confirms in Powly's dialog. Resolves when it closes, with
   * whether the player has them blocked now (hide their chat, say). Fails for player IDs that
   * aren't from this game.
   */
  players: {
    open(playerId: string, options?: { view?: PlayerView }): Promise<PlayersOpenResult>;
  };
  /**
   * The player's sound settings from Powly's options bar: overall volume, mute and the game's
   * channels (`Powly.init({ audio: { channels } })`). Play each channel at `level(channel)`.
   */
  audio: AudioApi;
  /** Realtime rooms (parties) with other players of this game. */
  rooms: RoomsApi;
  /**
   * The chat of the player's Twitch channel, for games with Twitch chat on (Studio → Configuration
   * → Twitch chat). Read-only; calls fail with a 403 PowlyError while the setting is off.
   */
  twitch: TwitchApi;
  leaderboards: {
    submit(board: string, score: number): Promise<{ best: number; improved: boolean }>;
    top(board: string, limit?: number): Promise<LeaderboardEntry[]>;
  };
  /**
   * The player's saves, stored by Powly: each key is created in Studio (game → Saves) with a simple
   * type (number, text, true/false, object, array). Reading always works; `set` and `delete` too,
   * except for saves the studio made server-only (403; the game's backend writes those). Unknown
   * keys fail with a 404, values of another type with a 422.
   */
  saves: {
    /** The player's value, or null if they have none. */
    get<T = unknown>(key: string): Promise<T | null>;
    /** All of the player's saves, by key. */
    all(): Promise<Record<string, unknown>>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** The keys the player has a value for. */
    list(): Promise<string[]>;
  };
  achievements: {
    /** The game's achievements (defined in Studio), with the player's unlocks. */
    list(): Promise<Achievement[]>;
    /**
     * Unlocks one from the browser: only achievements the studio marked "can be unlocked from the
     * browser" (others answer 403; the game's backend unlocks those). `granted` is false when the
     * player already had it.
     */
    unlock(key: string): Promise<{ key: string; granted: boolean }>;
  };
  /** @deprecated Settings are saves now: use `saves` (`reset` is `saves.delete`). */
  settings: {
    get<T = unknown>(key: string): Promise<T | null>;
    all(): Promise<Record<string, unknown>>;
    set(key: string, value: unknown): Promise<void>;
    reset(key: string): Promise<void>;
  };
  /** Whether the player owns the game (scope ownership.read). */
  ownership: { get(): Promise<Ownership> };
  /** Asks Powly to open its own purchase dialog (drawn by Powly, outside the game). */
  purchases: { open(): Promise<void> };
  fullscreen: { toggle(): Promise<void> };
  /**
   * Closes the game, like the exit button in Powly's options bar: the player goes back to the
   * game's store page and the launch ends ("ended" fires). Save the player's progress first.
   */
  quit(): Promise<void>;
  /**
   * Powly's loading screen is gone and the game is on screen ("shown": start the intro or music
   * here), Powly UI opened over the game ("pause"), closed ("resume"), or the launch ended
   * ("ended"). "shown" comes once per launch; listening for it later calls the listener right
   * away.
   */
  on(event: HostEventName, listener: () => void): () => void;
  /** Whether Powly's loading screen is gone and the game is on screen ("shown" came). */
  readonly shown: boolean;
};

function expectedOrigins(options: InitOptions): string[] {
  const configured = options.powlyOrigin;
  if (configured) return (Array.isArray(configured) ? configured : [configured]).map(originOf);
  // The launch URL can't add an origin (anyone can write one): it only narrows the built-in list.
  const fromUrl = originOf(new URL(location.href).searchParams.get("powly_origin") ?? "");
  const known = POWLY_ORIGINS.map(originOf);
  const candidates = known.includes(fromUrl) ? [fromUrl] : known;
  // Where the browser tells us who our parent really is, it must be one of them.
  const parent = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
  return parent ? candidates.filter((origin) => origin === parent) : candidates;
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/** Starts the SDK. Rejects when the game wasn't launched from Powly. */
export function init(options: InitOptions = {}): Promise<PowlySession> {
  if (window.parent === window) {
    return Promise.reject(new PowlyError("This game only runs when launched from Powly."));
  }
  const origins = expectedOrigins(options).filter(Boolean);
  if (origins.length === 0) {
    return Promise.reject(new PowlyError("This game only runs when launched from Powly."));
  }
  const audioChannels = audioChannelsOf(options.audio?.channels ?? []);
  // Before the game's engine makes a sound, so its connections go through the volume control.
  const auto = options.audio?.auto !== false;
  if (auto) masterGain ??= installMasterGain();
  const master = auto ? masterGain : null;
  return new Promise((resolve, reject) => {
    const channels = origins.map((origin) => {
      const channel = new MessageChannel();
      const message: InitMessage = {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        type: "init",
        sdkVersion: SDK_VERSION,
        pac: 1,
        ...(isOptionsButtonCorner(options.optionsButton) && {
          optionsButton: options.optionsButton,
        }),
        audio: { channels: audioChannels },
      };
      channel.port1.onmessage = (event: MessageEvent<HostMessage>) => {
        const data = event.data;
        if (data?.type === "ready") {
          clearTimeout(timer);
          for (const other of channels) if (other !== channel) other.port1.close();
          resolve(createSession(channel.port1, data, { channels: audioChannels, master }));
        } else if (data?.type === "failed") {
          clearTimeout(timer);
          reject(new PowlyError(data.error));
        }
      };
      // targetOrigin: the port is only delivered if the parent really is this Powly origin.
      window.parent.postMessage(message, origin, [channel.port2]);
      return channel;
    });
    const timer = setTimeout(() => {
      for (const channel of channels) channel.port1.close();
      reject(new PowlyError("Powly didn’t answer. This game only runs when launched from Powly."));
    }, options.timeoutMs ?? 10_000);
  });
}

/** The page's volume control (src/audio.ts), put in once even if init runs again. */
let masterGain: ReturnType<typeof installMasterGain> | null = null;

/** The sound settings Powly sent, with every channel (on, at full volume, when it sent none). */
function audioStateOf(value: unknown, channels: AudioChannel[]): AudioState {
  const sent = (typeof value === "object" && value !== null ? value : {}) as Partial<AudioState>;
  const levels = ((typeof sent.channels === "object" && sent.channels) || {}) as Record<
    string,
    Partial<ChannelState> | undefined
  >;
  return {
    volume: volumeOf(sent.volume) ?? 1,
    muted: sent.muted === true,
    channels: Object.fromEntries(
      channels.map((channel) => {
        const level = levels[channel.id];
        return [channel.id, { volume: volumeOf(level?.volume) ?? 1, on: level?.on !== false }];
      }),
    ),
  };
}

/** The settings with a game's changes in (known channels only), as Powly will answer them. */
function withChanges(state: AudioState, changes: AudioChanges): AudioState {
  const level = (value: unknown, fallback: number) => volumeOf(value) ?? fallback;
  const next: AudioState = {
    volume: level(changes?.volume, state.volume),
    muted: typeof changes?.muted === "boolean" ? changes.muted : state.muted,
    channels: { ...state.channels },
  };
  for (const [id, patch] of Object.entries(changes?.channels ?? {})) {
    const known = next.channels[id];
    if (!known || typeof patch !== "object" || patch === null) continue;
    next.channels[id] = {
      volume: level(patch.volume, known.volume),
      on: typeof patch.on === "boolean" ? patch.on : known.on,
    };
  }
  return next;
}

function createSession(
  port: MessagePort,
  ready: ReadyMessage,
  sound: { channels: AudioChannel[]; master: typeof masterGain },
): PowlySession {
  let token = ready.token;
  let expiresAt = Date.now() + ready.expiresIn * 1000;
  let refreshing: Promise<string> | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Map<HostEventName, Set<() => void>>();
  // "shown" comes once; games that listen for it later still hear it.
  let shown = false;

  // The player's sound settings; the page's volume follows them (auto).
  let channels = sound.channels;
  let audio = audioStateOf(ready.audio, channels);
  const audioListeners = new Set<(audio: AudioState) => void>();
  sound.master?.set(masterLevel(audio));
  const setAudio = (next: AudioState) => {
    audio = next;
    sound.master?.set(masterLevel(audio));
    for (const listener of audioListeners) {
      try {
        listener(audio);
      } catch (error) {
        console.error("[powly] an audio listener failed", error);
      }
    }
  };

  port.onmessage = (event: MessageEvent<HostMessage>) => {
    const data = event.data;
    if (data?.type === "response") {
      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      if (data.ok) waiting.resolve(data.result);
      else waiting.reject(new PowlyError(data.error));
    } else if (data?.type === "event") {
      const message = data as EventMessage;
      if (message.event === "audio") {
        if ("audio" in message) setAudio(audioStateOf(message.audio, channels));
        return;
      }
      const name = message.event;
      if (name === "shown") {
        if (shown) return;
        shown = true;
      }
      for (const listener of listeners.get(name) ?? []) listener();
    }
  };

  const call = (
    method: HostMethod,
    extra: Pick<
      RequestMessage,
      "params" | "members" | "playerId" | "view" | "audio" | "channels"
    > = {},
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ type: "request", id, method, ...extra } satisfies RequestMessage);
    });

  const getSessionToken = async () => {
    if (expiresAt - Date.now() > 10_000) return token;
    refreshing ??= call("getSessionToken")
      .then((result) => {
        const fresh = result as { token: string; expiresIn: number };
        token = fresh.token;
        expiresAt = Date.now() + fresh.expiresIn * 1000;
        return token;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  // Keep a token ready, so calls don't wait for a refresh.
  const refreshTimer = setInterval(() => {
    if (expiresAt - Date.now() < 20_000) getSessionToken().catch(() => {});
  }, 5_000);
  const stopPac = startPacSensor(port, { guard: ready.pac?.guard === true });
  listeners.set("ended", new Set([() => clearInterval(refreshTimer), stopPac]));

  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${ready.apiBase}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${await getSessionToken()}`,
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "omit",
    });
    const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : `Request failed (${response.status})`;
      throw new PowlyError(message, response.status);
    }
    return data as T;
  };

  const path = (value: string) => encodeURIComponent(value);

  const sendInvite = async (playerId: string, params: Record<string, string> = {}) => {
    await api("/invites", { method: "POST", body: { to: playerId, params } });
  };
  const realtime = createRooms({
    playerId: ready.profile.playerId,
    getTicket: () => api("/realtime", { method: "POST" }),
    invite: sendInvite,
  });
  listeners.get("ended")?.add(() => realtime.stop());
  const twitch = createTwitch({
    getInfo: () => api<TwitchInfo>("/twitch"),
    prompt: async () => ((await call("twitch.connect")) as TwitchConnectResult).connected,
  });
  listeners.get("ended")?.add(() => twitch.stop());

  const saves: PowlySession["saves"] = {
    get: async <T>(key: string) => {
      try {
        return (await api<{ value: T }>(`/saves/${path(key)}`)).value;
      } catch (error) {
        if (error instanceof PowlyError && error.status === 404) return null;
        throw error;
      }
    },
    all: async () => (await api<{ values: Record<string, unknown> }>("/saves?values=1")).values,
    set: async (key, value) => {
      await api(`/saves/${path(key)}`, { method: "PUT", body: { value } });
    },
    delete: async (key) => {
      await api(`/saves/${path(key)}`, { method: "DELETE" });
    },
    list: async () => (await api<{ keys: string[] }>("/saves")).keys,
  };

  return {
    profile: ready.profile,
    scopes: ready.scopes,
    launchParams: ready.params,
    launchId: ready.launchId,
    apiBase: ready.apiBase,
    getSessionToken,
    api,
    friends: { list: async () => (await api<{ friends: Friend[] }>("/friends")).friends },
    presence: {
      set: async (text) => {
        await api("/presence", { method: "PUT", body: { text } });
      },
    },
    invites: {
      list: async () => (await api<{ invites: Invite[] }>("/invites")).invites,
      send: sendInvite,
      on: (_event, listener) => realtime.onInvite(listener),
      open: async (params) => {
        // Inviting to the room the player is in: who's already there can't be invited to it.
        const room = realtime.rooms.current;
        const members =
          room && params?.room === room.code ? room.members.map((member) => member.playerId) : [];
        return (await call("invites.open", { params, members })) as InvitesOpenResult;
      },
    },
    players: {
      open: async (playerId, options = {}) =>
        (await call("players.open", {
          playerId,
          ...(options.view && { view: options.view }),
        })) as PlayersOpenResult,
    },
    audio: {
      get volume() {
        return audio.volume;
      },
      get muted() {
        return audio.muted;
      },
      get channels() {
        return Object.fromEntries(
          Object.entries(audio.channels).map(([id, state]) => [id, { ...state }]),
        );
      },
      level(channel) {
        const state = channel === undefined ? undefined : audio.channels[channel];
        const own = state ? (state.on ? state.volume : 0) : 1;
        return sound.master ? own : own * masterLevel(audio);
      },
      async register(channel) {
        const next = audioChannelsOf([
          ...channels.filter((existing) => existing.id !== channel?.id),
          channel,
        ]);
        if (!next.some((entry) => entry.id === channel?.id)) {
          throw new PowlyError(
            `A channel needs an id of letters, digits, _ and -, and a game has up to ${MAX_AUDIO_CHANNELS}.`,
          );
        }
        // Same order as before; a changed channel keeps its place.
        channels = [
          ...channels.map((existing) => next.find((entry) => entry.id === existing.id) ?? existing),
          ...next.filter((entry) => !channels.some((existing) => existing.id === entry.id)),
        ];
        const result = await call("audio.channels", { channels });
        setAudio(audioStateOf(result, channels));
      },
      async set(changes) {
        // At once, so the game's own controls don't jump back while Powly answers.
        const before = audio;
        const ask = call("audio.set", { audio: changes });
        setAudio(withChanges(audio, changes));
        let result: unknown;
        try {
          result = await ask;
        } catch (error) {
          setAudio(before);
          throw error;
        }
        const confirmed = audioStateOf(result, channels);
        if (JSON.stringify(confirmed) !== JSON.stringify(audio)) setAudio(confirmed);
      },
      async open() {
        await call("audio.open");
      },
      on(_event, listener) {
        audioListeners.add(listener);
        return () => audioListeners.delete(listener);
      },
    },
    rooms: realtime.rooms,
    twitch: {
      info: twitch.info,
      connect: twitch.connect,
      disconnect: twitch.disconnect,
      get state() {
        return twitch.state;
      },
      get channel() {
        return twitch.channel;
      },
      on: twitch.on,
    },
    leaderboards: {
      submit: (board, score) =>
        api(`/leaderboards/${path(board)}/scores`, { method: "POST", body: { score } }),
      top: async (board, limit = 10) =>
        (await api<{ entries: LeaderboardEntry[] }>(`/leaderboards/${path(board)}?limit=${limit}`))
          .entries,
    },
    saves,
    achievements: {
      list: async () => (await api<{ achievements: Achievement[] }>("/achievements")).achievements,
      unlock: (key) => api("/achievements", { method: "POST", body: { key } }),
    },
    settings: { get: saves.get, all: saves.all, set: saves.set, reset: saves.delete },
    ownership: { get: () => api<Ownership>("/ownership") },
    purchases: {
      open: async () => {
        await call("purchases.open");
      },
    },
    fullscreen: {
      toggle: async () => {
        await call("fullscreen.toggle");
      },
    },
    quit: async () => {
      await call("quit");
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      if (event === "shown" && shown) {
        queueMicrotask(() => {
          if (set.has(listener)) listener();
        });
      }
      return () => set.delete(listener);
    },
    get shown() {
      return shown;
    },
  };
}

const Powly = { init, SDK_VERSION, PowlyError };
export default Powly;
export type {
  AudioApi,
  AudioChannel,
  AudioOptions,
  AudioState,
  ChannelState,
  ConnectOptions,
  HostEventName,
  PlayerProfile,
  PlayersOpenResult,
  PlayerView,
  TwitchApi,
  TwitchChatMessage,
  TwitchChatState,
  TwitchInfo,
};
