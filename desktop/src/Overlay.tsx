import { useEffect, useRef, useState } from "react";
import { api, useEvent, type DictationState, type Outcome } from "./api";
import { Icon } from "./icons";

const COLS = 20;
const ROWS = 5;
const empty = () => Array<number>(COLS).fill(0);
const IDLE: DictationState = { status: "idle", mode: "dictate", handsFree: false, stage: "", micReady: false };

export default function Overlay() {
  const [state, setState] = useState<DictationState>(IDLE);
  const [levels, setLevels] = useState(empty);
  const [partial, setPartial] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [slowMic, setSlowMic] = useState(false);
  const [since, setSince] = useState(0); // when hands-free recording started
  const [now, setNow] = useState(Date.now());

  // On macOS the pill is click-through (clicking would steal focus), so buttons are hidden.
  const [buttons, setButtons] = useState(true);
  const sounds = useRef(true);
  const prev = useRef<DictationState>(IDLE);
  useEffect(() => {
    api.permissions().then((p) => setButtons(p.platform !== "macos")).catch(() => {});
    api.getSettings().then((st) => { sounds.current = st.sounds; }).catch(() => {});
  }, []);

  useEvent("dictation-state", (s) => {
    const p = prev.current;
    if (s.status === "recording" && p.status === "idle") {
      setOutcome(null);
      api.getSettings().then((st) => { sounds.current = st.sounds; }).catch(() => {});
    }
    // The start cue plays once the mic delivers audio: speaking at the cue loses no words.
    if (s.status === "recording" && s.micReady && !(p.status === "recording" && p.micReady) && sounds.current) beep(880);
    if (s.status === "processing" && p.status !== "processing" && sounds.current) beep(520);
    if (s.handsFree && !p.handsFree) setSince(Date.now());
    prev.current = s;
    setState(s);
    if (s.status === "idle") { setLevels(empty()); setPartial(""); }
  });
  useEvent("dictation-outcome", setOutcome);
  useEvent("audio-level", (l) => setLevels((prev) => [...prev.slice(1), Math.max(0, Math.min(1, l))]));
  useEvent("partial-transcript", setPartial);

  // "Opening mic…" only when the mic is slow to start (Bluetooth), so fast mics don't flash it.
  const waiting = state.status === "recording" && !state.micReady;
  useEffect(() => {
    if (!waiting) { setSlowMic(false); return; }
    const t = setTimeout(() => setSlowMic(true), 400);
    return () => clearTimeout(t);
  }, [waiting]);
  const timing = state.status === "recording" && state.handsFree;
  useEffect(() => {
    if (!timing) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timing]);
  // The window is hidden by the backend after the outcome; drop it here too so it can't flash later.
  useEffect(() => {
    if (!outcome) return;
    const t = setTimeout(() => setOutcome(null), outcome.kind === "ok" ? 1200 : 3400);
    return () => clearTimeout(t);
  }, [outcome]);

  if (state.status === "idle") {
    if (!outcome) return null;
    return (
      <div className="overlay-wrap">
        <div className={"pill outcome " + outcome.kind} role="status" aria-live="polite">
          {outcome.kind === "ok" ? <span className="pill-icon"><Icon name="check" size={16} /></span> : <span className="pill-dot still" />}
          <span className="pill-status" title={outcome.message}>{outcome.message}</span>
        </div>
      </div>
    );
  }

  const processing = state.status === "processing";
  const stage = state.stage === "polishing" ? (state.mode === "command" ? "Rewriting…" : "Polishing…") : "Transcribing…";
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));

  return (
    <div className="overlay-wrap">
      <div className={"pill " + state.status + (state.handsFree ? " hands-free" : "")} role="status" aria-live="polite"
        aria-label={processing ? stage : state.micReady ? "Listening" : "Opening microphone"}>
        <span className={"pill-dot" + (waiting ? " hollow" : "")} />
        {state.mode === "command" && <span className="pill-badge">CMD</span>}
        {timing && <span className="pill-lock"><Icon name="lock" size={12} /><span className="pill-time">{fmtClock(elapsed)}</span></span>}
        {processing ? (
          <>
            <Lattice cols={8} sweep={state.stage === "polishing" ? "diagonal" : "column"} />
            <span className="pill-status">{stage}</span>
          </>
        ) : slowMic ? (
          <span className="pill-status">Opening mic…</span>
        ) : (
          <>
            <Lattice levels={partial ? levels.slice(-6) : levels} mini={!!partial} />
            {partial && <span className="pill-text"><span>{tail(partial, buttons ? 14 : 26)}</span></span>}
          </>
        )}
        {buttons && !processing && (
          <span className="pill-actions">
            <button className="pill-btn" onClick={() => api.cancelDictation()} aria-label="Cancel" title="Cancel">
              <Icon name="x" size={12} />
            </button>
            <button className="pill-btn" onClick={() => api.stopDictation()} aria-label="Stop" title="Stop">
              <Icon name="stop" size={12} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** The signature waveform: a dot lattice on the 4px grid. Live levels light dots outward from the
 * centre row; while processing, a column (transcribing) or diagonal (polishing) sweeps across. */
function Lattice({ levels, cols, mini, sweep }: { levels?: number[]; cols?: number; mini?: boolean; sweep?: "column" | "diagonal" }) {
  const columns = levels ?? Array<number>(cols ?? COLS).fill(0);
  return (
    <div className={"lattice" + (mini ? " mini" : "") + (sweep ? " sweep" : "")} aria-hidden="true">
      {columns.map((l, c) => {
        const reach = Math.round(l * ((ROWS - 1) / 2 + 0.49));
        return (
          <span key={c} className="lattice-col">
            {Array.from({ length: ROWS }, (_, r) => (
              <i key={r} className={!sweep && Math.abs(r - (ROWS - 1) / 2) <= reach && l > 0.02 ? "on" : undefined}
                style={sweep ? { animationDelay: `${(sweep === "diagonal" ? c + r : c) * 70}ms` } : undefined} />
            ))}
          </span>
        );
      })}
    </div>
  );
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The end of the live transcript, cut at a word boundary so the pill never shows half a word. */
function tail(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const space = cut.indexOf(" ");
  return "…" + (space >= 0 && space < cut.length - 1 ? cut.slice(space + 1) : cut);
}

let ctx: AudioContext | null = null;

/** Short, quiet start/stop cue. */
function beep(freq: number) {
  try {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  } catch {
    /* audio output unavailable */
  }
}
