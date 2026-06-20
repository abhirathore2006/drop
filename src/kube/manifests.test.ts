import { test, expect } from "bun:test";
import { appManifests } from "./manifests.ts";
import type { AppConfig } from "../app-config.ts";

const base: AppConfig = { image: "ecr/billing:v1", services: [{ internalPort: 8080, protocol: "http" }] };

test("appManifests builds Deployment + Service + HTTPScaledObject", () => {
  const m = appManifests(
    { ...base, resources: { cpu: "0.5", memory: "512Mi" }, env: { NODE_ENV: "production" }, scale: { min: 0, max: 3 } },
    { name: "billing", namespace: "drop-acme", host: "billing.drop.example.com" },
  );

  const dm = m.deployment as any;
  expect(dm.apiVersion).toBe("apps/v1");
  expect(dm.kind).toBe("Deployment");
  expect(dm.metadata).toMatchObject({ name: "billing", namespace: "drop-acme" });
  expect(dm.spec.replicas).toBeUndefined(); // KEDA owns replica count
  const ctr = dm.spec.template.spec.containers[0];
  expect(ctr.image).toBe("ecr/billing:v1");
  expect(ctr.ports).toEqual([{ containerPort: 8080 }]);
  expect(ctr.env).toEqual([{ name: "NODE_ENV", value: "production" }]);
  expect(ctr.resources.limits).toEqual({ cpu: "0.5", memory: "512Mi" });
  expect(ctr.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(ctr.securityContext.capabilities.drop).toContain("ALL");

  const sm = m.service as any;
  expect(sm.kind).toBe("Service");
  expect(sm.spec.ports[0]).toMatchObject({ port: 80, targetPort: 8080 });
  expect(sm.spec.selector).toEqual(dm.spec.selector.matchLabels);

  const h = m.httpScaledObject as any;
  expect(h.apiVersion).toBe("http.keda.sh/v1alpha1");
  expect(h.kind).toBe("HTTPScaledObject");
  expect(h.spec.hosts).toEqual(["billing.drop.example.com"]);
  expect(h.spec.scaleTargetRef).toMatchObject({ name: "billing", kind: "Deployment", service: "billing", port: 80 });
  expect(h.spec.replicas).toEqual({ min: 0, max: 3 });
});

test("appManifests defaults scale to min:0/max:3 when unspecified", () => {
  const m = appManifests(base, { name: "x", namespace: "ns", host: "x.example.com" });
  expect((m.httpScaledObject as any).spec.replicas).toEqual({ min: 0, max: 3 });
  expect((m.deployment as any).spec.template.spec.containers[0].resources).toBeUndefined(); // no limits given
});

test("appManifests rejects raw-TCP / multi-service (v1 443-only)", () => {
  expect(() =>
    appManifests({ image: "x", services: [{ internalPort: 5432, protocol: "tcp" }] }, { name: "x", namespace: "ns", host: "h" }),
  ).toThrow();
});
