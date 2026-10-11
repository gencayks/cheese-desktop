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
