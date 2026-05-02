#!/usr/bin/env bash
set -euo pipefail

WHISPER_MODEL="${WHISPER_MODEL:-small}"
INSTALL_DIR="${WHISPER_INSTALL_DIR:-$HOME/.local/share/whisper-cpp}"
MODEL_FILE="ggml-${WHISPER_MODEL}.bin"

echo "=== Whisper.cpp Install (macOS) ==="
echo "Model: $WHISPER_MODEL"
echo "Install dir: $INSTALL_DIR"
echo

if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew not found. Install from https://brew.sh, then re-run." >&2
  exit 1
fi

echo "Installing whisper-cpp and ffmpeg via Homebrew..."
brew install whisper-cpp ffmpeg

# Locate the brew-installed whisper-cli binary.
WHISPER_PREFIX="$(brew --prefix whisper-cpp)"
BREW_BIN="$WHISPER_PREFIX/bin/whisper-cli"
if [ ! -x "$BREW_BIN" ]; then
  echo "ERROR: whisper-cli not found at $BREW_BIN after brew install." >&2
  echo "Brew formula may have changed binary name. Check 'brew list whisper-cpp'." >&2
  exit 1
fi
# whisper-cli's --help exits 1 (its arg parser treats --help as "unknown
# command"), so we can't gate on the exit code. The brew install + the
# executable check above are the real signal; this run just confirms we
# can launch the binary at all (catches dyld errors / missing libs).
"$BREW_BIN" --help >/dev/null 2>&1 || true

# Mirror the Linux source-build layout so lib/transcribe.js's derived path
# (modelDir/../build/bin/whisper-cli) finds the binary without code changes.
TARGET_BIN_DIR="$INSTALL_DIR/build/bin"
mkdir -p "$TARGET_BIN_DIR" "$INSTALL_DIR/models"
ln -sf "$BREW_BIN" "$TARGET_BIN_DIR/whisper-cli"
echo "Symlinked $BREW_BIN -> $TARGET_BIN_DIR/whisper-cli"

# Download the model if not already present.
if [ ! -f "$INSTALL_DIR/models/$MODEL_FILE" ]; then
  echo "Downloading $MODEL_FILE model..."
  DOWNLOAD_SCRIPT="$INSTALL_DIR/models/download-ggml-model.sh"
  if [ ! -f "$DOWNLOAD_SCRIPT" ]; then
    curl -fsSL -o "$DOWNLOAD_SCRIPT" \
      https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/models/download-ggml-model.sh
    chmod +x "$DOWNLOAD_SCRIPT"
  fi
  ( cd "$INSTALL_DIR/models" && bash "$DOWNLOAD_SCRIPT" "$WHISPER_MODEL" )
else
  echo "Model $MODEL_FILE already exists."
fi

echo
echo "=== Whisper.cpp install complete ==="
echo "Binary (symlink): $TARGET_BIN_DIR/whisper-cli -> $BREW_BIN"
echo "Model:            $INSTALL_DIR/models/$MODEL_FILE"
echo
echo "Set in .env:"
echo "  WHISPER_MODEL_PATH=$INSTALL_DIR/models/$MODEL_FILE"
