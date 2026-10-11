import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function request(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, "cheese-sidecar.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const end = out.indexOf("\n");
      if (end !== -1) {
        child.stdin.end();
        resolve(out.slice(0, end));
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

test("health reports sidecar, node, and driver versions", async () => {
  const res = JSON.parse(await request({ id: 1, cmd: "health" }));
  assert.equal(res.id, 1);
  assert.equal(res.ok, true);
  assert.equal(res.sidecar, "cheese-sidecar/1");
  assert.match(res.node, /^v\d+/);
  assert.match(res.drivers, /^@openmouse\/protocol@\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(res.filters) && res.filters > 100);
});

test("unknown commands fail loudly with the request id", async () => {
  const res = JSON.parse(await request({ id: 7, cmd: "overclock" }));
  assert.equal(res.id, 7);
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown command/);
});

test("resolve maps catalog IDs to brand and model", async () => {
  const viper = JSON.parse(await request({ id: 1, cmd: "resolve", vid: 0x1532, pid: 0x00a5 }));
  assert.equal(viper.known, true);
  assert.equal(viper.brand, "Razer");
  assert.equal(viper.model, "Viper V2 Pro");
  const koone = JSON.parse(await request({ id: 2, cmd: "resolve", vid: 0x373e, pid: 0x006a }));
  assert.equal(koone.known, true);
  assert.equal(koone.brand, "CRDRAKO");
  const strange = JSON.parse(await request({ id: 3, cmd: "resolve", vid: 0x1234, pid: 0x5678 }));
  assert.equal(strange.known, false);
});

test("devices lists live USB with catalog annotations", async () => {
  const res = JSON.parse(await request({ id: 1, cmd: "devices" }));
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.devices) && res.devices.length > 0);
  for (const device of res.devices) {
    assert.ok(Number.isInteger(device.vid) && Number.isInteger(device.pid));
    assert.equal(typeof device.usbName, "string");
    assert.equal(typeof device.known, "boolean");
    if (device.known) assert.equal(typeof device.brand, "string");
  }
});
