// Starfall: catch the falling stars, dodge the meteors. A small game showing the Powly SDK
// (window.Powly, from powly.js): the player's name, their best score in Powly saves, a
// leaderboard, achievements, pausing when Powly's menu opens, the player's "start muted"
// preference and fullscreen.
//
// It has no backend, so it saves and submits scores from the browser. Powly only allows that when
// the studio allows it (players could cheat): a "best" save the browser may write (Studio → Player
// data), and a "high-score" board created with clientSubmissions, for example:
//
//   curl -u "$CLIENT_ID:$SECRET_KEY" -H 'content-type: application/json' \
//     https://powly.gg/api/platform/v1/leaderboards \
//     -d '{"key":"high-score","name":"High score","minScore":0,"maxScore":1000000,
//          "maxScorePerSecond":60,"clientSubmissions":true}'
//
// A real game should keep scores and saves on its own backend instead.
(() => {
  const BOARD = "high-score";
  const STAR_POINTS = 10;
  const LIVES = 3;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const screen = document.getElementById("screen");
  const $score = document.getElementById("score");
  const $lives = document.getElementById("lives");
  const $sound = document.getElementById("sound");
  const $fullscreen = document.getElementById("fullscreen");

  let powly = null;
  let best = 0;
  let muted = false;
  let width = 0;
  let height = 0;
  let scale = 1;

  // ── Drawing surface ──────────────────────────────────────────────────────────

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // Sizes are relative to a 720 px tall screen.
    scale = Math.max(0.6, Math.min(height / 720, 1.6));
  }
  window.addEventListener("resize", resize);
  resize();

  const backdrop = Array.from({ length: 120 }, () => ({
    x: Math.random(),
    y: Math.random(),
    size: Math.random() * 1.6 + 0.3,
    speed: Math.random() * 0.02 + 0.005,
  }));

  // ── Sound (tiny synthesized blips) ───────────────────────────────────────────

  let audio = null;
  function blip(frequency, duration, type = "sine", volume = 0.08) {
    if (muted) return;
    audio ??= new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + duration);
  }
  function setMuted(value) {
    muted = value;
    $sound.classList.toggle("off", muted);
    $sound.setAttribute("aria-pressed", String(!muted));
  }
  $sound.addEventListener("click", () => setMuted(!muted));

  // ── Game state ───────────────────────────────────────────────────────────────

  const state = {
    phase: "title", // "title" | "playing" | "paused" | "over"
    score: 0,
    lives: LIVES,
    time: 0,
    ship: { x: 0.5, target: 0.5 },
    things: [],
    sparks: [],
    spawnIn: 0,
    hurtFor: 0,
  };
  const keys = new Set();

  function start() {
    Object.assign(state, {
      phase: "playing",
      score: 0,
      lives: LIVES,
      time: 0,
      things: [],
      sparks: [],
      spawnIn: 0.6,
      hurtFor: 0,
      wasHit: false,
    });
    state.ship.x = state.ship.target = 0.5;
    screen.hidden = true;
    updateHud();
    blip(660, 0.12, "triangle");
  }

  function updateHud() {
    $score.textContent = String(state.score);
    $lives.textContent = "♥".repeat(state.lives);
  }

  function spawn() {
    // Faster and busier the longer the run lasts.
    const level = Math.min(state.time / 60, 1);
    const meteor = Math.random() < 0.28 + level * 0.22;
    state.things.push({
      kind: meteor ? "meteor" : "star",
      x: 0.06 + Math.random() * 0.88,
      y: -0.05,
      speed: (meteor ? 0.28 : 0.22) + level * 0.35 + Math.random() * 0.1,
      spin: Math.random() * Math.PI,
      size: meteor ? 0.03 + Math.random() * 0.02 : 0.022,
    });
    state.spawnIn = 0.75 - level * 0.42 + Math.random() * 0.25;
  }

  function burst(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 0.4 + 0.1;
      state.sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.4,
        color,
      });
    }
  }

  function update(dt) {
    for (const star of backdrop) {
      star.y += star.speed * dt * (state.phase === "playing" ? 3 : 1);
      if (star.y > 1) {
        star.y -= 1;
        star.x = Math.random();
      }
    }
    for (const spark of state.sparks) {
      spark.x += spark.vx * dt * (height / width);
      spark.y += spark.vy * dt;
      spark.life -= dt;
    }
    state.sparks = state.sparks.filter((spark) => spark.life > 0);
    if (state.phase !== "playing") return;

    state.time += dt;
    state.hurtFor = Math.max(0, state.hurtFor - dt);
    const ship = state.ship;
    const steer = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
    if (steer) ship.target = Math.min(0.97, Math.max(0.03, ship.target + steer * dt * 0.9));
    ship.x += (ship.target - ship.x) * Math.min(1, dt * 14);

    state.spawnIn -= dt;
    if (state.spawnIn <= 0) spawn();

    const shipY = 0.88;
    const aspect = height / width;
    for (const thing of state.things) {
      thing.y += thing.speed * dt;
      thing.spin += dt * 2;
      const dx = (thing.x - ship.x) / aspect;
      const dy = thing.y - shipY;
      if (!thing.done && Math.hypot(dx, dy) < thing.size + 0.035) {
        thing.done = true;
        if (thing.kind === "star") {
          state.score += STAR_POINTS;
          burst(thing.x, thing.y, "#ffd76a", 10);
          blip(880 + Math.random() * 220, 0.1, "triangle");
          checkAchievements();
        } else if (state.hurtFor === 0) {
          state.lives -= 1;
          state.wasHit = true;
          state.hurtFor = 1.2;
          burst(thing.x, thing.y, "#ff8fa3", 18);
          blip(140, 0.35, "sawtooth", 0.1);
          if (state.lives <= 0) gameOver();
        }
        updateHud();
      }
    }
    state.things = state.things.filter((thing) => !thing.done && thing.y < 1.1);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────────

  function drawStar(x, y, radius, rotation, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? radius : radius * 0.45;
      const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.shadowColor = color;
    ctx.shadowBlur = radius;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function drawMeteor(x, y, radius, rotation) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = radius * (0.78 + ((i * 37) % 7) / 25);
      const angle = (i / 8) * Math.PI * 2;
      ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.fillStyle = "#6b4f5e";
    ctx.fill();
    ctx.strokeStyle = "#ff8fa3";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#0b0d1a");
    sky.addColorStop(1, "#22163d");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    for (const star of backdrop) {
      ctx.globalAlpha = 0.35 + star.size / 3;
      ctx.fillStyle = "#cfd6ff";
      ctx.fillRect(star.x * width, star.y * height, star.size, star.size);
    }
    ctx.globalAlpha = 1;

    for (const thing of state.things) {
      const x = thing.x * width;
      const y = thing.y * height;
      if (thing.kind === "star") {
        drawStar(x, y, thing.size * height, thing.spin, "#ffd76a");
      } else {
        drawMeteor(x, y, thing.size * height, thing.spin);
      }
    }

    for (const spark of state.sparks) {
      ctx.globalAlpha = Math.max(spark.life * 1.6, 0);
      ctx.fillStyle = spark.color;
      ctx.fillRect(spark.x * width, spark.y * height, 3 * scale, 3 * scale);
    }
    ctx.globalAlpha = 1;

    if (state.phase !== "title") {
      // The ship: a small glowing catcher, blinking while it recovers from a hit.
      const x = state.ship.x * width;
      const y = 0.88 * height;
      if (state.hurtFor === 0 || Math.floor(state.hurtFor * 10) % 2 === 0) {
        ctx.save();
        ctx.shadowColor = "#8fb4ff";
        ctx.shadowBlur = 18 * scale;
        ctx.fillStyle = "#e8eeff";
        ctx.beginPath();
        ctx.moveTo(x, y - 20 * scale);
        ctx.lineTo(x + 18 * scale, y + 12 * scale);
        ctx.lineTo(x, y + 5 * scale);
        ctx.lineTo(x - 18 * scale, y + 12 * scale);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Input ────────────────────────────────────────────────────────────────────

  const keyNames = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" };
  window.addEventListener("keydown", (event) => {
    if (keyNames[event.code]) keys.add(keyNames[event.code]);
    if (event.code === "Space" || event.code === "Enter") {
      if (state.phase === "title" || state.phase === "over") {
        event.preventDefault();
        if (powly) start();
      }
    }
    if (event.code === "KeyP" || event.code === "Escape") togglePause();
    if (event.code === "KeyM") setMuted(!muted);
  });
  window.addEventListener("keyup", (event) => keys.delete(keyNames[event.code]));
  window.addEventListener("pointermove", (event) => {
    state.ship.target = Math.min(0.97, Math.max(0.03, event.clientX / width));
  });
  window.addEventListener("pointerdown", (event) => {
    state.ship.target = Math.min(0.97, Math.max(0.03, event.clientX / width));
  });

  function pause() {
    if (state.phase !== "playing") return;
    state.phase = "paused";
    keys.clear();
    show(`<div class="card"><h1>Paused</h1><p class="hint">Press P or click to continue</p></div>`);
    screen.onclick = resume;
  }
  function resume() {
    if (state.phase !== "paused") return;
    state.phase = "playing";
    screen.hidden = true;
    screen.onclick = null;
    last = performance.now();
  }
  function togglePause() {
    if (state.phase === "playing") pause();
    else resume();
  }

  // ── Screens ──────────────────────────────────────────────────────────────────

  const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

  function show(html) {
    screen.innerHTML = html;
    screen.hidden = false;
  }

  function titleScreen(message) {
    const name = powly ? escapeHtml(powly.profile.username) : null;
    show(`<div class="card">
      <h1>Starfall</h1>
      ${name ? `<p>Hi, ${name}!</p>` : ""}
      <p>Catch the stars. Dodge the meteors.</p>
      ${best ? `<p class="hint">Your best: ${best}</p>` : ""}
      ${
        message
          ? `<p class="hint">${escapeHtml(message)}</p>`
          : `<button id="play" type="button">Play</button>
             <p class="hint">Arrow keys, A/D or your mouse to move · P to pause · M for sound</p>`
      }
    </div>`);
    document.getElementById("play")?.addEventListener("click", start);
  }

  async function gameOver() {
    state.phase = "over";
    const score = state.score;
    const isBest = score > best;
    if (isBest) best = score;
    show(`<div class="card">
      <p>Game over</p>
      <p class="big">${score}</p>
      ${isBest && score > 0 ? `<p class="new">New best!</p>` : `<p class="hint">Best: ${best}</p>`}
      <ol class="board" id="board"><li class="hint">Loading the leaderboard…</li></ol>
      <button id="again" type="button">Play again</button>
    </div>`);
    document.getElementById("again").addEventListener("click", start);

    if (isBest) await saveBest();
    await showLeaderboard(score);
  }

  // ── Powly ────────────────────────────────────────────────────────────────────

  // Achievements (defined for Starfall in Studio, each marked "can be unlocked from the
  // browser"). Each is unlocked once per launch at most; Powly ignores repeats anyway.
  const unlocked = new Set();
  function unlock(key) {
    if (!powly || unlocked.has(key)) return;
    unlocked.add(key);
    powly.achievements.unlock(key).catch((error) => {
      unlocked.delete(key);
      console.info(`Starfall: achievement ${key} not unlocked:`, error.message);
    });
  }
  function checkAchievements() {
    unlock("first-star");
    if (state.score >= 100) unlock("century");
    if (state.score >= 500) unlock("stellar");
    if (state.score >= 200 && !state.wasHit) unlock("flawless");
  }

  async function saveBest() {
    try {
      localStorage.setItem("starfall-best", String(best));
    } catch {}
    try {
      // Needs a "best" save the browser may write (Studio → Saves); otherwise a 403 or 404,
      // and the best score stays on this device only.
      await powly.saves.set("best", best);
    } catch (error) {
      console.info("Starfall: best score not saved to Powly:", error.message);
    }
  }

  async function showLeaderboard(score) {
    const board = document.getElementById("board");
    try {
      if (score > 0) await powly.leaderboards.submit(BOARD, score);
    } catch (error) {
      console.info("Starfall: score not submitted:", error.message);
    }
    try {
      const top = await powly.leaderboards.top(BOARD, 5);
      if (!board?.isConnected) return;
      board.innerHTML = top.length
        ? top
            .map(
              (entry) => `<li class="${entry.playerId === powly.profile.playerId ? "me" : ""}">
                <span class="rank">${entry.rank}</span>
                <span class="name">${escapeHtml(entry.username ?? "Player")}</span>
                <span>${entry.score}</span>
              </li>`,
            )
            .join("")
        : `<li class="hint">No scores yet. Be the first!</li>`;
    } catch {
      if (board?.isConnected)
        board.innerHTML = `<li class="hint">The leaderboard isn’t set up yet.</li>`;
    }
  }

  $fullscreen.addEventListener("click", () => powly?.fullscreen.toggle());

  titleScreen("Connecting to Powly…");
  window.Powly.init()
    .then(async (session) => {
      powly = session;
      setMuted(powly.launchParams.muted === "true");
      // Powly's menu or a dialog opened over the game, or the tab was hidden.
      powly.on("pause", pause);
      powly.on("ended", () => {
        state.phase = "over";
        titleScreen("This session has ended. Start Starfall again from Powly.");
      });
      try {
        best = Number(localStorage.getItem("starfall-best")) || 0;
      } catch {}
      try {
        // Reading saves always works, from any device the player uses.
        best = Math.max(best, Number(await powly.saves.get("best")) || 0);
      } catch {}
      titleScreen();
    })
    .catch(() => {
      titleScreen("Starfall runs on Powly. Open it from its store page to play.");
    });
})();
