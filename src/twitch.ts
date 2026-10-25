// Twitch chat for games that use it (`powly.twitch`): Studio turns it on per game (Configuration →
// Twitch chat) and players connect Twitch in Powly's settings. Powly tells the game which channel
// is the player's (GET /twitch); the SDK then reads that channel's chat straight from Twitch, as
// an anonymous, read-only viewer, so no Twitch credentials ever reach the game.
//
//   const { status, channel } = await powly.twitch.connect();
//   if (status === "connected") {
//     powly.twitch.on("message", (message) => {
//       if (message.text === "!jump") player.jump();
//     });
//   }
//
// A game with a Twitch mode among others (Twitch chat "optional" in Studio) passes
// `{ prompt: true }` when the player picks that mode: if they haven't connected Twitch, Powly asks
// them to in its own dialog (drawn by Powly, outside the game), and `connect()` resolves once
// they did or closed it.
//
// Chat is Twitch IRC over a WebSocket (https://dev.twitch.tv/docs/chat/irc/). The connection comes
// back by itself when it drops, and stops when the launch ends.

export const TWITCH_CHAT_URL = "wss://irc-ws.chat.twitch.tv:443";

export type TwitchStatus = "connected" | "not_connected";

/** What GET /twitch answers: the game's Twitch chat setting and the player's channel. */
export type TwitchInfo = {
  /** The game's Twitch chat setting in Studio. */
  mode: "optional" | "required";
  /** "connected": `channel` is the player's. "not_connected": they haven't connected Twitch. */
  status: TwitchStatus;
  channel: { login: string; displayName: string } | null;
};

export type TwitchChatMessage = {
  /** Twitch's message ID (what "delete" events name). */
  id: string;
  /** The chatter's Twitch user ID, login and display name. */
  userId: string;
  login: string;
  displayName: string;
  /** Their name colour as "#RRGGBB", or null when they never picked one. */
  color: string | null;
  text: string;
  /** A "/me" message. */
  action: boolean;
  /** Bits cheered with the message (0 if none). */
  bits: number;
  /** Badge name → version, e.g. { subscriber: "12", moderator: "1" }. */
  badges: Record<string, string>;
  broadcaster: boolean;
  moderator: boolean;
  subscriber: boolean;
  vip: boolean;
  /** The chatter's first message in this channel ever. */
  firstMessage: boolean;
  /** When Twitch received it (ISO 8601). */
  sentAt: string;
};

/** The chat connection: "idle" until `connect()`, "closed" after `disconnect()`. */
export type TwitchChatState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

type Events = {
  message: TwitchChatMessage;
  /** A moderator deleted one message. */
  delete: { id: string };
  /** A moderator cleared the chat (`userId` null) or one chatter's messages (timeout, ban). */
  clear: { userId: string | null };
  state: TwitchChatState;
};

export type ConnectOptions = {
  /** Ask the player to connect Twitch in Powly's dialog when they haven't. Default false. */
  prompt?: boolean;
};

export type TwitchApi = {
  /** The game's setting and the player's channel, without opening chat. */
  info(): Promise<TwitchInfo>;
  /**
   * Opens the player's chat when they have a channel to read (`status: "connected"`). Resolves
   * with the info, once chat is joined (or failed to; it keeps retrying in the background).
   * `prompt`: when the player hasn't connected Twitch, Powly first asks them to in its own dialog
   * (they can connect it there without leaving the game); `status` is still "not_connected" if
   * they closed it.
   */
  connect(options?: ConnectOptions): Promise<TwitchInfo>;
  /** Closes chat; `connect()` opens it again. */
  disconnect(): void;
  readonly state: TwitchChatState;
  /** The channel chat is open for, or null. */
  readonly channel: TwitchInfo["channel"];
  on<E extends keyof Events>(event: E, listener: (value: Events[E]) => void): () => void;
};

// ── IRC ──────────────────────────────────────────────────────────────────────

