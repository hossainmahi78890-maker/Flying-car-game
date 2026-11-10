import { CARS } from "./cars.js";
import { CarPreview } from "./carPreview.js";
import { Game } from "./game.js";

const screens = {};
document.querySelectorAll(".screen").forEach((el) => (screens[el.id] = el));

function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove("active"));
  screens[id].classList.add("active");
}

// ---------------- Menu ----------------
document.getElementById("btn-play").addEventListener("click", () => {
  showScreen("screen-select");
  preview.start();
});
document.getElementById("btn-howto").addEventListener("click", () => showScreen("screen-howto"));
document.getElementById("btn-back-menu").addEventListener("click", () => showScreen("screen-menu"));
document.getElementById("btn-select-back").addEventListener("click", () => {
  preview.stop();
  showScreen("screen-menu");
});

// ---------------- Car Select ----------------
const previewCanvas = document.getElementById("car-preview");
const preview = new CarPreview(previewCanvas);

let carIndex = 0;
const carNameEl = document.getElementById("car-name");
const carDescEl = document.getElementById("car-desc");
const dotsEl = document.getElementById("car-dots");
const statEls = {
  power: document.getElementById("stat-power"),
  mass: document.getElementById("stat-mass"),
  handling: document.getElementById("stat-handling"),
  lift: document.getElementById("stat-lift"),
};

CARS.forEach((_, i) => {
  const dot = document.createElement("span");
  dotsEl.appendChild(dot);
});

function renderCarSelect() {
  const car = CARS[carIndex];
  carNameEl.textContent = car.name;
  carDescEl.textContent = car.desc;
  Object.entries(statEls).forEach(([key, el]) => {
    el.style.width = Math.round(car.stats[key] * 100) + "%";
  });
  [...dotsEl.children].forEach((d, i) => d.classList.toggle("active", i === carIndex));
  preview.setCar(car);
}

document.getElementById("car-prev").addEventListener("click", () => {
  carIndex = (carIndex - 1 + CARS.length) % CARS.length;
  renderCarSelect();
});
document.getElementById("car-next").addEventListener("click", () => {
  carIndex = (carIndex + 1) % CARS.length;
  renderCarSelect();
});
renderCarSelect();

// ---------------- Loading ----------------
const loadingFill = document.getElementById("loading-fill");
const loadingLabel = document.getElementById("loading-label");

let loading = false;
function fakeLoad(cb) {
  if (loading) return; // ignore double clicks / repeated R presses
  loading = true;
  showScreen("screen-loading");
  let p = 0;
  loadingFill.style.width = "0%";
  const labels = ["LOADING WORLD…", "SPOOLING THRUSTERS…", "CALIBRATING HANDLING…", "READY"];
  const timer = setInterval(() => {
    p += 8 + Math.random() * 18;
    if (p >= 100) {
      p = 100;
      loadingLabel.textContent = labels[3];
      loadingFill.style.width = "100%";
      clearInterval(timer);
      setTimeout(() => {
        loading = false;
        cb();
      }, 220);
      return;
    }
    loadingFill.style.width = p + "%";
    loadingLabel.textContent = labels[Math.min(2, Math.floor(p / 34))];
  }, 90);
}

// ---------------- Game setup ----------------
const gameCanvas = document.getElementById("game-canvas");
const gameScreen = screens["screen-game"];

let lastReason = "crash";
const game = new Game(gameCanvas, ({ reason, distance, best }) => {
  lastReason = reason;
  triggerCrashFlash();
  setTimeout(() => showGameOver(reason, distance, best), reason === "crash" ? 550 : 300);
});
// R restarts only from the Game Over screen — not from the menus, and not
// in the split second before the Game Over screen appears.
game.onRestartKey = () => {
  if (screens["screen-over"].classList.contains("active")) document.getElementById("btn-retry").click();
};

const hudSpeed = document.getElementById("hud-speed");
const hudAlt = document.getElementById("hud-alt");
const hudDistance = document.getElementById("hud-distance");
const hudBest = document.getElementById("hud-best");
const gaugeBoost = document.getElementById("gauge-boost");
const gaugeThrust = document.getElementById("gauge-thrust");
const hudWarn = document.getElementById("hud-warn");

game.onHud((data) => {
  hudSpeed.textContent = data.speedKmh;
  hudAlt.textContent = data.alt;
  hudDistance.textContent = data.distance;
  hudBest.textContent = data.best;
  gaugeBoost.style.width = Math.round(data.boost * 100) + "%";
  gaugeThrust.style.width = Math.round(data.thrust * 100) + "%";
});
game.onWarn((text) => {
  if (text) {
    hudWarn.textContent = text;
    hudWarn.classList.add("show");
  } else {
    hudWarn.classList.remove("show");
  }
});

const crashFlash = document.getElementById("crash-flash");
function triggerCrashFlash() {
  crashFlash.classList.remove("active");
  void crashFlash.offsetWidth; // restart animation
  crashFlash.classList.add("active");
}

document.getElementById("btn-launch").addEventListener("click", () => {
  preview.stop();
  fakeLoad(() => {
    game.setCar(CARS[carIndex]);
    showScreen("screen-game");
    gameScreen.classList.add("active");
    game.start();
  });
});

// ---------------- Game Over ----------------
const overTitle = document.getElementById("over-title");
const overSub = document.getElementById("over-sub");
const overDistance = document.getElementById("over-distance");
const overBest = document.getElementById("over-best");

function showGameOver(reason, distance, best) {
  if (loading) return; // a restart is already on its way
  overTitle.textContent = reason === "fall" ? "YOU FELL" : "CRASHED";
  overSub.textContent =
    reason === "fall"
      ? "Lost altitude and dropped out of the sky."
      : "Impact detected. The " + CARS[carIndex].name + " didn't make it.";
  overDistance.textContent = distance;
  overBest.textContent = best;
  showScreen("screen-over");
}

document.getElementById("btn-retry").addEventListener("click", () => {
  fakeLoad(() => {
    game.setCar(CARS[carIndex]);
    showScreen("screen-game");
    game.start();
  });
});
document.getElementById("btn-change-car").addEventListener("click", () => {
  showScreen("screen-select");
  renderCarSelect();
  preview.start();
});
document.getElementById("btn-quit-menu").addEventListener("click", () => {
  showScreen("screen-menu");
});

// Best distance shown from the start on the HUD before first update.
hudBest.textContent = localStorage.getItem("aerovolt_best") || "0";
