import assert from "node:assert/strict";
import test from "node:test";

// Drivers were written for browsers; the sidecar shims the one global they
// pace exchanges with. The shim itself lives in cheese-sidecar.mjs, so tests
// that drive drivers directly install it here too.
if (typeof window === "undefined") globalThis.window = globalThis;

import { createSupportedClient } from "@openmouse/protocol/drivers/registry";
import { RazerHidClient } from "@openmouse/protocol/drivers/razer/hid";
import { LogitechHidppClient } from "@openmouse/protocol/drivers/logitech/hidpp";
import {
  RAZER_STATUS,
  RAZER_TRANSACTION_ID,
  encodeRazerRequest,
  razerChecksum,
  razerReadDpiCommand,
  razerSetDpiCommand,
} from "@openmouse/protocol/razer";
import { withSoftwareId } from "@openmouse/protocol/logitech";
import { pickEntry, NodeWebHidDevice } from "./usb.mjs";

const collection = (usagePage, usage) => ({
  usagePage,
  usage,
  inputReports: [],
  outputReports: [],
  featureReports: [],
  children: [],
});

const mouseCollections = () => [
  collection(0x01, 0x02),
  collection(0xff00, 1),
];

const fakeDevice = (vendorId, productId, name, collections) => ({
  vendorId,
  productId,
  productName: name,
  opened: false,
  collections,
  async open() {
    this.opened = true;
  },
  async close() {
    this.opened = false;
  },
});

test("registry routes Viper V2 Pro and Logitech HID++ to their drivers", () => {
  const razer = createSupportedClient(fakeDevice(0x1532, 0x00a5, "Viper", mouseCollections()));
  assert.ok(razer instanceof RazerHidClient);
  const logi = createSupportedClient(fakeDevice(0x046d, 0xc08b, "G502", [collection(0xff00, 1)]));
  assert.ok(logi instanceof LogitechHidppClient);
  const unknown = createSupportedClient(fakeDevice(0x1234, 0x5678, "?", [collection(1, 2)]));
  assert.equal(unknown, null);
});

/** WebHID-shaped fake whose feature replies are built with the real codec. */
function razerFake() {
  const sent = [];
  return {
    sent,
    device: {
      ...fakeDevice(0x1532, 0x00a5, "Viper V2 Pro", [collection(0xff00, 1)]),
      async sendFeatureReport(_id, data) {
        sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
        return sent[sent.length - 1].length;
      },
      async receiveFeatureReport(_id) {
        const request = sent[sent.length - 1];
        const read = razerReadDpiCommand(request[8]);
        const isRead = request[6] === read.commandClass && request[7] === read.commandId;
        const reply = new Uint8Array(90);
        reply[0] = RAZER_STATUS.ok;
        reply[1] = request[1];
        reply[6] = request[6];
        reply[7] = request[7];
        if (isRead) {
          reply[5] = 5;
          reply.set([0x00, 0x06, 0x40, 0x06, 0x40], 8);
        } else {
          reply[5] = 0;
        }
        reply[88] = razerChecksum(reply);
        return new DataView(reply.buffer);
      },
    },
  };
}

test("Razer setDpi writes exact command bytes and confirms the readback", async () => {
  const { device, sent } = razerFake();
  const client = new RazerHidClient(device);
  await client.open();
  const result = await client.setDpi(1600);
  assert.equal(result, 1600);
  assert.equal(sent.length, 2);
  for (const packet of sent) {
    assert.equal(packet.length, 90);
    assert.equal(packet[88], razerChecksum(packet));
  }
  const storage = sent[0][8];
  const expected = encodeRazerRequest(
    razerSetDpiCommand(1600, 1600, storage),
    RAZER_TRANSACTION_ID,
  );
  assert.deepEqual(sent[0], expected);
});

test("Logitech DPI resolve emits the exact HID++ root query first", async () => {
  const writes = [];
  const device = {
    ...fakeDevice(0x046d, 0xc08b, "G502", [collection(0xff00, 1)]),
    async sendReport(id, data) {
      writes.push([
        id,
        ...new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
      ]);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const client = new LogitechHidppClient(device);
  await client.open();
  assert.ok(device.opened);
  const pending = client
    .requestWithOptions(0x00, 0x00, [0x22, 0x02], { timeoutMs: 300 })
    .then(
      () => "unexpectedly resolved",
      (error) => error.message,
    );
  const start = Date.now();
  while (writes.length === 0 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Root feature discovery: direct device, feature 0x0000, getFeature 0x00
  // asking where extended DPI (0x2202) lives.
  assert.deepEqual(writes[0], [0x10, 0xff, 0x00, withSoftwareId(0x00), 0x22, 0x02, 0x00]);
  const outcome = await pending;
  assert.match(outcome, /timed out|no reply|timeout|did not answer/i);
});

test("shim maps WebHID reports onto node-hid buffers", async () => {
  const calls = [];
  const fakeHandle = {
    async sendFeatureReport(buffer) {
      calls.push(["feature-out", [...buffer]]);
      return buffer.length;
    },
    async getFeatureReport(id, length) {
      calls.push(["feature-in", id, length]);
      return Buffer.alloc(length, 0xab);
    },
    async write(bytes) {
      calls.push(["out", bytes]);
    },
    on() {},
  };
  const device = new NodeWebHidDevice(
    [{ vendorId: 0x1532, productId: 0xa5, path: null, usagePage: 0xff00, usage: 1 }],
    fakeHandle,
  );
  await device.open();
  await device.sendFeatureReport(0, new Uint8Array([1, 2, 3]));
  const reply = await device.receiveFeatureReport(0);
  assert.equal(reply.byteLength, 90);
  assert.equal(reply.getUint8(0), 0xab);
  await device.sendReport(0x10, new Uint8Array([0xff, 0x00]));
  assert.deepEqual(calls[0], ["feature-out", [0, 1, 2, 3]]);
  assert.deepEqual(calls[1], ["feature-in", 0, 90]);
  assert.deepEqual(calls[2], ["out", [0x10, 0xff, 0x00]]);
  await device.close();
  assert.equal(device.opened, false);
});

test("shim dispatches input reports to listeners", async () => {
  let dataHandler = null;
  const fakeHandle = { on(type, callback) { dataHandler = callback; } };
  const device = new NodeWebHidDevice(
    [{ vendorId: 0x046d, productId: 0xc08b, path: null, usagePage: 0xff00, usage: 1 }],
    fakeHandle,
  );
  await device.open();
  const seen = [];
  device.addEventListener("inputreport", (event) => seen.push(event));
  dataHandler(Buffer.from([0x10, 0xff, 0x00, 0x02]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reportId, 0x10);
  assert.equal(seen[0].data.byteLength, 3);
  assert.equal(seen[0].data.getUint8(0), 0xff);
});

test("pickEntry prefers the HID++ short-report collection", () => {
  const mouse = { usagePage: 1, usage: 2 };
  const vendor = { usagePage: 0xff00, usage: 1 };
  const other = { usagePage: 0xff00, usage: 9 };
  assert.equal(pickEntry([mouse, other, vendor]), vendor);
  assert.equal(pickEntry([mouse, other]), other);
  assert.equal(pickEntry([mouse]), mouse);
  assert.equal(pickEntry([]), null);
});
