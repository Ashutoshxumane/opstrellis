// React integration regressions with controlled IPC (no native OS/provider claims).
// With Vite on :1430: CHROME=/usr/bin/chromium node e2e/review_regressions.mjs
// Uses the external Playwright installation from design_check.mjs (PW_DIR, default /tmp/pw).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const { chromium } = createRequire(path.join(process.env.PW_DIR ?? '/tmp/pw', 'package.json'))('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.addInitScript(() => {
  let next = 0;
  const callbacks = new Map(), listeners = new Map();
  const review = window.review = { saves: [], pendingSaves: [], delaySaves: false, drafts: [], histories: [], delayHistory: false, lastHistory: [] };
  review.emit = (event, payload) => {
    for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (fn) => { const id = ++next; callbacks.set(id, fn); return id; },
    invoke: async (cmd, args = {}) => {
      if (cmd === 'plugin:event|listen') { const id = ++next; listeners.set(id, args); return id; }
      if (cmd === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (cmd === 'plugin:app|version') return 'test';
      if (cmd === 'meeting_follow_up') return new Promise((resolve, reject) => review.drafts.push({ args, resolve, reject }));
      if (cmd === 'list_history' && review.delayHistory) return new Promise((resolve) => review.histories.push({ args, resolve }));
      const { mockInvoke } = await import('/src/mock.ts');
      const result = await mockInvoke(cmd, args);
      if (cmd === 'get_settings') { const copy = structuredClone(result); copy.llm.enabled = true; return copy; }
      if (cmd === 'save_settings') {
        review.saves.push(structuredClone(args.settings));
        if (review.delaySaves) return new Promise((resolve, reject) => review.pendingSaves.push({ result, resolve, reject }));
      }
      if (cmd === 'list_history') review.lastHistory = structuredClone(result);
      return result;
    },
  };
});
const base = process.env.BASE_URL ?? 'http://localhost:1430/';
const nav = (name) => page.locator('.nav-item').getByText(name, { exact: true }).click();
try {
  await page.goto(`${base}?page=settings`);
  const model = page.locator('#s-ai label').filter({ hasText: /^Model$/ }).locator('input');
  await model.fill('pending-model');
  await page.evaluate(async () => {
    const settings = await window.__TAURI_INTERNALS__.invoke('get_settings');
    settings.llm.enabled = false;
    window.review.emit('settings-changed', settings);
  });
  await page.waitForFunction(() => window.review.saves.length > 0);
  const saved = await page.evaluate(() => window.review.saves.at(-1));
  assert.equal(saved.llm.enabled, false, 'pending save must keep the tray toggle');
  assert.equal(saved.llm.model, 'pending-model', 'tray toggle must keep pending model edits');
  await page.locator('#s-ai').getByRole('switch', { name: 'AI polish' }).click();
  await model.waitFor();
  assert.equal(await model.inputValue(), 'pending-model');
  console.log('PASS tray toggle with pending AI settings edits');

  await page.evaluate(() => { window.review.delaySaves = true; });
  await page.waitForFunction(() => window.review.pendingSaves.length === 1);
  await page.evaluate(async () => {
    const settings = await window.__TAURI_INTERNALS__.invoke('get_settings');
    settings.llm.enabled = false;
    window.review.emit('settings-changed', settings);
    const pending = window.review.pendingSaves[0];
    pending.resolve(pending.result);
  });
  // A later rejected edit must roll back to the tray's accepted state, even if an older save's
  // acknowledgement arrived after that event.
  await page.locator('#s-ai').getByRole('switch', { name: 'AI polish' }).click();
  await page.waitForFunction(() => window.review.pendingSaves.length === 2);
  await page.evaluate(() => window.review.pendingSaves[1].reject('save failed'));
  await page.waitForFunction(() => document.querySelector('#s-ai [role=switch]')?.getAttribute('aria-checked') === 'false');
  await page.evaluate(() => { window.review.delaySaves = false; });
  await page.locator('#s-ai').getByRole('switch', { name: 'AI polish' }).click();
  console.log('PASS stale settings acknowledgement and failure rollback');

  await nav('Notes');
  await page.getByRole('tab', { name: 'Meetings', exact: true }).click();
  await page.locator('.meeting-toggle').first().click();
  await page.getByRole('button', { name: 'Draft follow-up email' }).click();
  await page.waitForFunction(() => window.review.drafts.length === 1);
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.evaluate(() => window.review.drafts[0].resolve('late closed draft'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.modal').count(), 0, 'closed draft must stay closed');
  console.log('PASS closing a pending meeting draft');

  await page.getByRole('button', { name: 'Draft follow-up email' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'CRM note', exact: true }).click();
  await page.waitForFunction(() => window.review.drafts.length === 3);
  await page.evaluate(() => window.review.drafts[2].resolve('current CRM draft'));
  await page.getByText('current CRM draft', { exact: true }).waitFor();
  await page.evaluate(() => window.review.drafts[1].reject('late email failure'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.modal .follow-up').textContent(), 'current CRM draft');
  console.log('PASS out-of-order meeting drafts and stale failures');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();

  await nav('Home');
  await page.locator('.list-row.timed').first().waitFor();
  await page.evaluate(() => { window.review.delayHistory = true; });
  const search = page.getByPlaceholder('Search history');
  await search.fill('first');
  await page.waitForFunction(() => window.review.histories.some((h) => h.args.query === 'first'));
  await search.fill('second');
  await page.waitForFunction(() => window.review.histories.some((h) => h.args.query === 'second'));
  await page.evaluate(() => {
    const r = window.review;
    r.histories.find((h) => h.args.query === 'second').resolve([{ ...r.lastHistory[0], id: 900, text: 'current search result' }]);
  });
  await page.getByText('current search result', { exact: true }).waitFor();
  await page.evaluate(() => {
    const r = window.review;
    r.histories.find((h) => h.args.query === 'first').resolve([{ ...r.lastHistory[0], id: 901, text: 'stale search result' }]);
  });
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('stale search result', { exact: true }).count(), 0);
  assert.equal(await page.getByText('current search result', { exact: true }).count(), 1);
  console.log('PASS out-of-order history search responses');
} finally {
  await browser.close();
}
