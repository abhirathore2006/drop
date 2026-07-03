import { test, expect } from "bun:test";
import { appManifests, tenantManifests } from "./manifests.ts";
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
  expect(ctr.env).toBeUndefined(); // env lives in a Secret, referenced via envFrom (SEC-5)
  expect(ctr.envFrom[0].secretRef.name).toBe("billing-env");
  expect((m.secret as any).stringData.NODE_ENV).toBe("production");
  expect(ctr.resources.limits).toEqual({ cpu: "0.5", memory: "512Mi" });
  expect(ctr.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(ctr.securityContext.seccompProfile.type).toBe("RuntimeDefault");
  expect(ctr.securityContext.capabilities).toBeUndefined(); // no cap-drop — would break images that chown/setuid (nginx, postgres)

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

test("appManifests sets an explicit imagePullPolicy by tag + imagePullSecrets only when given", () => {
  // versioned tag → use the present image (local-imported / already-pulled), no pull secret
  const versioned = appManifests(base, { name: "x", namespace: "ns", host: "x.example.com" });
  const vc = (versioned.deployment as any).spec.template.spec;
  expect(vc.containers[0].imagePullPolicy).toBe("IfNotPresent");
  expect(vc.imagePullSecrets).toBeUndefined();

  // :latest (or untagged) → Always re-pull
  const latest = appManifests({ ...base, image: "nginx:latest" }, { name: "x", namespace: "ns", host: "x.example.com" });
  expect((latest.deployment as any).spec.template.spec.containers[0].imagePullPolicy).toBe("Always");
  const untagged = appManifests({ ...base, image: "nginx" }, { name: "x", namespace: "ns", host: "x.example.com" });
  expect((untagged.deployment as any).spec.template.spec.containers[0].imagePullPolicy).toBe("Always");

  // registry backend supplies a pull secret → referenced on the pod
  const reg = appManifests(base, { name: "x", namespace: "ns", host: "x.example.com", imagePullSecret: "drop-registry" });
  expect((reg.deployment as any).spec.template.spec.imagePullSecrets).toEqual([{ name: "drop-registry" }]);

  // local-imported drop.local/* image MUST be IfNotPresent even at :latest (no registry to pull from)
  const local = appManifests({ ...base, image: "drop.local/x:latest" }, { name: "x", namespace: "ns", host: "x.example.com" });
  expect((local.deployment as any).spec.template.spec.containers[0].imagePullPolicy).toBe("IfNotPresent");
  // registry-with-port, untagged → Always (the ':5000' is a port, not a tag)
  const port = appManifests({ ...base, image: "reg.example.com:5000/app" }, { name: "x", namespace: "ns", host: "x.example.com" });
  expect((port.deployment as any).spec.template.spec.containers[0].imagePullPolicy).toBe("Always");
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

test("tenantManifests: PSA-labeled namespace + default-deny NetworkPolicy + quota + limitrange", () => {
  const m = tenantManifests("drop-t-alice-1234");
  expect((m.namespace as any).metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("baseline");
  const np = m.networkPolicy as any;
  expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  expect(np.spec.egress.some((e: any) => (e.ports ?? []).some((p: any) => p.port === 53))).toBe(true); // DNS
  // HTTPS egress allowlist excludes link-local metadata + the default (local) cluster CIDR
  const https = np.spec.egress.find((e: any) => (e.ports ?? []).some((p: any) => p.port === 443));
  expect(https.to[0].ipBlock.except).toContain("169.254.169.254/32");
  expect(https.to[0].ipBlock.except).toContain("10.0.0.0/8"); // default when no CIDRs configured (local k3s)
  expect((m.resourceQuota as any).spec.hard["count/pods"]).toBeDefined();
  expect((m.limitRange as any).spec.limits[0].default.cpu).toBeDefined();
});

test("tenantManifests: egress except CIDRs are config-driven (EKS pod/service CIDRs outside 10/8)", () => {
  // The security-critical knob: on EKS the pod/service CIDRs are commonly NOT in 10/8,
  // so the cross-tenant + platform-DB block depends on these being passed from config.
  const m = tenantManifests("drop-t-x", { blockedEgressCidrs: ["172.16.0.0/12", "100.64.0.0/10"] });
  const https = (m.networkPolicy as any).spec.egress.find((e: any) => (e.ports ?? []).some((p: any) => p.port === 443));
  expect(https.to[0].ipBlock.except).toEqual(["169.254.169.254/32", "172.16.0.0/12", "100.64.0.0/10"]);
  expect(https.to[0].ipBlock.except).not.toContain("10.0.0.0/8"); // default NOT silently retained
  // IMDS is always excluded regardless of configured cluster CIDRs
  expect(tenantManifests("drop-t-y", { blockedEgressCidrs: [] }).networkPolicy as any).toBeDefined();
  const empty = (tenantManifests("drop-t-y", { blockedEgressCidrs: [] }).networkPolicy as any).spec.egress.find(
    (e: any) => (e.ports ?? []).some((p: any) => p.port === 443),
  );
  expect(empty.to[0].ipBlock.except).toContain("169.254.169.254/32"); // IMDS always
  expect(empty.to[0].ipBlock.except).toContain("10.0.0.0/8"); // empty array falls back to default
});

test("appManifests: env in a Secret; interceptor ingress on the container port; sandbox optional", () => {
  const m = appManifests(
    { image: "x:1", env: { TOKEN: "s3cr3t" }, services: [{ internalPort: 8080, protocol: "http" }] },
    { name: "billing", namespace: "drop-t-alice", host: "billing.drop.example.com", sandbox: true },
  );
  expect((m.secret as any).kind).toBe("Secret");
  expect((m.secret as any).stringData.TOKEN).toBe("s3cr3t");
  const ctr = (m.deployment as any).spec.template.spec.containers[0];
  expect(ctr.env).toBeUndefined();
  // config Secret first, then the write-only app-secret (optional, LAST → wins on key collision).
  expect(ctr.envFrom).toEqual([{ secretRef: { name: "billing-env" } }, { secretRef: { name: "billing-secret", optional: true } }]);
  expect((m.deployment as any).spec.template.spec.runtimeClassName).toBe("gvisor");
  const ip = m.ingressPolicy as any;
  expect(ip.kind).toBe("NetworkPolicy");
  expect(ip.spec.ingress[0].from[0].namespaceSelector.matchLabels).toEqual({ "kubernetes.io/metadata.name": "keda" });
  expect(ip.spec.ingress[0].ports[0].port).toBe(8080); // CONTAINER port, not Service :80
});

test("appManifests: no runtimeClassName / no config Secret when sandbox off & no env; still envFroms the optional app-secret", () => {
  const m = appManifests({ image: "x:1", services: [{ internalPort: 80, protocol: "http" }] }, { name: "a", namespace: "n", host: "a.x" });
  expect((m.deployment as any).spec.template.spec.runtimeClassName).toBeUndefined();
  expect(m.secret).toBeUndefined(); // no <name>-env config Secret
  // even with no config env, the app-secret ref is always present (optional) so set secrets inject.
  expect((m.deployment as any).spec.template.spec.containers[0].envFrom).toEqual([{ secretRef: { name: "a-secret", optional: true } }]);
});

test("appManifests: uses binds a db — envFrom <db>-app + CA volume/mount + verify-full, exactly once", () => {
  const m = appManifests(
    { ...base, env: { LOG_LEVEL: "info" }, uses: [{ database: "tododb" }] },
    { name: "todo", namespace: "drop-acme", host: "todo.drop.example.com" },
  );
  const pod = (m.deployment as any).spec.template.spec;
  const ctr = pod.containers[0];
  // <db>-app comes FIRST (base layer), then config Secret, then the optional app-secret (wins on collision).
  expect(ctr.envFrom).toEqual([
    { secretRef: { name: "tododb-app" } },
    { secretRef: { name: "todo-env" } },
    { secretRef: { name: "todo-secret", optional: true } },
  ]);
  // TLS verification env: verify-full + a PGSSLROOTCERT at the mounted CA path — each once.
  expect(ctr.env).toEqual([
    { name: "PGSSLMODE", value: "verify-full" },
    { name: "PGSSLROOTCERT", value: "/var/run/drop/db-ca/tododb/ca.crt" },
  ]);
  // CA volume mounts ca.crt ONLY (never the CA private key), read-only, at a stable per-db path.
  expect(pod.volumes).toEqual([
    { name: "db-ca-tododb", secret: { secretName: "tododb-ca", items: [{ key: "ca.crt", path: "ca.crt" }] } },
  ]);
  expect(ctr.volumeMounts).toEqual([{ name: "db-ca-tododb", mountPath: "/var/run/drop/db-ca/tododb", readOnly: true }]);
});

test("appManifests: nothing DB-related when uses is absent", () => {
  const m = appManifests(base, { name: "todo", namespace: "ns", host: "h" });
  const pod = (m.deployment as any).spec.template.spec;
  expect(pod.volumes).toBeUndefined();
  expect(pod.containers[0].volumeMounts).toBeUndefined();
  expect(pod.containers[0].env).toBeUndefined(); // no PGSSLMODE etc.
  expect(pod.containers[0].envFrom).toEqual([{ secretRef: { name: "todo-secret", optional: true } }]); // no <db>-app
});

test("appManifests: two bound dbs → envFrom+CA per db; verify-full once; PGSSLROOTCERT = first db", () => {
  const m = appManifests({ ...base, uses: [{ database: "db1" }, { database: "db2" }] }, { name: "app", namespace: "ns", host: "h" });
  const pod = (m.deployment as any).spec.template.spec;
  const ctr = pod.containers[0];
  expect(ctr.envFrom.filter((e: any) => e.secretRef.name.endsWith("-app")).map((e: any) => e.secretRef.name)).toEqual(["db1-app", "db2-app"]);
  expect(pod.volumes.map((v: any) => v.secret.secretName)).toEqual(["db1-ca", "db2-ca"]);
  expect(ctr.volumeMounts.map((v: any) => v.mountPath)).toEqual(["/var/run/drop/db-ca/db1", "/var/run/drop/db-ca/db2"]);
  expect(ctr.env.filter((e: any) => e.name === "PGSSLMODE")).toHaveLength(1); // single-connection model
  expect(ctr.env.find((e: any) => e.name === "PGSSLROOTCERT").value).toBe("/var/run/drop/db-ca/db1/ca.crt");
});
