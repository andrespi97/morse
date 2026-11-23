(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Morse dictionary                                                   */
  /* ------------------------------------------------------------------ */

  const MORSE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.",
    G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..",
    M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.",
    S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
    Y: "-.--", Z: "--..",
    Ä: ".-.-", Ö: "---.", Ü: "..--",
    0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-",
    5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "!": "-.-.--",
    "'": ".----.", '"': ".-..-.", "/": "-..-.", "(": "-.--.",
    ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.",
    "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-",
    $: "...-..-", "@": ".--.-.",
  };

  const MORSE_TO_CHAR = new Map(
    Object.entries(MORSE).map(([char, code]) => [code, char])
  );

  /* ------------------------------------------------------------------ */
  /*  Timing + state                                                     */
  /* ------------------------------------------------------------------ */

  const LONG_PRESS_MS = 220;   // more than this held = dash
  const LETTER_GAP_MS = 650;   // pause after a letter -> commit it
  const WORD_EXTRA_MS = 850;   // extra pause -> insert a space
  const MIN_TONE_MS = 70;      // so quick taps still make an audible blip
  const MAX_PRESS_MS = 20000;  // safety: never let a press ring forever
  const TONE_HZ = 600;
  const TONE_GAIN = 0.16;
  const MAX_TEXT = 600;

  const $ = (id) => document.getElementById(id);

  const el = {
    pad: $("pad"),
    key: $("key"),
    symbols: $("symbols"),
    message: $("message"),
    messageText: $("messageText"),
    caret: $("caret"),
    soundToggle: $("soundToggle"),
    translateToggle: $("translateToggle"),
    clearBtn: $("clearBtn"),
    tree: $("morseTree"),
  };

  const state = {
    text: "",
    pending: "",
    candidate: null,      // "." or "-" while the finger is down
    pressing: false,
    pressStart: 0,
    long: false,
    sound: readPref("morse.sound", true),
    translate: readPref("morse.translate", true),
    letterTimer: null,
    wordTimer: null,
    longTimer: null,
    pressGuard: null,
    toneGuard: null,
  };

  function readPref(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      /* private mode, ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Audio                                                              */
  /* ------------------------------------------------------------------ */

  /*
   * A single oscillator runs for the whole session and the audible part is a
   * gain gate that is silent by default. That way a lost pointerup can never
   * leave a tone ringing: releasing just ramps the gate to 0, and any weird
   * state can be flattened with hardStop().
   */
  const tone = (() => {
    let ctx = null;
    let osc = null;
    let gate = null;
    let startedAt = 0;
    let open = false;

    function param() {
      return gate ? gate.gain : null;
    }

    function hold(g, now) {
      if (typeof g.cancelAndHoldAtTime === "function") {
        try {
          g.cancelAndHoldAtTime(now);
          return;
        } catch {
          /* fall through */
        }
      }
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.max(g.value, 0), now);
      } catch {
        /* ignore */
      }
    }

    function ensure() {
      if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        try {
          ctx = new AudioCtx();
        } catch {
          return null;
        }
      }

      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      if (!osc) {
        try {
          osc = ctx.createOscillator();
          gate = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = TONE_HZ;
          gate.gain.value = 0;
          osc.connect(gate);
          gate.connect(ctx.destination);
          osc.start();
        } catch {
          osc = null;
          gate = null;
        }
      }

      return ctx;
    }

    function start() {
      if (!state.sound) return;
      const c = ensure();
      const g = param();
      if (!c || !g) return;

      const now = c.currentTime;
      open = true;
      startedAt = performance.now();

      try {
        hold(g, now);
        g.linearRampToValueAtTime(TONE_GAIN, now + 0.012);
      } catch {
        hardStop();
      }
    }

    function stop(minMs = 0) {
      const c = ctx;
      const g = param();
      if (!c || !g) return;

      const now = c.currentTime;
      const elapsed = performance.now() - startedAt;
      const wait = open ? Math.max(0, minMs - elapsed) / 1000 : 0;
      open = false;

      try {
        hold(g, now);
        if (wait > 0) g.setValueAtTime(Math.max(g.value, 0), now + wait);
        g.linearRampToValueAtTime(0, now + wait + 0.015);
      } catch {
        hardStop();
      }
    }

    function hardStop() {
      open = false;
      const c = ctx;
      const g = param();
      if (!c || !g) return;
      const now = c.currentTime;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(0, now);
      } catch {
        /* ignore */
      }
    }

    return { start, stop, hardStop, ensure };
  })();

  /* Last-resort silencer, in case a pointerup never reaches the pad. */
  function panic() {
    if (state.pressing) endPress(true);
    tone.hardStop();
  }

  function buzz(ms) {
    if (typeof navigator.vibrate === "function") navigator.vibrate(ms);
  }

  /* ------------------------------------------------------------------ */
  /*  Message + symbols                                                  */
  /* ------------------------------------------------------------------ */

  function renderMessage() {
    const hasText = state.text.length > 0;

    el.messageText.textContent = state.text;
    el.messageText.hidden = !(state.translate && hasText);
    el.caret.hidden = !(state.translate && hasText);

    el.message.scrollLeft = el.message.scrollWidth;
  }

  function renderSymbols() {
    let code = "";
    let candidateIndex = -1;

    if (previewCode !== null) {
      code = previewCode;
    } else if (state.pressing && state.candidate) {
      code = state.pending + state.candidate;
      candidateIndex = code.length - 1;
    } else if (state.pending) {
      code = state.pending;
    } else if (lastCommittedCode) {
      code = lastCommittedCode;
    }

    if (!code) {
      el.symbols.replaceChildren();
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < code.length; i++) {
      const symbol = code[i];
      const item = document.createElement("i");
      item.className = symbol === "." ? "sym-dot" : "sym-dash";
      if (i === candidateIndex) item.classList.add("is-candidate");
      frag.appendChild(item);
    }
    el.symbols.replaceChildren(frag);
  }

  function appendText(chunk) {
    if (!chunk) return;

    if (chunk === " ") {
      state.text = state.text.replace(/ +$/, "");
      if (!state.text) return;
      state.text += " ";
    } else {
      state.text += chunk;
    }

    if (state.text.length > MAX_TEXT) {
      state.text = state.text.slice(-MAX_TEXT);
    }

    renderMessage();
  }

  /* ------------------------------------------------------------------ */
  /*  Morse graph                                                        */
  /* ------------------------------------------------------------------ */

  const SVG_NS = "http://www.w3.org/2000/svg";
  const NODE_R = 13;      // radio del símbolo punto
  const DASH_W = 38;      // ancho del símbolo raya
  const DASH_H = 16;      // alto del símbolo raya
  const ROOT_R = 24;

  /*
   * Rejilla de la placa grabada: columnas -3..4 y filas 0..6.
   * El hijo "raya" sale hacia fuera en la misma fila y el hijo "punto" baja
   * recto en la misma columna, de modo que cada conexión es una única línea
   * recta que va de un símbolo a otro (nunca de una línea a otra).
   */
  const GRID_X = [30, 82, 134, 200, 270, 322, 374, 426]; // columnas -3..4
  const GRID_Y = [52, 120, 188, 256, 324, 392, 460];      // filas 0..6

  /*
   * [columna, fila, [dx, dy, anclaje]] -> el símbolo es el punto/raya y la
   * letra se dibuja fuera, en el lado libre de cableado.
   */
  const GRAPH_LAYOUT = {
    // fila superior
    O: [-3, 0, [0, -29, "middle"]],
    M: [-2, 0, [0, -29, "middle"]],
    T: [-1, 0, [0, -29, "middle"]],
    E: [1, 0, [0, -29, "middle"]],
    I: [2, 0, [0, -29, "middle"]],
    S: [3, 0, [0, -29, "middle"]],
    H: [4, 0, [0, -29, "middle"]],
    // ramas de la izquierda (raya hacia fuera, punto hacia abajo)
    Q: [-3, 1, [0, 37, "middle"]],
    G: [-2, 1, [24, 8, "start"]],
    Z: [-2, 2, [24, 8, "start"]],
    Y: [-3, 3, [0, -29, "middle"]],
    K: [-2, 3, [0, -29, "middle"]],
    N: [-1, 3, [24, 8, "start"]],
    C: [-2, 4, [24, 8, "start"]],
    X: [-2, 5, [-25, 8, "end"]],
    D: [-1, 5, [24, 8, "start"]],
    B: [-1, 6, [24, 8, "start"]],
    // ramas de la derecha (punto hacia fuera, raya hacia abajo)
    V: [3, 1, [24, 8, "start"]],
    U: [2, 2, [-24, 8, "end"]],
    F: [3, 2, [24, 8, "start"]],
    A: [1, 3, [-25, 8, "end"]],
    R: [2, 3, [0, -29, "middle"]],
    L: [3, 3, [24, 8, "start"]],
    W: [1, 4, [-24, 8, "end"]],
    P: [2, 4, [24, 8, "start"]],
    J: [1, 5, [24, 8, "start"]],
  };

  const GRAPH_EDGES = [
    ["", "T"], ["T", "M"], ["M", "O"],
    ["", "E"], ["E", "I"], ["I", "S"], ["S", "H"],
    ["M", "G"], ["G", "Q"], ["G", "Z"],
    ["T", "N"], ["N", "K"], ["N", "D"],
    ["K", "Y"], ["K", "C"], ["D", "X"], ["D", "B"],
    ["E", "A"], ["A", "R"], ["A", "W"],
    ["R", "L"], ["W", "J"], ["W", "P"],
    ["I", "U"], ["U", "F"],
    ["S", "V"],
  ];

  const ROOT = { x: GRID_X[3], y: GRID_Y[0] };

  const nodeData = new Map();   // code -> { char, x, y, dash, label }
  const nodeEls = new Map();    // code -> <g>
  const edgeEls = new Map();    // code -> <g>
  const rootGroup = { el: null };

  let previewCode = null;
  let lastCommittedCode = null;

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    return node;
  }

  function codeWords(code) {
    return code
      .split("")
      .map((symbol) => (symbol === "." ? "punto" : "raya"))
      .join(" ");
  }

  function keyIcon() {
    const g = svgEl("g", {
      class: "root-icon",
      transform: `translate(${ROOT.x} ${ROOT.y}) scale(1.22) translate(-16 -13)`,
    });

    const parts = [
      ["path", { d: "M3.5 22.2h25" }],
      ["path", { d: "M7 22.2v-3.1h17.2v3.1" }],
      ["path", { d: "M7.4 19.1 22.6 11" }],
      ["circle", { class: "solid", cx: 22.9, cy: 18.3, r: 1.35 }],
      ["circle", { class: "solid", cx: 9.3, cy: 10.4, r: 3.1 }],
      ["path", { d: "M14.1 16.4v2.7" }],
      ["path", { d: "M24.2 18.3v-3.4" }],
    ];

    for (const [tag, attrs] of parts) g.appendChild(svgEl(tag, attrs));
    return g;
  }

  function buildTree() {
    for (const [char, [col, row, label]] of Object.entries(GRAPH_LAYOUT)) {
      const code = MORSE[char];
      nodeData.set(code, {
        char,
        x: GRID_X[col + 3],
        y: GRID_Y[row],
        dash: code.endsWith("-"),
        label,
      });
    }

    const edgeLayer = svgEl("g", { class: "edge-layer" });
    const nodeLayer = svgEl("g", { class: "node-layer" });

    for (const [from, to] of GRAPH_EDGES) {
      const child = nodeData.get(MORSE[to]);
      if (!child) continue;

      const parent =
        from === ""
          ? ROOT
          : nodeData.get(MORSE[from]);

      if (!parent) continue;

      const { d } = edgeGeometry(parent, child);
      const code = MORSE[to];
      const group = svgEl("g", { class: "edge", "data-code": code });
      group.appendChild(svgEl("path", { class: "trace", d }));

      edgeLayer.appendChild(group);
      edgeEls.set(code, group);
    }

    for (const [code, node] of nodeData) {
      const group = svgEl("g", {
        class: "node",
        "data-code": code,
        "data-char": node.char,
        role: "button",
        tabindex: "0",
        "aria-label": `Letra ${node.char}, código ${codeWords(code)}`,
      });

      const hit = node.dash
        ? svgEl("rect", {
            class: "node-hit",
            x: node.x - DASH_W / 2 - 12,
            y: node.y - DASH_H / 2 - 12,
            width: DASH_W + 24,
            height: DASH_H + 24,
            rx: (DASH_H + 24) / 2,
          })
        : svgEl("circle", {
            class: "node-hit",
            cx: node.x,
            cy: node.y,
            r: NODE_R + 16,
          });

      const halo = node.dash
        ? svgEl("rect", {
            class: "node-halo",
            x: node.x - (DASH_W / 2 + 7),
            y: node.y - (DASH_H / 2 + 7),
            width: DASH_W + 14,
            height: DASH_H + 14,
            rx: (DASH_H + 14) / 2,
          })
        : svgEl("circle", {
            class: "node-halo",
            cx: node.x,
            cy: node.y,
            r: NODE_R + 7,
          });

      // El símbolo es la propia letra del código: punto o raya.
      const shape = node.dash
        ? svgEl("rect", {
            class: "node-shape",
            x: node.x - DASH_W / 2,
            y: node.y - DASH_H / 2,
            width: DASH_W,
            height: DASH_H,
            rx: DASH_H / 2,
          })
        : svgEl("circle", {
            class: "node-shape",
            cx: node.x,
            cy: node.y,
            r: NODE_R,
          });

      const [dx, dy, anchor] = node.label;
      const letter = svgEl("text", {
        class: "node-letter",
        x: node.x + dx,
        y: node.y + dy,
        "text-anchor": anchor,
      });
      letter.textContent = node.char;

      group.append(hit, halo, shape, letter);
      nodeLayer.appendChild(group);
      nodeEls.set(code, group);
    }

    const root = svgEl("g", { class: "root" });
    const rootHit = svgEl("circle", {
      class: "node-hit",
      cx: ROOT.x,
      cy: ROOT.y,
      r: 34,
    });
    const rootCore = svgEl("circle", {
      class: "root-core",
      cx: ROOT.x,
      cy: ROOT.y,
      r: ROOT_R,
    });
    root.append(rootHit, rootCore, keyIcon());

    el.tree.append(edgeLayer, nodeLayer, root);
    rootGroup.el = root;
  }

  function halfW(node) {
    if (node === ROOT) return ROOT_R;
    return node.dash ? DASH_W / 2 : NODE_R;
  }

  function halfH(node) {
    if (node === ROOT) return ROOT_R;
    return node.dash ? DASH_H / 2 : NODE_R;
  }

  function edgeGeometry(parent, child) {
    // Misma fila: tramo horizontal de símbolo a símbolo.
    if (Math.abs(parent.y - child.y) < 0.5) {
      const dir = Math.sign(child.x - parent.x) || 1;
      const x1 = parent.x + dir * halfW(parent);
      const x2 = child.x - dir * halfW(child);
      return { d: `M${x1} ${parent.y}H${x2}` };
    }

    // Misma columna: bajada recta de símbolo a símbolo.
    const y1 = parent.y + halfH(parent);
    const y2 = child.y - halfH(child);
    return { d: `M${parent.x} ${y1}V${y2}` };
  }

  function displayCode() {
    if (previewCode !== null) return previewCode;
    if (state.pressing && state.candidate) return state.pending + state.candidate;
    if (state.pending) return state.pending;
    return lastCommittedCode || "";
  }

  function renderGraph() {
    const code = displayCode();
    const candidate =
      previewCode === null && state.pressing && state.candidate !== null;

    for (const node of nodeEls.values()) {
      node.classList.remove("is-lit", "is-current", "is-keying");
    }
    for (const edge of edgeEls.values()) {
      edge.classList.remove("is-lit", "is-keying");
    }
    if (rootGroup.el) rootGroup.el.classList.remove("is-lit");

    if (code) {
      if (rootGroup.el) rootGroup.el.classList.add("is-lit");

      for (let i = 1; i <= code.length; i++) {
        const prefix = code.slice(0, i);
        const node = nodeEls.get(prefix);
        if (!node) break;

        node.classList.add("is-lit");
        const edge = edgeEls.get(prefix);
        if (edge) edge.classList.add("is-lit");
      }

      if (nodeEls.has(code)) {
        const target = nodeEls.get(code);
        target.classList.add("is-current");
        if (candidate) {
          target.classList.add("is-keying");
          const edge = edgeEls.get(code);
          if (edge) edge.classList.add("is-keying");
        }
      }
    }
  }

  function activateNode(target) {
    const group = target.closest ? target.closest(".node") : null;
    if (!group || !el.tree.contains(group)) return;
    if (state.pressing) return;

    const code = group.getAttribute("data-code");
    if (!code) return;

    previewCode = previewCode === code ? null : code;
    lastCommittedCode = null;
    renderGraph();
    renderSymbols();
  }

  el.tree.addEventListener("click", (event) => {
    const root = event.target.closest ? event.target.closest(".root") : null;
    if (root && el.tree.contains(root)) {
      if (state.pressing) return;
      previewCode = null;
      lastCommittedCode = null;
      renderGraph();
      renderSymbols();
      return;
    }

    activateNode(event.target);
  });

  el.tree.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const group = event.target.closest ? event.target.closest(".node") : null;
    if (!group) return;
    event.preventDefault();
    activateNode(group);
  });

  /* ------------------------------------------------------------------ */
  /*  Key flow                                                           */
  /* ------------------------------------------------------------------ */

  function clearTimers() {
    if (state.letterTimer) {
      clearTimeout(state.letterTimer);
      state.letterTimer = null;
    }
    if (state.wordTimer) {
      clearTimeout(state.wordTimer);
      state.wordTimer = null;
    }
    if (state.longTimer) {
      clearTimeout(state.longTimer);
      state.longTimer = null;
    }
  }

  function commitLetter(withWordGap = true) {
    state.letterTimer = null;
    if (!state.pending) return;

    const sequence = state.pending;
    const char = MORSE_TO_CHAR.get(sequence) || "?";
    state.pending = "";
    lastCommittedCode = nodeEls.has(sequence) ? sequence : null;

    renderSymbols();
    renderGraph();

    if (state.translate) appendText(char);

    if (withWordGap && state.translate) {
      state.wordTimer = setTimeout(() => {
        state.wordTimer = null;
        if (state.translate) appendText(" ");
      }, WORD_EXTRA_MS);
    }
  }

  function addSymbol(symbol) {
    state.pending = (state.pending + symbol).slice(-8);
    previewCode = null;
    lastCommittedCode = null;
    state.candidate = null;

    renderSymbols();
    renderGraph();

    clearTimers();
    state.letterTimer = setTimeout(() => commitLetter(true), LETTER_GAP_MS);
  }

  /* ------------------------------------------------------------------ */
  /*  Press / release                                                    */
  /* ------------------------------------------------------------------ */

  let pressPoint = null; // solo para dibujar la onda del toque

  function beginPress(point = null) {
    if (state.pressing) return;

    clearTimers();
    if (state.toneGuard) {
      clearTimeout(state.toneGuard);
      state.toneGuard = null;
    }
    previewCode = null;
    lastCommittedCode = null;
    state.pressing = true;
    state.pressStart = performance.now();
    state.long = false;
    state.candidate = ".";
    pressPoint = point;

    el.pad.classList.add("is-pressing");
    el.key.classList.remove("is-dash");

    tone.start();
    renderSymbols();
    renderGraph();

    state.longTimer = setTimeout(() => {
      if (!state.pressing) return;
      state.long = true;
      state.candidate = "-";
      el.key.classList.add("is-dash");
      renderSymbols();
      renderGraph();
      buzz(10);
    }, LONG_PRESS_MS);

    if (state.pressGuard) clearTimeout(state.pressGuard);
    state.pressGuard = setTimeout(() => {
      state.pressGuard = null;
      if (!state.pressing) return;
      endPress(true);
      tone.hardStop();
    }, MAX_PRESS_MS);
  }

  function endPress(cancelled = false) {
    if (!state.pressing) return;

    const duration = performance.now() - state.pressStart;
    const isDash = state.long || duration >= LONG_PRESS_MS;

    state.pressing = false;
    state.long = false;
    state.candidate = null;

    if (state.longTimer) {
      clearTimeout(state.longTimer);
      state.longTimer = null;
    }

    el.pad.classList.remove("is-pressing");
    el.key.classList.remove("is-dash");

    tone.stop(MIN_TONE_MS);

    if (state.pressGuard) {
      clearTimeout(state.pressGuard);
      state.pressGuard = null;
    }
    // Guarantee silence once the short release tail has faded out.
    state.toneGuard = setTimeout(() => {
      state.toneGuard = null;
      if (!state.pressing) tone.hardStop();
    }, MIN_TONE_MS + 140);

    spawnRipple();

    if (!cancelled) {
      addSymbol(isDash ? "-" : ".");
      buzz(isDash ? 14 : 6);
    } else {
      renderSymbols();
      renderGraph();
    }
  }

  function spawnRipple() {
    const rect = el.pad.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.left = (pressPoint ? pressPoint.x : rect.width / 2) + "px";
    ripple.style.top = (pressPoint ? pressPoint.y : rect.height * 0.46) + "px";
    pressPoint = null;
    el.pad.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  }

  /* ------------------------------------------------------------------ */
  /*  Pointer input                                                      */
  /* ------------------------------------------------------------------ */

  el.pad.addEventListener("pointerdown", (event) => {
    if (state.pressing) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    try {
      el.pad.setPointerCapture(event.pointerId);
    } catch {
      /* not critical */
    }

    const rect = el.pad.getBoundingClientRect();
    beginPress({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  });

  el.pad.addEventListener("pointerup", (event) => {
    if (!state.pressing) return;
    event.preventDefault();
    endPress(false);
  });

  el.pad.addEventListener("pointercancel", () => endPress(true));
  el.pad.addEventListener("lostpointercapture", () => endPress(true));
  el.pad.addEventListener("contextmenu", (event) => event.preventDefault());

  /* Safety net: any pointer release anywhere ends the press + silences. */
  for (const type of ["pointerup", "pointercancel", "touchend", "touchcancel", "mouseup"]) {
    window.addEventListener(type, () => {
      if (state.pressing) endPress(true);
    });
  }

  window.addEventListener("blur", panic);
  window.addEventListener("pagehide", panic);

  /* Keyboard: space acts as the key, for desktop testing. */
  window.addEventListener("keydown", (event) => {
    const onControl = event.target.closest
      ? event.target.closest("button, input, textarea, .node")
      : false;

    if (event.code === "Space" || event.key === " ") {
      if (onControl) return;
      if (event.repeat) return;
      event.preventDefault();
      if (state.pressing) return;
      beginPress();
      return;
    }

    if (event.key === "Backspace") {
      if (event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      removeLast();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      clearAll();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.key === " ") {
      if (!state.pressing) return;
      event.preventDefault();
      endPress(false);
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Tools                                                              */
  /* ------------------------------------------------------------------ */

  function removeLast() {
    clearTimers();
    previewCode = null;
    lastCommittedCode = null;

    if (state.pending) {
      state.pending = state.pending.slice(0, -1);
      renderSymbols();
      renderGraph();
      return;
    }

    if (state.text) {
      state.text = state.text.slice(0, -1);
      renderMessage();
    }

    renderSymbols();
    renderGraph();
  }

  function clearAll() {
    clearTimers();
    state.text = "";
    state.pending = "";
    state.candidate = null;
    previewCode = null;
    lastCommittedCode = null;
    renderSymbols();
    renderGraph();
    renderMessage();
  }

  el.clearBtn.addEventListener("click", clearAll);

  /* ------------------------------------------------------------------ */
  /*  Toggles                                                            */
  /* ------------------------------------------------------------------ */

  function applySound(on) {
    state.sound = on;
    el.soundToggle.checked = on;
    if (!on) tone.hardStop();
    writePref("morse.sound", on);
  }

  function applyTranslate(on) {
    state.translate = on;
    el.translateToggle.checked = on;
    writePref("morse.translate", on);
    renderMessage();
  }

  el.soundToggle.addEventListener("change", () => {
    applySound(el.soundToggle.checked);
    if (state.sound) tone.ensure();
  });

  el.translateToggle.addEventListener("change", () => {
    applyTranslate(el.translateToggle.checked);
  });

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      panic();
    } else if (state.sound) {
      tone.ensure();
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Init                                                               */
  /* ------------------------------------------------------------------ */

  applySound(state.sound);
  applyTranslate(state.translate);
  buildTree();
  renderSymbols();
  renderGraph();
  renderMessage();
})();
