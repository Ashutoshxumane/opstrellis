#!/usr/bin/env bash
# End-to-end: real app binary, real global hotkey (XTest key events), real audio through a virtual
# microphone, real local model; asserts the text lands in another app's text field.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${OPSTRELLIS_BIN:-$HERE/../src-tauri/target/debug/opstrellis}
WAV=${1:-$HERE/../src-tauri/resources/sample.wav}
EXPECT=${2:-voice into text}
MODE=${MODE:-hold}            # hold | tap | cancel | command (hold the command shortcut)
source "$HERE/env.sh"

export XDG_DATA_HOME=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d)
DATA="$XDG_DATA_HOME/app.opstrellis.desktop"; mkdir -p "$DATA"
if [ -n "${SETTINGS_JSON:-}" ]; then
  printf '%s' "$SETTINGS_JSON" > "$DATA/settings.json"
else
  cat > "$DATA/settings.json" <<JSON
{ "onboarded": true, "overlay": true, "language": "en",
  "sttChain": [ { "id": "local", "provider": "local", "model": "moonshine-tiny-en", "streaming": false, "enabled": true } ],
  "styles": { "personal": "casual", "work": "casual", "email": "formal", "other": "formal" } }
JSON
fi
# No Secret Service in the headless session: the app uses its 0600 file fallback.
[ -n "${SECRETS_JSON:-}" ] && printf '%s' "$SECRETS_JSON" > "$DATA/secrets.json"
export OPSTRELLIS_MODELS_DIR=${OPSTRELLIS_MODELS_DIR:-/tmp/opstrellis-models}
OUT=$(mktemp); LOG=$(mktemp)
TARGET_NAME="E2E Target Editor"
if [ "${TARGET:-editor}" = terminal ]; then
  # A real terminal emulator (pastes with Ctrl+Shift+V); cat in non-canonical mode mirrors input to $OUT.
  TARGET_NAME=${TERM_TITLE:-E2E Terminal}   # e.g. "✳ Claude Code" for an AI agent
  lxterminal -t "$TARGET_NAME" -e "bash -c 'stty -icanon -echo; cat > $OUT'" & TARGET=$!
else
  ${PYTHON_TK:-python3.12} "$HERE/target_app.py" "$OUT" & TARGET=$!
fi
"$BIN" --background >"$LOG" 2>&1 & APP=$!
# A failed step must not leave the hotkey held down for the next test.
trap 'xdotool keyup ctrl alt shift space 2>/dev/null; kill $APP $TARGET 2>/dev/null; wait $APP 2>/dev/null || true' EXIT
[ -n "${KEEP_LOG:-}" ] && ln -sf "$LOG" "$KEEP_LOG"
sleep 4
# A cold start of the debug binary can take longer than the fixed wait; a key pressed before the
# shortcuts are registered is ignored (logged "-> None"), so wait for them.
for _ in $(seq 1 200); do grep -q 'shortcuts registered' "$LOG" && break; kill -0 "$APP" 2>/dev/null || break; sleep 0.1; done
[ -n "${SETUP_PY:-}" ] && python3 -c "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); $SETUP_PY; db.commit()" "$DATA/opstrellis.db"
xdotool search --name "$TARGET_NAME" | head -1 | xargs -I{} xdotool windowactivate --sync {} windowfocus --sync {}
sleep 0.5
[ -n "${BEFORE_HOOK:-}" ] && eval "$BEFORE_HOOK"
DUR=$(python3 -c "import wave,sys; w=wave.open(sys.argv[1]); print(w.getnframes()/w.getframerate())" "$WAV")
T0=$(date +%s.%N)
# Drive speech at the same readiness cue a user sees/hears. A fixed 300 ms delay clips the test
# audio while the virtual microphone opens under load, especially for the 1.6 s snippet fixture.
wait_mic() {
  for _ in $(seq 1 120); do
    grep -q 'microphone opened in' "$LOG" && return
    kill -0 "$APP" 2>/dev/null || return 1
    sleep 0.05
  done
  echo "FAIL (microphone did not become ready)"; tail -20 "$LOG"; return 1
}
if [ "$MODE" = cancel ]; then
  xdotool key ctrl+shift+space
  wait_mic; paplay --device=vmic "$WAV"
  xdotool key Escape
  sleep 2
elif [ "$MODE" = command ]; then
  xdotool keydown ctrl+alt+space
  wait_mic; paplay --device=vmic "$WAV"; sleep 0.4
  xdotool keyup space keyup alt keyup ctrl
elif [ "$MODE" = tap ]; then
  xdotool key ctrl+shift+space             # tap -> hands-free
  wait_mic; paplay --device=vmic "$WAV"; sleep 0.4
  xdotool key ctrl+shift+space             # tap again -> stop
else
  xdotool keydown ctrl+shift+space
  wait_mic; paplay --device=vmic "$WAV"; sleep 0.4
  xdotool keyup space keyup shift keyup ctrl
fi
REL=$(date +%s.%N)
# Runs right after the key is released, while the dictation is processing.
[ -n "${RELEASE_HOOK:-}" ] && eval "$RELEASE_HOOK"
for i in $(seq 1 100); do
  # WAIT_FOR: a pattern to wait for, when the target already holds text (command mode).
  if [ -n "${WAIT_FOR:-}" ]; then grep -q "$WAIT_FOR" "$OUT" && break; elif [ -s "$OUT" ]; then break; fi
  sleep 0.05
done
DONE=$(date +%s.%N)
[ -n "${AFTER_HOOK:-}" ] && { sleep 0.5; eval "$AFTER_HOOK"; sleep 1.5; }
TEXT=$(cat "$OUT")
echo "audio: ${DUR}s  inserted: \"$TEXT\""
python3 -c "print(f'release->text observed: {($DONE-$REL)*1000:.0f} ms')"
grep -E "dictation done|ERROR|error" "$LOG" | tail -3 || true
sleep "${LINGER:-0}"   # let background work (e.g. usage sync) finish before the app is stopped
# Extra assertion (e.g. on the clipboard or the LLM request log); runs with $OUT and $LOG set.
if [ -n "${CHECK:-}" ] && ! eval "$CHECK"; then echo "FAIL (check: $CHECK)"; tail -30 "$LOG"; exit 1; fi
if [ "$EXPECT" = "<empty>" ]; then
  if [ -z "$TEXT" ]; then echo PASS; exit 0; else echo FAIL; exit 1; fi
fi
if echo "$TEXT" | tr 'A-Z' 'a-z' | grep -q "$(echo "$EXPECT" | tr 'A-Z' 'a-z')"; then echo PASS; else echo FAIL; tail -30 "$LOG"; exit 1; fi