export type IrcMessage = {
  tags: Record<string, string>;
  /** The sender's nick (the part of the prefix before "!"), or null. */
  nick: string | null;
  command: string;
  params: string[];
};

/** What a tag value's escapes stand for (anything else escaped is itself). */
const TAG_ESCAPES: Record<string, string> = { s: " ", ":": ";", r: "\r", n: "\n" };

const unescapeTag = (value: string) =>
  value.replace(/\\(.)?/g, (_, char: string | undefined) => TAG_ESCAPES[char ?? ""] ?? char ?? "");

/** One IRC line (without its CRLF), or null when it isn't one. */
export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    for (const pair of rest.slice(1, end).split(";")) {
      const eq = pair.indexOf("=");
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (key) tags[key] = eq < 0 ? "" : unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(end + 1).trimStart();
  }
  let nick: string | null = null;
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    const prefix = rest.slice(1, end);
    nick = prefix.includes("!") ? prefix.slice(0, prefix.indexOf("!")) : prefix;
    rest = rest.slice(end + 1).trimStart();
  }
  const params: string[] = [];
  const trailingAt = rest.indexOf(" :");
  const head = trailingAt < 0 ? rest : rest.slice(0, trailingAt);
  const words = head.split(" ").filter(Boolean);
  const command = words.shift();
  if (!command) return null;
  params.push(...words);
  if (trailingAt >= 0) params.push(rest.slice(trailingAt + 2));
  return { tags, nick, command: command.toUpperCase(), params };
}

/** "/me" messages arrive wrapped in CTCP: "\u0001ACTION text\u0001". */
const CTCP = String.fromCharCode(1);

const actionText = (text: string) =>
  text.startsWith(`${CTCP}ACTION `) && text.endsWith(CTCP) && text.length > 9
    ? text.slice(8, -1)
    : null;

