import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  api, errMsg, useEvent, type CloudStatus, type LocalModel, type Permissions, type PolishModel, type ProviderKind, type Settings, type SttEntry,
} from "../api";
import { Icon } from "../icons";
import { IS_MAC, Keys, isSingleKey, Modal, Page, Progress, Row, Section, Toggle, comboText, useModelDownloads, type SettingsProps } from "../ui";

export const PROVIDERS: Record<ProviderKind, string> = {
  local: "Local model (offline)", openai: "OpenAI-compatible", deepgram: "Deepgram", assemblyai: "AssemblyAI",
  google: "Google Cloud", azure: "Azure Speech", elevenlabs: "ElevenLabs", cloud: "OpsTrellis Cloud",
};
export const MODELS: Record<Exclude<ProviderKind, "local">, string[]> = {
  openai: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
  deepgram: ["nova-3", "nova-2"],
  assemblyai: ["universal-streaming", "best", "nano"],
  google: ["latest_long", "latest_short"],
  azure: ["default"],
  elevenlabs: ["scribe_v1"],
  cloud: ["auto", "deepgram/nova-3", "groq/whisper-large-v3-turbo", "local/moonshine-base"],
};
const STREAMING: ProviderKind[] = ["local", "openai", "deepgram", "assemblyai", "cloud"];
const LANGUAGES: [string, string][] = [
  ["auto", "Detect automatically"], ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["tr", "Turkish"], ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["ar", "Arabic"],
  ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
];
const GROUPS: [string, string[]][] = [
  ["Dictation", ["Shortcuts", "Voice input", "Text insertion", "Permissions"]],
  ["Speech & AI", ["Transcription", "Local models", "AI polish"]],
  ["App", ["General", "Privacy", "Account", "About"]],
];
const SECTIONS = GROUPS.flatMap(([, sections]) => sections);

type Props = SettingsProps & { saveError: string | null; saveNow: () => Promise<void> };

