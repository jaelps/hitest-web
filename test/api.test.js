import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodePath, isPublicAddress, validateDevices } from "../api/[...path].js";

const validDevice = {
  id: "module-01",
  category: "machine_modules",
  endpoint: "https://module.example-tunnel.com",
};

test("accepts only HTTPS tunnel URLs and supported categories", () => {
  assert.deepEqual(validateDevices([validDevice]), [validDevice]);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "http://module.example.com" }]), /HTTPS/);
  assert.throws(() => validateDevices([{ ...validDevice, endpoint: "https://127.0.0.1" }]), /domínio público/);
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
