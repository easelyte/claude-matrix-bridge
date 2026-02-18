#!/usr/bin/env bash
set -euo pipefail

WHISPER_VERSION="v1.8.3"
WHISPER_MODEL="small"
INSTALL_DIR="${WHISPER_INSTALL_DIR:-$HOME/.local/share/whisper-cpp}"
MODEL_FILE="ggml-${WHISPER_MODEL}.bin"

echo "=== Whisper.cpp Install ==="
echo "Version: $WHISPER_VERSION"
echo "Model: $WHISPER_MODEL"
echo "Install dir: $INSTALL_DIR"
echo

# Install system dependencies
echo "Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg cmake g++ 2>&1 | tail -1

# Clone or update whisper.cpp
if [ -d "$INSTALL_DIR" ]; then
  echo "Whisper.cpp directory exists, updating..."
  cd "$INSTALL_DIR"
  git fetch --tags
  git checkout "$WHISPER_VERSION"
else
  echo "Cloning whisper.cpp..."
  git clone --branch "$WHISPER_VERSION" --depth 1 https://github.com/ggerganov/whisper.cpp.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Build
echo "Building whisper.cpp..."
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j "$(nproc)"

# Verify binary
WHISPER_BIN="$INSTALL_DIR/build/bin/whisper-cli"
if [ ! -f "$WHISPER_BIN" ]; then
  echo "ERROR: whisper-cli binary not found at $WHISPER_BIN"
  exit 1
fi
echo "Binary: $WHISPER_BIN"
"$WHISPER_BIN" --help 2>&1 | head -1

# Download model if not present
if [ ! -f "$INSTALL_DIR/models/$MODEL_FILE" ]; then
  echo "Downloading $MODEL_FILE model..."
  bash "$INSTALL_DIR/models/download-ggml-model.sh" "$WHISPER_MODEL"
else
  echo "Model $MODEL_FILE already exists."
fi

echo
echo "=== Whisper.cpp install complete ==="
echo "Binary: $WHISPER_BIN"
echo "Model: $INSTALL_DIR/models/$MODEL_FILE"
