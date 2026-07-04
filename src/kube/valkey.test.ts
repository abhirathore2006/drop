import { test, expect } from "bun:test";
import { cacheManifests, cacheHost, VALKEY_IMAGE } from "./valkey.ts";
import type { CacheConfig } from "../cache-config.ts";

const ctx = { name: "sessions", namespace: "tenant-acme", password: "s3cr3t-pass" };

function container(m: ReturnType<typeof cacheManifests>): any {
  return (m.deployment as any).spec.template.spec.containers[0];
}

test("cacheHost is the in-namespace svc DNS name", () => {
  expect(cacheHost("sessions", "tenant-acme")).toBe("sessions.tenant-acme.svc.cluster.local");
});

test("ephemeral cache: Deployment(pinned image, requirepass via secret env) + Service, NO PVC, NO save", () => {
  const cfg: CacheConfig = { memory: "256Mi", persistent: false };
  const m = cacheManifests(cfg, ctx);

  // deployment shape: single replica, Recreate strategy, pinned image
  const dep = m.deployment as any;
  expect(dep.kind).toBe("Deployment");
  expect(dep.spec.replicas).toBe(1);
  expect(dep.spec.strategy.type).toBe("Recreate");
  const c = container(m);
  expect(c.image).toBe(VALKEY_IMAGE);
  expect(c.command).toEqual(["valkey-server"]);
  // requirepass read from the <name>-cache Secret via a secretKeyRef env, expanded by k8s $(VAR)
  expect(c.args).toContain("--requirepass");
  expect(c.args).toContain("$(VALKEY_PASSWORD)");
  expect(c.env).toEqual([{ name: "VALKEY_PASSWORD", valueFrom: { secretKeyRef: { name: "sessions-cache", key: "password" } } }]);
  // ephemeral → persistence disabled (--save "") and NO PVC / volume / volumeMount
  expect(c.args).toContain("--save");
  expect(c.args[c.args.indexOf("--save") + 1]).toBe(""); // save disabled
  expect(m.pvc).toBeUndefined();
  expect(c.volumeMounts).toBeUndefined();
  expect(dep.spec.template.spec.volumes).toBeUndefined();
  // resources: limit = memory, cpu 250m
  expect(c.resources.limits).toEqual({ cpu: "250m", memory: "256Mi" });

  // Service on 6379 (ClusterIP by omission)
  const svc = m.service as any;
  expect(svc.kind).toBe("Service");
  expect(svc.spec.ports).toEqual([{ name: "redis", port: 6379, targetPort: 6379 }]);

  // requirepass Secret emitted at create (password present)
  expect((m.secret as any).stringData).toEqual({ password: "s3cr3t-pass" });

  // tenant-consistent labels + a drop.dev/kind=cache marker for teardown/status
  const labels = dep.metadata.labels;
  expect(labels["app.kubernetes.io/managed-by"]).toBe("drop");
  expect(labels["app.kubernetes.io/name"]).toBe("sessions");
  expect(labels["drop.dev/kind"]).toBe("cache");
});

test("persistent cache: adds a PVC at /data (sized to memory) + volume/mount + RDB save", () => {
  const cfg: CacheConfig = { memory: "512Mi", persistent: true };
  const m = cacheManifests(cfg, ctx);
  const c = container(m);
  // PVC sized to memory, RWO
  expect((m.pvc as any).kind).toBe("PersistentVolumeClaim");
  expect((m.pvc as any).metadata.name).toBe("sessions-cache-data");
  expect((m.pvc as any).spec.accessModes).toEqual(["ReadWriteOnce"]);
  expect((m.pvc as any).spec.resources.requests.storage).toBe("512Mi");
  // volume + mount wire the PVC at /data
  expect(c.volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);
  expect((m.deployment as any).spec.template.spec.volumes).toEqual([{ name: "data", persistentVolumeClaim: { claimName: "sessions-cache-data" } }]);
  // RDB persistence enabled (--dir /data --save 60 1)
  expect(c.args).toContain("--dir");
  expect(c.args).toContain("/data");
  const si = c.args.indexOf("--save");
  expect([c.args[si + 1], c.args[si + 2]]).toEqual(["60", "1"]);
});

test("re-apply (no password in ctx) omits the Secret but keeps the Deployment/Service", () => {
  const m = cacheManifests({ memory: "256Mi", persistent: false }, { name: "sessions", namespace: "tenant-acme" });
  expect(m.secret).toBeUndefined(); // never re-write / re-rotate on update
  expect(m.deployment).toBeDefined();
  expect(m.service).toBeDefined();
});

test("maxmemory is set to ~90% of the limit in raw bytes (headroom for OOM safety)", () => {
  const c = container(cacheManifests({ memory: "256Mi", persistent: false }, ctx));
  const i = c.args.indexOf("--maxmemory");
  expect(i).toBeGreaterThan(-1);
  expect(Number(c.args[i + 1])).toBe(Math.floor(256 * 2 ** 20 * 0.9));
});
