// ================== CONFIG ==================
const FILES = {
  menu: "rive/menu.riv",
  transition: "rive/transition.riv",
  game: "rive/game.riv",
  instructions: "rive/instructions.riv",
};

// State machine name inside each .riv file (change if yours are named differently)
const STATE_MACHINES = {
  menu: "State Machine 1",
  transition: "State Machine 1",
  game: "State Machine 1",
  instructions: "State Machine 1",
};

// Artboard to play in each .riv file (null = the file's default artboard).
// transition.riv must play "Artboard 1" — that's the artboard with the WaterEffect script.
const ARTBOARDS = {
  menu: null,
  transition: "Artboard 1",
  game: null,
  instructions: null,
};

// Files that use shaders / GPU Canvas.
// Each GPU Canvas instance takes its own WebGL context, so only enable it where needed.
const GPU_CANVAS = {
  menu: false,
  transition: true,
  game: false,
  instructions: false,
};

const PLAY_TRIGGER = "playPressed";                 // trigger in menu.riv  -> goes to game
const INSTRUCTIONS_TRIGGER = "instructionsPressed"; // trigger in menu.riv  -> goes to instructions
const HOME_TRIGGER = "home";                        // trigger in game.riv  -> goes back to menu
const RESTART_TRIGGER = "restart";                  // trigger in game.riv  -> restarts the game
const BACK_TRIGGER = "back";                        // trigger in instructions.riv -> goes back to menu

// Triggers in transition.riv
const LOADING_TRIGGER = "loading";    // normal navigation
const LOSE_TRIGGER = "lose";          // game lost
const WIN_TRIGGER = "win";            // game won

// Game values in game.riv's view model
// (extra spaces at the start/end of names in Rive are ignored)
const ENERGY_PROPS = ["energy zombie 1", "energy zombie 2", "energy zombie 3", "energy zombie 4"];
const POSITION_PROPS = ["position 1 zombie", "position 2 zombie", "position 3 zombie", "position 4 zombie"];
// Fired by the zombie click listeners in Rive (the "ask")
const GAIN_REQUEST_PROPS = ["gain request 1", "gain request 2", "gain request 3", "gain request 4"];
// Fired by this script only when sharing is allowed (Rive reacts to these)
const GAIN_PROPS = ["gain energy 1", "gain energy 2", "gain energy 3", "gain energy 4"];
const SWEET_PROP = "sweet";
const RESULT_CHECK_INTERVAL = 100; // ms between win/lose checks
const RESULT_DELAY = 3500;         // ms to wait after win/lose before the transition starts

// All times are counted from the moment the transition trigger fires.
// REMOVE_CURRENT_AT: when the screen you are leaving starts fading out
// SWAP_AT:           when the next screen starts fading in behind the transition
// TRANSITION_DURATION: when the transition itself starts fading out
const REMOVE_CURRENT_AT = 500;     // ms
const SWAP_AT = 2900;              // ms
const TRANSITION_DURATION = 3300;  // ms

// Fade in / fade out time for every animation appearing or disappearing
const FADE_DURATION = 400;         // ms

// rive.Fit.Contain keeps the whole artboard visible.
// The stage already has the 1920x1427 ratio, so nothing gets cut.
const FIT = rive.Fit.Contain;
// ============================================

// Send fade time to CSS
document.documentElement.style.setProperty("--fade", FADE_DURATION + "ms");

const menuCanvas = document.getElementById("menuCanvas");
const gameCanvas = document.getElementById("gameCanvas");
const instructionsCanvas = document.getElementById("instructionsCanvas");
const transitionCanvas = document.getElementById("transitionCanvas");
const loadingEl = document.getElementById("loading");

// Each screen: its canvas and the triggers that leave it (trigger -> target screen)
const SCENES = {
  menu: {
    canvas: menuCanvas,
    exits: [
      { trigger: PLAY_TRIGGER, goesTo: "game" },
      { trigger: INSTRUCTIONS_TRIGGER, goesTo: "instructions" },
    ],
  },
  game: {
    canvas: gameCanvas,
    exits: [
      { trigger: HOME_TRIGGER, goesTo: "menu" },
      { trigger: RESTART_TRIGGER, goesTo: "game" }, // same screen = restart
    ],
  },
  instructions: {
    canvas: instructionsCanvas,
    exits: [
      { trigger: BACK_TRIGGER, goesTo: "menu" },
    ],
  },
};

const buffers = {};
const sceneRive = { menu: null, game: null, instructions: null }; // running Rive instance per screen
let currentScene = null;
let transitionRive = null;
let isTransitioning = false;
let resultTimer = null;
let resultDelayTimer = null;

function layout() {
  return new rive.Layout({ fit: FIT, alignment: rive.Alignment.Center });
}

