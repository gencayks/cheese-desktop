# Cheese Desktop

Native Linux desktop companion to [Cheese](https://github.com/gencayks/openmouse)
(Cheese itself is a fork of [OpenMouse](https://github.com/OpenMouse-Project/openmouse)).
Cheese configures your mouse in the browser over WebHID; Cheese Desktop brings
the same drivers to a native app: 100% of the UI is Rust/GPUI, and a small
bundled Node sidecar runs the existing `@openmouse/protocol` drivers and talks
to the UI over NDJSON stdio. Drivers are **not** ported to Rust — the sidecar
reuses the TypeScript drivers as-is.

## Status

v1 item 1 (skeleton): hello window + sidecar spawn and health check. Queued:
native device list, DPI + polling controls (Razer Viper V2 Pro first), battery
readout, Linux packaging.

## Build

```bash
# Arch: toolchain, Node, and the GPUI system libraries
sudo pacman -S --needed base-devel rust nodejs npm libxkbcommon wayland

# Rust UI
cargo build

# Node sidecar (tested with Node 26)
cd sidecar && npm install
```

## Run

```bash
cd sidecar && npm install   # once
cargo run
```

The window shows the sidecar health line (`node` + `@openmouse/protocol`
versions + HID filter count). `CHEESE_SIDECAR` overrides the sidecar path.

## Sidecar protocol

NDJSON over stdio, one request line per process run (`health`, `devices`,
`resolve`, `status`, `set`). Mouse commands open the best hidraw node for a
VID:PID through a WebHID-shaped `node-hid` shim (`sidecar/usb.mjs`) and drive
the protocol registry's own auto-detected drivers — no driver code is ported.
`status` reads DPI/polling state, `set` applies `dpi` and/or `pollingHz` with
read-back. Needs `lsusb` (usbutils) for enumeration and hidraw access
(Cheese udev rules) for control.

## Check

```bash
cargo clippy --all-targets   # must be zero warnings
cargo fmt --check
cargo test
cd sidecar && npm run check
```

GPUI APIs used here are verified against `~/gpui-playground`
(`crates/gpui/examples/hello_world.rs`, zed rev `72d073d` — the same pin this
repo builds).

## License

AGPL-3.0-or-later, see LICENSE.
