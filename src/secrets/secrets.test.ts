import { test, expect } from "bun:test";
import { validateSecretKey, fingerprint } from "./secrets.ts";
import { appSecretName } from "./types.ts";
import { FakeSecretStore } from "./fake.ts";

test("validateSecretKey: env-var names only", () => {
  expect(validateSecretKey("PGPASSWORD")).toBeNull();
  expect(validateSecretKey("API_KEY_2")).toBeNull();
  expect(validateSecretKey("_X")).toBeNull();
  expect(validateSecretKey("lowercase")).not.toBeNull();
  expect(validateSecretKey("1LEADING")).not.toBeNull();
  expect(validateSecretKey("HAS-DASH")).not.toBeNull();
  expect(validateSecretKey("HAS SPACE")).not.toBeNull();
  expect(validateSecretKey("")).not.toBeNull();
  expect(validateSecretKey(123)).not.toBeNull();
  expect(validateSecretKey("X".repeat(257))).not.toBeNull();
});

test("fingerprint: stable, differs by value, non-reversible, short", () => {
  expect(fingerprint("hunter2")).toBe(fingerprint("hunter2"));
  expect(fingerprint("hunter2")).not.toBe(fingerprint("other"));
  expect(fingerprint("hunter2")).not.toContain("hunter2");
  expect(fingerprint("hunter2").length).toBe(12);
});

test("appSecretName", () => {
  expect(appSecretName("billing")).toBe("billing-secret");
});

test("FakeSecretStore: set/list/delete/destroy; listKeys returns names sorted", async () => {
  const s = new FakeSecretStore();
  const scope = { owner: "alice@example.com", app: "billing", namespace: "drop-t-alice" };
  await s.setSecret(scope, "API_KEY", "v1");
  await s.setSecret(scope, "DB_URL", "v2");
  expect(await s.listKeys(scope)).toEqual(["API_KEY", "DB_URL"]);
  await s.setSecret(scope, "API_KEY", "v1b"); // overwrite, no new key
  expect(await s.listKeys(scope)).toEqual(["API_KEY", "DB_URL"]);
  await s.deleteSecret(scope, "API_KEY");
  expect(await s.listKeys(scope)).toEqual(["DB_URL"]);
  await s.ensureBinding(scope, ["DB_URL"]);
  expect(s.bindings.at(-1)).toEqual({ scope: "drop-t-alice/billing", keys: ["DB_URL"] });
  await s.destroy(scope);
  expect(await s.listKeys(scope)).toEqual([]);
  expect(s.destroyed).toContain("drop-t-alice/billing");
});
