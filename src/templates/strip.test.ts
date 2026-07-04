import { test, expect, describe } from "bun:test";
import { stripStackSpec, stripImageDigest, entropyBitsPerChar, looksLikeCredential } from "./strip.ts";
import type { StackSpec } from "../stack-config.ts";

describe("stripImageDigest", () => {
  test("strips a digest to repo:tag, keeps mutable tags and dir-based (no image) untouched", () => {
    expect(stripImageDigest("registry.io/app:1.2@sha256:" + "a".repeat(64))).toEqual({ image: "registry.io/app:1.2", stripped: true });
    expect(stripImageDigest("app@sha256:" + "b".repeat(64))).toEqual({ image: "app", stripped: true });
    expect(stripImageDigest("app:1")).toEqual({ image: "app:1", stripped: false });
  });
});

describe("entropy heuristics", () => {
  test("low-entropy config values stay low; random tokens go high", () => {
    expect(entropyBitsPerChar("5432")).toBeLessThan(3);
    expect(entropyBitsPerChar("require")).toBeLessThan(3);
    expect(entropyBitsPerChar("aB3xK9pQ2mZ7wL4v")).toBeGreaterThan(3);
    expect(looksLikeCredential("app")).toBe(false); // too short
    expect(looksLikeCredential("aB3xK9pQ2mZ7wL4v")).toBe(true);
  });
});

describe("stripStackSpec", () => {
  test("strips image digests and rewrites the stack-name prefix in env to ${stack}", () => {
    const spec: StackSpec = {
      name: "guestbook",
      resources: {
        db: { type: "database", storage: "1Gi" },
        web: {
          type: "app",
          image: "registry.io/guestbook:1@sha256:" + "c".repeat(64),
          uses: [{ database: "db" }],
          env: { PGHOST: "guestbook-db-rw", PGPORT: "5432", PGUSER: "app" },
        },
      },
    };
    const r = stripStackSpec({ spec });
    expect(r.spec.resources.web!.image).toBe("registry.io/guestbook:1");
    expect(r.spec.resources.web!.env!.PGHOST).toBe("${stack}-db-rw"); // stack-relative
    expect(r.spec.resources.web!.env!.PGPORT).toBe("5432"); // untouched
    expect(r.flags).toEqual([]); // nothing credential-looking
    expect(r.notes.some((n) => /stripped image digest/.test(n))).toBe(true);
  });

  test("removes env keys registered as write-only secrets (app_secret_keys)", () => {
    const spec: StackSpec = {
      name: "shop",
      resources: { web: { type: "app", image: "web:1", env: { PGPASSWORD: "leaked-value-here-xyz", PGUSER: "app" } } },
    };
    const r = stripStackSpec({ spec, secretKeyNames: { web: ["PGPASSWORD"] } });
    expect(r.spec.resources.web!.env).toEqual({ PGUSER: "app" }); // PGPASSWORD dropped
    expect(r.removed).toEqual([{ resourceKey: "web", envKey: "PGPASSWORD", reason: "registered as a write-only secret (app_secret_keys)" }]);
    expect(r.flags).toEqual([]); // it was removed, not flagged
  });

  test("FAILS CLOSED: a credential-looking value not registered/allowed is FLAGGED", () => {
    const spec: StackSpec = {
      name: "shop",
      resources: { web: { type: "app", image: "web:1", env: { API_TOKEN: "aB3xK9pQ2mZ7wL4vR8nT" } } },
    };
    const r = stripStackSpec({ spec });
    expect(r.flags.length).toBe(1);
    expect(r.flags[0]!).toMatchObject({ resourceKey: "web", envKey: "API_TOKEN" });
  });

  test("--allow lets a flagged value through; a ${var.…} value is never flagged", () => {
    const spec: StackSpec = {
      name: "shop",
      resources: {
        web: { type: "app", image: "web:1", env: { API_TOKEN: "aB3xK9pQ2mZ7wL4vR8nT", SESSION_SECRET: "${var.session}" } },
      },
    };
    const allowed = stripStackSpec({ spec, allow: ["API_TOKEN"] });
    expect(allowed.flags).toEqual([]); // allow-listed → passes
    // ${var.session} is variable-ized already → never a flag even though the key looks secret
    expect(allowed.spec.resources.web!.env!.SESSION_SECRET).toBe("${var.session}");
  });

  test("a suspicious KEY with a low-entropy value is NOT flagged (needs both heuristics)", () => {
    const spec: StackSpec = { name: "shop", resources: { web: { type: "app", image: "web:1", env: { PGPASSWORD: "changeme" } } } };
    expect(stripStackSpec({ spec }).flags).toEqual([]);
  });

  test("drops explicit resource name overrides (template resources are stack-relative)", () => {
    const spec: StackSpec = { name: "shop", resources: { db: { type: "database", name: "shop-db", storage: "1Gi" } } };
    const r = stripStackSpec({ spec });
    expect(r.spec.resources.db!.name).toBeUndefined();
    expect(r.notes.some((n) => /dropped explicit name/.test(n))).toBe(true);
  });
});
