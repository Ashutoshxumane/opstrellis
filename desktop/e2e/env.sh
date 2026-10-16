# Headless Linux desktop for E2E: Xvfb + openbox + PulseAudio virtual microphone ("vmic").
# Usage: source e2e/env.sh
export DISPLAY=:99
export XDG_SESSION_TYPE=x11
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
  sleep 1
  openbox >/tmp/openbox.log 2>&1 &
fi
if ! pactl info >/dev/null 2>&1; then
  pulseaudio -D --exit-idle-time=-1 2>/tmp/pulse.log || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
  pactl load-module module-null-sink sink_name=vmic sink_properties=device.description=VirtualMic >/dev/null
  pactl set-default-source vmic.monitor
fi
# A suspended null sink drops the first moments of playback when it resumes; keep it running.
pactl unload-module module-suspend-on-idle 2>/dev/null || true
# Route ALSA (what cpal uses on Linux) through PulseAudio.
[ -f ~/.asoundrc ] || printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > ~/.asoundrc
export PULSE_COOKIE=${PULSE_COOKIE:-$HOME/.config/pulse/cookie}
export PULSE_SERVER=${PULSE_SERVER:-unix:$(pactl info | sed -n "s/^Server String: //p")}
