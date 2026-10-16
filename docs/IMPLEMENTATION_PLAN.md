# Implementation plan: roadmap phases 1–2

Status: phases 1–4 implemented (see [TASKS.md](TASKS.md)); the deferred items are listed at the
end.

This turns the first slice of [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) into shippable increments.
Every phase keeps current behaviour as the default, adds unit tests for the new logic and an e2e
check for each new pipeline path, and ends with a review checkpoint: re-read the diff, run
`cargo test`, `npm run build`, the e2e scenarios and the design check, and fix what they find
before moving on.

The roadmap items (1.x, 2.x) are referenced by number.

## Reuse before adding

| Need | Reused |
|---|---|
| Pill states and outcomes | The `dictation-state` event and `emit_state` overlay show/hide. No new window. |
| Category overrides and the AI-prompts style | The `context::classify` rules, `Settings.styles` and `autoTransforms` maps. |
| Prompt mode, style notes, context | `llm::cleanup_prompt`, which gains rules rather than new prompts or clients. |
| Voice actions | The `transforms` table, matched by name in command mode, plus one `output` column. |
| Snippet variables | The existing snippet pass in `text.rs`. |
| Meeting templates and follow-ups | The `finish_note` summary call and `llm::Client`. |
| Navigation and Library | The existing page components, wrapped in tabs. |

## Phase 1: trust and latency

| Item | Change | Acceptance |
|---|---|---|
| 1.1 Pill feedback | `DictationState` gains `stage` and `micReady`. A new `dictation-outcome` event (`ok`, `warn`, `error` plus a message). The overlay lingers about 0.9 s for ok and 3 s for warn or error, unless a new recording starts. The start cue plays on mic-ready. | Silent audio, an empty transcript, an AI failure and a paste failure all show a message in the pill. Success shows "Inserted" and the latency. A new press during the linger is unaffected. |
| 1.2 One LLM call | The auto-transform instruction is folded into the cleanup prompt, with a relaxed output guard in that case. A whole-dictation snippet skips the LLM. Timeouts: 10 s for cleanup, 30 s for commands and summaries. | The e2e "AI cleanup + auto transform" scenario passes with one request (the stand-in counts them). A snippet trigger makes no LLM request. |
| 1.5 Reliability | Paste-last falls back to the in-memory last text, so it works in privacy mode. Hands-free shows an elapsed timer and auto-stops after 2 min of silence or at 30 min (the recording is processed, not discarded). | Unit tests for the auto-stop decision. In privacy mode the paste-last e2e passes. |
| 1.9 Meeting kind | A `notes.kind` column, backfilled from the "Meeting" title prefix. `list_notes` takes a `kind` filter. | A note titled "Meeting prep" stays in Notes. Meetings no longer appear in the Notes list. |

**Checkpoint 1:** cargo tests, all 10 e2e scenarios plus the new ones, UI e2e.

## Phase 2: context and prompt refinement

| Item | Change | Acceptance |
|---|---|---|
| 1.3 App rules | `Settings.appCategories` (an app or title needle mapped to a category) is checked first. Built-in rules use word boundaries. A new `ai` style category: `ai_prompts` maps to it, and its tone defaults to the user's "other" tone. Style shows an AI prompts tab and an Apps list built from history. | Unit tests: "password manager" is not "documents"; an override wins; an `ai` tone that hasn't been set yet follows "other". |
| 1.4 Agent terminals | A terminal whose title names an AI CLI (`claude`, `codex`, `aider`, `gemini`…) is categorised as `ai_prompts` and allows the auto action. Paste still uses terminal paste. A plain shell is unchanged. | Unit test for classification. An e2e terminal titled "claude" gets prompt cleanup. |
| 2.1 Prompt mode | A cleanup-prompt branch for the AI-prompts category (backticks for identifiers, spoken symbols, never answering), with `promptStyle: clean \| structured`. | A unit test on the prompt content. The e2e stand-in sees the prompt-mode rules. |
| 2.7 Style notes | `Settings.styleNotes` per category, appended to the cleanup prompt and capped at 300 characters. | A unit test. |

