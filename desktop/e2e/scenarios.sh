#!/usr/bin/env bash
# Desktop E2E scenarios on a headless X11 session. Each runs the real app binary.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=/tmp/probe/sherpa-onnx-moonshine-tiny-en-int8/test_wavs   # LibriSpeech samples
fails=0
run() {
  local name=$1; shift
  local out; out=$("$@" 2>&1)
  local line; line=$(echo "$out" | grep -E "inserted:" | head -1)
  if echo "$out" | grep -q '^PASS'; then echo "PASS  $name  $line"; else echo "FAIL  $name  $line"; echo "$out" | tail -15; fails=$((fails+1)); fi
}

run "push-to-talk (hold)"            "$HERE/dictate_test.sh" "$LIB/0.wav" "yellow lamps would light up"
ffmpeg -loglevel error -y -i "$LIB/0.wav" -t 1.6 -ar 16000 -ac 1 /tmp/opstrellis-short.wav
run "short hold (1.6 s) is push-to-talk" "$HERE/dictate_test.sh" /tmp/opstrellis-short.wav "nightfall"
run "hands-free (tap/tap), 17 s"     env MODE=tap "$HERE/dictate_test.sh" "$LIB/1.wav" "lovely child"
run "Esc cancels, nothing inserted"  env MODE=cancel "$HERE/dictate_test.sh" "$LIB/0.wav" "<empty>"
run "dictionary + snippet"           env SETUP_PY="db.execute(\"insert into dictionary(phrase,replacement,created_at) values('yellow lamps','LED lamps','x')\"); db.execute(\"insert into snippets(trigger,expansion,created_at) values('squalid quarter','old town (see https://example.com/map)','x')\")" \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "LED lamps would light up.*old town (see https://example.com/map)"
run "dictionary casing at sentence start" env SETUP_PY="db.execute(\"insert into dictionary(phrase,replacement,created_at) values('after early','iOS','x')\")" \
                                     CHECK='grep -q "^iOS nightfall" "$OUT"' "$HERE/dictate_test.sh" "$LIB/0.wav" "iOS nightfall"
run "terminal paste (Ctrl+Shift+V)"  env TARGET=terminal "$HERE/dictate_test.sh" "$LIB/0.wav" "yellow lamps"
run "fallback: dead cloud -> local"  env SETTINGS_JSON='{"onboarded":true,"language":"en","cloud":{"baseUrl":"http://127.0.0.1:9"},"sttChain":[{"id":"c","provider":"cloud","model":"auto","enabled":true},{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]}' \
                                     SECRETS_JSON='{"cloud":"utt_invalid"}' "$HERE/dictate_test.sh" "$LIB/0.wav" "yellow lamps"
run "paste last transcript"          env AFTER_HOOK="xdotool key ctrl+alt+v" "$HERE/dictate_test.sh" "$LIB/0.wav" "brothels.After early nightfall"
run "paste last with history off"    env SETTINGS_JSON='{"onboarded":true,"language":"en","privacy":{"historyRetentionDays":0},"sttChain":[{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]}' \
                                     AFTER_HOOK="xdotool key ctrl+alt+v" "$HERE/dictate_test.sh" "$LIB/0.wav" "brothels.After early nightfall"
REQLOG=$(mktemp); export REQLOG
python3 "$HERE/llm_standin.py" 8799 "$REQLOG" & LLM=$!
sleep 0.5
AI='"llm":{"enabled":true,"provider":"openai","baseUrl":"http://127.0.0.1:8799/v1","model":"standin"},"sttChain":[{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]'
requests() { [ "$(wc -l < "$REQLOG")" -eq "$1" ]; }
export -f requests
run "AI cleanup + auto transform (local LLM stand-in)" env SETTINGS_JSON='{"onboarded":true,"language":"en","llm":{"enabled":true,"provider":"openai","baseUrl":"http://127.0.0.1:8799/v1","model":"standin"},"autoTransforms":{"other":1},"sttChain":[{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]}' \
                                     BEFORE_HOOK=': > $REQLOG' CHECK='requests 1' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "TRANSFORMED: After early nightfall"
run "AI recasing keeps dictionary spelling" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",\"styleNotes\":{\"other\":\"SHOUT_DICTATION\"},$AI}" \
                                     SETUP_PY="db.execute(\"insert into dictionary(phrase,replacement,created_at) values('after early','iOS','x')\")" \
                                     CHECK='grep -q "^iOS NIGHTFALL" "$OUT"' "$HERE/dictate_test.sh" "$LIB/0.wav" "iOS NIGHTFALL"
LOCAL='"llm":{"enabled":true,"provider":"local","model":"s1-mini"},"sttChain":[{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]'
run "local polish not downloaded: rule-based text" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$LOCAL}" \
                                     CHECK='grep -q "isn.t downloaded yet" "$LOG"' "$HERE/dictate_test.sh" "$LIB/0.wav" "^After early nightfall"
run "local polish skips terminals"   env TARGET=terminal SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$LOCAL}" \
                                     CHECK='! grep -q "isn.t downloaded" "$LOG"' "$HERE/dictate_test.sh" "$LIB/0.wav" "^After early nightfall"
