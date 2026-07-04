import { test, expect } from "bun:test";
import {
  sanitizeCacheConfig,
  parseCacheConfig,
  validateCacheMemory,
  cacheMemoryToBytes,
  cachePvcSize,
  MIN_CACHE_MEMORY_BYTES,
  MAX_CACHE_MEMORY_BYTES,
} from "./cache-config.ts";

test("cacheMemoryToBytes parses Mi/Gi, rejects junk / other units", () => {
  expect(cacheMemoryToBytes("256Mi")).toBe(256 * 2 ** 20);
  expect(cacheMemoryToBytes("1Gi")).toBe(2 ** 30);
  expect(cacheMemoryToBytes("0.5Gi")).toBe(0.5 * 2 ** 30);
  expect(cacheMemoryToBytes("512")).toBeNull(); // no unit
  expect(cacheMemoryToBytes("1Ti")).toBeNull(); // Ti not allowed for a cache
  expect(cacheMemoryToBytes("junk")).toBeNull();
});

test("sanitizeCacheConfig defaults: 256Mi, ephemeral", () => {
  expect(sanitizeCacheConfig({})).toEqual({ memory: "256Mi", persistent: false });
  expect(sanitizeCacheConfig(null)).toEqual({ memory: "256Mi", persistent: false });
  expect(sanitizeCacheConfig("nonsense")).toBeUndefined(); // clearly-invalid scalar
});

test("sanitizeCacheConfig clamps memory into [64Mi, 1Gi]", () => {
  expect(sanitizeCacheConfig({ memory: "128Mi" })!.memory).toBe("128Mi"); // in range → kept
  expect(sanitizeCacheConfig({ memory: "16Mi" })!.memory).toBe("64Mi"); // below min → 64Mi
  expect(sanitizeCacheConfig({ memory: "4Gi" })!.memory).toBe("1Gi"); // above max → 1Gi
  expect(sanitizeCacheConfig({ memory: "junk" })!.memory).toBe("256Mi"); // malformed → default
  // the clamp bounds line up with the exported byte constants
  expect(cacheMemoryToBytes("64Mi")).toBe(MIN_CACHE_MEMORY_BYTES);
  expect(cacheMemoryToBytes("1Gi")).toBe(MAX_CACHE_MEMORY_BYTES);
});

test("sanitizeCacheConfig persistent flag is strict boolean true", () => {
  expect(sanitizeCacheConfig({ persistent: true })!.persistent).toBe(true);
  expect(sanitizeCacheConfig({ persistent: "true" })!.persistent).toBe(false); // only literal true
  expect(sanitizeCacheConfig({ persistent: 1 })!.persistent).toBe(false);
});

test("sanitizeCacheConfig round-trips (CLI -> JSON -> API re-sanitizes unchanged)", () => {
  const once = sanitizeCacheConfig({ memory: "512Mi", persistent: true, name: "sessions" })!;
  const twice = sanitizeCacheConfig(JSON.parse(JSON.stringify(once)))!;
  expect(twice).toEqual(once);
});

test("cachePvcSize is the cache memory (persistent PVC sizing)", () => {
  expect(cachePvcSize({ memory: "512Mi", persistent: true })).toBe("512Mi");
});

test("validateCacheMemory: null for absent / well-formed, error for malformed", () => {
  expect(validateCacheMemory({})).toBeNull(); // no memory requested
  expect(validateCacheMemory({ memory: "256Mi" })).toBeNull();
  expect(validateCacheMemory({ memory: "5Gi" })).toBeNull(); // well-formed (clamped later), not rejected
  expect(validateCacheMemory({ memory: "512" })).not.toBeNull(); // no unit → error
  expect(validateCacheMemory({ memory: 256 })).not.toBeNull(); // non-string → error
  expect(validateCacheMemory(null)).toBeNull();
});

test("parseCacheConfig reads a drop.yaml cache: section (present → config, absent → undefined)", () => {
  expect(parseCacheConfig("app:\n  image: x:1\n")).toBeUndefined(); // no cache: key
  expect(parseCacheConfig("cache:\n  memory: 512Mi\n  persistent: true\n")).toEqual({ memory: "512Mi", persistent: true });
  expect(parseCacheConfig("cache: {}\n")).toEqual({ memory: "256Mi", persistent: false });
});

test("parseCacheConfig throws on a malformed memory quantity (loud CLI rejection)", () => {
  expect(() => parseCacheConfig("cache:\n  memory: 512\n")).toThrow();
});
