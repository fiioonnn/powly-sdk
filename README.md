# @powly/sdk

The SDK for games on [Powly](https://powly.gg): the launch handshake with Powly, the player's
profile, session tokens and the platform services (saves, leaderboards, achievements, friends,
invites, multiplayer rooms, Twitch chat, sound settings).

## Install

```bash
npm install @powly/sdk
```

Starting a new game? `npm create powly@latest my-game` sets up a React + Vite project with
the SDK.

## Use

Call `Powly.init()` as early as possible (before loading your game's assets): Powly expects the
handshake promptly, and it only succeeds when the game was launched from Powly.

```ts
import Powly from "@powly/sdk";

const powly = await Powly.init();

powly.profile.username;
const level = (await powly.saves.get<number>("level")) ?? 1;
await powly.leaderboards.submit("high-score", 1200);
```

Without a bundler, load the classic script instead; it defines `window.Powly`:

```html
<script src="https://cdn.jsdelivr.net/npm/@powly/sdk@0.10.0/dist/powly.js"></script>
```

## Testing

Run your dev server and open it in **Studio → Developer mode** (for example
`http://localhost:5173`). Opened directly, `Powly.init()` rejects with "This game only runs when
launched from Powly."

## Self-hosted Powly

This package trusts `https://powly.gg` and `http://localhost:3000`. For another Powly
installation, pass its origin:

```ts
await Powly.init({ powlyOrigin: "https://games.example.com" });
```

## Security

The game runs in the player's browser, so nothing here is a security boundary. Saves and
leaderboard scores are written by your backend unless the studio allows browser writes for them;
your backend verifies session tokens or exchanges them for an access token.

## This repository

The SDK is developed in Powly's main repository and mirrored here with each release; this is
`@powly/sdk` 0.10.0. Issues are welcome; changes land through the main repository.

To build it yourself (Node.js 24 or newer):

```bash
npm install
npm run build
```

`dist/powly.mjs`, `dist/powly.js` and `dist/powly.d.ts` are what npm ships. `examples/` has
Starfall, a small example game, and the SDK playground (every SDK function behind a button).