# An AI request that never answers keeps the dictation processing (10 s cap) while another window takes focus.
HANG='python3 -c "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((\"127.0.0.1\", 8797)); s.listen(); time.sleep(25)" &'
SWITCH='lxterminal -t "Other window" -e "sleep 30" & echo $! > /tmp/opstrellis-other.pid; for _ in $(seq 1 40); do xdotool search --name "Other window" >/dev/null && break; sleep 0.1; done; xdotool search --name "Other window" | head -1 | xargs -I{} xdotool windowactivate --sync {}'
run "focus moved while processing: clipboard, not the other window" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",\"llm\":{\"enabled\":true,\"provider\":\"openai\",\"baseUrl\":\"http://127.0.0.1:8797/v1\",\"model\":\"x\"},\"sttChain\":[{\"id\":\"l\",\"provider\":\"local\",\"model\":\"moonshine-tiny-en\",\"enabled\":true}]}" \
                                     BEFORE_HOOK="$HANG" RELEASE_HOOK="$SWITCH" LINGER=9 \
                                     CHECK='ok=1; [ ! -s "$OUT" ] && xclip -o -selection clipboard | grep -q nightfall && grep -q "focus moved to" "$LOG" || ok=0; kill $(cat /tmp/opstrellis-other.pid); [ $ok = 1 ]' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "<empty>"
run "whole-snippet dictation skips AI" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$AI}" \
                                     SETUP_PY="db.execute(\"insert into snippets(trigger,expansion,created_at) values('after early nightfall','SNIPPET OK','x')\")" \
                                     BEFORE_HOOK=': > $REQLOG' CHECK='requests 0' "$HERE/dictate_test.sh" /tmp/opstrellis-short.wav "^SNIPPET OK$"
run "AI unreachable: rule-based text" env SETTINGS_JSON='{"onboarded":true,"language":"en","llm":{"enabled":true,"provider":"openai","baseUrl":"http://127.0.0.1:9/v1","model":"x"},"sttChain":[{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]}' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "^After early nightfall"
run "AI agent in a terminal: prompt mode + auto action" env TARGET=terminal TERM_TITLE="Claude Code - e2e" \
                                     SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",\"autoTransforms\":{\"ai\":1},$AI}" \
                                     BEFORE_HOOK=': > $REQLOG' CHECK='requests 1 && grep -q "prompt the speaker will send" $REQLOG' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "TRANSFORMED: After early nightfall"
run "plain terminal: no auto action" env TARGET=terminal SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",\"autoTransforms\":{\"other\":1,\"ai\":1},$AI}" \
                                     BEFORE_HOOK=': > $REQLOG' CHECK='! grep -q "Then rewrite" $REQLOG' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "^After early nightfall"
SELECT_HELLO='xdotool type --delay 20 "hello world"; sleep 0.3; xdotool key ctrl+slash; sleep 0.3'
run "command mode replaces selection" env MODE=command SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$AI}" \
                                     BEFORE_HOOK="$SELECT_HELLO" WAIT_FOR=TRANSFORMED "$HERE/dictate_test.sh" "$LIB/0.wav" "^TRANSFORMED: hello world$"
run "command action copies result"   env MODE=command SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$AI}" \
                                     SETUP_PY="db.execute(\"insert into transforms(name,prompt,builtin,output) values('after early nightfall','Reply to it.',0,'copy')\")" \
                                     BEFORE_HOOK="$SELECT_HELLO" \
                                     CHECK='for i in $(seq 60); do xclip -o -selection clipboard 2>/dev/null | grep -q "TRANSFORMED: hello world" && break; sleep 0.1; done; xclip -o -selection clipboard | grep -q "TRANSFORMED: hello world"' \
                                     "$HERE/dictate_test.sh" /tmp/opstrellis-short.wav "^hello world$"
run "auto transform off by default"  env SETTINGS_JSON='{"onboarded":true,"language":"en","llm":{"enabled":true,"provider":"openai","baseUrl":"http://127.0.0.1:8799/v1","model":"standin"},"sttChain":[{"id":"l","provider":"local","model":"moonshine-tiny-en","enabled":true}]}' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "^After early nightfall"
run "clipboard-only snippet skips AI" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$AI}" \
                                     SETUP_PY="db.execute(\"insert into snippets(trigger,expansion,created_at) values('after early nightfall','{clipboard}','x')\")" \
                                     BEFORE_HOOK=': > "$REQLOG"; printf "%s" private-fixture-token | xclip -selection clipboard' CHECK='requests 0' \
                                     "$HERE/dictate_test.sh" /tmp/opstrellis-short.wav "^private-fixture-token$"
run "mixed clipboard snippet stays local" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",$AI}" \
                                     SETUP_PY="db.execute(\"insert into snippets(trigger,expansion,created_at) values('yellow lamps','{clipboard}','x')\")" \
                                     BEFORE_HOOK=': > "$REQLOG"; printf "%s" private-fixture-token | xclip -selection clipboard' \
                                     CHECK='requests 1 && ! grep -q private-fixture-token "$REQLOG"' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "private-fixture-token"
run "auto action preserves code and list indentation" env SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",\"autoTransforms\":{\"other\":1},$AI}" \
                                     SETUP_PY="db.execute(\"update transforms set prompt='KEEP_ACTION_INDENT' where id=1\")" \
                                     BEFORE_HOOK=': > "$REQLOG"' CHECK='requests 1 && grep -q "^    run()" "$OUT" && grep -q "^  - Use Postgres" "$OUT"' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "Plan"
run "agent-named shell directory blocks auto action" env TARGET=terminal TERM_TITLE="~/src/codex" \
                                     SETTINGS_JSON="{\"onboarded\":true,\"language\":\"en\",\"autoTransforms\":{\"other\":1,\"ai\":1},$AI}" \
                                     BEFORE_HOOK=': > "$REQLOG"' CHECK='requests 1 && ! grep -q "Then rewrite" "$REQLOG"' \
                                     "$HERE/dictate_test.sh" "$LIB/0.wav" "^After early nightfall"
kill $LLM
echo "failures: $fails"
exit $fails
