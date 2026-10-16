#!/usr/bin/env sh
# Downloads the self-hosted STT model (Moonshine tiny, int8) for the `local` provider.
# Usage: scripts/fetch-model.sh [models-dir]   (default: ./models next to this script's parent)
set -eu
NAME="${MODEL_NAME:-sherpa-onnx-moonshine-tiny-en-int8}"
DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/models}"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2"
mkdir -p "$DIR"
if [ -f "$DIR/$NAME/tokens.txt" ]; then
  echo "Model already present: $DIR/$NAME"
  exit 0
fi
echo "Downloading $URL"
curl -fL --retry 3 -o "$DIR/$NAME.tar.bz2" "$URL"
tar -xjf "$DIR/$NAME.tar.bz2" -C "$DIR"
rm -f "$DIR/$NAME.tar.bz2"
echo "Model ready: $DIR/$NAME"
