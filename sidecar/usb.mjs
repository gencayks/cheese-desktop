// Node WebHID shim: presents real USB HID devices (via node-hid) through the
// WebHID surface the @openmouse/protocol drivers are written against. This is
// TRANSPORT ONLY — no driver code lives here; drivers are instantiated by the
// sidecar from the protocol package and never learn they are not in Chrome.
//
// Layout facts the mapping relies on (all verified against hardware/docs):
//  - Razer answers 90-byte id-less feature transactions (RAZER_PACKET_LENGTH).
//    node-hid returns exactly the requested length, so id-0 reads ask for 90
//    and the bytes pass through verbatim (WebHID omits the id byte for id 0,
//    and so does hidapi).
//  - Logitech HID++ travels as output reports (0x10 short / 0x11 long) with
//    replies arriving as input reports; the shim forwards node-hid "data"
//    events as inputreport events with the id byte split off, matching the
//    WebHID {reportId, data} shape the driver filters on.
//  - Entry selection prefers the 0xFF00:0x01 short-report collection (the
//    documented HID++ USB carrier), then any vendor page, then the first
//    interface — the same narrowing the web panel's HID filters apply.
//  - Unhandled node-hid "error" events would crash the sidecar process, so a
//    quiet handler is attached; reads and writes surface their own errors.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HID = require("node-hid");

export function pickEntry(entries) {
  return (
    entries.find((entry) => entry.usagePage === 0xff00 && entry.usage === 1) ??
    entries.find((entry) => (entry.usagePage ?? 0) >= 0xff00) ??
    entries[0] ??
    null
  );
}

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  throw new Error("report payload must be a BufferSource");
}

export class NodeWebHidDevice {
  // entries: every node-hid entry sharing the opened hidraw path — one entry
  // per top-level collection, exactly how WebHID groups an interface.
  constructor(entries, handle = null) {
    const entry = entries[0];
    this.vendorId = entry.vendorId;
    this.productId = entry.productId;
    this.productName = entry.product || "";
    this.path = entry.path ?? null;
    this.collections = entries.map((item) => ({
      usagePage: item.usagePage ?? 0,
      usage: item.usage ?? 0,
      inputReports: [],
      outputReports: [],
      featureReports: [],
      children: [],
    }));
    this.opened = false;
    this.handle = handle;
    this.listeners = new Map();
    this.onData = null;
  }

  async open() {
    if (this.opened) return;
    if (!this.handle) {
      if (!this.path) throw new Error("no hidraw path for this device entry");
      this.handle = new HID.HID(this.path);
    }
    this.handle.on("error", () => undefined);
    this.opened = true;
  }

  async close() {
    try {
      await this.handle?.close();
    } catch {
      // Closing an already-gone handle is not a failure.
    }
    this.handle = null;
    this.listeners.clear();
    this.onData = null;
    this.opened = false;
  }

  async sendFeatureReport(reportId, data) {
    this.requireOpen();
    const bytes = toBytes(data);
    const packet = Buffer.concat([Buffer.from([reportId]), Buffer.from(bytes)]);
    return this.handle.sendFeatureReport(packet);
  }

  async receiveFeatureReport(reportId) {
    this.requireOpen();
    const length = reportId === 0 ? 90 : 64;
    const reply = await this.handle.getFeatureReport(reportId, length);
    const bytes = Uint8Array.from(reply);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async sendReport(reportId, data) {
    this.requireOpen();
    const bytes = toBytes(data);
    await this.handle.write([reportId, ...bytes]);
  }

  addEventListener(type, callback) {
    if (type !== "inputreport") return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
    if (!this.onData && this.handle) {
      this.onData = (buffer) => {
        const bytes = Uint8Array.from(buffer);
        const event = { reportId: bytes[0], data: new DataView(bytes.buffer, 1) };
        for (const listener of this.listeners.get(type) ?? []) {
          try {
            listener(event);
          } catch {
            // A failing listener must not break dispatch to the rest.
          }
        }
      };
      this.handle.on("data", this.onData);
    }
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  requireOpen() {
    if (!this.opened || !this.handle) throw new Error("device is not open");
  }
}

/** Open the best hidraw node for a VID:PID. Throws when nothing matches
 * (unplugged) or the OS denies access (missing udev rules). */
export async function openMouseDevice(vid, pid) {
  const hex = `0x${vid.toString(16)}:0x${pid.toString(16)}`;
  let entries;
  try {
    entries = HID.devices().filter((entry) => entry.vendorId === vid && entry.productId === pid);
  } catch (error) {
    throw new Error(`USB enumeration failed: ${error.message}`);
  }
  if (entries.length === 0) throw new Error(`no HID device ${hex} (is it plugged in?)`);
  const entry = pickEntry(entries);
  const siblings = entries.filter((item) => item.path === entry.path);
  const device = new NodeWebHidDevice(siblings.length > 0 ? siblings : [entry]);
  try {
    await device.open();
  } catch (error) {
    throw new Error(`cannot open ${hex} (${entry.path}): ${error.message}`);
  }
  return device;
}