**Checkpoint 2.**

## Phase 3: voice actions and context workflows

| Item | Change | Acceptance |
|---|---|---|
| 3.2 Actions with an output | `transforms.output`: `replace` (the default, as today) or `copy`. New built-ins *Reply* (copy: select a message, say "reply saying Thursday works", paste the draft wherever you reply) and *Summarize* (copy), seeded once for existing databases. Empty or oversized command output is rejected instead of replacing the selection. | E2E: the command shortcut on a selection with a `copy` action leaves the target unchanged and puts the result on the clipboard. Replace still works. |
| 2.3 Snippet variables | `{date}`, `{time}`, `{weekday}` and `{clipboard}` in expansions. Unknown braces are kept. | Unit tests. |
| 2.5 Meeting templates and follow-up | Built-in templates (General, Sales call, Interview, 1:1, Standup) are picked before recording. A "Draft follow-up email" button on a meeting runs an LLM call and shows the result with Copy. | A unit test on template prompts. UI e2e for the template picker. |

**Checkpoint 3.**

## Phase 4: navigation and History

| Item | Change | Acceptance |
|---|---|---|
| 1.7 IA | Nine nav items become six: Home, Notes (Notes, Meetings), Library (Dictionary, Snippets, Actions), Style, Insights, Settings. AI provider setup moves to Settings → AI with a Test button (`test_llm`). | Design check and UI e2e updated and passing. Every old page is still reachable. |
| 1.6 History | Original vs polished, Insert again, Polish again (`repolish_history`), Load more. | UI e2e. |
| 1.10 Tray | Copy last transcript, an AI polish toggle, Start/stop meeting recording. | Manual check plus code review; there's no tray in Xvfb tests. |

**Checkpoint 4:** full regression run and a final diff review.

## Deferred (with reasons)

- **2.4 Selection as context while dictating.** In most apps, selecting the message you're replying
  to moves focus out of the reply box (Gmail, browsers). In VS Code, Ctrl+C with nothing selected
  copies the whole line. So "select, then dictate the reply" would paste into the wrong place. The
  *Reply* action (command mode, copy output) covers this workflow reliably.

- **2.2 Review card.** It needs global Enter and key grabs plus overlay resizing. Ship the outcome
  feedback first and measure discard rates.
- **2.6 Me/Them speaker split.** Doubles STT cost and needs echo handling. It's next after the
  meeting templates.
- **3.1 Repository index.** Large. It builds on the AI-prompts category added here.
- **3.4 Team library, 3.5 local LLM.** These are product decisions, not polish.
- **Command-mode selection copied in parallel with transcription.** Rejected: on release the
  hotkey's modifiers can still be held, so a synthetic Ctrl+C would arrive as Ctrl+Alt+C.

## Results

All measured in this repository's CI-like environment (Xvfb, PulseAudio virtual mic, Moonshine Tiny
on 4 vCPUs). The original code was built from the previous `HEAD` in a separate worktree and run
the same way.

| Check | Before | After |
|---|---|---|
| Rust unit/integration tests | 44 pass | 53 pass |
| E2E scenarios (real hotkeys, mic, insertion) | 10/10 | 17/17 (the 10 originals unchanged) |
| UI e2e (WebDriver, real app) | 8/8 | 12/12 |
| Design check (light and dark) | (not re-run) | 187/187 |

Latency, release → text inserted (the app's own timing log, 5 runs each; the LLM stand-in adds
300 ms per request to emulate a network round trip):

| Dictation | Before | After |
|---|---|---|
| AI polish + auto action | 928 ms mean, 2 LLM requests | **638 ms mean, 1 LLM request (−31%)** |
| AI polish | 666 ms, 1 request | 648 ms, 1 request |
| No AI (8 interleaved runs) | 324 ms | 265 ms (same stage times; the variance is in transcription) |
| Whole-snippet dictation with AI on | 1 LLM request | 0 requests |

The original binary fails the new "paste last with history off" scenario (it reports "Nothing
dictated yet"); the new one passes.

