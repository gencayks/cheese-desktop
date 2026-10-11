// Cheese Desktop sidecar: runs the @openmouse/protocol mouse drivers for the
// native GPUI UI. Protocol is NDJSON over stdio — one JSON object per line,
// every response carries the request id:
//
//   --> {"id": 1, "cmd": "health"}
//   <-- {"id": 1, "ok": true, "sidecar": "cheese-sidecar/1", ...}
//
// The process exits when stdin closes. Drivers are NOT ported here in full
// yet (v1 item 1: spawn + health check only); device enumeration lands next.
// Drivers run in Node here, but were written for browsers: Razer/Logitech
// pace their exchanges with window.setTimeout.
if (typeof window === "undefined") globalThis.window = globalThis;

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "@openmouse/protocol/drivers/vendors";
import * as lamzu from "@openmouse/protocol/lamzu";
import * as razerDevices from "@openmouse/protocol/razer-devices";
import { createSupportedClient } from "@openmouse/protocol/drivers/registry";
import { openMouseDevice } from "./usb.mjs";

// package.json is not an exported subpath; reach it via the exported module.
const vendorsPath = fileURLToPath(await import.meta.resolve("@openmouse/protocol/drivers/vendors"));
const driversVersion = JSON.parse(
  readFileSync(join(dirname(vendorsPath), "..", "..", "package.json"), "utf8"),
).version;

// Supported-mouse catalog: [vid, pid] -> { brand, model }. Built ONLY from
// the protocol's exported product tables (the driver registry is the source
// of truth; no driver code runs here, just ID tables). VID pairings verified
// against drivers/vendors.js VENDOR_ID + the lamzu driver product table:
//  - lamzu mainline/Atlantis/Inca carry their own VENDOR_ID exports
//  - ATTACKSHARK/CRDRAKO/LUNAFURY pid lists live in the lamzu driver and
//    answer under LAMZU_VENDOR_ID (0x373e); model splits below come from that
//    same product table (R5/R6/R8, KO-ONE wired/wireless, LUNA33/TYPE33)
//  - classic Glorious spans four SinoWealth VIDs (see the classic HID filters)
const LAMZU_MAIN = lamzu.LAMZU_VENDOR_ID;
const catalog = new Map();
const add = (vid, pid, brand, model) => catalog.set(`${vid}:${pid}`, { brand, model });
for (const [pid, info] of lamzu.LAMZU_PRODUCTS) {
  add(LAMZU_MAIN, pid, info.brand ?? "Lamzu", info.model);
}
for (const [pid, info] of lamzu.LAMZU_ATLANTIS_PRODUCTS) {
  add(lamzu.LAMZU_ATLANTIS_VENDOR_ID, pid, "Lamzu", info.model);
}
for (const [pid, info] of lamzu.LAMZU_INCA_PRODUCTS) {
  add(lamzu.LAMZU_INCA_VENDOR_ID, pid, "Lamzu", info.model);
}
const ATTACKSHARK_R5 = new Set([70, 71]);
const ATTACKSHARK_R6 = new Set([33, 34]);
for (const pid of lamzu.ATTACKSHARK_PRODUCT_IDS) {
  add(LAMZU_MAIN, pid, "Attack Shark", ATTACKSHARK_R5.has(pid) ? "R5 Ultra" : ATTACKSHARK_R6.has(pid) ? "R6" : "R8");
}
for (const pid of lamzu.CRDRAKO_PRODUCT_IDS) {
  add(LAMZU_MAIN, pid, "CRDRAKO", "KO-ONE");
}
const LUNAFURY_LUNA33 = new Set([50, 51]);
for (const pid of lamzu.LUNAFURY_PRODUCT_IDS) {
  add(LAMZU_MAIN, pid, "LunaFury", LUNAFURY_LUNA33.has(pid) ? "LUNA33" : "TYPE33");
}
for (const [pid, info] of razerDevices.RAZER_PRODUCTS) {
  add(protocol.VENDOR_ID.razer, pid, "Razer", typeof info === "string" ? info : info.model);
}
for (const [pid, info] of protocol.GLORIOUS_PRODUCTS) {
  add(protocol.VENDOR_ID.glorious, pid, "Glorious", info.name);
}
for (const vid of [0x258a, 0x22d4, 0x320f, 0x3794]) {
  for (const [pid, info] of protocol.GLORIOUS_CLASSIC_PRODUCTS) {
    add(vid, pid, "Glorious", info.name);
  }
}
for (const [pid, info] of protocol.WLMOUSE_PRODUCTS) {
  add(protocol.VENDOR_ID.wlmouse, pid, "WLMouse", info.name);
}
for (const pid of protocol.TEEVOLUTION_PRODUCT_IDS) {
  add(protocol.VENDOR_ID.teevolution, pid, "Teevolution", null);
}
for (const pid of protocol.LOGITECH_PRODUCT_IDS) {
  add(protocol.VENDOR_ID.logitech, pid, "Logitech", null);
}

