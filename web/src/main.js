import { Game } from "./game.js";

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll(".screen")];

/** Show exactly these screens (the HUD can stay up under the pause/results panels). */
function show(...ids) {
  for (const el of screens) el.classList.toggle("active", ids.includes(el.id));
}

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/* ---------------- HUD ---------------- */
const el = {
  stopLabel: $("hud-stop-label"),
  stopName: $("hud-stop-name"),
  stopBn: $("hud-stop-bn"),
  stopDist: $("hud-stop-dist"),
  time: $("hud-time"),
  pax: $("hud-pax"),
  speed: $("hud-speed"),
  gear: $("hud-gear"),
  rpm: $("rpm-arc"),
  routeFill: $("route-fill"),
  routeBus: $("route-bus"),
  routeTicks: $("route-ticks"),
  cam: $("hud-cam"),
  sound: $("hud-sound"),
  warnOff: $("warn-offroad"),
  warnLane: $("warn-lane"),
  keys: $("hud-keys"),
};
const last = {};
function set(key, node, value, prop = "textContent") {
  if (last[key] === value) return;
  last[key] = value;
  node[prop] = value;
}

function buildTicks(fracs) {
  el.routeTicks.innerHTML = "";
  fracs.forEach((f, i) => {
    if (i === 0) return;
    const t = document.createElement("div");
    t.className = "route-tick";
    t.style.left = `${Math.min(100, f * 100)}%`;
    el.routeTicks.appendChild(t);
  });
}

const ui = {
  onHud(d) {
    if (!el.routeTicks.children.length) buildTicks(d.stopFracs);
    if (d.next) {
      const atStop = d.phase !== "drive";
      set("label", el.stopLabel, atStop ? (d.phase === "doors" ? "Doors open" : "Doors closing") : "Next stop");
      set("name", el.stopName, d.next.en);
      set("bn", el.stopBn, d.next.bn);
      set("dist", el.stopDist, atStop ? "" : d.next.dist > 950 ? `${(d.next.dist / 1000).toFixed(1)} km` : `${d.next.dist} m`);
    }
    set("time", el.time, fmtTime(d.time));
    set("pax", el.pax, String(d.passengers));
    set("speed", el.speed, String(d.speed));
    set("gear", el.gear, d.gear);
    const dash = `${Math.round(d.rpm * 100)} 100`;
    if (last.rpm !== dash) {
      last.rpm = dash;
      el.rpm.setAttribute("stroke-dasharray", dash);
    }
    set("fill", el.routeFill.style, `${d.progress * 100}%`, "width");
    set("bus", el.routeBus.style, `${d.progress * 100}%`, "left");
    [...el.routeTicks.children].forEach((t, i) => t.classList.toggle("done", i + 1 < d.target));
    set("cam", el.cam, d.cam === "chase" ? "Chase cam · C" : "Driver's seat · C");
    set("sound", el.sound, d.muted ? "Sound off · M" : "Sound on · M");
    el.sound.classList.toggle("off", d.muted);
    el.warnOff.classList.toggle("show", d.offRoad);
    el.warnLane.classList.toggle("show", d.wrongLane && !d.offRoad);
  },

  onMessage(title, sub, kind = "info", ms = 2500) {
    const box = $("toasts");
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    const b = document.createElement("b");
    b.textContent = title;
    t.appendChild(b);
    if (sub) {
      const s = document.createElement("span");
      s.className = "bn";
      s.textContent = sub;
      t.appendChild(s);
    }
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 300);
    }, ms);
  },

  onPause(paused) {
    show(...(paused ? ["screen-game", "screen-pause"] : ["screen-game"]));
  },

  onEnd(r) {
    $("over-kicker").textContent = r.success ? "Route complete" : "Run over";
    $("over-title").textContent = r.success ? "Arrived at Nilgiri" : "Accident on the hill road";
    const star = (on) =>
      `<svg viewBox="0 0 24 24"><path d="M12 2l3 6.6 7.2.8-5.4 4.9 1.5 7.1L12 17.8 5.7 21.4l1.5-7.1L1.8 9.4 9 8.6z" fill="${on ? "#f2b705" : "rgba(255,255,255,0.15)"}"/></svg>`;
    $("over-stars").innerHTML = r.success ? [1, 2, 3].map((n) => star(n <= r.stars)).join("") : "";
    $("over-pax").textContent = r.delivered;
    $("over-time").textContent = fmtTime(r.time);
    $("over-score").textContent = r.score;
    $("over-best").textContent = r.best;
    const pen = [];
    const s = r.stats;
    if (r.success && r.timeBonus) pen.push(`Time bonus +${r.timeBonus}`);
    if (s.missed) pen.push(`Missed stops ×${s.missed}`);
    if (s.scrapes) pen.push(`Barrier scrapes ×${s.scrapes}`);
    if (s.respawns) pen.push(`Recoveries ×${s.respawns}`);
    if (s.wrongLane) pen.push(`Wrong lane ×${s.wrongLane}`);
    if (!r.success) pen.push("Keep left — oncoming traffic uses the right lane");
    $("over-penalties").innerHTML = pen.map((p) => `<li>${p}</li>`).join("");
    show("screen-game", "screen-over");
    renderBest();
  },
};

/* ---------------- Game ---------------- */
const game = new Game($("game-canvas"), ui);
game.setMinimap($("minimap"));

function renderBest() {
  let best = 0;
  try {
    best = Number(localStorage.getItem("hte_best") || 0);
  } catch {}
  $("menu-best").textContent = best ? `Best score: ${best}` : "";
}

let hintTimer = 0;
function startRun() {
  for (const k of Object.keys(last)) delete last[k];
  el.routeTicks.innerHTML = "";
  $("toasts").innerHTML = "";
  show("screen-game");
  game.start();
  el.keys.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.keys.classList.add("hidden"), 12000);
}

function toMenu() {
  game.toMenu();
  show("screen-menu");
  renderBest();
}

$("btn-play").addEventListener("click", startRun);
$("btn-howto").addEventListener("click", () => show("screen-howto"));
$("btn-howto-back").addEventListener("click", () => show("screen-menu"));
$("btn-resume").addEventListener("click", () => game.pause(false));
$("btn-restart").addEventListener("click", startRun);
$("btn-pause-menu").addEventListener("click", toMenu);
$("btn-retry").addEventListener("click", startRun);
$("btn-over-menu").addEventListener("click", toMenu);

// Buttons keep focus after a click; drop it so Space/Enter go to the bus, not the button.
document.addEventListener("click", (e) => {
  if (e.target.closest("button")) e.target.closest("button").blur();
});

show("screen-loading");
game
  .init((p, label) => {
    $("loading-fill").style.width = `${Math.round(p * 100)}%`;
    $("loading-label").textContent = label;
  })
  .then(() => {
    show("screen-menu");
    renderBest();
  })
  .catch((err) => {
    console.error(err);
    $("loading-label").textContent = `Couldn't build the world: ${err.message}`;
  });