/** A PRIVMSG as a chat message, or null. */
export function chatMessageOf(message: IrcMessage): TwitchChatMessage | null {
  if (message.command !== "PRIVMSG" || message.params.length < 2) return null;
  const { tags } = message;
  const raw = message.params[1] ?? "";
  const action = actionText(raw);
  const badges: Record<string, string> = {};
  for (const badge of (tags.badges ?? "").split(",")) {
    const slash = badge.indexOf("/");
    if (slash > 0) badges[badge.slice(0, slash)] = badge.slice(slash + 1);
  }
  const login = (message.nick ?? "").toLowerCase();
  const sentAt = Number(tags["tmi-sent-ts"]);
  return {
    id: tags.id ?? "",
    userId: tags["user-id"] ?? "",
    login,
    displayName: tags["display-name"] || login,
    color: /^#[0-9A-Fa-f]{6}$/.test(tags.color ?? "") ? (tags.color as string) : null,
    text: action ?? raw,
    action: action !== null,
    bits: Number(tags.bits) > 0 ? Number(tags.bits) : 0,
    badges,
    broadcaster: "broadcaster" in badges,
    moderator: tags.mod === "1" || "moderator" in badges,
    subscriber: tags.subscriber === "1" || "subscriber" in badges || "founder" in badges,
    vip: tags.vip === "1" || "vip" in badges,
    firstMessage: tags["first-msg"] === "1",
    sentAt: new Date(Number.isFinite(sentAt) && sentAt > 0 ? sentAt : Date.now()).toISOString(),
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Twitch pings every few minutes; silence for longer than this means the connection is gone. */
const SILENCE_MS = 6 * 60_000;

export function createTwitch(options: {
  getInfo: () => Promise<TwitchInfo>;
  /** Opens Powly's Connect Twitch dialog; resolves with whether Twitch is connected now. */
  prompt?: () => Promise<boolean>;
  /** Twitch chat's WebSocket URL (tests point it elsewhere). */
  url?: string;
}): TwitchApi & { stop(): void } {
  const url = options.url ?? TWITCH_CHAT_URL;
  const listeners = new Map<keyof Events, Set<(value: never) => void>>();
  let state: TwitchChatState = "idle";
  let channel: TwitchInfo["channel"] = null;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves `connect()` once the channel is joined (or the first try failed). */
  let joined: (() => void) | null = null;
  let stopped = false;

  const emit = <E extends keyof Events>(event: E, value: Events[E]) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        (listener as (value: Events[E]) => void)(value);
      } catch (error) {
        console.error("[powly] a Twitch listener failed", error);
      }
    }
  };

  const setState = (next: TwitchChatState) => {
    if (state === next) return;
    state = next;
    emit("state", next);
  };

  const settle = () => {
    joined?.();
    joined = null;
  };

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    retryTimer = null;
    silenceTimer = null;
  };

  const close = () => {
    clearTimers();
    const open = socket;
    socket = null;
    if (open) {
      open.onopen = open.onmessage = open.onclose = open.onerror = null;
      try {
        open.close();
      } catch {
        // Already closed.
      }
    }
  };

  const watchSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => reconnect(), SILENCE_MS);
  };

  /** Opens chat again after a pause (longer each try in a row), or at once (`now`). */
  const reconnect = (now = false) => {
    close();
    if (stopped || !channel || state === "closed" || state === "idle") return;
    setState("reconnecting");
    settle();
    const delay = now ? 0 : (RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 30_000);
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  const handle = (message: IrcMessage, ws: WebSocket) => {
    switch (message.command) {
      case "PING":
        ws.send(`PONG :${message.params[0] ?? "tmi.twitch.tv"}`);
        return;
      case "RECONNECT":
        // Twitch is restarting the server: come back right away.
        reconnect(true);
        return;
      case "ROOMSTATE":
      case "366":
        attempt = 0;
        setState("connected");
        settle();
        return;
      case "PRIVMSG": {
        const chat = chatMessageOf(message);
        if (chat) emit("message", chat);
        return;
      }
      case "CLEARMSG": {
        const id = message.tags["target-msg-id"];
        if (id) emit("delete", { id });
        return;
      }
      case "CLEARCHAT":
        emit("clear", { userId: message.tags["target-user-id"] || null });
        return;
    }
  };

  const open = () => {
    retryTimer = null;
    if (stopped || !channel) return;
    const login = channel.login;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      reconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      // Anonymous and read-only: Twitch accepts any "justinfan" nick without a password.
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 89_999)}`);
      ws.send(`JOIN #${login}`);
      watchSilence();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      watchSilence();
      for (const line of event.data.split("\r\n")) {
        if (!line) continue;
        const message = parseIrcLine(line);
        if (message) handle(message, ws);
      }
    };
    ws.onclose = () => {
      if (socket === ws) reconnect();
    };
    ws.onerror = () => {
      if (socket === ws) reconnect();
    };
  };

  const disconnect = () => {
    close();
    settle();
    channel = null;
    attempt = 0;
    if (state !== "idle") setState("closed");
  };

  return {
    info: options.getInfo,
    async connect(connectOptions = {}) {
      let info = await options.getInfo();
      if (info.status === "not_connected" && connectOptions.prompt && options.prompt) {
        if (await options.prompt()) info = await options.getInfo();
      }
      const next = info.status === "connected" ? info.channel : null;
      if (!next || stopped) {
        disconnect();
        return info;
      }
      // Already reading this channel.
      if (channel?.login === next.login && socket) return info;
      disconnect();
      channel = next;
      setState("connecting");
      const done = new Promise<void>((resolve) => {
        joined = resolve;
      });
      open();
      await done;
      return info;
    },
    disconnect,
    get state() {
      return state;
    },
    get channel() {
      return channel;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (value: never) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (value: never) => void);
    },
    stop() {
      stopped = true;
      disconnect();
    },
  };
}