export default function SettingsPage(props: Props) {
  const { settings, set } = props;
  const [models, setModels] = useState<LocalModel[]>([]);
  const loadModels = () => api.listLocalModels().then(setModels, () => {});
  useEffect(() => void loadModels(), []);
  const current = useScrollSpy();

  return (
    <Page title="Settings" className="settings-page">
      <div className="settings">
        <nav className="subnav" aria-label="Settings sections">
          {GROUPS.map(([group, sections]) => (
            <div key={group} className="subnav-group">
              <div className="subnav-label">{group}</div>
              {sections.map((s) => (
                <button key={s} className={current === anchor(s) ? "active" : ""} aria-current={current === anchor(s) ? "true" : undefined}
                  onClick={() => document.getElementById(anchor(s))?.scrollIntoView({ behavior: "smooth" })}>{s}</button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-body">
          <SettingsSection title="Shortcuts">
            <Shortcuts {...props} />
            {props.saveError && <div className="error">{props.saveError}</div>}
          </SettingsSection>

          <SettingsSection title="Voice input">
            <Microphone {...props} />
            <Row title="Spoken language" desc="Setting it explicitly is faster and more accurate than detection.">
              <select value={settings.language} onChange={(e) => set("language", e.target.value)}>
                {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </Row>
          </SettingsSection>

          <SettingsSection title="Text insertion">
            <Row title="Insert text by" desc="Pasting is instant. Typing works in apps that block paste.">
              <select value={settings.insertion.method}
                onChange={(e) => set("insertion", { ...settings.insertion, method: e.target.value as "paste" | "type" })}>
                <option value="paste">Pasting</option>
                <option value="type">Typing</option>
              </select>
            </Row>
            <Row title="Restore clipboard" desc="Put back what was on your clipboard after pasting.">
              <Toggle checked={settings.insertion.restoreClipboard} onChange={(v) => set("insertion", { ...settings.insertion, restoreClipboard: v })} />
            </Row>
            <Row title="Paste delay" desc="Increase if text sometimes doesn't appear.">
              <div className="inline">
                <input type="number" min={0} max={2000} step={10} className="num" value={settings.insertion.pasteDelayMs}
                  onChange={(e) => set("insertion", { ...settings.insertion, pasteDelayMs: Math.min(2000, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
                <span className="meta">ms</span>
              </div>
            </Row>
          </SettingsSection>

          <SettingsSection title="Permissions"><PermissionsInfo shortcuts={settings.hotkeys.dictate + " " + settings.hotkeys.command} /></SettingsSection>

          <SettingsSection title="Transcription" desc="OpsTrellis uses the first enabled provider. If it fails, the next one takes over.">
            <Providers {...props} localIds={models.filter((m) => m.installed).map((m) => m.id)} />
          </SettingsSection>

          <SettingsSection title="Local models" desc="Run speech recognition on this computer. Nothing leaves your device.">
            <LocalModels models={models} reload={loadModels} />
          </SettingsSection>

          <SettingsSection title="AI polish" desc="AI polish cleans up dictations, runs transforms and command mode, and summarizes meetings.">
            <LlmSection settings={settings} set={set} saveNow={props.saveNow} />
          </SettingsSection>

          <SettingsSection title="General">
            <Row title="Appearance">
              <div className="segmented" role="radiogroup" aria-label="Appearance">
                {(["system", "light", "dark"] as const).map((t) => (
                  <button key={t} role="radio" aria-checked={settings.theme === t} className={settings.theme === t ? "active" : ""}
                    onClick={() => set("theme", t)}>{t[0].toUpperCase() + t.slice(1)}</button>
                ))}
              </div>
            </Row>
            <Row title="Show recording pill" desc="A small indicator at the bottom of the screen while you talk.">
              <Toggle checked={settings.overlay} onChange={(v) => set("overlay", v)} />
            </Row>
            <Row title="Sounds" desc="Play a soft sound when recording starts and stops.">
              <Toggle checked={settings.sounds} onChange={(v) => set("sounds", v)} />
            </Row>
            <Row title="Launch at login">
              <Toggle checked={settings.launchAtLogin} onChange={(v) => set("launchAtLogin", v)} />
            </Row>
            <Row title={IS_MAC ? "Show in Dock" : "Show in dock and taskbar"}
              desc={IS_MAC
                ? "Off: OpsTrellis stays in the menu bar only and keeps running in the background. Open it from the menu bar icon."
                : "Off: OpsTrellis stays in the system tray only and keeps running in the background. Some Wayland desktops still show it in the dock."}>
              <Toggle checked={settings.showInDock} onChange={(v) => set("showInDock", v)} label={IS_MAC ? "Show in Dock" : "Show in dock and taskbar"} />
            </Row>
          </SettingsSection>

          <SettingsSection title="Privacy"><Privacy {...props} /></SettingsSection>
          <SettingsSection title="Account"><Account {...props} /></SettingsSection>

          <SettingsSection title="About"><About /></SettingsSection>
        </div>
      </div>
    </Page>
  );
}

const anchor = (title: string) => "s-" + title.toLowerCase().replace(/\s+/g, "-");

/** The id of the section nearest the top of the scrolling panel, for highlighting the section nav. */
function useScrollSpy() {
  const [current, setCurrent] = useState(anchor(SECTIONS[0]));
  const frame = useRef(0);
  useEffect(() => {
    const panel = document.querySelector(".panel");
    if (!panel) return;
    const update = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const top = panel.getBoundingClientRect().top + 120;
        const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 4;
        let id = anchor(SECTIONS[0]);
        for (const s of SECTIONS) {
          const el = document.getElementById(anchor(s));
          if (el && (el.getBoundingClientRect().top <= top || atEnd)) id = anchor(s);
        }
        setCurrent(id);
      });
    };
    panel.addEventListener("scroll", update, { passive: true });
    return () => { panel.removeEventListener("scroll", update); cancelAnimationFrame(frame.current); };
  }, []);
  return current;
}

function SettingsSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return <Section id={anchor(title)} title={title} desc={desc}><div className="card">{children}</div></Section>;
}

// ---------- AI ----------

const LLM_DEFAULTS: Record<Settings["llm"]["provider"], string> = {
  openai: "gpt-4o-mini", anthropic: "claude-haiku-4-5", cloud: "auto", local: "s1-mini",
};

/** AI polish on/off, provider, model, key, and a test request. */
export function LlmSection({ settings, set, saveNow }: SettingsProps & { saveNow: () => Promise<void> }) {
  const llm = settings.llm;
  const update = (patch: Partial<Settings["llm"]>) => set("llm", { ...llm, ...patch });
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<{ busy?: boolean; ok?: string; error?: string }>({});
  useEffect(() => void api.hasSecrets().then((s) => setHasKey(s.includes("llm")), () => {}), []);

  async function saveKey() {
    try {
      await api.setSecret("llm", key.trim());
      setKey(""); setHasKey(true); setMsg(null);
    } catch (e) { setMsg(errMsg(e)); }
  }
  async function runTest() {
    setTest({ busy: true });
    try {
      await saveNow(); // test what's on screen, not the last debounced save
      const r = await api.testLlm();
      setTest({ ok: `“${r.text}” in ${r.latencyMs} ms` });
    } catch (e) { setTest({ error: errMsg(e) }); }
  }

  return (
    <>
      <Row title="AI polish" desc={"Fix grammar, handle self-corrections, format lists and apply your style. " +
        (llm.provider === "local" ? "Runs on this device: nothing leaves your computer." : "Dictated text is sent to the provider below.")}>
        <Toggle checked={llm.enabled} onChange={(v) => update({ enabled: v })} label="AI polish" />
      </Row>
      {llm.enabled && (
        <div className="form-grid">
          <label className="field">
            <span>Provider</span>
            <select value={llm.provider} onChange={(e) => {
              const provider = e.target.value as Settings["llm"]["provider"];
              update({ provider, model: LLM_DEFAULTS[provider], baseUrl: null });
              setTest({});
              // The saved key belongs to the previous provider; never send it to the new one.
              if (hasKey) api.deleteSecret("llm").then(() => setHasKey(false), (err) => setMsg(errMsg(err)));
            }}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="cloud">OpsTrellis Cloud</option>
              <option value="local">On this device (S1-mini, offline)</option>
            </select>
          </label>
          {llm.provider !== "local" && (
            <label className="field">
              <span>Model</span>
              <input value={llm.model} onChange={(e) => update({ model: e.target.value })} />
            </label>
          )}
          {llm.provider === "local" && <LocalPolish />}
          {llm.provider === "openai" && (
            <label className="field span2">
              <span>Base URL <em>optional: Groq, OpenRouter, Ollama, LM Studio…</em></span>
              <input value={llm.baseUrl ?? ""} placeholder="https://api.openai.com/v1"
                onChange={(e) => update({ baseUrl: e.target.value || null })} />
            </label>
          )}
          {llm.provider !== "cloud" && llm.provider !== "local" && (
            <label className="field span2">
              <span>API key {hasKey && <em className="ok">saved</em>}</span>
              <div className="inline">
                <input type="password" value={key} placeholder={hasKey ? "••••••••  (enter to replace)" : "Paste your API key"}
                  onChange={(e) => setKey(e.target.value)} />
                <button className="btn" onClick={saveKey} disabled={!key.trim()}>Save key</button>
              </div>
              {msg && <div className="error">{msg}</div>}
            </label>
          )}
          {llm.provider === "cloud" && <p className="meta span2">Uses your OpsTrellis Cloud account. Sign in under Account.</p>}
          <div className="span2 inline test-row">
            <button className="btn" onClick={runTest} disabled={test.busy}>{test.busy ? "Testing…" : "Test"}</button>
            {test.ok && <span className="ok"><Icon name="check" />{test.ok}</span>}
            {test.error && <span className="error">{test.error}</span>}
          </div>
        </div>
      )}
    </>
  );
}

/** The on-device polish model: download, progress, delete, and what it does and doesn't do. */
function LocalPolish() {
  const [model, setModel] = useState<PolishModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.polishModelStatus().then(setModel, (e) => setError(errMsg(e)));
  useEffect(() => void load(), []);
  const progress = useModelDownloads((id) => id === "s1-mini" && load())["s1-mini"];
  const busy = (!!progress && !progress.error) || !!model?.downloading;
  // A retry hides the last attempt's error until the new attempt reports progress.
  const [retried, setRetried] = useState<typeof progress | undefined>(undefined);
  const failed = (progress !== retried ? progress?.error : null) ?? error;

  return (
    <div className="span2">
      <div className="row">
        <div className="row-text">
          <div className="row-title">S1-mini by Superwhisper <span className="meta">· English · {model?.sizeMb ?? 484} MB</span></div>
          <div className="row-desc">
            A small model trained only to clean up dictation: fillers, self-corrections (“at 2, sorry, 3” → “at 3”), grammar and lists.
            Uses about 1 GB of memory while selected. Code editors, terminals and other languages keep the rule-based text;
            actions, command mode and meeting summaries need one of the other providers.
          </div>
          {busy && progress && <Progress value={progress.total ? progress.downloaded / progress.total : 0} />}
        </div>
        <div className="row-control">
          {model?.installed ? (
            <>
              <span className="tag ok">Installed</span>
              <button className="icon-btn" title="Delete model"
                onClick={() => api.deletePolishModel().then(load, (e) => setError(errMsg(e)))}><Icon name="trash" /></button>
            </>
          ) : (
            <button className="btn primary" disabled={busy || !model}
              onClick={() => { setError(null); setRetried(progress); api.downloadPolishModel().catch((e) => setError(errMsg(e))); }}>
              {busy && progress ? `${Math.round((progress.downloaded / (progress.total || 1)) * 100)}%` : busy ? "Downloading…" : "Download"}
            </button>
          )}
        </div>
      </div>
      {model && !model.installed && !busy && <p className="meta">Until it's downloaded, dictation uses the rule-based cleanup.</p>}
      {failed && <div className="error">Download failed: {failed}. Check your connection and try again.</div>}
    </div>
  );
}

// ---------- Shortcuts ----------

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Turns a keydown into an accelerator like "Ctrl+Shift+Space"; null while only modifiers are held. */
function accelerator(e: KeyboardEvent): { mods: string[]; key: string | null } {
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  if (MODIFIER_CODES.test(e.code)) return { mods, key: null };
  const key = e.code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "");
  return { mods, key };
}

type Hotkeys = Settings["hotkeys"];
const SHORTCUT_NAMES: Record<keyof Hotkeys, string> = { dictate: "Dictate", command: "Command mode", pasteLast: "Paste last transcript" };

/** Dictate and command mode can also be a single key on macOS (🌐 fn, Right ⌥, …), one of them at a time. */
/** Always registered for dictation by the backend (`hotkeys::FALLBACK`) unless a shortcut above uses it. */
const FALLBACK = "Ctrl+Shift+Space";

function Shortcuts({ settings, set }: SettingsProps) {
  const hk = settings.hotkeys;
  const [taken, setTaken] = useState<string | null>(null);
  const update = (which: keyof Hotkeys, value: string) => {
    // Catch a clash here, where it can be named, instead of a rejected save.
    const other = (Object.keys(hk) as (keyof Hotkeys)[]).find((k) => k !== which && hk[k] === value);
    if (other) { setTaken(`${comboText(value)} is already the ${SHORTCUT_NAMES[other]} shortcut.`); return; }
    setTaken(null);
    set("hotkeys", { ...hk, [which]: value });
  };
  // Why a single key can't be used in a row (true: it can).
  const single = (other: keyof Hotkeys): true | string =>
    isSingleKey(hk[other]) ? `${SHORTCUT_NAMES[other]} already uses a single key; use a combination here` : true;
  const holdDesc = (base: string, value: string) =>
    isSingleKey(value) ? `${base} Double-tap for hands-free, press again to finish.` : `${base} Tap once for hands-free, tap again to finish.`;
  return (
    <>
      <Row title="Dictate" desc={holdDesc("Hold to talk.", hk.dictate)}>
        <HotkeyInput value={hk.dictate} onChange={(v) => update("dictate", v)} single={IS_MAC && single("command")} />
      </Row>
      <Row title="Command mode" desc={holdDesc("Select text, hold and say how to change it.", hk.command)}>
        <HotkeyInput value={hk.command} onChange={(v) => update("command", v)} single={IS_MAC && single("dictate")} />
      </Row>
      <Row title="Paste last transcript">
        <HotkeyInput value={hk.pasteLast} onChange={(v) => update("pasteLast", v)}
          single={IS_MAC && "Paste last needs a key combination"} />
      </Row>
      {!Object.values(hk).includes(FALLBACK) && (
        <Row title="Fallback dictation" desc="Always on, in case the dictate shortcut stops working. Press once to start, press again to finish.">
          <Keys combo={FALLBACK} />
        </Row>
      )}
      {taken && <div className="error">{taken}</div>}
    </>
  );
}

/**
 * Records a shortcut. Combinations come from the webview's key events. Single keys (🌐 fn, Right ⌥,
 * …) never reach the webview, so on macOS the backend captures them (`shortcut-captured`); it also
 * pauses the current shortcuts meanwhile, so pressing one records it instead of triggering it.
 * `single`: true if a single key may be the shortcut, or why not (false: not offered, Linux).
 */
function HotkeyInput({ value, onChange, single }: { value: string; onChange: (v: string) => void; single: boolean | string }) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    if (!recording) return;
    api.setShortcutRecording(true).catch(() => {});
    return () => void api.setShortcutRecording(false).catch(() => {});
  }, [recording]);

  useEvent("shortcut-captured", (key) => {
    if (!recording) return;
    if (single !== true) { if (single) setPreview(single); return; }
    onChange(key);
    setRecording(false);
  });

  function onKeyDown(e: KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { setRecording(false); return; }
    // WebKit reports 🌐 as a key; it's captured natively on release (`shortcut-captured`).
    if (e.code === "Fn" || e.key === "Fn") return;
    const { mods, key } = accelerator(e);
    if (!key) { setPreview(mods.length ? comboText(mods.join("+")) + (IS_MAC ? "…" : "+…") : ""); return; }
    if (mods.length === 0 && !/^F\d+$/.test(key)) { setPreview(single === true ? "Add a modifier, or press 🌐 fn" : "Add a modifier key"); return; }
    onChange([...mods, key].join("+"));
    setRecording(false);
  }

  return (
    <div className="inline">
      {single === true && value !== "Fn" && !recording && (
        <button type="button" className="btn ghost use-fn" onClick={() => onChange("Fn")} title="Use the Fn (🌐) key">Use 🌐 fn</button>
      )}
      <button type="button" className={"hotkey" + (recording ? " recording" : "")}
        title={recording
          ? (single === true ? "Press a key combination, or a single key like 🌐 fn or Right ⌥. Esc keeps the current one."
            : "Press a key combination. Esc keeps the current one.")
          : "Click to change"}
        onClick={() => { setRecording(!recording); setPreview(""); }} onKeyDown={onKeyDown} onBlur={() => setRecording(false)}>
        {recording ? preview || "Press keys…" : <Keys combo={value} />}
      </button>
    </div>
  );
}

// ---------- Microphone ----------

function Microphone({ settings, set }: SettingsProps) {
  const [devices, setDevices] = useState<string[]>([]);
  useEffect(() => void api.listInputDevices().then(setDevices, () => {}), []);
  const missing = settings.microphone && !devices.includes(settings.microphone);
  return (
    <Row title="Microphone">
      <select value={settings.microphone ?? ""} onChange={(e) => set("microphone", e.target.value || null)}>
        <option value="">System default</option>
        {missing && <option value={settings.microphone!}>{settings.microphone} (not connected)</option>}
        {devices.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </Row>
  );
}

// ---------- Transcription providers ----------

function Providers({ settings, set, saveNow, localIds }: Props & { localIds: string[] }) {
  const chain = settings.sttChain;
  const [secrets, setSecrets] = useState<string[]>([]);
  const loadSecrets = () => api.hasSecrets().then(setSecrets, () => {});
  useEffect(() => void loadSecrets(), []);

  const update = (id: string, patch: Partial<SttEntry>) => set("sttChain", chain.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const move = (i: number, d: number) => {
    const next = [...chain];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set("sttChain", next);
  };
  const remove = (id: string) => {
    set("sttChain", chain.filter((e) => e.id !== id));
    if (secrets.includes(`stt:${id}`)) api.deleteSecret(`stt:${id}`).then(loadSecrets, () => {});
  };
  const add = () => set("sttChain", [...chain, {
    id: crypto.randomUUID(), provider: "deepgram", model: "nova-3", baseUrl: null, region: null, streaming: true, enabled: true,
  }]);

  return (
    <>
      {chain.length === 0 && <div className="list-empty">No providers yet. Add one, or download a local model below.</div>}
      {chain.map((entry, i) => (
        <ProviderEntry key={entry.id} entry={entry} index={i} count={chain.length} localIds={localIds}
          hasKey={secrets.includes(`stt:${entry.id}`)} onKeySaved={loadSecrets} saveNow={saveNow}
          update={(p) => update(entry.id, p)} move={(d) => move(i, d)} remove={() => remove(entry.id)}
          primary={chain.findIndex((e) => e.enabled) === i} />
      ))}
      <div className="row"><button className="btn" onClick={add}><Icon name="plus" />Add provider</button></div>
    </>
  );
}

interface EntryProps {
  entry: SttEntry; index: number; count: number; primary: boolean; localIds: string[]; hasKey: boolean;
  update: (p: Partial<SttEntry>) => void; move: (d: number) => void; remove: () => void;
  onKeySaved: () => void; saveNow: () => Promise<void>;
}

function ProviderEntry({ entry, index, count, primary, localIds, hasKey, update, move, remove, onKeySaved, saveNow }: EntryProps) {
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ busy?: boolean; text?: string; latencyMs?: number; error?: string } | null>(null);
  const suggestions = entry.provider === "local" ? localIds : MODELS[entry.provider];
  const needsKey = entry.provider !== "local";

  async function saveKey() {
    try { await api.setSecret(`stt:${entry.id}`, key.trim()); setKey(""); onKeySaved(); }
    catch (e) { setTest({ error: errMsg(e) }); }
  }
  async function runTest() {
    setTest({ busy: true });
    try {
      await saveNow();
      const r = await api.testStt(entry.id);
      setTest(r);
    } catch (e) { setTest({ error: errMsg(e) }); }
  }

  return (
    <div className={"provider" + (entry.enabled ? "" : " disabled")}>
      <div className="provider-head">
        <span className="order">{index + 1}</span>
        <span className="strong">{PROVIDERS[entry.provider]}</span>
        <span className="tag">{!entry.enabled ? "Off" : primary ? "Primary" : "Fallback"}</span>
        <span className="grow" />
        <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => move(-1)}><Icon name="up" /></button>
        <button className="icon-btn" title="Move down" disabled={index === count - 1} onClick={() => move(1)}><Icon name="down" /></button>
        <button className="icon-btn" title="Remove" onClick={remove}><Icon name="trash" /></button>
        <Toggle checked={entry.enabled} onChange={(v) => update({ enabled: v })} label="Enabled" />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Provider</span>
          <select value={entry.provider} onChange={(e) => {
            const provider = e.target.value as ProviderKind;
            const model = provider === "local" ? localIds[0] ?? "moonshine-tiny-en" : MODELS[provider][0];
            update({ provider, model, streaming: STREAMING.includes(provider) && entry.streaming });
          }}>
            {Object.entries(PROVIDERS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <input list={`models-${entry.id}`} value={entry.model} onChange={(e) => update({ model: e.target.value })} />
          <datalist id={`models-${entry.id}`}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        {(entry.provider === "openai" || entry.provider === "cloud") && (
          <label className="field span2">
            <span>Base URL <em>{entry.provider === "openai" ? "optional: Groq, Fireworks, self-hosted…" : "optional: self-hosted gateway"}</em></span>
            <input value={entry.baseUrl ?? ""} placeholder={entry.provider === "openai" ? "https://api.openai.com/v1" : "Uses your OpsTrellis Cloud URL"}
              onChange={(e) => update({ baseUrl: e.target.value || null })} />
          </label>
        )}
        {entry.provider === "azure" && (
          <label className="field">
            <span>Region</span>
            <input value={entry.region ?? ""} placeholder="westeurope" onChange={(e) => update({ region: e.target.value || null })} />
          </label>
        )}
        {needsKey && (
          <label className="field span2">
            <span>API key {hasKey && <em className="ok">saved</em>}
              {entry.provider === "cloud" && !hasKey && <em>optional when signed in</em>}</span>
            <div className="inline">
              <input type="password" value={key} placeholder={hasKey ? "••••••••  (enter to replace)" : "Paste your API key"}
                onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key.trim() && saveKey()} />
              <button className="btn" onClick={saveKey} disabled={!key.trim()}>Save key</button>
            </div>
          </label>
        )}
      </div>
      <div className="provider-foot">
        {STREAMING.includes(entry.provider) ? (
          <label className="toggle-label">
            <Toggle checked={entry.streaming} onChange={(v) => update({ streaming: v })} label="Streaming" />Stream while speaking
          </label>
        ) : <span className="meta">Transcribes after you finish speaking</span>}
        <span className="grow" />
        {test && !test.busy && (test.error
          ? <span className="error inline-msg">{test.error}</span>
          : <span className="ok inline-msg"><Icon name="check" />“{test.text}” · {test.latencyMs} ms</span>)}
        <button className="btn" onClick={runTest} disabled={test?.busy}>{test?.busy ? "Testing…" : "Test"}</button>
      </div>
    </div>
  );
}

// ---------- Local models ----------

function LocalModels({ models, reload }: { models: LocalModel[]; reload: () => void }) {
  const progress = useModelDownloads(() => reload());
  const [error, setError] = useState<string | null>(null);
  const failed = models.map((m) => progress[m.id]).find((p) => p?.error);

  return (
    <>
      {models.map((m) => {
        const p = progress[m.id];
        return (
          <div key={m.id} className="row">
            <div className="row-text">
              <div className="row-title">{m.name} <span className="meta">· {m.languages} · {m.sizeMb} MB</span></div>
              <div className="row-desc">{m.description}</div>
              {p && !p.error && <Progress value={p.total ? p.downloaded / p.total : 0} />}
            </div>
            <div className="row-control">
              {m.installed ? (
                <>
                  <span className="tag ok">Installed</span>
                  <button className="icon-btn" title="Delete model"
                    onClick={() => api.deleteLocalModel(m.id).then(reload, (e) => setError(errMsg(e)))}><Icon name="trash" /></button>
                </>
              ) : (
                <button className="btn" disabled={(!!p && !p.error) || m.downloading}
                  onClick={() => api.downloadLocalModel(m.id).catch((e) => setError(errMsg(e)))}>
                  {p && !p.error ? `${Math.round((p.downloaded / (p.total || 1)) * 100)}%` : m.downloading ? "Downloading…" : "Download"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {models.length === 0 && <div className="list-empty">No local models available.</div>}
      {(error || failed) && <div className="error">{error ?? `Download failed: ${failed!.error}`}</div>}
    </>
  );
}

// ---------- Privacy ----------

function Privacy({ settings, set }: SettingsProps) {
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const r = settings.privacy.historyRetentionDays;
  const retention = r === null ? "forever" : String(r);

  return (
    <>
      <Row title="Keep history" desc={r === 0 ? "Privacy mode: dictations are not saved." : "Older dictations are deleted automatically."}>
        <select value={retention}
          onChange={(e) => set("privacy", { ...settings.privacy, historyRetentionDays: e.target.value === "forever" ? null : Number(e.target.value) })}>
          <option value="forever">Forever</option>
          <option value="30">30 days</option>
          <option value="7">7 days</option>
          <option value="0">Don't save</option>
        </select>
      </Row>
      <Row title="Sync usage stats" desc="Send word counts and durations (never text or audio) to your OpsTrellis Cloud account.">
        <Toggle checked={settings.privacy.syncUsage} onChange={(v) => set("privacy", { ...settings.privacy, syncUsage: v })} />
      </Row>
      <Row title="Clear history" desc={msg ?? "Permanently delete all saved dictations."}>
        <button className="btn danger" onClick={() => setConfirm(true)}>Clear all history</button>
      </Row>
      {confirm && (
        <Modal title="Clear all history?" onClose={() => setConfirm(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn danger solid" onClick={async () => {
              try { await api.clearHistory(); setMsg("History cleared."); } catch (e) { setMsg(errMsg(e)); }
              setConfirm(false);
            }}>Delete everything</button>
          </>}>
          This deletes every saved dictation on this computer. Your stats history is removed too. This can't be undone.
        </Modal>
      )}
    </>
  );
}

// ---------- Account ----------

function Account({ settings, set }: SettingsProps) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [login, setLogin] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.cloudStatus().then(setStatus, (e) => setError(errMsg(e))), []);
  useEvent("cloud-status", (s) => { setStatus(s); setLogin(null); }); // signed in, or the attempt ended

  async function signIn() {
    setError(null);
    try { setLogin(await api.cloudLogin()); } catch (e) { setError(errMsg(e)); }
  }
  async function signOut() {
    try { setStatus(await api.cloudLogout()); } catch (e) { setError(errMsg(e)); }
  }

  return (
    <>
      <Row title="OpsTrellis Cloud" desc={status?.signedIn
        ? <>Signed in as <b>{status.email}</b>{status.plan && <> · <span className="tag">{status.plan}</span></>}</>
        : "Optional. Use managed transcription without your own keys and sync your stats."}>
        {status?.signedIn
          ? <button className="btn" onClick={signOut}>Sign out</button>
          : <button className="btn primary" onClick={signIn}>Sign in</button>}
      </Row>
      {status?.signedIn && status.usage && typeof status.usage === "object" && (
        <div className="row usage">
          {Object.entries(status.usage).filter(([, v]) => typeof v !== "object").map(([k, v]) => (
            <div key={k}><div className="meta">{humanize(k)}</div><div className="strong">{String(v)}</div></div>
          ))}
        </div>
      )}
      {login && !status?.signedIn && (
        <div className="row device-code">
          <div>
            <div className="meta">We opened your browser. Confirm this code there:</div>
            <div className="code">{login.userCode}</div>
            <div className="meta">Browser didn't open? Go to <span className="mono">{login.verificationUrl}</span></div>
          </div>
          <span className="spinner" aria-label="Waiting for approval" />
        </div>
      )}
      <Row title="Server URL" desc="Change this only if you run your own OpsTrellis Cloud.">
        <input className="wide" value={settings.cloud.baseUrl} onChange={(e) => set("cloud", { ...settings.cloud, baseUrl: e.target.value })} />
      </Row>
      {error && <div className="error">{error}</div>}
    </>
  );
}

const humanize = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// ---------- About ----------

function About() {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.version().then(setVersion, () => {}), []);

  return (
    <>
      <Row title="Version"><span className="meta mono">{version ?? "…"}</span></Row>
      <Row title="Logs" desc={error ?? "Timings and errors for each dictation, without the dictated text."}>
        <button className="btn" onClick={() => api.openLogs().then(() => setError(null), (e) => setError(errMsg(e)))}>Show logs</button>
      </Row>
    </>
  );
}

// ---------- Permissions ----------

/** `shortcuts`: reloads when they change (choosing Fn needs Input Monitoring), after the settings save. */
export function PermissionsInfo({ shortcuts }: { shortcuts?: string }) {
  const [perm, setPerm] = useState<Permissions | null>(null);
  const load = () => api.permissions().then(setPerm, () => {});
  const first = useRef(true);
  useEffect(() => {
    // After a change, wait for the debounced save to re-register the shortcuts.
    const t = setTimeout(load, first.current ? 0 : 800);
    first.current = false;
    return () => clearTimeout(t);
  }, [shortcuts]);
  // Permissions are granted in System Settings; recheck on coming back.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  if (!perm) return null;

  return (
    <>
      {perm.platform === "macos" && (
        <Row title="Accessibility" desc="Needed to paste text into other apps and to read the selection in command mode.">
          {perm.accessibility
            ? <span className="tag ok">Granted</span>
            : <button className="btn primary" onClick={() => api.requestAccessibility().then(load)}>Grant access</button>}
        </Row>
      )}
      {perm.inputMonitoring !== null && (
        <Row title="Input Monitoring" desc="Needed for a single-key shortcut like 🌐 fn or Right ⌥ to work in every app.">
          {perm.inputMonitoring
            ? <span className="tag ok">Granted</span>
            : <button className="btn primary" onClick={() => api.requestInputMonitoring().then(load)}>Grant access</button>}
        </Row>
      )}
      {perm.fnSystemAction && (
        <Row title="🌐 key conflict"
          desc={`Pressing 🌐 fn also ${perm.fnSystemAction}, and OpsTrellis couldn't switch that off. In System Settings → Keyboard, set “Press 🌐 key to” to “Do Nothing”.`}>
          <button className="btn" onClick={load}>Check again</button>
        </Row>
      )}
      {perm.platform === "linux" && !perm.wayland && (
        <Row title="Global shortcuts" desc="Running on X11: shortcuts work out of the box."><span className="tag ok">Ready</span></Row>
      )}
      {perm.wayland && (
        <div className="row column">
          <div className="row-title">Wayland shortcuts</div>
          <div className="row-desc">
            Wayland doesn't let apps listen for global shortcuts. Add custom shortcuts in your desktop settings
            (GNOME: Settings → Keyboard → Custom Shortcuts; KDE: System Settings → Shortcuts) that run:
          </div>
          <table className="cmd-table">
            <tbody>
              <tr><td className="mono">opstrellis --toggle</td><td>Start or finish dictation</td></tr>
              <tr><td className="mono">opstrellis --cancel</td><td>Cancel the current recording</td></tr>
              <tr><td className="mono">opstrellis --command</td><td>Start command mode on the selection</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

