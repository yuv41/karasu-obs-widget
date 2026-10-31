(() => {
  "use strict";

  const API = "https://api.karasu.live/public/v1/players/";
  const form = document.getElementById("config");
  const playerInput = document.getElementById("player");
  const status = document.getElementById("player-status");
  const urlInput = document.getElementById("url");
  const copyBtn = document.getElementById("copy");
  const frame = document.getElementById("preview");
  const stage = frame.parentElement;
  const obsSize = document.getElementById("obs-size");
  const stageNote = document.getElementById("stage-note");
  const statsToggle = form.querySelector("[data-card-only]");

  // The player the preview shows: fetched once per ID and handed to the frame,
  // so dragging a slider never spends the API's 10-a-minute limit.
  let player = null; // { id, data }
  let lookupSeq = 0;
  let widgetSize = { w: 448, h: 290 };

  const steamIdFrom = (text) => ((String(text).match(/7656\d{13}/) || String(text).match(/\b\d{17}\b/) || [])[0] || null);

  function setStatus(state, text) {
    status.dataset.state = state;
    status.textContent = text;
  }

  function options() {
    const f = new FormData(form);
    return {
      layout: f.get("layout") || "card",
      avatar: f.get("avatar") === "on",
      stats: f.get("stats") === "on",
      daystart: Number(f.get("daystart")) || 0,
      scale: Number(f.get("scale")) || 1,
      bg: Number(f.get("bg")),
    };
  }

  // Only what differs from the defaults goes in the link, so it stays short.
  function query(o, id) {
    const p = new URLSearchParams();
    if (id) p.set("id", id);
    if (o.layout !== "card") p.set("layout", o.layout);
    if (o.stats && o.layout === "card") p.set("stats", "1");
    if (!o.avatar) p.set("avatar", "0");
    if (o.daystart) p.set("daystart", String(o.daystart));
    if (o.scale !== 1) p.set("scale", String(o.scale));
    if (o.bg !== 90) p.set("bg", String(o.bg));
    return p;
  }

  let frameTimer = 0;
  function refresh() {
    const o = options();
    document.getElementById("scale-out").textContent = `${Math.round(o.scale * 100)}%`;
    document.getElementById("bg-out").textContent = `${o.bg}%`;
    statsToggle.classList.toggle("is-off", o.layout !== "card");

    const id = player && player.data ? player.id : null;
    if (id) {
      urlInput.value = `${location.origin}/overlay?${query(o, id)}`;
      copyBtn.disabled = false;
    } else {
      urlInput.value = "";
      urlInput.placeholder = "Add your player above to get your link";
      copyBtn.disabled = true;
    }
    stageNote.textContent = id ? `Live data · ${player.data.player.name}` : "Sample data";

    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => {
      const p = query(o, id);
      p.set("preview", "1");
      const src = `/overlay?${p}`;
      if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
    }, 120);
  }

  function fitFrame() {
    const { w, h } = widgetSize;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    const room = stage.clientWidth - 32;
    const fit = room > 0 && w > room ? room / w : 1;
    frame.style.transform = fit < 1 ? `scale(${fit})` : "";
    frame.style.marginBottom = fit < 1 ? `${-(h * (1 - fit))}px` : "";
    obsSize.textContent = `${w} × ${h}`;
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === "kw:ready") {
      frame.contentWindow.postMessage({ type: "kw:data", data: player && player.data ? player.data : null }, location.origin);
    } else if (event.data.type === "kw:size") {
      widgetSize = { w: event.data.w, h: event.data.h };
      fitFrame();
    }
  });
  window.addEventListener("resize", fitFrame);

  async function lookup() {
    const raw = playerInput.value.trim();
    const id = steamIdFrom(raw);
    const seq = ++lookupSeq;
    if (!raw) {
      player = null;
      setStatus("idle", "Paste the link to your Karasu profile, or the 17-digit Steam ID at the end of it.");
      refresh();
      return;
    }
    if (!id) {
      player = null;
      setStatus("error", "That doesn't contain a Steam ID. It's the 17-digit number at the end of your profile link.");
      refresh();
      return;
    }
    if (player && player.id === id && player.data) return;
    setStatus("busy", "Looking you up…");
    try {
      const res = await fetch(API + id, { cache: "no-store" });
      if (seq !== lookupSeq) return;
      if (res.status === 404) {
        player = null;
        setStatus("error", "No Karasu player with that Steam ID. Play a match first, or check the number.");
      } else if (res.status === 429) {
        player = null;
        setStatus("error", "Too many lookups in a minute. Try again shortly.");
      } else if (!res.ok) {
        player = null;
        setStatus("error", "Karasu didn't answer. Try again in a moment.");
      } else {
        const data = await res.json();
        player = { id, data };
        const e = data.elo || {};
        const rank = data.leaderboard && data.leaderboard.position ? ` · #${data.leaderboard.position.toLocaleString("en-US")}` : "";
        setStatus("ok", `Found ${data.player.name} · ${Number(e.current).toLocaleString("en-US")} ELO · ${e.level_name || "Ultimate"}${rank}`);
      }
    } catch {
      if (seq !== lookupSeq) return;
      player = null;
      setStatus("error", "Couldn't reach Karasu. Check your connection.");
    }
    refresh();
  }

  let lookupTimer = 0;
  playerInput.addEventListener("input", () => {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(lookup, 450);
  });
  playerInput.addEventListener("paste", () => setTimeout(lookup, 0));
  form.addEventListener("input", (e) => { if (e.target !== playerInput) refresh(); });
  form.addEventListener("change", (e) => { if (e.target !== playerInput) refresh(); });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(urlInput.value);
    } catch {
      urlInput.select();
      document.execCommand("copy");
    }
    copyBtn.textContent = "Copied";
    copyBtn.classList.add("is-done");
    setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("is-done"); }, 1600);
  });

  document.querySelectorAll("[data-sim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      frame.contentWindow && frame.contentWindow.postMessage({ type: "kw:simulate", result: btn.dataset.sim }, location.origin);
    });
  });

  // ?id= on the builder pre-fills the player, so a link can be shared.
  const preset = steamIdFrom(new URLSearchParams(location.search).get("id") || "");
  if (preset) {
    playerInput.value = preset;
    lookup();
  } else {
    refresh();
  }
})();
