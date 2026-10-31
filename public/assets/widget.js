/*
 * Karasu stream widget - the overlay itself.
 *
 * Runs entirely in the viewer's browser source: it reads the public Karasu API
 * directly (CORS is open, 10 requests a minute per IP), so nothing is proxied
 * and one streamer's widget can never eat another's rate limit.
 *
 * The API only returns the last five matches, so "today" is tallied here: every
 * poll folds today's matches into a per-day record in localStorage, which OBS's
 * browser source keeps between sessions. Whenever the day's first match is in
 * view, the day's starting ELO is pinned too, so the ELO-today figure stays
 * exact even after more than five games.
 *
 * Query parameters (all optional except id):
 *   id        17-digit Steam ID (a full karasu.live profile link also works)
 *   layout    card (default) | bar
 *   stats     1 to add the last-20 row (K/D, ADR, HS, win rate)
 *   avatar    0 to hide the Steam avatar
 *   daystart  hour 0-23 when "today" rolls over (default 0, local midnight)
 *   scale     0.5-3 (default 1)
 *   bg        panel opacity 0-100 (default 90)
 *   demo      1 for sample data (no id needed)
 *   preview   1 inside the builder: data comes from the page, nothing is
 *             persisted, and simulated matches can be played
 */
(() => {
  "use strict";

  const API = "https://api.karasu.live/public/v1/players/";
  const POLL_MS = 45_000;
  const BACKOFF_MS = 90_000;
  const STALE_MS = 4 * 60_000;
  const SIM_HOLD_MS = 2 * 60_000;

  // Karasu's ladder (utils/eloTier.ts on the site): ten 400-point levels, then
  // Ultimate from 4500. Used for the progress bar and for demo/simulated data.
  const LEVEL_SIZE = 400;
  const ULTIMATE = 4500;
  const LEVEL_RGB = {
    1: "177 195 217", 2: "177 195 217", 3: "34 197 94", 4: "34 197 94",
    5: "168 85 247", 6: "168 85 247", 7: "249 115 22", 8: "249 115 22",
    9: "239 68 68", 10: "245 158 11", ultimate: "14 165 201",
  };

  const q = new URLSearchParams(location.search);
  const num = (v, d) => {
    const n = Number(v);
    return v !== null && v !== "" && Number.isFinite(n) ? n : d;
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const cfg = {
    id: ((q.get("id") || "").match(/\d{17}/) || [])[0] || null,
    layout: q.get("layout") === "bar" ? "bar" : "card",
    stats: q.get("stats") === "1",
    avatar: q.get("avatar") !== "0",
    dayStart: clamp(Math.round(num(q.get("daystart"), 0)), 0, 23),
    scale: clamp(num(q.get("scale"), 1), 0.5, 3),
    bg: clamp(Math.round(num(q.get("bg"), 90)), 0, 100),
    demo: q.get("demo") === "1",
    preview: q.get("preview") === "1",
  };

  const root = document.getElementById("kw");
  const docStyle = document.documentElement.style;
  docStyle.setProperty("--kw-scale", String(cfg.scale));
  docStyle.setProperty("--kw-alpha", String(cfg.bg / 100));
  root.classList.add(`kw--${cfg.layout}`);

  // ── Formatting ──────────────────────────────────────────────────────────
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmt(Math.abs(n));
  const tone = (n) => (n > 0 ? "is-up" : n < 0 ? "is-down" : "is-flat");

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return `${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255}`;
  }
  const levelOf = (elo) => (elo >= ULTIMATE ? null : clamp(Math.floor(Math.max(0, elo) / LEVEL_SIZE) + 1, 1, 10));

  // ── Persistence ─────────────────────────────────────────────────────────
  // The builder preview and demo mode keep everything in memory, so a
  // simulated match never lands in a real day's tally.
  const memory = new Map();
  const persistent = !cfg.preview && !cfg.demo;
  const prefix = `kw:v1:${cfg.id || "demo"}:`;
  const store = {
    get(key) {
      if (!persistent) return memory.get(key) || null;
      try { return JSON.parse(localStorage.getItem(prefix + key)) || null; } catch { return null; }
    },
    set(key, value) {
      if (!persistent) { memory.set(key, value); return; }
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix) && k !== prefix + key) localStorage.removeItem(k);
        }
      } catch { /* storage blocked: today falls back to what the API shows */ }
    },
  };

  // ── Today ───────────────────────────────────────────────────────────────
  function dayInfo(now = Date.now()) {
    const shifted = new Date(now - cfg.dayStart * 3_600_000);
    const y = shifted.getFullYear();
    const m = shifted.getMonth();
    const d = shifted.getDate();
    return {
      key: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      start: new Date(y, m, d, cfg.dayStart).getTime(),
    };
  }

  function computeToday(data) {
    const { key, start } = dayInfo();
    const day = store.get(key) || { baseline: null, matches: {} };
    const recent = (data.recent_matches || []).filter((m) => m && m.match_id);
    const todays = recent.filter((m) => Date.parse(m.played_at) >= start);
    const entry = (m) => ({
      r: m.result,
      e: Number(m.elo_change) || 0,
      k: Number(m.kills) || 0,
      d: Number(m.deaths) || 0,
      t: Date.parse(m.played_at),
    });

    for (const m of todays) day.matches[m.match_id] = entry(m);
    for (const [id, m] of Object.entries(day.matches)) if (!(m.t >= start)) delete day.matches[id];

    const current = Number(data.elo && data.elo.current);
    // The day's boundary is in view when the API's five include an older match
    // (or there are fewer than five): then every match today is on screen and
    // the starting ELO can be read off exactly.
    const boundaryVisible = recent.length < 5 || todays.length < recent.length;
    if (boundaryVisible && Number.isFinite(current)) {
      day.baseline = current - todays.reduce((s, m) => s + (Number(m.elo_change) || 0), 0);
      day.matches = Object.fromEntries(todays.map((m) => [m.match_id, entry(m)]));
    }
    store.set(key, day);

    const list = Object.values(day.matches);
    const complete = day.baseline !== null && Number.isFinite(current);
    const kills = list.reduce((s, m) => s + (m.k || 0), 0);
    const deaths = list.reduce((s, m) => s + (m.d || 0), 0);
    return {
      matches: list.length,
      wins: list.filter((m) => m.r === "win").length,
      losses: list.filter((m) => m.r === "loss").length,
      ties: list.filter((m) => m.r === "tie").length,
      elo: complete ? current - day.baseline : list.reduce((s, m) => s + m.e, 0),
      kd: list.length ? (kills / Math.max(1, deaths)).toFixed(2) : null,
      // Opened mid-day after 5+ games: the count is a floor, so it shows "5+".
      partial: !complete,
    };
  }

  // ── Markup ──────────────────────────────────────────────────────────────
  const CARD = `
    <div class="kw-frame">
      <svg class="kw-edge" aria-hidden="true"><path class="kw-edge-line"/><path class="kw-edge-accent"/></svg>
      <div class="kw-sweep"></div>
      <header class="kw-head kw-row" style="--i:0">
        <img class="kw-avatar" alt="" referrerpolicy="no-referrer">
        <div class="kw-id">
          <div class="kw-name" data-k="name"></div>
          <div class="kw-rank"><span data-k="rank"></span><span class="kw-rank-of" data-k="rankOf"></span></div>
        </div>
        <div class="kw-brand"><span class="kw-live"></span><img src="/assets/karasu-mark.png" alt=""><span>KARASU</span></div>
      </header>
      <section class="kw-hero kw-row" style="--i:1">
        <div class="kw-badge">
          <svg viewBox="0 0 48 54" aria-hidden="true"><path d="M24 2.5 45 14.5v25L24 51.5 3 39.5v-25z"/></svg>
          <span class="kw-badge-cap">LVL</span>
          <span class="kw-badge-num" data-k="level"></span>
        </div>
        <div class="kw-elo-block">
          <div class="kw-elo-line">
            <span class="kw-elo-wrap"><span class="kw-elo" data-k="elo"></span><span class="kw-float"></span></span>
            <span class="kw-elo-unit">ELO</span>
            <span class="kw-delta" data-k="delta"><b></b><small>TODAY</small></span>
          </div>
          <div class="kw-progress"><i></i></div>
          <div class="kw-progress-meta"><span class="kw-level-name" data-k="levelName"></span><span data-k="next"></span></div>
        </div>
      </section>
      <section class="kw-today kw-row" style="--i:2">
        <div class="kw-cell"><span class="kw-val" data-k="tMatches"></span><span class="kw-label">Matches today</span></div>
        <div class="kw-cell"><span class="kw-val kw-wl"><b class="kw-w" data-k="tWins"></b><i>/</i><b class="kw-l" data-k="tLosses"></b></span><span class="kw-label">Won / Lost</span></div>
        <div class="kw-cell"><span class="kw-val" data-k="tKd"></span><span class="kw-label">K/D today</span></div>
      </section>
      <section class="kw-recent kw-row" style="--i:3">
        <span class="kw-label">Last 5</span>
        <div class="kw-chips" data-k="chips"></div>
      </section>
      <section class="kw-last20 kw-row" style="--i:4" hidden>
        <span class="kw-label">Last 20</span>
        <span><small>K/D</small><b data-k="kd"></b></span>
        <span><small>ADR</small><b data-k="adr"></b></span>
        <span><small>HS</small><b data-k="hs"></b></span>
        <span><small>WIN</small><b data-k="wr"></b></span>
      </section>
    </div>`;

  const BAR = `
    <div class="kw-frame">
      <svg class="kw-edge" aria-hidden="true"><path class="kw-edge-line"/><path class="kw-edge-accent"/></svg>
      <div class="kw-sweep"></div>
      <div class="kw-badge kw-row" style="--i:0">
        <svg viewBox="0 0 48 54" aria-hidden="true"><path d="M24 2.5 45 14.5v25L24 51.5 3 39.5v-25z"/></svg>
        <span class="kw-badge-num" data-k="level"></span>
      </div>
      <div class="kw-bar-main kw-row" style="--i:1">
        <div class="kw-bar-name"><span data-k="name"></span><span class="kw-bar-rank" data-k="rank"></span></div>
        <div class="kw-elo-line">
          <span class="kw-elo-wrap"><span class="kw-elo" data-k="elo"></span><span class="kw-float"></span></span>
          <span class="kw-elo-unit">ELO</span>
        </div>
        <div class="kw-progress"><i></i></div>
      </div>
      <div class="kw-bar-sep"></div>
      <div class="kw-bar-today kw-row" style="--i:2">
        <span class="kw-label">Today</span>
        <span class="kw-bar-today-vals">
          <span class="kw-wl"><b class="kw-w" data-k="tWins"></b><i>W</i><b class="kw-l" data-k="tLosses"></b><i>L</i></span>
          <span data-k="tElo"></span>
        </span>
      </div>
      <div class="kw-bar-sep"></div>
      <div class="kw-bar-recent kw-row" style="--i:3">
        <span class="kw-label">Last 5</span>
        <div class="kw-chips" data-k="chips"></div>
      </div>
      <div class="kw-brand kw-row" style="--i:4"><span class="kw-live"></span><img src="/assets/karasu-mark.png" alt=""></div>
    </div>`;

  let els = null;

  function mount() {
    root.innerHTML = cfg.layout === "bar" ? BAR : CARD;
    const refs = {};
    root.querySelectorAll("[data-k]").forEach((el) => { refs[el.dataset.k] = el; });
    els = {
      ...refs,
      frame: root.querySelector(".kw-frame"),
      edgeLine: root.querySelector(".kw-edge-line"),
      edgeAccent: root.querySelector(".kw-edge-accent"),
      edge: root.querySelector(".kw-edge"),
      sweep: root.querySelector(".kw-sweep"),
      avatar: root.querySelector(".kw-avatar"),
      badge: root.querySelector(".kw-badge"),
      float: root.querySelector(".kw-float"),
      bar: root.querySelector(".kw-progress i"),
      last20: root.querySelector(".kw-last20"),
    };
    if (els.last20) els.last20.hidden = !cfg.stats;
    if (els.avatar && !cfg.avatar) els.avatar.remove();
    watchEdge();
  }

  // The frame is a chamfered panel; the outline and the accent corner are an SVG
  // drawn to the panel's real pixel size, so the cut stays 45 degrees at any height.
  function watchEdge() {
    const cut = cfg.layout === "bar" ? 10 : 14;
    const draw = () => {
      const w = els.frame.offsetWidth;
      const h = els.frame.offsetHeight;
      if (!w || !h) return;
      els.edge.setAttribute("viewBox", `0 0 ${w} ${h}`);
      els.edgeLine.setAttribute("d",
        `M${cut + 0.5} 0.5H${w - 0.5}V${h - cut - 0.5}L${w - cut - 0.5} ${h - 0.5}H0.5V${cut + 0.5}Z`);
      els.edgeAccent.setAttribute("d",
        `M1 ${cut + 22}V${cut + 0.5}L${cut + 0.5} 1H${cut + 46}` +
        `M${w - 1} ${h - cut - 22}V${h - cut - 0.5}L${w - cut - 0.5} ${h - 1}H${w - cut - 46}`);
      postSize();
    };
    draw();
    if ("ResizeObserver" in window) new ResizeObserver(draw).observe(els.frame);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  }

  // The builder sizes its preview, and suggests the OBS source size, from this.
  // offsetWidth ignores the scale transform, so the scale is applied here; 24 is
  // the body padding that leaves room for the glow.
  function postSize() {
    if (window.parent === window) return;
    window.parent.postMessage({
      type: "kw:size",
      w: Math.ceil(root.offsetWidth * cfg.scale + 24),
      h: Math.ceil(root.offsetHeight * cfg.scale + 24),
    }, location.origin);
  }

  function message(title, detail) {
    root.className = `kw kw--${cfg.layout} kw--msg is-ready`;
    root.innerHTML = `<div class="kw-msg"><img src="/assets/karasu-mark.png" alt=""><div><b></b><span></span></div></div>`;
    root.querySelector("b").textContent = title;
    root.querySelector("span").textContent = detail;
    els = null;
    postSize();
  }

  // ── Animation helpers ───────────────────────────────────────────────────
  const restart = (el, cls) => {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  let countFrame = 0;
  function countUp(el, from, to) {
    cancelAnimationFrame(countFrame);
    const started = performance.now();
    const duration = 1400;
    const step = (now) => {
      const t = Math.min(1, (now - started) / duration);
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) countFrame = requestAnimationFrame(step);
    };
    countFrame = requestAnimationFrame(step);
  }

  function setText(el, text, bump) {
    if (!el) return;
    const changed = el.textContent !== text;
    el.textContent = text;
    if (changed && bump) restart(el, "kw-bump");
  }

  // ── Render ──────────────────────────────────────────────────────────────
  let prev = null;

  function render(data) {
    if (!els) { root.className = `kw kw--${cfg.layout}`; mount(); }
    const today = computeToday(data);
    const elo = data.elo || {};
    const current = Number(elo.current) || 0;
    const level = elo.level ?? levelOf(current);
    const rgb = hexToRgb(elo.level_color) || LEVEL_RGB[level ?? "ultimate"] || LEVEL_RGB.ultimate;
    root.style.setProperty("--kw-level", rgb);
    const animate = !!prev;

    // Identity
    if (els.name) els.name.textContent = (data.player && data.player.name) || "Unknown player";
    if (els.avatar) {
      const url = data.player && data.player.avatar_url;
      if (url && els.avatar.getAttribute("src") !== url) els.avatar.src = url;
      els.avatar.hidden = !url;
    }
    const lb = data.leaderboard || {};
    if (els.rank) els.rank.textContent = lb.position ? `#${fmt(lb.position)}` : "Unranked";
    if (els.rankOf) els.rankOf.textContent = lb.position && lb.total ? ` of ${fmt(lb.total)}` : "";

    // Level + progress
    els.level.textContent = level ?? "U";
    els.badge.classList.toggle("is-ultimate", level === null);
    const floor = level ? (level - 1) * LEVEL_SIZE : ULTIMATE;
    const next = Number(elo.next_level_elo) || null;
    const pct = next && next > floor ? clamp((current - floor) / (next - floor), 0, 1) : 1;
    els.bar.style.width = `${(pct * 100).toFixed(1)}%`;
    if (els.levelName) els.levelName.textContent = elo.level_name || (level ? `Level ${level}` : "Ultimate");
    if (els.next) {
      const toNext = Number(elo.to_next_level);
      const nextName = level === 10 ? "Ultimate" : level ? `Level ${level + 1}` : "";
      els.next.textContent = next && Number.isFinite(toNext) ? `${fmt(toNext)} to ${nextName}` : "Top of the ladder";
    }

    // ELO, with the change counted up and floated off the number
    if (animate && prev.elo !== current) {
      const diff = current - prev.elo;
      countUp(els.elo, prev.elo, current);
      els.float.textContent = signed(diff);
      els.float.className = `kw-float ${tone(diff)}`;
      restart(els.float, "is-run");
      els.sweep.style.setProperty("--sweep", diff > 0 ? "74 222 128" : "248 113 113");
      restart(els.sweep, "is-run");
      if (level !== null && prev.level !== null && level > prev.level) restart(els.badge, "is-levelup");
      if (level === null && prev.level !== null) restart(els.badge, "is-levelup");
    } else if (!animate) {
      els.elo.textContent = fmt(current);
    }

    // Today
    const dTone = tone(today.elo);
    if (els.delta) {
      els.delta.className = `kw-delta ${dTone}`;
      setText(els.delta.querySelector("b"), signed(today.elo), animate);
    }
    setText(els.tMatches, today.partial && today.matches >= 5 ? `${today.matches}+` : String(today.matches), animate);
    setText(els.tWins, String(today.wins), animate);
    setText(els.tLosses, String(today.losses), animate);
    setText(els.tKd, today.kd ?? "\u2013", animate);
    if (els.tElo) {
      els.tElo.className = `kw-val-elo ${dTone}`;
      setText(els.tElo, signed(today.elo), animate);
    }

    // Last five
    const recent = (data.recent_matches || []).slice(0, 5);
    const newest = recent[0] && recent[0].match_id;
    const isNew = animate && newest && newest !== prev.newest;
    els.chips.textContent = "";
    for (let i = 0; i < 5; i++) {
      const m = recent[i];
      const chip = document.createElement("span");
      if (!m) {
        chip.className = "kw-chip is-empty";
      } else {
        const res = m.result === "win" || m.result === "loss" ? m.result : "tie";
        chip.className = `kw-chip is-${res}${isNew && i === 0 ? " is-new" : ""}`;
        chip.textContent = cfg.layout === "bar"
          ? res[0].toUpperCase()
          : (Number.isFinite(Number(m.elo_change)) ? signed(Number(m.elo_change)) : res[0].toUpperCase());
        chip.title = `${m.map || ""} ${m.kills ?? ""}-${m.deaths ?? ""}`.trim();
      }
      els.chips.appendChild(chip);
    }

    // Last twenty
    if (cfg.stats && els.kd) {
      const l20 = data.last_20 || {};
      const val = (v, suffix = "") => (v === null || v === undefined ? "–" : `${v}${suffix}`);
      els.kd.textContent = val(l20.kd);
      els.adr.textContent = val(l20.adr);
      els.hs.textContent = val(l20.hs_pct, "%");
      els.wr.textContent = val(l20.win_rate, "%");
    }

    if (!animate) requestAnimationFrame(() => root.classList.add("is-ready"));
    prev = { elo: current, level, newest };
  }

  // ── Data ────────────────────────────────────────────────────────────────
  let lastData = null;
  let lastOk = 0;
  let simHoldUntil = 0;
  let timer = 0;

  async function poll() {
    clearTimeout(timer);
    let wait = POLL_MS;
    try {
      const res = await fetch(API + cfg.id, { cache: "no-store" });
      if (res.status === 429) {
        wait = BACKOFF_MS;
      } else if (res.status === 404 || res.status === 400) {
        if (!lastData) message("Player not found", "Check the Steam ID in the widget link.");
        wait = BACKOFF_MS;
      } else if (res.ok) {
        const data = await res.json();
        lastOk = Date.now();
        if (Date.now() >= simHoldUntil) {
          lastData = data;
          render(data);
        }
      }
    } catch {
      // Offline or the API is down: keep showing the last numbers, go stale.
      if (!lastData) message("Karasu is unreachable", "Retrying in a minute.");
      wait = BACKOFF_MS;
    }
    // A little jitter so many widgets on one network don't poll in lockstep.
    timer = setTimeout(poll, wait + Math.random() * 4000);
  }

  setInterval(() => {
    root.classList.toggle("is-stale", !!lastOk && Date.now() - lastOk > STALE_MS && !cfg.demo);
  }, 15_000);

  // ── Demo + builder simulation ───────────────────────────────────────────
  function demoData() {
    const now = Date.now();
    const ago = (min) => new Date(now - min * 60_000).toISOString();
    return {
      player: { name: "karasu_streamer", avatar_url: null, karasu_plus: true },
      elo: { current: 1984, level: 5, level_name: "Level 5", level_color: "#a855f7", next_level_elo: 2000, to_next_level: 16, change_24h: 47 },
      leaderboard: { position: 214, total: 6313 },
      recent_matches: [
        { match_id: "d5", result: "win", elo_change: 24, map: "de_mirage", kills: 22, deaths: 14, played_at: ago(35) },
        { match_id: "d4", result: "loss", elo_change: -19, map: "de_inferno", kills: 15, deaths: 18, played_at: ago(80) },
        { match_id: "d3", result: "win", elo_change: 21, map: "de_nuke", kills: 27, deaths: 16, played_at: ago(130) },
        { match_id: "d2", result: "win", elo_change: 21, map: "de_ancient", kills: 19, deaths: 15, played_at: ago(60 * 26) },
        { match_id: "d1", result: "loss", elo_change: -22, map: "de_dust2", kills: 11, deaths: 17, played_at: ago(60 * 27) },
      ],
      last_20: { matches: 20, wins: 12, win_rate: 60, kd: 1.18, kr: 0.79, adr: 84.6, avg_kills: 18.2, hs_pct: 52 },
    };
  }

  let simCount = 0;
  function simulate(result) {
    if (!lastData) return;
    const data = JSON.parse(JSON.stringify(lastData));
    const delta = result === "win" ? 18 + Math.round(Math.random() * 10) : result === "loss" ? -(16 + Math.round(Math.random() * 9)) : 0;
    const current = (Number(data.elo.current) || 0) + delta;
    const level = levelOf(current);
    const rgb = LEVEL_RGB[level ?? "ultimate"].split(" ").map(Number);
    data.elo = {
      ...data.elo,
      current,
      level,
      level_name: level ? `Level ${level}` : "Ultimate",
      level_color: `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`,
      next_level_elo: level ? (level === 10 ? ULTIMATE : level * LEVEL_SIZE) : null,
      to_next_level: level ? (level === 10 ? ULTIMATE : level * LEVEL_SIZE) - current : null,
      change_24h: (Number(data.elo.change_24h) || 0) + delta,
    };
    data.recent_matches = [
      { match_id: `sim-${++simCount}-${Date.now()}`, result, elo_change: delta, map: "de_mirage", kills: 20, deaths: 15, played_at: new Date().toISOString() },
      ...(data.recent_matches || []),
    ].slice(0, 5);
    simHoldUntil = Date.now() + SIM_HOLD_MS;
    lastData = data;
    render(data);
  }

  // ── Start ───────────────────────────────────────────────────────────────
  // In the builder the page hands over the player it already fetched, so
  // changing an option reloads this frame without spending the API limit.
  if (cfg.preview) {
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || !event.data) return;
      if (event.data.type === "kw:data") {
        lastData = event.data.data || demoData();
        lastOk = Date.now();
        render(lastData);
      } else if (event.data.type === "kw:simulate") {
        simulate(event.data.result);
      }
    });
    window.parent.postMessage({ type: "kw:ready" }, location.origin);
  } else if (cfg.demo) {
    lastData = demoData();
    lastOk = Date.now();
    render(lastData);
  } else if (!cfg.id) {
    message("No player set", "Make your widget link at widget.karasu.live");
  } else {
    poll();
  }
})();
