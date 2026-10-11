// Cheese Desktop sidecar: runs the @openmouse/protocol mouse drivers for the
// native GPUI UI. Protocol is NDJSON over stdio — one JSON object per line,
// every response carries the request id:
//
//   --> {"id": 1, "cmd": "health"}
//   <-- {"id": 1, "ok": true, "sidecar": "cheese-sidecar/1", ...}
//
// The process exits when stdin closes. Drivers are NOT ported here in full
// yet (v1 item 1: spawn + health check only); device enumeration lands next.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "@openmouse/protocol/drivers/vendors";

// package.json is not an exported subpath; reach it via the exported module.
const vendorsPath = fileURLToPath(await import.meta.resolve("@openmouse/protocol/drivers/vendors"));
const driversVersion = JSON.parse(
  readFileSync(join(dirname(vendorsPath), "..", "..", "package.json"), "utf8"),
).version;

const handlers = {
  health: () => ({
    ok: true,
    sidecar: "cheese-sidecar/1",
    node: process.version,
    drivers: `@openmouse/protocol@${driversVersion}`,
    filters: protocol.SUPPORTED_HID_FILTERS.length,
  }),
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: "not JSON" })}\n`);
      continue;
    }
    const handle = handlers[request?.cmd];
    const body = handle
      ? handle()
      : { ok: false, error: `unknown command ${JSON.stringify(request?.cmd)}` };
    process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, ...body })}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
