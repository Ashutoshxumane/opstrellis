const EXAMPLES = [
  { app: "Terminal", said: ["~um", "so", "~uh", "run", "cube", "control", "get", "pods"], typed: ["code", "so run kubectl get pods"], took: "0.4 s" },
  { app: "Cursor", said: ["open", "main", "dot", "rs", "and", "add", "dash", "dash", "watch"], typed: ["code", "open main.rs and add --watch"], took: "0.5 s" },
  { app: "Slack", said: ["~um", "check", "the", "nest", "dev", "branch", "new", "line", "it's", "ready", "for", "review"], typed: ["text", "Check the feature/nest_dev branch\nIt's ready for review."], took: "0.6 s" },
];

for (const button of document.querySelectorAll(".copy")) {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(source.textContent);
      button.textContent = "Copied";
    } catch {
      getSelection().selectAllChildren(source);
      button.textContent = "Selected";
    }
    setTimeout(() => (button.textContent = "Copy"), 1800);
  });
}

const $ = (id) => document.getElementById(id);
const app = $("demo-app"), said = $("demo-said"), typed = $("demo-typed");
const pill = $("pill"), pillText = $("pill-text"), pillTime = $("pill-time"), lattice = $("lattice");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const COLS = 7, ROWS = 5;
const dots = Array.from({ length: COLS * ROWS }, () => lattice.appendChild(document.createElement("i")));
function setLevels(levels) {
  levels.forEach((level, c) => {
    const lit = Math.round(level * ROWS);
    for (let r = 0; r < ROWS; r++) dots[r * COLS + c].classList.toggle("on", Math.abs(r - 2) * 2 < lit);
  });
}
let talking = false;
setInterval(() => setLevels(Array.from({ length: COLS }, (_, c) => (talking ? 0.25 + Math.random() * 0.75 * (1 - Math.abs(c - 3) / 5) : 0.2))), 110);

function renderSaid(words, count, strike) {
  said.replaceChildren();
  words.slice(0, count).forEach((w, i) => {
    if (i) said.append(" ");
    const filler = w.startsWith("~");
    const el = document.createElement(filler && strike ? "s" : "span");
    el.textContent = filler ? w.slice(1) : w;
    said.append(el);
  });
}

function renderTyped([kind, text]) {
  typed.replaceChildren();
  if (!text) return;
  if (kind === "code") {
    const code = document.createElement("code");
    code.textContent = text;
    typed.append(code);
  } else {
    text.split("\n").forEach((line, i) => { if (i) typed.append(document.createElement("br")); typed.append(line); });
  }
}

function setPill(state, text) {
  pill.dataset.state = state;
  pillText.textContent = text;
}

function show(ex) {
  app.textContent = ex.app;
  renderSaid(ex.said, ex.said.length, true);
  renderTyped(ex.typed);
  setPill("done", `Inserted · ${ex.took}`);
}

async function play() {
  for (let n = 0; ; n = (n + 1) % EXAMPLES.length) {
    const ex = EXAMPLES[n];
    app.textContent = ex.app;
    renderTyped(["text", ""]);
    setPill("rec", "");
    talking = true;
    const start = performance.now();
    for (let i = 1; i <= ex.said.length; i++) {
      renderSaid(ex.said, i, false);
      pillText.textContent = "…" + ex.said.slice(Math.max(0, i - 3), i).map((w) => w.replace("~", "")).join(" ");
      pillTime.textContent = `0:0${Math.floor((performance.now() - start) / 1000)}`;
      await wait(240);
    }
    await wait(300);
    talking = false;
    setPill("busy", "Transcribing");
    renderSaid(ex.said, ex.said.length, true);
    await wait(650);
    renderTyped(ex.typed);
    setPill("done", `Inserted · ${ex.took}`);
    await wait(3200);
  }
}

if (matchMedia("(prefers-reduced-motion: reduce)").matches) show(EXAMPLES[0]);
else play();
