#!/usr/bin/env bash
# Manual install for Cheese Desktop (packaging without the AUR):
# builds the release binary + sidecar tree and installs them under PREFIX
# (default /usr/local) with the desktop entry and icon.
#
# Usage:
#   ./scripts/install-linux.sh                  # installs to /usr/local
#   PREFIX=/usr ./scripts/install-linux.sh      # system-wide, like the AUR
#
# Re-runs itself with sudo when PREFIX is not writable. Mouse access still
# needs hidraw udev rules — install cheese (cheese-git) or copy its
# 70-cheese.rules, then unplug/replug the mouse.

set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [ ! -w "${PREFIX}" ]; then
  exec sudo -- "${BASH_SOURCE[0]}" "$@"
fi

cd "${REPO_ROOT}"
cargo build --release --locked
(cd sidecar && npm ci --no-audit --no-fund)

install -Dm755 target/release/cheese-desktop "${PREFIX}/bin/cheese-desktop"
install -dm755 "${PREFIX}/share/cheese-desktop/sidecar"
cp -r sidecar/cheese-sidecar.mjs sidecar/usb.mjs sidecar/package.json \
  sidecar/node_modules "${PREFIX}/share/cheese-desktop/sidecar/"
install -Dm644 distro/aur/cheese-desktop.desktop \
  "${PREFIX}/share/applications/cheese-desktop.desktop"
install -Dm644 assets/icon-512.png \
  "${PREFIX}/share/icons/hicolor/512x512/apps/cheese-desktop.png"

cat <<EOF

Cheese Desktop installed under ${PREFIX}. Launch with \`cheese-desktop\`
(or the app menu). Still needed for mouse access: hidraw udev rules plus
one unplug/replug — see the Cheese repo's scripts/install-linux.sh.
EOF