function resolve(vid, pid) {
  return catalog.get(`${vid}:${pid}`) ?? null;
}

// `lsusb` line: Bus 001 Device 003: ID 1532:00a5 Razer USA, Ltd Viper V2 Pro
function listUsb() {
  let text;
  try {
    text = execFileSync("lsusb", [], { encoding: "utf8", timeout: 5000 });
  } catch (error) {
    throw new Error(`USB enumeration needs lsusb: ${error.message}`);
  }
  const devices = [];
  for (const line of text.split("\n")) {
    const match = /^Bus (\d+) Device (\d+): ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const vid = parseInt(match[3], 16);
    const pid = parseInt(match[4], 16);
    const found = resolve(vid, pid);
    devices.push({
      bus: match[1],
      device: match[2],
      vid,
      pid,
      usbName: match[5].trim(),
      brand: found?.brand ?? null,
      model: found?.model ?? null,
      known: found !== null,
    });
  }
  return devices;
}

const handlers = {
  health: () => ({
    ok: true,
    sidecar: "cheese-sidecar/1",
    node: process.version,
    drivers: `@openmouse/protocol@${driversVersion}`,
    filters: protocol.SUPPORTED_HID_FILTERS.length,
  }),
  devices: () => {
    try {
      return { ok: true, devices: listUsb() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  },
  resolve: (request) => {
    const found = resolve(request?.vid, request?.pid);
    return found
      ? { ok: true, brand: found.brand, model: found.model, known: true }
      : { ok: true, brand: null, model: null, known: false };
  },
  status: (request) => mouseCommand(request, readMouse),
  set: (request) => mouseCommand(request, applyMouse),
};

/** Open the mouse, run a driver command, always close. Client selection uses
 * the protocol registry's own auto-detection over the shim's collections. */
async function mouseCommand(request, command) {
  const vid = request?.vid;
  const pid = request?.pid;
  if (!Number.isInteger(vid) || !Number.isInteger(pid)) {
    return { ok: false, error: "mouse commands need integer vid and pid" };
  }
  let device;
  try {
    device = await openMouseDevice(vid, pid);
  } catch (error) {
    return { ok: false, error: hintPermissions(error.message) };
  }
  try {
    const client = createSupportedClient(device);
    if (!client) {
      return { ok: false, error: `no driver claims 0x${vid.toString(16)}:0x${pid.toString(16)}` };
    }
    await client.open();
    return { ok: true, driver: client.constructor.name, ...(await command(client, request)) };
  } catch (error) {
    return { ok: false, error: hintPermissions(error.message) };
  } finally {
    await device.close().catch(() => undefined);
  }
}

function hintPermissions(message) {
  if (/permission denied|access denied|not permitted/i.test(message)) {
    return `${message} (missing udev rules? run the installer from the Cheese repo)`;
  }
  return message;
}

async function readMouse(client) {
  const status = await client.readStatus();
  return {
    dpi: status.dpi ?? null,
    pollingHz: status.pollingRateHz ?? null,
    dpiMin: await dpiBound(client, "min"),
    dpiMax: await dpiBound(client, "max"),
    pollingRates: await safeRates(client),
  };
}

async function applyMouse(client, request) {
  if (request.dpi !== undefined && request.dpi !== null) await client.setDpi(request.dpi);
  if (request.pollingHz !== undefined && request.pollingHz !== null) {
    await client.setPollingRate(request.pollingHz);
  }
  return readMouse(client);
}

async function dpiBound(client, end) {
  try {
    const options = await client.getDpiOptions();
    if (!Array.isArray(options) || options.length === 0) return null;
    return end === "min" ? options[0] : options[options.length - 1];
  } catch {
    return null;
  }
}

async function safeRates(client) {
  try {
    const rates = await client.getSupportedPollingRates();
    return Array.isArray(rates) ? rates : [];
  } catch {
    return [];
  }
}

let buffer = "";
// The Rust client closes stdin right after its one request; async handlers
// (status/set) still need event-loop turns afterwards, so exit on stdin end
// only when no request is in flight — otherwise responses are lost.
let pending = 0;
let stdinEnded = false;
function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}
async function serve(line) {
  pending += 1;
  try {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: "not JSON" })}\n`);
      return;
    }
    const handle = handlers[request?.cmd];
    let body;
    try {
      body = handle
        ? await handle(request)
        : { ok: false, error: `unknown command ${JSON.stringify(request?.cmd)}` };
    } catch (error) {
      body = { ok: false, error: error.message };
    }
    process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, ...body })}\n`);
  } finally {
    pending -= 1;
    maybeExit();
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  const lines = [];
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) lines.push(line);
  }
  for (const line of lines) void serve(line);
});
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});