function createRive(name, canvas, onLoad) {
  const options = {
    buffer: buffers[name].slice(0), // copy so the buffer can be reused
    canvas: canvas,
    stateMachines: STATE_MACHINES[name],
    autoplay: true,
    autoBind: true, // binds the default view model instance (for data binding triggers)
    layout: layout(),
    enableGPUCanvas: GPU_CANVAS[name], // required for shaders / GPU Canvas scripts
    onLoad: () => {
      r.resizeDrawingSurfaceToCanvas();
      if (onLoad) onLoad(r);
    },
    onLoadError: (e) => {
      console.error("Rive failed to load " + FILES[name], e);
    },
  };
  if (ARTBOARDS[name]) options.artboard = ARTBOARDS[name];

  const r = new rive.Rive(options);
  return r;
}

// Fade a canvas in (it must start hidden for the fade to be visible)
function fadeIn(canvas) {
  // force the browser to apply the hidden state first, then fade in
  void canvas.offsetWidth;
  canvas.classList.remove("hidden");
}

// Fade a canvas out, then free its Rive instance once the fade is done
function fadeOutAndCleanup(canvas, riveInstance) {
  canvas.classList.add("hidden");
  if (riveInstance) {
    setTimeout(() => riveInstance.cleanup(), FADE_DURATION);
  }
}

// Load all .riv files first so navigation is instant
async function preload() {
  const names = Object.keys(FILES);
  const results = await Promise.all(
    names.map((n) => fetch(FILES[n]).then((res) => {
      if (!res.ok) throw new Error("Cannot load " + FILES[n]);
      return res.arrayBuffer();
    }))
  );
  names.forEach((n, i) => (buffers[n] = results[i]));
}

// Prints every property in a view model (to find exact names)
function logAvailableProperties(fileName, vmi) {
  if (!vmi.properties) return;
  console.log(
    "Properties in " + fileName + " view model:",
    vmi.properties.map((p) => "'" + p.name + "' (" + p.type + ")")
  );
}

// Finds the real property name, ignoring extra spaces at the start/end
function realName(vmi, name) {
  if (!vmi.properties) return name;
  const wanted = name.trim();
  const found = vmi.properties.find((p) => p.name.trim() === wanted);
  return found ? found.name : name;
}

// Property getters that tolerate extra spaces in Rive names
function getTrigger(vmi, name) { return vmi.trigger(realName(vmi, name)); }
function getNumber(vmi, name) { return vmi.number(realName(vmi, name)); }
function getBoolean(vmi, name) { return vmi.boolean(realName(vmi, name)); }

// Shows a screen with a fade in and listens for its exit triggers
function showScene(name, onLoad) {
  const scene = SCENES[name];

  const r = createRive(name, scene.canvas, (instance) => {
    fadeIn(scene.canvas);
    listenForExits(name, instance);
    if (name === "game") {
      handleGainRequests(instance);
      watchGameResult(instance);
    }
    if (onLoad) onLoad(instance);
  });

  sceneRive[name] = r;
  currentScene = name;
}

// Fades a screen out and frees its Rive instance
function hideScene(name) {
  if (name === "game") stopWatchingGameResult();
  fadeOutAndCleanup(SCENES[name].canvas, sceneRive[name]);
  sceneRive[name] = null;
}

// Exit triggers as View Model (data binding) triggers
function listenForExits(name, r) {
  const scene = SCENES[name];
  const vmi = r.viewModelInstance;
  if (!vmi) {
    console.warn(FILES[name] + " has no bound view model instance");
    return;
  }
  scene.exits.forEach((exit) => {
    const trigger = getTrigger(vmi, exit.trigger);
    if (!trigger) {
      console.warn("No trigger named '" + exit.trigger + "' in " + FILES[name] + " view model");
      logAvailableProperties(FILES[name], vmi);
      return;
    }
    trigger.on(() => navigateTo(exit.goesTo));
  });
}

// ---------- Energy sharing in game.riv ----------
// Rive fires "gain request N" when zombie N is clicked.
// This script fires "gain energy N" ONLY if no neighbour zombie
// on the same position has 0 energy. Otherwise nothing happens.
function handleGainRequests(r) {
  const vmi = r.viewModelInstance;
  if (!vmi) return;

  const energies = ENERGY_PROPS.map((p) => getNumber(vmi, p));
  const positions = POSITION_PROPS.map((p) => getNumber(vmi, p));
  if (energies.includes(null) || positions.includes(null)) return; // watchGameResult logs missing names

  GAIN_REQUEST_PROPS.forEach((requestName, i) => {
    const request = getTrigger(vmi, requestName);
    const gain = getTrigger(vmi, GAIN_PROPS[i]);

    if (!request) {
      console.warn("No trigger named '" + requestName + "' in game.riv view model");
      return;
    }
    if (!gain) {
      console.warn("No trigger named '" + GAIN_PROPS[i] + "' in game.riv view model");
      return;
    }

    request.on(() => {
      const myPos = positions[i].value;

      // neighbours = zombie above and below, only if on the same position
      const sameSpotNeighbours = [i - 1, i + 1].filter(
        (n) => n >= 0 && n < 4 && positions[n].value === myPos
      );

      const emptyNeighbour = sameSpotNeighbours.find((n) => energies[n].value <= 0);
      if (emptyNeighbour !== undefined) {
        console.log(
          "'" + GAIN_PROPS[i] + "' not fired: zombie " + (emptyNeighbour + 1) +
          " on the same position has 0 energy"
        );
        return;
      }

      gain.trigger();
    });
  });
}

