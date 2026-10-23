import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appendEvent,
  decodePath,
  getDeviceHistoryPage,
  getEventPage,
  getPageParameters,
  getStatus,
  isPublicAddress,
  validateDevices,
} from "../api/[...path].js";

const validDevice = {
  id: "module-01",
  category: "machine_modules",
  endpoint: "https://module.example-tunnel.com",
};

test("accepts public device IPs and HTTPS tunnel URLs with supported categories", () => {
  assert.deepEqual(validateDevices([validDevice]), [validDevice]);
  assert.equal(
    validateDevices([{ ...validDevice, endpoint: "http://1.1.1.1" }])[0].endpoint,
    "http://1.1.1.1",
  );
  assert.equal(
    validateDevices([{ ...validDevice, endpoint: "https://1.1.1.1" }])[0].endpoint,
    "https://1.1.1.1",
  );
  assert.equal(
    validateDevices([{ ...validDevice, endpoint: "https://[2606:4700:4700::1111]" }])[0].endpoint,
    "https://[2606:4700:4700::1111]",
  );
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "http://module.example.com" }]), /Domínios precisam usar HTTPS/);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "https://127.0.0.1" }]), /IP do dispositivo precisa ser público/);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "http://192.168.1.5" }]), /IP do dispositivo precisa ser público/);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "https://192.0.2.1" }]), /IP do dispositivo precisa ser público/);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "http://[2606:4700:4700::1111]" }]), /IPv6/);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "http://1.1.1.1:8080" }]), /porta padrão/);
  assert.throws(() => validateDevices([{ ...validDevice, category: "unknown" }]), /Categoria inválida/);
});

test("rejects duplicate ids and malformed device lists", () => {
  assert.throws(() => validateDevices([validDevice, validDevice]), /únicos/);
  assert.throws(() => validateDevices({ devices: [validDevice] }), /lista/);
  assert.throws(() => validateDevices([{ ...validDevice, id: "../device" }]), /identificadores/);
});

test("blocks non-public addresses before the serverless function calls a device", () => {
  for (const address of [
    "10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1",
    "169.254.169.254", "100.64.0.1", "198.51.100.1", "203.0.113.1", "::1",
  ]) {
    assert.equal(isPublicAddress(address), false, `${address} must not be public`);
  }
  for (const address of ["1.1.1.1", "198.51.101.1", "203.0.114.1"]) {
    assert.equal(isPublicAddress(address), true, `${address} must be public`);
  }
});

test("decodes API route path segments", () => {
  assert.deepEqual(decodePath(["devices", "module-01", "command"]), ["devices", "module-01", "command"]);
  assert.deepEqual(decodePath("devices/module-01/command"), ["devices", "module-01", "command"]);
});

test("provides the four requested screens and never asks for a private LAN IP", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const screen of ["overview", "devices", "activity", "settings"]) {
    assert.match(page, new RegExp(`data-screen="${screen}"`));
  }
  assert.match(page, /device-endpoint/);
  assert.doesNotMatch(page, /device-ip|gateway-url/);
});

test("provides responsive breakpoints and mobile-friendly device rows", async () => {
  const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  for (const breakpoint of ["1100px", "760px", "560px", "390px"]) {
    assert.ok(stylesheet.includes(`max-width: ${breakpoint}`), `missing ${breakpoint} responsive breakpoint`);
  }
  assert.match(stylesheet, /prefers-reduced-motion/);
  assert.match(stylesheet, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(stylesheet, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesheet, /content: attr\(data-label\)/);
  assert.match(app, /data-label="Endereço público"/);
});

test("keeps activity events without automatic trimming and paginates the full history", async () => {
  const storedEvents = [];
  const redis = {
    async lpush(_key, event) { storedEvents.unshift(event); },
    async lrange(_key, start, end) { return storedEvents.slice(start, end + 1); },
    async llen() { return storedEvents.length; },
  };
  await appendEvent(redis, { type: "first" });
  await appendEvent(redis, { type: "second" });
  const firstPage = await getEventPage(redis, 0, 1);
  const secondPage = await getEventPage(redis, 1, 1);
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.hasMore, true);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.events[0].type, "first");
  assert.equal(typeof getPageParameters({ offset: "0", limit: "50" }).limit, "number");
  assert.throws(() => getPageParameters({ offset: "-1", limit: "10" }), /inválida/);
  assert.equal(storedEvents.length, 2);
});

test("does not configure an automatic retention limit for stored data", async () => {
  const api = await readFile(new URL("../api/[...path].js", import.meta.url), "utf8");
  assert.doesNotMatch(api, /MAX_EVENTS|ltrim|expire\(/i);
  assert.match(api, /redis\.hset\(STATUS_KEY, statusUpdates\)/);
  assert.match(api, /redis\.lpush\(EVENT_KEY/);
});

test("persists the latest device status and preserves last-seen metrics while offline", async () => {
  const previous = {
    status: "online",
    version: "2.0",
    uptime: "5 dias",
    device_status: "ready",
    lastSeen: "2026-10-22T12:00:00.000Z",
  };
  let saved;
  const redis = {
    async hgetall() { return { "module-01": JSON.stringify(previous) }; },
    async hset(_key, values) { saved = values; },
    async lpush() {},
  };
  const result = await getStatus(redis, [validDevice], async () => {
    throw new Error("offline");
  });
  assert.equal(result[0].status, "offline");
  assert.equal(result[0].version, "2.0");
  assert.equal(result[0].lastSeen, previous.lastSeen);
  const persisted = JSON.parse(saved["module-01"]);
  assert.equal(persisted.status, "offline");
  assert.equal(persisted.version, "2.0");
  assert.ok(persisted.checkedAt);
});

test("saves every online and offline heartbeat to permanent per-device history", async () => {
  const histories = new Map();
  const redis = {
    async hgetall() { return {}; },
    async hset() {},
    async lpush(key, record) {
      histories.set(key, [record, ...(histories.get(key) || [])]);
    },
  };
  const onlinePayload = { device: "module-01", version: "2.2", uptime: 88, status: "ready" };
  await getStatus(redis, [validDevice], async () => ({
    body: Buffer.from(JSON.stringify(onlinePayload)),
  }));
  await getStatus(redis, [validDevice], async () => {
    throw new Error("offline");
  });

  const page = await getDeviceHistoryPage(redis, validDevice.id, 0, 10);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.records[0].status, "offline");
  assert.equal(page.records[1].payload.version, "2.2");
  assert.equal(page.records[1].payload.uptime, 88);
});
