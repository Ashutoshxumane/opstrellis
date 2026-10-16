// Design checks for "Quiet Glass" (docs/DESIGN.md), run against the Vite dev server with the mock backend.
//
//   npx vite --port 1430 &            (from desktop/)
//   node e2e/design_check.mjs         (PW_DIR: a throwaway Playwright install, default /tmp/pw)
//
// Writes screenshots to $OUT (default /tmp/design) and exits non-zero when a check fails.
//
// Header rule (DESIGN.md "shared edges"): the sidebar's 32px logo row and the 64px sticky page header
// share one band at the top of the window. We assert
//   - the page header's top equals the sidebar's top (both 0),
//   - the logo row's vertical centre equals the page title's vertical centre (±1px), and
//   - the first nav item's top equals the page header's bottom edge (64px, ±1px),
// so the nav list starts exactly where the content area under the header starts.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PW_DIR = process.env.PW_DIR ?? "/tmp/pw";
const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright");
const BASE = process.env.BASE_URL ?? "http://localhost:1430/";
const OUT = process.env.OUT ?? "/tmp/design";
const CHROME = process.env.CHROME ?? "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
const PAGES = ["home", "notes", "notes&tab=meetings", "library", "library&tab=snippets", "library&tab=actions", "style", "insights", "settings"];
const SCHEMES = ["light", "dark"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const failures = [];
let passed = 0;
function check(name, problems) {
  if (problems.length === 0) { passed++; return; }
  failures.push(`${name}\n    - ${problems.slice(0, 8).join("\n    - ")}${problems.length > 8 ? `\n    - … ${problems.length - 8} more` : ""}`);
}

// a. No gradients anywhere in the UI source.
try {
  const hits = execSync(`grep -riE "gradient" ${path.join(HERE, "../src")} --include=*.css --include=*.tsx || true`).toString().trim();
  check("no gradients in src", hits ? hits.split("\n") : []);
} catch (e) { check("no gradients in src", [String(e)]); }

/** Runs in the page: every layout measurement for one screen. */
function measure() {
  const px = (v) => parseFloat(v) || 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const name = (el) => {
    const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ""}`;
  };
  const out = { sidebar: [], align: [], header: [], overflow: [], heights: [], contrast: [], grid: [], centring: [], columns: [], icons: [] };
  const panel = document.querySelector(".panel");
  const title = document.querySelector(".page-title");
  const head = document.querySelector(".page-head");
  const body = document.querySelector(".page-body");
  if (!panel || !title || !head || !body) return { fatal: "page structure missing" };
  const tr = title.getBoundingClientRect();

  // 1. Title left edge == left edge of every top-level card / list / block in the content column.
  const top = [
    ...body.children,
    ...body.querySelectorAll(":scope > .section > :not(.section-head)"),
    ...body.querySelectorAll(":scope > .section > .day > .card"),
  ].filter(visible);
  for (const el of top) {
    const l = el.getBoundingClientRect().left;
    if (Math.abs(l - tr.left) > 1) out.align.push(`${name(el)} left ${l.toFixed(1)} ≠ title ${tr.left.toFixed(1)}`);
  }
  // Settings is a documented two-column layout: the section nav takes the column edge, and every
  // section card shares the second column's edge.
  const sb = body.querySelector(".settings-body");
  if (sb) {
    const edge = sb.getBoundingClientRect().left;
    for (const el of sb.querySelectorAll(":scope > .section > *")) {
      const l = el.getBoundingClientRect().left;
      if (visible(el) && Math.abs(l - edge) > 1) out.align.push(`settings ${name(el)} left ${l.toFixed(1)} ≠ ${edge.toFixed(1)}`);
    }
  }

  // 2. Header band (see the rule at the top of this file).
  const hr = head.getBoundingClientRect();
  const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
  const brand = document.querySelector(".brand").getBoundingClientRect();
  const nav = document.querySelector(".nav .nav-item").getBoundingClientRect();
  if (Math.abs(hr.top - sidebar.top) > 1) out.header.push(`header top ${hr.top} ≠ sidebar top ${sidebar.top}`);
  if (Math.abs(hr.height - 64) > 1) out.header.push(`header height ${hr.height} ≠ 64`);
  const bc = brand.top + brand.height / 2, tc = tr.top + tr.height / 2;
  if (Math.abs(bc - tc) > 1) out.header.push(`logo row centre ${bc} ≠ title centre ${tc}`);
  if (Math.abs(nav.top - hr.bottom) > 1) out.header.push(`first nav item top ${nav.top} ≠ header bottom ${hr.bottom}`);
  const actions = document.querySelector(".page-actions");
  if (actions) {
    const ar = actions.getBoundingClientRect();
    if (Math.abs(ar.top + ar.height / 2 - (hr.top + hr.height / 2)) > 1) out.header.push("header actions not vertically centred");
  }

  // 3. No horizontal overflow: the scroll container never scrolls sideways, and nothing pokes out of the column.
  if (panel.scrollWidth > panel.clientWidth) out.overflow.push(`panel scrollWidth ${panel.scrollWidth} > clientWidth ${panel.clientWidth}`);
  const bcs = getComputedStyle(body);
  const colRight = body.getBoundingClientRect().right - px(bcs.paddingRight);
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return true;
    return false;
  };
  for (const el of body.querySelectorAll("*")) {
    if (!visible(el) || clipped(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > colRight + 1) out.overflow.push(`${name(el)} right ${r.right.toFixed(1)} > column ${colRight.toFixed(1)}`);
  }

  // 4. Every button / input / select in the content area is 32px tall, except these composite controls.
  // Inline text links (.link, e.g. "Show original") are text, not buttons.
  const EXEMPT = ".toggle, .tone-card, .note-item, .meeting-toggle, .link";
  for (const el of panel.querySelectorAll("button, input:not([type=checkbox]):not([type=radio]), select")) {
    if (!visible(el) || el.matches(EXEMPT)) continue;
    const h = el.getBoundingClientRect().height;
    if (Math.abs(h - 32) > 1) out.heights.push(`${name(el)} is ${h.toFixed(1)}px tall`);
  }

  // 5. Text contrast (WCAG AA) of every text run against the surface it sits on.
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const backdrop = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = parse(getComputedStyle(document.body).backgroundColor);
    for (const c of layers.reverse()) bg = over(c, bg);
    return bg;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const scope = [panel, ...document.querySelectorAll(".modal, .sidebar")];
  for (const root of scope) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (!visible(el) || el.closest("[disabled], .provider.disabled, .heatmap, .li-actions")) continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      const bg = backdrop(el);
      const fg = over(parse(cs.color), bg);
      const size = px(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const r = ratio(fg, bg);
      if (r < need) out.contrast.push(`${name(el)} ${r.toFixed(2)}:1 (< ${need})`);
    }
  }

  // 6. 4px grid: padding, margin, gap and radius are multiples of 4 (1px hairlines and the
  //    spec's 6px kbd padding / --radius-xs excepted).
  const ok4 = (v) => { const n = Math.abs(px(v)); return n % 4 === 0 || n === 1; };
  const AUTO_MARGIN = ".page-body, .page-head-inner, .status-label, .sidebar-foot"; // margin: auto (resolved to px)
  for (const el of [panel, ...panel.querySelectorAll("*"), ...document.querySelectorAll(".sidebar, .sidebar *")]) {
    if (!visible(el) || el instanceof SVGElement) continue;
    const cs = getComputedStyle(el);
    const props = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap", "borderTopLeftRadius"];
    if (!el.matches(AUTO_MARGIN)) props.push("marginTop", "marginRight", "marginBottom", "marginLeft");
    for (const p of props) {
      const v = cs[p];
      if (!v || v === "normal" || v.endsWith("%") || v.includes(" ")) continue;
      const n = Math.abs(px(v));
      if (ok4(v)) continue;
      if (n === 6 && (el.tagName === "KBD" || p === "borderTopLeftRadius")) continue;
      out.grid.push(`${name(el)} ${p} = ${v}`);
    }
  }

  // 7. A search field and the section heading beside it: same height band, vertically centred.
  for (const sh of body.querySelectorAll(".section-head")) {
    const s = sh.querySelector(".search, .segmented");
    if (!s) continue;
    const h2 = sh.querySelector(".section-title").getBoundingClientRect(), r = s.getBoundingClientRect();
    if (Math.abs(h2.top + h2.height / 2 - (r.top + r.height / 2)) > 1) out.centring.push(`${name(sh)} heading and control not centred`);
  }

  // 8. Text columns inside list rows line up between rows.
  for (const list of body.querySelectorAll(".list")) {
    const lefts = [...list.querySelectorAll(":scope > .list-row .li-main")].map((e) => Math.round(e.getBoundingClientRect().left));
    if (new Set(lefts).size > 1) out.columns.push(`${name(list)} text columns at ${[...new Set(lefts)].join(", ")}`);
    const times = [...list.querySelectorAll(".li-time")].map((e) => Math.round(e.getBoundingClientRect().left));
    if (new Set(times).size > 1) out.columns.push(`${name(list)} time columns differ`);
  }

  // 9. Icons in buttons, fields and the sidebar are all 16px.
  for (const svg of document.querySelectorAll(".panel .btn svg, .panel .icon-btn svg, .panel .search svg, .sidebar .nav-item svg")) {
    const r = svg.getBoundingClientRect();
    if (visible(svg) && (Math.round(r.width) !== 16 || Math.round(r.height) !== 16)) out.icons.push(`${name(svg.parentElement)} icon ${r.width}×${r.height}`);
  }
  // 10. No label is cut off: sidebar items, the status row's hotkey next to "Ready", the Home hint line, titles.
  for (const el of document.querySelectorAll(".sidebar .nav-item, .sidebar .status-label, .sidebar kbd, .hint-main, .page-title, .section-title")) {
    if (el.scrollWidth > el.clientWidth + 1) out.sidebar.push(`${name(el)} is truncated (${el.scrollWidth} > ${el.clientWidth})`);
  }
  return out;
}

const browser = await chromium.launch({ executablePath: CHROME });
try {
  for (const scheme of SCHEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    for (const p of PAGES) {
      await page.goto(`${BASE}?page=${p}`);
      await page.waitForSelector(".page-title");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const m = await page.evaluate(measure);
      const tag = `${p} (${scheme})`;
      if (m.fatal) { check(`${tag}: structure`, [m.fatal]); continue; }
      check(`${tag}: title edge = card/list edges`, m.align);
      check(`${tag}: header band`, m.header);
      check(`${tag}: no horizontal overflow`, m.overflow);
      check(`${tag}: controls are 32px`, m.heights);
      check(`${tag}: text contrast AA`, m.contrast);
      check(`${tag}: 4px grid`, m.grid);
      check(`${tag}: heading/control centring`, m.centring);
      check(`${tag}: list text columns aligned`, m.columns);
      check(`${tag}: 16px icons`, m.icons);
      check(`${tag}: no truncated labels`, m.sidebar);
      await page.screenshot({ path: `${OUT}/${p.replace(/[&=]/g, "-")}-${scheme}.png` });
    }

    // A modal (portal into <body>), measured for contrast and control heights too.
    await page.goto(`${BASE}?page=dictionary`);
    await page.click("text=Add new");
    await page.waitForSelector(".modal input");
    await page.waitForTimeout(300);
    const modal = await page.evaluate(() => {
      const bad = [];
      if (document.querySelector(".modal").closest("#root")) bad.push("modal is not portaled to <body>");
      for (const el of document.querySelectorAll(".modal button, .modal input")) {
        const h = el.getBoundingClientRect().height;
        if (Math.abs(h - 32) > 1) bad.push(`${el.tagName} ${el.textContent || el.placeholder} is ${h}px`);
      }
      return bad;
    });
    check(`modal (${scheme})`, modal);
    await page.screenshot({ path: `${OUT}/modal-${scheme}.png` });

    // Onboarding.
    await page.goto(`${BASE}?onboarding`);
    await page.waitForSelector(".modal.onboarding");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/onboarding-${scheme}.png` });
    check(`no page errors (${scheme})`, errors);
    await ctx.close();
  }

  // Overlay pill over a neutral light and a neutral dark backdrop, composed into one image.
  const shots = {};
  for (const [label, bg] of [["light", "#e4e4e7"], ["dark", "#27272a"]]) {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 64 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}#overlay`);
    await page.waitForSelector(".pill-text");
    await page.addStyleTag({ content: `html.overlay-window, html.overlay-window body { background: ${bg} !important; }` });
    await page.waitForTimeout(1600);
    shots[label] = (await page.screenshot()).toString("base64");
    const pill = await page.evaluate(() => {
      const r = document.querySelector(".pill").getBoundingClientRect();
      return [r.width, r.height];
    });
    // The browser preview records hands-free, which is 280 wide (room for the timer); push-to-talk is 240.
    check(`overlay pill is 280×44 hands-free (${label})`, pill[0] === 280 && pill[1] === 44 ? [] : [`pill is ${pill.join("×")}`]);
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 300, height: 128 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(`<body style="margin:0">${["light", "dark"].map((k) =>
    `<img src="data:image/png;base64,${shots[k]}" style="display:block;width:300px;height:64px">`).join("")}</body>`);
  await page.screenshot({ path: `${OUT}/overlay.png` });
  await ctx.close();
} finally {
  await browser.close();
}

const report = `${passed} checks passed, ${failures.length} failed\n` + failures.map((f) => `FAIL ${f}`).join("\n");
writeFileSync(`${OUT}/report.txt`, report + "\n");
console.log(report);
console.log(`screenshots: ${OUT}`);
process.exit(failures.length ? 1 : 0);