// ---------- Win / lose check in game.riv ----------
function watchGameResult(r) {
  stopWatchingGameResult();
  const vmi = r.viewModelInstance;
  if (!vmi) return;

  let missing = false;
  const numberProp = (p) => {
    const prop = getNumber(vmi, p);
    if (!prop) {
      console.warn("No number named '" + p + "' in game.riv view model");
      missing = true;
    }
    return prop;
  };

  const energies = ENERGY_PROPS.map(numberProp);
  const positions = POSITION_PROPS.map(numberProp);
  const sweet = getBoolean(vmi, SWEET_PROP);
  if (!sweet) {
    console.warn("No boolean named '" + SWEET_PROP + "' in game.riv view model");
    missing = true;
  }

  if (missing) {
    logAvailableProperties("game.riv", vmi);
    return;
  }

  let lastLog = "";

  const check = () => {
    if (isTransitioning || currentScene !== "game") return;

    const e = energies.map((p) => p.value);
    const pos = positions.map((p) => p.value);
    const s = sweet.value;

    // Log values only when they change
    const log = "energy: " + e.join(", ") + " | positions: " + pos.join(", ") + " | sweet: " + s;
    if (log !== lastLog) {
      console.log(log);
      lastLog = log;
    }

    const allPositionsZero = pos.every((v) => v === 0);
    const allEnergyZero = e.every((v) => v <= 0);

    // WIN: sweet is true and all zombie positions are 0 (energy not checked)
    if (s === true && allPositionsZero) {
      console.log("WIN");
      finishGame(WIN_TRIGGER);
      return;
    }

    // LOSE: all energy is 0 and it is not a win (positions and sweet don't matter)
    if (allEnergyZero) {
      console.log("LOSE");
      finishGame(LOSE_TRIGGER);
    }
  };

  resultTimer = setInterval(check, RESULT_CHECK_INTERVAL);
}

// Win/lose found: stop checking, wait RESULT_DELAY, then start the transition
function finishGame(transitionTrigger) {
  stopWatchingGameResult();
  resultDelayTimer = setTimeout(() => {
    resultDelayTimer = null;
    navigateTo("menu", transitionTrigger);
  }, RESULT_DELAY);
}

function stopWatchingGameResult() {
  if (resultTimer) {
    clearInterval(resultTimer);
    resultTimer = null;
  }
}

// Cancels a pending win/lose (e.g. home or restart pressed during the wait)
function cancelPendingResult() {
  if (resultDelayTimer) {
    clearTimeout(resultDelayTimer);
    resultDelayTimer = null;
  }
}

// Fires a trigger (loading / win / lose) in transition.riv's view model
function fireTransitionTrigger(r, triggerName) {
  const vmi = r.viewModelInstance;
  if (!vmi) {
    console.warn("transition.riv has no bound view model instance");
    return;
  }
  const trigger = getTrigger(vmi, triggerName);
  if (!trigger) {
    console.warn("No trigger named '" + triggerName + "' in transition.riv view model");
    logAvailableProperties("transition.riv", vmi);
    return;
  }
  trigger.trigger();
}

// Same transition for every navigation between screens
// transitionTrigger chooses which trigger fires in transition.riv
function navigateTo(target, transitionTrigger = LOADING_TRIGGER) {
  if (isTransitioning) return;
  isTransitioning = true;
  cancelPendingResult();
  const from = currentScene;
  if (from === "game") stopWatchingGameResult();

  // 1. Transition fades in above everything
  transitionRive = createRive("transition", transitionCanvas, (r) => {
    fadeIn(transitionCanvas);
    // Fire the trigger and only now start the clock,
    // so timing matches the transition animation exactly
    fireTransitionTrigger(r, transitionTrigger);
    startTransitionTimers(from, target);
  });
}

function startTransitionTimers(from, target) {
  // 2. Screen we are leaving fades out
  setTimeout(() => {
    hideScene(from);
  }, REMOVE_CURRENT_AT);

  // 3. Next screen fades in behind the transition
  //    (for restart this creates a fresh game.riv)
  setTimeout(() => {
    showScene(target);
  }, SWAP_AT);

  // 4. Transition fades out
  setTimeout(() => {
    fadeOutAndCleanup(transitionCanvas, transitionRive);
    transitionRive = null;
    // allow new navigation once the fade has finished
    setTimeout(() => {
      isTransitioning = false;
    }, FADE_DURATION);
  }, TRANSITION_DURATION);
}

// Keep canvases sharp when the window is resized
window.addEventListener("resize", () => {
  [...Object.values(sceneRive), transitionRive].forEach((r) => {
    if (r) r.resizeDrawingSurfaceToCanvas();
  });
});

preload()
  .then(() => {
    // menu canvas starts hidden so it fades in on first load too
    menuCanvas.classList.add("hidden");
    showScene("menu", () => {
      loadingEl.style.display = "none";
    });
  })
  .catch((err) => {
    console.error(err);
    loadingEl.textContent = err.message;
  });