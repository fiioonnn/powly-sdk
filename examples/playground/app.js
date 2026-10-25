// Powly Playground: every function of the Powly SDK (window.Powly, from powly.js), one section
// at a time, with what each call sent and got in the log. The calls that need the game's secret
// key (a backend) are shown as ready-to-run commands for this launch instead.
//
// It has no backend, so it uses what the browser may do once the studio allows it: saves the
// browser may write (Studio → Saves), leaderboards created with clientSubmissions,
// and achievements marked "can be unlocked from the browser". `pnpm example:publish` sets all of
// that up.
(() => {
  let powly = null;
  let board = "score";
  let token = "";
  let friendsCache = null;

  // ── Small DOM helpers (text only: nothing from the API is ever parsed as HTML) ──────────────

  const $ = (id) => document.getElementById(id);
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name === "class") node.className = value;
      else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) {
        node.setAttribute(name, value === true ? "" : value);
      }
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) {
        node.append(child instanceof Node ? child : String(child));
      }
    }
    return node;
  }
  const pretty = (value) =>
    value === undefined ? "(nothing)" : (JSON.stringify(value, null, 2) ?? String(value));
  const empty = (text) => el("li", { class: "empty" }, text);

  // ── The log ─────────────────────────────────────────────────────────────────────────────────

  let entries = 0;
  function log(kind, title, detail, meta) {
    entries += 1;
    $("log-count").textContent = String(entries);
    const entry = el(
      "li",
      { class: `${kind} fresh` },
      el(
        "details",
        { open: kind === "err" },
        el(
          "summary",
          {},
          el("span", { class: "mark" }),
          el("span", { class: "label" }, title),
          el("span", { class: "meta" }, meta ?? ""),
        ),
        detail === undefined ? null : el("pre", {}, detail),
      ),
    );
    $("log").prepend(entry);
    setTimeout(() => entry.classList.remove("fresh"), 1000);
  }

  /** Runs one SDK call, logging what it returned or why it failed. */
  async function run(label, call) {
    const started = performance.now();
    try {
      const result = await call();
      log("ok", label, pretty(result), `${Math.round(performance.now() - started)} ms`);
      return result ?? true;
    } catch (error) {
      const status = error?.status ? `${error.status} · ` : error?.code ? `${error.code} · ` : "";
      log(
        "err",
        label,
        `${error?.name ?? "Error"}: ${error?.message ?? error}`,
        `${status}${Math.round(performance.now() - started)} ms`,
      );
      return undefined;
    }
  }

  const parseJson = (text, fallback) => {
    try {
      return JSON.parse(text);
    } catch {
      log("err", "Invalid JSON", text);
      return fallback;
    }
  };
  /** JSON if it parses, else the text itself (for chat messages). */
  const jsonOrText = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  // ── Tabs ────────────────────────────────────────────────────────────────────────────────────

  function showTab(name) {
    for (const button of document.querySelectorAll("[data-tab]")) {
      if (button.dataset.tab === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const panel of document.querySelectorAll("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    const first = { leaderboards: loadBoard, settings: () => loadSettings(true) }[name];
    if (first && powly) first();
  }

  // ── Player ──────────────────────────────────────────────────────────────────────────────────

  function showPlayer() {
    const { profile } = powly;
    $("username").textContent = profile.username;
    $("player-id").textContent = profile.playerId;
    $("avatar").replaceChildren(
      profile.avatarUrl
        ? el("img", { src: profile.avatarUrl, alt: "" })
        : (profile.username[0] ?? "?").toUpperCase(),
    );
    const facts = $("session");
    facts.replaceChildren();
    const add = (label, value) => facts.append(el("dt", {}, label), el("dd", {}, value));
    add("scopes", powly.scopes.join(" ") || "(none)");
    add("launchParams", JSON.stringify(powly.launchParams));
    add("launchId", powly.launchId);
    add("apiBase", powly.apiBase);
    add("SDK", window.Powly.SDK_VERSION);
    add("avatarUrl", profile.avatarUrl ?? "null (add one in Powly → Profile)");
  }

  /** A session token's claims (its middle part), for looking at, not for trusting. */
  function claimsOf(value) {
    try {
      const part = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(atob(part));
      return { ...claims, expiresIn: `${Math.round(claims.exp - Date.now() / 1000)} s` };
    } catch {
      return null;
    }
  }

  // ── Friends & invites ───────────────────────────────────────────────────────────────────────

  async function loadFriends() {
    const friends = await run("friends.list()", () => powly.friends.list());
    if (!friends) return;
    friendsCache = friends;
    $("friends").replaceChildren(
      ...(friends.length
        ? friends.map((friend) =>
            el(
              "li",
              {},
              el("span", { class: "grow" }, friend.username),
              el(
                "button",
                { type: "button", class: "small", onclick: () => inviteFriend(friend) },
                "invites.send()",
              ),
              el(
                "button",
                { type: "button", class: "small ghost", onclick: () => openPlayer(friend) },
                "players.open()",
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "small ghost",
                  onclick: () => openPlayer(friend, "report"),
                },
                "Report",
              ),
            ),
          )
        : [empty("None of your friends play this game yet.")]),
    );
  }

  async function inviteFriend(friend) {
    const params = parseJson($("invite-params").value || "{}", undefined);
    if (params === undefined) return;
    const sent = await run(`invites.send("${friend.playerId}")`, () =>
      powly.invites.send(friend.playerId, params),
    );
    if (sent) await unlock("invite-friend");
  }

  /** Powly's own dialog with the player's profile (add, block, report), or straight the report. */
  function openPlayer(friend, view) {
    const call = view
      ? `players.open("${friend.playerId}", { view: "${view}" })`
      : `players.open("${friend.playerId}")`;
    return run(call, () => powly.players.open(friend.playerId, view ? { view } : {}));
  }

  function inviteRow(invite, live) {
    const code = invite.params.room;
    return el(
      "li",
      {},
      el("span", { class: "grow" }, `${invite.from.username} invited you`),
      live ? el("span", { class: "tag accent" }, "live") : null,
      el("small", { class: "mono" }, JSON.stringify(invite.params)),
      code
        ? el(
            "button",
            { type: "button", class: "small primary", onclick: () => joinRoom(code) },
            `Join ${code}`,
          )
        : null,
    );
  }

  function showLiveInvite(invite) {
    log("event", `invite from ${invite.from.username}`, pretty(invite));
    const list = $("invites");
    list.querySelector(".empty")?.remove();
    list.prepend(inviteRow(invite, true));
  }

  // ── Rooms ───────────────────────────────────────────────────────────────────────────────────

  async function joinRoom(code) {
    const room = await run(`rooms.join("${code}")`, () =>
      powly.rooms.join(code, { me: { ready: false } }),
    );
    if (room) enterRoom(room);
  }

  async function createRoom() {
    const maxPlayers = Number($("room-size").value) || 4;
    const listed = $("room-listed").checked;
    const room = await run(`rooms.create({ maxPlayers: ${maxPlayers}, listed: ${listed} })`, () =>
      powly.rooms.create({ maxPlayers, listed, me: { ready: false } }),
    );
    if (!room) return;
    enterRoom(room);
    await unlock("party-host");
  }

  const nameOf = (room, playerId) =>
    room.members.find((member) => member.playerId === playerId)?.username ?? "Someone";

  /** A room message as one line: chat text as it is, anything else as event + JSON. */
  const messageText = (event, data) =>
    event === "chat" && typeof data === "string" ? data : `${event} ${JSON.stringify(data)}`;

  function feed(...parts) {
    const list = $("room-feed");
    list.append(el("li", {}, ...parts));
    list.scrollTop = list.scrollHeight;
  }
  const system = (text) => feed(el("span", { class: "system" }, text));

  function enterRoom(room) {
    showTab("rooms");
    $("room-feed").replaceChildren();
    system(`You’re in ${room.code}. Share the code, or invite a friend.`);
    room.on("message", ({ from, event, data }) => {
      log("event", `room: “${event}” from ${nameOf(room, from)}`, pretty(data));
      feed(el("span", { class: "who-said" }, nameOf(room, from)), " ", messageText(event, data));
    });
    room.on("join", (member) => {
      log("event", `room: ${member.username} joined`, pretty(member));
      system(`${member.username} joined`);
      renderRoom();
    });
    room.on("leave", ({ playerId, reason }) => {
      log("event", `room: ${playerId} ${reason}`);
      system(reason === "dropped" ? "A player dropped out" : `A player ${reason}`);
      renderRoom();
    });
    room.on("member", (member) => {
      log("event", `room: ${member.username} updated`, pretty(member));
      renderRoom();
    });
    room.on("update", () => {
      log("event", "room: updated", pretty({ hostId: room.hostId, data: room.data }));
      renderRoom();
    });
    room.on("closed", ({ reason }) => {
      log("event", `room: closed (${reason})`);
      renderRoom();
    });
    renderRoom();
  }

  function renderRoom() {
    const room = powly.rooms.current;
    $("room-lobby").hidden = Boolean(room);
    $("room-current").hidden = !room;
    $("rooms-badge").textContent = room ? room.code : "";
    $("rooms-badge").classList.toggle("live", Boolean(room));
    if (!room) return;
    const me = powly.profile.playerId;
    $("room-code-big").textContent = room.code;
    $("room-chips").replaceChildren(
      ...[
        el("span", { class: "tag" }, `${room.members.length} / ${room.maxPlayers} players`),
        room.isHost ? el("span", { class: "tag accent" }, "you host") : null,
        room.locked ? el("span", { class: "tag" }, "locked") : null,
        room.listed ? el("span", { class: "tag" }, "listed") : null,
        room.data ? el("span", { class: "tag" }, JSON.stringify(room.data)) : null,
      ].filter(Boolean),
    );
    $("host-tools").hidden = !room.isHost;
    const button = (label, title, call) =>
      el("button", { type: "button", class: "small", onclick: () => run(title, call) }, label);
    $("room-members").replaceChildren(
      ...room.members.map((member) => {
        const other = member.playerId !== me;
        return el(
          "li",
          { class: member.connected ? "" : "away" },
          el("span", { class: "grow" }, member.username, other ? "" : el("small", {}, " (you)")),
          member.playerId === room.hostId ? el("span", { class: "tag accent" }, "host") : null,
          member.data?.ready ? el("span", { class: "tag accent" }, "ready") : null,
          member.connected ? null : el("span", { class: "tag" }, "reconnecting…"),
          other && room.isHost
            ? button("make host", `room.makeHost("${member.playerId}")`, () =>
                room.makeHost(member.playerId).then(() => `${member.username} hosts now`),
              )
            : null,
          other && room.isHost
            ? button("kick", `room.kick("${member.playerId}")`, () =>
                room.kick(member.playerId).then(() => `kicked ${member.username}`),
              )
            : null,
        );
      }),
    );
  }

  /** Runs `call` with the current room, or says there isn't one. */
  function withRoom(label, call) {
    const room = powly.rooms.current;
    if (!room) return log("err", label, "Create or join a room first.");
    return run(label, () => call(room));
  }

  function sendMessage(event) {
    event.preventDefault();
    const room = powly.rooms.current;
    if (!room) return;
    const name = $("room-event").value.trim() || "chat";
    const data = jsonOrText($("room-data").value);
    const sent = room.send(name, data);
    log(sent ? "ok" : "err", `room.send("${name}")`, pretty(data), sent ? "sent" : "not connected");
    if (!sent) return;
    feed(el("span", { class: "who-said" }, "You"), " ", messageText(name, data));
    $("room-data").value = "";
    if (room.members.length > 1) void unlock("pen-pal");
  }

  async function pickFriendForRoom() {
    const room = powly.rooms.current;
    if (!room) return;
    if (!friendsCache) await loadFriends();
    $("pick-friend-list").replaceChildren(
      ...(friendsCache?.length
        ? friendsCache.map((friend) =>
            el(
              "li",
              {},
              el("span", { class: "grow" }, friend.username),
              el(
                "button",
                {
                  type: "button",
                  class: "small primary",
                  onclick: async () => {
                    $("pick-friend").close();
                    await run(`room.invite("${friend.playerId}")`, () =>
                      room.invite(friend.playerId).then(() => `invited to ${room.code}`),
                    );
                  },
                },
                "Invite",
              ),
            ),
          )
        : [empty("None of your friends play this game yet.")]),
    );
    $("pick-friend").showModal();
  }

  async function listRooms() {
    const rooms = await run("rooms.list()", () => powly.rooms.list());
    if (!rooms) return;
    $("room-list").replaceChildren(
      ...(rooms.length
        ? rooms.map((room) =>
            el(
              "li",
              {},
              el("span", { class: "mono" }, room.code),
              el("span", { class: "grow" }, `${room.host}’s room`),
              el("small", {}, `${room.players}/${room.maxPlayers}`),
              el(
                "button",
                { type: "button", class: "small primary", onclick: () => joinRoom(room.code) },
                "Join",
              ),
            ),
          )
        : [empty("No listed rooms right now. Create one with “Listed” ticked.")]),
    );
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────────

  async function loadSettings(quiet = false) {
    const settings = quiet
      ? await powly.saves.all().catch(() => undefined)
      : await run("saves.all()", () => powly.saves.all());
    if (!settings) return;
    const keys = Object.keys(settings);
    $("settings").replaceChildren(
      ...(keys.length
        ? keys.map((key) => {
            const input = el("input", {
              value: JSON.stringify(settings[key]),
              "aria-label": `${key} (JSON)`,
              spellcheck: "false",
            });
            return el(
              "div",
              { class: "setting" },
              el("span", { class: "mono" }, key),
              input,
              el(
                "div",
                { class: "actions" },
                el(
                  "button",
                  {
                    type: "button",
                    class: "small primary",
                    onclick: () => saveSetting(key, input),
                  },
                  "set",
                ),
                el(
                  "button",
                  { type: "button", class: "small", onclick: () => resetSetting(key) },
                  "reset",
                ),
              ),
            );
          })
        : [el("p", { class: "empty" }, "No saves with a value yet (Studio → Saves).")]),
    );
  }

  async function saveSetting(key, input) {
    const value = parseJson(input.value, undefined);
    if (value === undefined) return;
    const done = await run(`saves.set("${key}", ${JSON.stringify(value)})`, () =>
      powly.saves.set(key, value).then(() => "saved"),
    );
    if (done) await unlock("make-it-yours");
    await loadSettings(true);
  }

  async function resetSetting(key) {
    await run(`saves.delete("${key}")`, () => powly.saves.delete(key).then(() => "deleted"));
    await loadSettings(true);
  }

  // ── Leaderboards ────────────────────────────────────────────────────────────────────────────

  async function loadBoard() {
    const top = await run(`leaderboards.top("${board}", 10)`, () =>
      powly.leaderboards.top(board, 10),
    );
    $("leaderboard").replaceChildren(
      ...(top?.length
        ? top.map((entry) =>
            el(
              "li",
              { class: entry.playerId === powly.profile.playerId ? "me" : "" },
              el("span", { class: "rank" }, `#${entry.rank}`),
              el("span", { class: "name" }, entry.username ?? "Player"),
              el("span", { class: "mono" }, entry.score),
            ),
          )
        : [el("li", { class: "empty" }, "No scores yet. Submit one.")]),
    );
  }

  function pickBoard(next) {
    board = next;
    for (const button of document.querySelectorAll("[data-board]")) {
      button.setAttribute("aria-pressed", String(button.dataset.board === next));
    }
    $("board-hint").textContent =
      next === "score" ? "Higher is better." : "A run time in milliseconds; lower is better.";
    $("score").value = next === "score" ? "1200" : "60000";
    void loadBoard();
  }

  // ── Achievements ────────────────────────────────────────────────────────────────────────────

  async function unlock(key) {
    const result = await run(`achievements.unlock("${key}")`, () => powly.achievements.unlock(key));
    if (result) await loadAchievements(true);
    return result;
  }

  async function loadAchievements(quiet = false) {
    const list = quiet
      ? await powly.achievements.list().catch(() => undefined)
      : await run("achievements.list()", () => powly.achievements.list());
    if (!list) return;
    const unlocked = list.filter((achievement) => achievement.unlocked).length;
    $("achievements-badge").textContent = `${unlocked}/${list.length}`;
    $("achievements").replaceChildren(
      ...list.map((achievement) =>
        el(
          "li",
          { class: achievement.unlocked ? "done" : "" },
          el(
            "span",
            { class: "title" },
            el("span", { class: "star" }, achievement.unlocked ? "★" : "☆"),
            achievement.name,
          ),
          el("p", {}, achievement.description || " "),
          el(
            "span",
            { class: "actions" },
            el("span", { class: "tag" }, achievement.rarity),
            el("span", { class: "tag" }, achievement.key),
            achievement.unlocked
              ? null
              : el(
                  "button",
                  { type: "button", class: "small", onclick: () => unlock(achievement.key) },
                  "unlock()",
                ),
          ),
        ),
      ),
    );
  }

  // ── Backend commands (need the secret key: run them on a server, not in a browser) ───────────

  function renderBackend() {
    const api = powly.apiBase;
    const origin = new URL(api).origin;
    const auth = '-u "$CLIENT_ID:$SECRET_KEY"';
    const json = "-H 'content-type: application/json'";
    const bearer = '-H "authorization: Bearer $ACCESS_TOKEN"';
    const snippets = [
      [
        "Exchange this session token for an access token",
        `curl ${origin}/api/platform/oauth/token ${auth} \\\n  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \\\n  -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \\\n  -d subject_token=${token || "<run getSessionToken() on the Player tab>"}`,
      ],
      [
        "Write the backend-only save “coins”",
        `curl -X PUT ${api}/saves/coins ${bearer} ${json} \\\n  -d '{"value":250}'`,
      ],
      [
        "Turn on the backend-only save “cheats”",
        `curl -X PUT ${api}/saves/cheats ${bearer} ${json} \\\n  -d '{"value":true}'`,
      ],
      [
        "Unlock “backend-only” for this player",
        `curl ${api}/achievements ${auth} ${json} \\\n  -d '{"playerId":"${powly.profile.playerId}","key":"backend-only"}'`,
      ],
      [
        "Submit a score for this player",
        `curl ${api}/leaderboards/score/scores ${auth} ${json} \\\n  -d '{"playerId":"${powly.profile.playerId}","score":4200}'`,
      ],
      [
        "Create or update a leaderboard",
        `curl ${api}/leaderboards ${auth} ${json} \\\n  -d '{"key":"score","name":"Score","minScore":0,"maxScore":1000000,"maxScorePerSecond":1000,"clientSubmissions":true}'`,
      ],
      ["Public keys to verify session tokens", `curl ${origin}/.well-known/jwks.json`],
    ];
    $("backend").replaceChildren(
      ...snippets.map(([title, command]) => {
        const pre = el("pre", {}, command);
        const copy = el(
          "button",
          {
            type: "button",
            class: "small ghost",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(command);
                copy.textContent = "copied";
              } catch {
                // The game's frame may not be allowed the clipboard: select it for ⌘C instead.
                getSelection()?.selectAllChildren(pre);
                copy.textContent = "selected";
              }
              setTimeout(() => {
                copy.textContent = "copy";
              }, 1500);
            },
          },
          "copy",
        );
        return el("div", { class: "snippet" }, el("h3", {}, title, copy), pre);
      }),
    );
  }

  // ── Actions (buttons with data-action) ──────────────────────────────────────────────────────

  const saveKey = () => $("save-key").value.trim();

  const actions = {
    async token() {
      const value = await run("getSessionToken()", () => powly.getSessionToken());
      if (typeof value !== "string") return;
      token = value;
      $("claims").hidden = false;
      $("claims").textContent = `${pretty(claimsOf(value))}\n\n${value}`;
      renderBackend();
    },
    me: () => run('api("/me")', () => powly.api("/me")),
    ownership: () => run("ownership.get()", () => powly.ownership.get()),
    async avatar() {
      const url = powly.profile.avatarUrl;
      if (!url) {
        return log("err", "fetch(avatarUrl)", "This player has no avatar (avatarUrl is null).");
      }
      await run("fetch(avatarUrl)", async () => {
        const response = await fetch(url);
        const blob = await response.blob();
        if (!response.ok) {
          throw Object.assign(new Error("The avatar didn’t load."), { status: response.status });
        }
        return { status: response.status, type: blob.type, bytes: blob.size };
      });
    },
    // A game's Twitch mode: Powly asks the player to connect Twitch when they haven't.
    // Powly's sound menu: a channel registered after init, with only an on/off switch.
    "audio-register": () =>
      run('audio.register({ id: "drawing", volume: false })', async () => {
        await powly.audio.register({ id: "drawing", label: "Drawing sounds", volume: false });
        return powly.audio.channels;
      }),
    "audio-set": () =>
      run("audio.set({ music: 0.3 })", async () => {
        await powly.audio.set({ channels: { music: { volume: 0.3 } } });
        return { music: powly.audio.level("music"), effects: powly.audio.level("effects") };
      }),
    twitch: () =>
      run("twitch.connect({ prompt: true })", () => powly.twitch.connect({ prompt: true })),
    friends: loadFriends,
    async invites() {
      const invites = await run("invites.list()", () => powly.invites.list());
      if (!Array.isArray(invites)) return;
      $("invites").replaceChildren(
        ...(invites.length
          ? invites.map((invite) => inviteRow(invite, false))
          : [empty("No invites right now.")]),
      );
    },
    presence: () =>
      run("presence.set(text)", () =>
        powly.presence.set($("presence").value || null).then(() => "set"),
      ),
    "presence-clear": () =>
      run("presence.set(null)", () => powly.presence.set(null).then(() => "cleared")),

    "room-create": createRoom,
    "room-join"() {
      const code = $("room-code").value.trim();
      if (!code) return log("err", "rooms.join()", "Type a room code first.");
      return joinRoom(code);
    },
    "room-list": listRooms,
    "room-leave": () =>
      withRoom("room.leave()", (room) =>
        room.leave().then(() => {
          renderRoom();
          return "left";
        }),
      ),
    "room-ready": () =>
      withRoom("room.setMyData()", async (room) => {
        const me = room.members.find((member) => member.playerId === powly.profile.playerId);
        const ready = !me?.data?.ready;
        await room.setMyData({ ready });
        renderRoom();
        return { ready };
      }),
    "room-invite-friends": pickFriendForRoom,
    "room-update-data": () =>
      withRoom("room.update({ data })", async (room) => {
        const data = parseJson($("room-state").value, undefined);
        if (data === undefined) return "not changed";
        await room.update({ data });
        return { data: room.data };
      }),
    "room-lock": () =>
      withRoom("room.update({ locked })", async (room) => {
        await room.update({ locked: !room.locked });
        return { locked: room.locked };
      }),
    "room-listed": () =>
      withRoom("room.update({ listed })", async (room) => {
        await room.update({ listed: !room.listed });
        return { listed: room.listed };
      }),

    "setting-all": () => loadSettings(),

    "save-get": () => run(`saves.get("${saveKey()}")`, () => powly.saves.get(saveKey())),
    async "save-set"() {
      const value = parseJson($("save-value").value, undefined);
      if (value === undefined) return;
      const done = await run(`saves.set("${saveKey()}")`, () =>
        powly.saves.set(saveKey(), value).then(() => "saved"),
      );
      if (done) await unlock("first-save");
    },
    "save-delete": () =>
      run(`saves.delete("${saveKey()}")`, () =>
        powly.saves.delete(saveKey()).then(() => "deleted"),
      ),
    "save-list": () => run("saves.list()", () => powly.saves.list()),

    async submit() {
      const score = Number($("score").value);
      const result = await run(`leaderboards.submit("${board}", ${score})`, () =>
        powly.leaderboards.submit(board, score),
      );
      if (!result) return;
      await unlock("first-score");
      await loadBoard();
    },

    fullscreen: () => run("fullscreen.toggle()", () => powly.fullscreen.toggle().then(() => "ok")),
    purchase: () => run("purchases.open()", () => powly.purchases.open().then(() => "opened")),
    quit: () => run("quit()", () => powly.quit().then(() => "closing")),
    "clear-log": () => {
      entries = 0;
      $("log-count").textContent = "";
      $("log").replaceChildren();
    },
  };

  // ── Start ───────────────────────────────────────────────────────────────────────────────────

  const controls = () => document.querySelectorAll("[data-action], [data-board], [data-save-key]");
  for (const control of controls()) control.disabled = true;

  document.addEventListener("click", (event) => {
    const target = event.target.closest?.(
      "[data-tab], [data-action], [data-board], [data-save-key]",
    );
    if (!target) return;
    if (target.dataset.tab) return showTab(target.dataset.tab);
    if (!powly) return;
    if (target.dataset.board) return pickBoard(target.dataset.board);
    if (target.dataset.saveKey) {
      $("save-key").value = target.dataset.saveKey;
      return;
    }
    actions[target.dataset.action]?.();
  });
  $("room-composer").addEventListener("submit", sendMessage);
  $("room-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") actions["room-join"]();
  });

  const started = performance.now();
  // Two kinds of sound for Powly's sound menu; "drawing" is registered later (a button).
  window.Powly.init({
    audio: {
      channels: [
        { id: "music", label: "Music" },
        { id: "effects", label: "Sound effects" },
      ],
    },
  })
    .then(async (session) => {
      powly = session;
      $("who").className = "who ok";
      $("who-text").textContent =
        `${powly.profile.username}${powly.launchParams.devMode === "true" ? " · developer mode" : ""}`;
      log(
        "ok",
        "Powly.init()",
        pretty({ profile: powly.profile, scopes: powly.scopes, launchParams: powly.launchParams }),
        `${Math.round(performance.now() - started)} ms`,
      );
      for (const control of controls()) control.disabled = false;
      showPlayer();
      renderBackend();

      for (const event of ["shown", "pause", "resume", "ended"]) {
        powly.on(event, () => log("event", `powly.on("${event}")`));
      }
      powly.rooms.on("status", (status) => {
        log("event", `realtime: ${status}`);
        if (!powly.rooms.current) {
          $("rooms-badge").textContent = status === "connected" ? "" : status;
        }
      });
      powly.invites.on("received", showLiveInvite);
      powly.audio.on("change", (audio) => log("event", 'powly.audio.on("change")', pretty(audio)));

      // A hidden achievement for the curious: a tiny button in the corner.
      document.body.append(
        el("button", {
          type: "button",
          class: "secret",
          title: "?",
          "aria-label": "?",
          onclick: () => unlock("secret-button"),
        }),
      );

      // Opened from a room invite: straight into the room it carries.
      if (powly.launchParams.room) await joinRoom(powly.launchParams.room);
      await unlock("hello");
      await Promise.all([loadAchievements(true), loadSettings(true)]);
    })
    .catch((error) => {
      $("who").className = "who err";
      $("who-text").textContent = `Not connected: ${error.message}`;
      log("err", "Powly.init()", String(error.message));
    });
})();
