import { useEffect, useState } from "react";
import { api, type AppUse, type Category, type Settings, type Tone, type Transform } from "../api";
import { Icon } from "../icons";
import { CATEGORY_LABELS, Page, Row, Section, Toggle, type SettingsProps } from "../ui";

const TABS: { id: Category; label: string; desc: string }[] = [
  { id: "personal", label: "Personal", desc: "Messengers like Signal, WhatsApp, Telegram" },
  { id: "work", label: "Work", desc: "Slack, Teams, Discord, Mattermost" },
  { id: "email", label: "Email", desc: "Gmail, Outlook, Thunderbird, Mail" },
  { id: "ai", label: "AI prompts", desc: "ChatGPT, Claude, Cursor, and AI agents in a terminal such as Claude Code, Codex or Aider" },
  { id: "other", label: "Other", desc: "Everything else: docs, editors, browsers" },
];
const TONES: { id: Tone; label: string; hint: string }[] = [
  { id: "formal", label: "Formal", hint: "Caps + full punctuation" },
  { id: "casual", label: "Casual", hint: "Caps + light punctuation" },
  { id: "very_casual", label: "Very casual", hint: "lowercase, minimal punctuation" },
  { id: "excited", label: "Excited", hint: "More exclamations!" },
];
const EXAMPLES: Record<Category, Record<Tone, string>> = {
  personal: {
    formal: "Hey, are you free for dinner tonight? Let me know.",
    casual: "Hey are you free for dinner tonight? Let me know",
    very_casual: "hey are you free for dinner tonight lmk",
    excited: "Hey, are you free for dinner tonight?! Let me know!",
  },
  work: {
    formal: "I've pushed the fix. Could you review it when you have a moment?",
    casual: "Pushed the fix, could you review it when you get a sec",
    very_casual: "pushed the fix can u review when u get a sec",
    excited: "Pushed the fix! Could you review it when you have a moment?",
  },
  email: {
    formal: "Hi Sam,\nThank you for the update. I will review the proposal and reply by Friday.\nBest regards,",
    casual: "Hi Sam,\nThanks for the update. I'll look over the proposal and get back to you by Friday.\nCheers,",
    very_casual: "hey sam\nthanks for the update, will look over the proposal and get back to you by friday",
    excited: "Hi Sam,\nThanks so much for the update! I'll review the proposal and get back to you by Friday!\nCheers,",
  },
  ai: {
    formal: "Refactor parseDate to return the weekday name, and add a unit test for leap years.",
    casual: "Refactor parseDate to return the weekday name and add a unit test for leap years",
    very_casual: "refactor parseDate to return the weekday name and add a unit test for leap years",
    excited: "Refactor parseDate to return the weekday name, and add a unit test for leap years!",
  },
  other: {
    formal: "The meeting has been moved to Thursday at 3 p.m.",
    casual: "Meeting's moved to Thursday at 3pm",
    very_casual: "meeting moved to thursday 3pm",
    excited: "The meeting's moved to Thursday at 3pm!",
  },
};

export default function Style({ settings, set }: SettingsProps) {
  const [tab, setTab] = useState<Category>("personal");
  const current = TABS.find((t) => t.id === tab)!;
  const cleanup = (patch: Partial<Settings["cleanup"]>) => set("cleanup", { ...settings.cleanup, ...patch });

  return (
    <Page title="Style">
      <Section title="Tone" desc={<>OpsTrellis adapts formatting to the app you dictate into. {current.desc}.</>}
        aside={
          <div className="segmented" role="tablist" aria-label="Kind of app">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        }>
        <div className="tone-grid">
          {TONES.map((tone) => {
            const selected = settings.styles[tab] === tone.id;
            return (
              <button key={tone.id} className={"card tone-card" + (selected ? " selected" : "")} aria-pressed={selected}
                onClick={() => set("styles", { ...settings.styles, [tab]: tone.id })}>
                <span className="tone-head">
                  <span className="tone-name">{tone.label}</span>
                  <span className="tone-check">{selected && <Icon name="check" size={12} />}</span>
                </span>
                <span className="tone-hint">{tone.hint}</span>
                <span className="tone-example">{EXAMPLES[tab][tone.id]}</span>
              </button>
            );
          })}
        </div>
        {!settings.llm.enabled && <p className="note">Without AI polish, tones adjust capitalization and end punctuation only.</p>}
      </Section>

      <AppAi settings={settings} set={set} tab={tab} label={current.label} />

      <Apps settings={settings} set={set} />

      <Section title="Cleanup">
        <div className="card">
          <Row title="Remove filler words" desc="Drop “um”, “uh”, “erm” and “hmm”.">
            <Toggle checked={settings.cleanup.removeFillers} onChange={(v) => cleanup({ removeFillers: v })} />
          </Row>
          <Row title="Voice commands" desc="Say “new line”, “new paragraph”, “scratch that” or end with “press enter”.">
            <Toggle checked={settings.cleanup.voiceCommands} onChange={(v) => cleanup({ voiceCommands: v })} />
          </Row>
          <Row title="Auto-learn from corrections" desc="When you correct a dictation in History, misheard words are added to your Dictionary; other changes are learned once you make them twice. Like other entries, they're sent to your transcription and AI providers as hints and stay until you remove them.">
            <Toggle checked={settings.cleanup.autoLearn} onChange={(v) => cleanup({ autoLearn: v })} />
          </Row>
          <Row title="Tech terms" desc="Fix common mis-hearings of developer and workplace tools (“cube control” → kubectl, “post gress” → Postgres) and send the ones you say most to your transcription and AI providers as hints. How often you say each term is counted on this device.">
            <Toggle checked={settings.cleanup.techTerms} onChange={(v) => cleanup({ techTerms: v })} />
          </Row>
        </div>
      </Section>

      <Section title="AI polish">
        <div className="card">
          <Row title="Polish with AI" desc={<>Fix grammar, self-corrections and lists, and apply the style above. Provider, model and key are in Settings → AI.</>}>
            <Toggle checked={settings.llm.enabled} onChange={(v) => set("llm", { ...settings.llm, enabled: v })} label="AI polish" />
          </Row>
        </div>
      </Section>
    </Page>
  );
}

