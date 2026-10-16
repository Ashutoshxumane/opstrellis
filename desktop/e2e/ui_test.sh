#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/env.sh"
export OPSTRELLIS_MODELS_DIR=${OPSTRELLIS_MODELS_DIR:-/tmp/opstrellis-models}
exec python3 "$HERE/ui_test.py"