/** Per app category: what AI polish does there (auto action, prompt style, the user's notes). */
function AppAi({ settings, set, tab, label }: SettingsProps & { tab: Category; label: string }) {
  const [transforms, setTransforms] = useState<Transform[]>([]);
  useEffect(() => void api.listTransforms().then((ts) => setTransforms(ts.filter((t) => t.output === "replace")), () => {}), []);
  const current = settings.autoTransforms[tab];
  const ai = settings.llm.enabled;
  const choose = (value: string) => {
    const next = { ...settings.autoTransforms };
    if (value) next[tab] = Number(value);
    else delete next[tab];
    set("autoTransforms", next);
  };
  const setNotes = (v: string) => set("styleNotes", { ...settings.styleNotes, [tab]: v });
  return (
    <Section title={`AI in ${label.toLowerCase()} apps`}
      desc={ai ? "Applied by AI polish, in the same request as the cleanup." : "Turn on AI polish below to use these."}>
      <div className="card">
        <Row title="Auto action" desc={`Rewrite every dictation here with an action from Library → Actions before it's inserted.${tab === "other" ? " Never in a plain terminal." : ""}`}>
          <select value={current ?? ""} disabled={!ai} aria-label={`Auto action for ${label}`} onChange={(e) => choose(e.target.value)}>
            <option value="">Off</option>
            {transforms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Row>
        {tab === "ai" && (
          <Row title="Prompt style" desc="Clean tidies your words and formats code names. Structured also adds light headings (Goal, Context, Constraints) to long prompts.">
            <div className="segmented" role="radiogroup" aria-label="Prompt style">
              {(["clean", "structured"] as const).map((v) => (
                <button key={v} role="radio" aria-checked={settings.promptStyle === v} className={settings.promptStyle === v ? "active" : ""}
                  disabled={!ai} onClick={() => set("promptStyle", v)}>{v === "clean" ? "Clean" : "Structured"}</button>
              ))}
            </div>
          </Row>
        )}
        <label className="field notes-field">
          <span>How you write here <em>optional, up to 300 characters</em></span>
          <textarea rows={2} maxLength={300} disabled={!ai} value={settings.styleNotes[tab] ?? ""} onChange={(e) => setNotes(e.target.value)}
            placeholder={NOTE_HINTS[tab]} />
        </label>
      </div>
    </Section>
  );
}

const NOTE_HINTS: Record<Category, string> = {
  personal: "e.g. Keep it short, no emoji.",
  work: "e.g. British spelling. No exclamation marks.",
  email: "e.g. Sign off with “Best, Alex”. Use “we” for the company.",
  ai: "e.g. I work in TypeScript and React; keep library names exact.",
  other: "e.g. Use the Oxford comma.",
};

const CATEGORY_CHOICES = Object.keys(CATEGORY_LABELS);

/** Which kind of app each app is (it picks the tone and AI behaviour), with the user's corrections. */
function Apps({ settings, set }: SettingsProps) {
  const [apps, setApps] = useState<AppUse[]>([]);
  const [needle, setNeedle] = useState("");
  const [cat, setCat] = useState("work_messages");
  useEffect(() => void api.listApps().then(setApps, () => {}), []);
  const rules = settings.appCategories;
  const key = (name: string) => name.trim().toLowerCase();
  const assign = (name: string, category: string) => {
    const next = { ...rules };
    if (category) next[key(name)] = category;
    else delete next[key(name)];
    set("appCategories", next);
  };
  // Rules for apps not (or no longer) in history stay visible so they can be removed.
  const extra = Object.keys(rules).filter((k) => !apps.some((a) => key(a.appName) === k));
  const add = () => { if (needle.trim()) { assign(needle, cat); setNeedle(""); } };

  return (
    <Section title="Apps" desc="OpsTrellis guesses the kind of app from its name and window title. Correct it here; your choice wins.">
      <div className="card list">
        {apps.map((a) => (
          <div key={a.appName} className="list-row app-row">
            <div className="li-main">
              <div className="li-title">{a.appName}</div>
              <div className="li-meta">{a.count} {a.count === 1 ? "dictation" : "dictations"}</div>
            </div>
            <select value={rules[key(a.appName)] ?? ""} aria-label={`Kind of app for ${a.appName}`} onChange={(e) => assign(a.appName, e.target.value)}>
              <option value="">Auto ({CATEGORY_LABELS[a.category] ?? "Other"})</option>
              {CATEGORY_CHOICES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
        ))}
        {extra.map((k) => (
          <div key={k} className="list-row app-row">
            <div className="li-main">
              <div className="li-title">{k}</div>
              <div className="li-meta">Your rule: app name or window title contains this</div>
            </div>
            <select value={rules[k]} aria-label={`Kind of app for ${k}`} onChange={(e) => assign(k, e.target.value)}>
              <option value="">Remove rule</option>
              {CATEGORY_CHOICES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
        ))}
        <div className="list-row app-row">
          <input className="grow" value={needle} placeholder="App name or window title text, e.g. HubSpot" aria-label="App name or window title"
            onChange={(e) => setNeedle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <select value={cat} aria-label="Kind of app" onChange={(e) => setCat(e.target.value)}>
            {CATEGORY_CHOICES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
          <button className="btn" onClick={add} disabled={!needle.trim()}>Add</button>
        </div>
      </div>
    </Section>
  );
}
