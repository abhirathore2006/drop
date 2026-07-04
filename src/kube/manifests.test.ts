import { test, expect } from "bun:test";
import { appManifests, releaseJobManifest, tenantManifests, edgeTcpManifests } from "./manifests.ts";
import type { AppConfig } from "../app-config.ts";
import { sanitizeAppConfig } from "../app-config.ts";

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

// ---- I5: stateful (constrained volumes) ----

test("appManifests: stateful emits a Recreate-strategy Deployment (explicit replicas, no HTTPScaledObject) + a PVC + a volumeMount", () => {
  const app = sanitizeAppConfig({ image: "ecr/notes:v1", stateful: { volume: "3Gi", mount: "/data" } })!;
  const m = appManifests(app, { name: "notes", namespace: "drop-acme", host: "notes.example.com", versionId: "v1" });

  expect(m.httpScaledObject).toBeUndefined(); // can't scale to zero — no KEDA target at all

  const dm = m.deployment as any;
  expect(dm.spec.strategy).toEqual({ type: "Recreate" }); // the RWO PVC never double-attaches
  expect(dm.spec.replicas).toBe(1); // explicit — nothing else owns the replica count
  expect(dm.metadata.labels["drop.dev/stateful"]).toBe("true"); // teardown + console badge marker
  expect(dm.spec.template.metadata.labels["drop.dev/stateful"]).toBe("true"); // on the pod template too
  expect(dm.spec.selector.matchLabels["drop.dev/stateful"]).toBeUndefined(); // selector stays immutable-safe (unchanged shape)
  expect(dm.spec.template.metadata.annotations["drop.dev/version"]).toBe("v1"); // (H1) version annotation preserved

  const ctr = dm.spec.template.spec.containers[0];
  const mount = ctr.volumeMounts.find((v: any) => v.mountPath === "/data");
  expect(mount).toBeDefined();
  const vol = dm.spec.template.spec.volumes.find((v: any) => v.name === mount.name);
  expect(vol.persistentVolumeClaim.claimName).toBe("notes-data");

  const pvc = m.pvc as any;
  expect(pvc.kind).toBe("PersistentVolumeClaim");
  expect(pvc.metadata.name).toBe("notes-data");
  expect(pvc.metadata.namespace).toBe("drop-acme");
  expect(pvc.metadata.labels["drop.dev/stateful"]).toBe("true");
  expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
  expect(pvc.spec.resources.requests.storage).toBe("3Gi");
  expect(pvc.spec.storageClassName).toBeUndefined(); // namespace default StorageClass

  // Service + ingressPolicy are unaffected — still emitted normally.
  expect(m.service).toBeDefined();
  expect(m.ingressPolicy).toBeDefined();
});

test("appManifests: stateful keeps envFrom/uses-bindings, probes, and resources on the container", () => {
  const app = sanitizeAppConfig({
    image: "ecr/notes:v1",
    resources: { cpu: "1", memory: "1Gi" },
    uses: [{ database: "notesdb" }],
    healthcheck: { path: "/healthz" },
    stateful: { volume: "2Gi", mount: "/data" },
  })!;
  const m = appManifests(app, { name: "notes", namespace: "ns", host: "notes.example.com" });
  const ctr = (m.deployment as any).spec.template.spec.containers[0];
  expect(ctr.envFrom[0].secretRef.name).toBe("notesdb-app"); // DB binding preserved
  expect(ctr.readinessProbe.httpGet.path).toBe("/healthz"); // healthcheck preserved
  expect(ctr.resources.limits).toEqual({ cpu: "1", memory: "1Gi" }); // resources preserved
  // both the DB-CA volume mount AND the stateful data mount are present
  expect(ctr.volumeMounts.some((v: any) => v.mountPath === "/data")).toBe(true);
  expect(ctr.volumeMounts.some((v: any) => v.mountPath.includes("notesdb"))).toBe(true);
});

test("appManifests: a non-stateful app is completely unaffected (no pvc, normal HTTPScaledObject, no stateful label)", () => {
  const m = appManifests(base, { name: "x", namespace: "ns", host: "x.example.com" });
  expect(m.pvc).toBeUndefined();
  expect(m.httpScaledObject).toBeDefined();
  expect((m.deployment as any).metadata.labels["drop.dev/stateful"]).toBeUndefined();
  expect((m.deployment as any).spec.strategy).toBeUndefined();
  expect((m.deployment as any).spec.replicas).toBeUndefined(); // KEDA still owns it
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

test("tenantManifests: ResourceQuota gains requests.storage + a PVC-count dim (I5 / Future.md item 10)", () => {
  const m = tenantManifests("drop-t-x");
  const hard = (m.resourceQuota as any).spec.hard;
  expect(hard["requests.storage"]).toBe("20Gi"); // static platform default
  expect(hard["count/persistentvolumeclaims"]).toBe("10");
  // an explicit override (future org-aware wiring) is honored
  const overridden = tenantManifests("drop-t-x", { storageBudget: "100Gi", maxPvcs: 25 });
  const hard2 = (overridden.resourceQuota as any).spec.hard;
  expect(hard2["requests.storage"]).toBe("100Gi");
  expect(hard2["count/persistentvolumeclaims"]).toBe("25");
  // the pre-existing cpu/memory/pods/services dims are untouched
  expect(hard2["limits.cpu"]).toBe("4");
  expect(hard2["count/pods"]).toBe("20");
});

test("tenantManifests: the edge-tcp allow rule appears ONLY for exposed workloads (A2b)", () => {
  // No exposed workloads → empty (default-deny stands, no allow hole).
  expect(tenantManifests("drop-t-x").edgeTcpPolicies).toEqual([]);
  expect(tenantManifests("drop-t-x", { blockedEgressCidrs: [] }).edgeTcpPolicies).toEqual([]);

  const m = tenantManifests("drop-t-x", {
    edgeTcp: { namespace: "drop-system", workloads: [{ name: "pg", kind: "database", port: 5432 }, { name: "api", kind: "app", port: 8080 }] },
  });
  expect(m.edgeTcpPolicies).toHaveLength(2);
  const pg = m.edgeTcpPolicies.find((p: any) => p.metadata.name === "pg-allow-edge-tcp") as any;
  expect(pg.metadata.labels["drop.dev/allow"]).toBe("edge-tcp");
  expect(pg.spec.podSelector.matchLabels["cnpg.io/cluster"]).toBe("pg"); // DB pods use the cnpg label
  expect(pg.spec.ingress[0].ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  // source = edge-tcp pods in the platform namespace (both selectors on the SAME from[] element = AND)
  const from = pg.spec.ingress[0].from[0];
  expect(from.namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("drop-system");
  expect(from.podSelector.matchLabels["app.kubernetes.io/component"]).toBe("edge-tcp");
  const apiP = m.edgeTcpPolicies.find((p: any) => p.metadata.name === "api-allow-edge-tcp") as any;
  expect(apiP.spec.podSelector.matchLabels["app.kubernetes.io/name"]).toBe("api"); // app pods use the name label
  expect(apiP.spec.ingress[0].ports).toEqual([{ protocol: "TCP", port: 8080 }]);
});

test("edgeTcpManifests: Deployment binds the whole range; Service publishes shared + active ports", () => {
  const m = edgeTcpManifests({
    name: "drop-edge-tcp",
    namespace: "drop-system",
    image: "ecr/drop:v1",
    sharedPorts: [{ port: 5432, protocol: "postgres" }],
    portRange: { from: 7000, to: 7099 },
    activeDynamicPorts: [7000, 7003],
    serviceType: "LoadBalancer",
    annotations: { "service.beta.kubernetes.io/aws-load-balancer-type": "external" },
  });
  const dep = m.deployment as any;
  expect(dep.spec.template.metadata.labels["app.kubernetes.io/component"]).toBe("edge-tcp");
  expect(dep.spec.template.spec.containers[0].command).toEqual(["node", "dist/edge-tcp.js"]);
  const env = dep.spec.template.spec.containers[0].env as { name: string; value: string }[];
  expect(env.find((e) => e.name === "DROP_TCP_SHARED_PORTS")!.value).toBe("5432:postgres");
  // the WHOLE range is bound at boot, so a freshly-allocated port is already listening (no restart)
  expect(env.find((e) => e.name === "DROP_TCP_DYNAMIC_RANGE")!.value).toBe("7000-7099");
  const svc = m.service as any;
  expect(svc.spec.type).toBe("LoadBalancer");
  expect(svc.metadata.annotations["service.beta.kubernetes.io/aws-load-balancer-type"]).toBe("external");
  // Service publishes only shared + ACTIVE dynamic ports (NLB listener quota is scarce)
  expect(svc.spec.ports.map((p: any) => p.port).sort((a: number, b: number) => a - b)).toEqual([5432, 7000, 7003]);
  // ClusterIP is the local default
  expect((edgeTcpManifests({ name: "e", namespace: "n", image: "i", sharedPorts: [], portRange: { from: 7000, to: 7099 } }).service as any).spec.type).toBe("ClusterIP");
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

test("appManifests: via:pooler (I3) overrides PGHOST at the <db>-pooler-rw Service (container env wins over envFrom)", () => {
  const m = appManifests(
    { ...base, uses: [{ database: "tododb", via: "pooler" }] },
    { name: "todo", namespace: "drop-acme", host: "todo.drop.example.com" },
  );
  const ctr = (m.deployment as any).spec.template.spec.containers[0];
  // envFrom still layers the <db>-app creds; PGHOST is a CONTAINER env (wins over any envFrom PGHOST).
  expect(ctr.envFrom[0]).toEqual({ secretRef: { name: "tododb-app" } });
  expect(ctr.env).toEqual([
    { name: "PGSSLMODE", value: "verify-full" },
    { name: "PGSSLROOTCERT", value: "/var/run/drop/db-ca/tododb/ca.crt" },
    { name: "PGHOST", value: "tododb-pooler-rw" },
  ]);
  // without via:pooler there is NO PGHOST override (the app uses the primary via its own connection).
  const noPooler = appManifests({ ...base, uses: [{ database: "tododb" }] }, { name: "todo", namespace: "ns", host: "h" });
  const env = (noPooler.deployment as any).spec.template.spec.containers[0].env;
  expect(env.find((e: any) => e.name === "PGHOST")).toBeUndefined();
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

// ---- L1: healthcheck probes ----

test("appManifests: absent healthcheck → default TCP-socket readiness probe on the container port, no liveness", () => {
  const ctr = (appManifests(base, { name: "x", namespace: "ns", host: "h" }).deployment as any).spec.template.spec.containers[0];
  expect(ctr.readinessProbe).toEqual({ tcpSocket: { port: 8080 }, periodSeconds: 10, timeoutSeconds: 2 });
  expect(ctr.livenessProbe).toBeUndefined(); // no honest liveness signal without a healthcheck
});

test("appManifests: healthcheck → HTTP readiness + liveness on the same endpoint with parsed bounds", () => {
  const app = sanitizeAppConfig({ image: "x:1", services: [{ internal_port: 8080 }], healthcheck: { path: "/healthz", interval: "10s", timeout: "2s", grace: "15s" } })!;
  const ctr = (appManifests(app, { name: "x", namespace: "ns", host: "h" }).deployment as any).spec.template.spec.containers[0];
  expect(ctr.readinessProbe).toEqual({ httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10, timeoutSeconds: 2, initialDelaySeconds: 15 });
  expect(ctr.livenessProbe).toEqual({ httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10, timeoutSeconds: 2, initialDelaySeconds: 15, failureThreshold: 3 });
});

// ---- L1: release Job ----

test("releaseJobManifest: shell-form command, backoffLimit 0, Never, deterministic name, envFrom/volumes parity with the app container", () => {
  const app = sanitizeAppConfig({
    image: "todo:1",
    env: { LOG_LEVEL: "info" },
    uses: [{ database: "tododb" }],
    release: "npm run migrate",
  })!;
  const job = releaseJobManifest(app, { name: "todo", namespace: "drop-acme", host: "", versionId: "v_1" }) as any;
  expect(job.kind).toBe("Job");
  expect(job.metadata.name).toBe("todo-release-v_1"); // deterministic, version-scoped
  expect(job.metadata.labels).toMatchObject({ "drop.dev/workload": "todo", "drop.dev/job": "release" });
  expect(job.spec.backoffLimit).toBe(0);
  expect(job.spec.template.spec.restartPolicy).toBe("Never");
  expect(job.spec.template.metadata.labels["app.kubernetes.io/name"]).toBe("todo-release-v_1"); // log lookup
  const ctr = job.spec.template.spec.containers[0];
  expect(ctr.command).toEqual(["/bin/sh", "-c", "npm run migrate"]); // string → shell-form
  expect(ctr.ports).toBeUndefined(); // a Job isn't routed
  // envFrom + DB env + CA volumes are IDENTICAL to the app container (same secrets/bindings)
  const appCtr = (appManifests(app, { name: "todo", namespace: "drop-acme", host: "h" }).deployment as any).spec.template.spec.containers[0];
  expect(ctr.envFrom).toEqual(appCtr.envFrom);
  expect(ctr.env).toEqual(appCtr.env);
  expect(job.spec.template.spec.volumes).toEqual([
    { name: "db-ca-tododb", secret: { secretName: "tododb-ca", items: [{ key: "ca.crt", path: "ca.crt" }] } },
  ]);
});

// ---- L1: processes (web + workers) ----

test("appManifests: web + worker → web keeps Service/HSO; worker is a plain Deployment (no Service/HSO), min≥1", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    scale: { min: 0, max: 3 },
    processes: {
      web: { command: "node server.js" },
      worker: { command: "node worker.js", scale: { min: 0, max: 2 }, resources: { cpu: "250m" } },
    },
  })!;
  const m = appManifests(app, { name: "app", namespace: "ns", host: "app.example.com" });
  // web: today's treatment
  expect((m.deployment as any).metadata.name).toBe("app");
  expect((m.deployment as any).spec.template.spec.containers[0].command).toEqual(["/bin/sh", "-c", "node server.js"]);
  expect((m.httpScaledObject as any).spec.replicas).toEqual({ min: 0, max: 3 });
  expect(m.service).toBeDefined();
  // worker: plain Deployment named <app>-<process>, static replicas = min (0 clamped to 1), no Service/HSO
  expect(m.workers).toHaveLength(1);
  const w = m.workers![0]!;
  expect(w.name).toBe("app-worker");
  expect((w.deployment as any).metadata.name).toBe("app-worker");
  expect((w.deployment as any).spec.replicas).toBe(1); // min≥1 enforced (no wake source for a worker)
  expect((w.deployment as any).metadata.labels["drop.dev/process"]).toBe("worker");
  expect((w.deployment as any).spec.template.spec.containers[0].command).toEqual(["/bin/sh", "-c", "node worker.js"]);
  expect((w.deployment as any).spec.template.spec.containers[0].resources.limits).toEqual({ cpu: "250m" }); // per-process override
  expect((w.deployment as any).spec.template.spec.containers[0].ports).toBeUndefined(); // workers aren't routed
  // workers get no probes (not a traffic target)
  expect((w.deployment as any).spec.template.spec.containers[0].readinessProbe).toBeUndefined();
});

test("appManifests: worker-only app has NO web Deployment / Service / HSO", () => {
  const app = sanitizeAppConfig({ image: "batch:1", processes: { worker: { command: "node w.js" } } })!;
  const m = appManifests(app, { name: "batch", namespace: "ns", host: "h" });
  expect(m.deployment).toBeUndefined();
  expect(m.service).toBeUndefined();
  expect(m.httpScaledObject).toBeUndefined();
  expect(m.ingressPolicy).toBeUndefined();
  expect(m.workers).toHaveLength(1);
  expect(m.workers![0]!.name).toBe("batch-worker");
});

test("appManifests: absent processes → unchanged single-process shape (web only, no workers)", () => {
  const m = appManifests(base, { name: "x", namespace: "ns", host: "h" });
  expect(m.deployment).toBeDefined();
  expect(m.service).toBeDefined();
  expect(m.httpScaledObject).toBeDefined();
  expect(m.workers).toBeUndefined(); // zero migration: no worker set for a classic app
  expect((m.deployment as any).spec.template.spec.containers[0].command).toBeUndefined(); // image entrypoint
});

// ---- H1: pod-template version annotation (same-tag redeploy/rollback still rolls pods) ----

test("appManifests: versionId stamps drop.dev/version on the web AND worker pod templates, and changes when versionId changes", () => {
  const app = sanitizeAppConfig({ image: "app:1", processes: { web: {}, worker: { command: "w" } } })!;
  const noVersion = appManifests(app, { name: "app", namespace: "ns", host: "h" });
  expect((noVersion.deployment as any).spec.template.metadata.annotations).toBeUndefined();
  expect((noVersion.workers![0]!.deployment as any).spec.template.metadata.annotations).toBeUndefined();

  const v1 = appManifests(app, { name: "app", namespace: "ns", host: "h", versionId: "v_1" });
  expect((v1.deployment as any).spec.template.metadata.annotations).toEqual({ "drop.dev/version": "v_1" });
  expect((v1.workers![0]!.deployment as any).spec.template.metadata.annotations).toEqual({ "drop.dev/version": "v_1" });

  // same image, DIFFERENT versionId (e.g. a rollback, or a same-tag redeploy) → the annotation
  // — and thus the pod template — differs, which is exactly what makes kube roll the pods.
  const v2 = appManifests(app, { name: "app", namespace: "ns", host: "h", versionId: "v_2" });
  expect((v2.deployment as any).spec.template.metadata.annotations).toEqual({ "drop.dev/version": "v_2" });
  expect(v2.deployment).not.toEqual(v1.deployment);
});

test("appManifests: shared config Secret + DB binding reach every process (web + worker)", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    env: { LOG_LEVEL: "info" },
    uses: [{ database: "tododb" }],
    processes: { web: {}, worker: { command: "w" } },
  })!;
  const m = appManifests(app, { name: "app", namespace: "ns", host: "h" });
  const webEnvFrom = (m.deployment as any).spec.template.spec.containers[0].envFrom;
  const workerEnvFrom = (m.workers![0]!.deployment as any).spec.template.spec.containers[0].envFrom;
  expect(workerEnvFrom).toEqual(webEnvFrom); // identical secrets/bindings across processes
  expect((m.secret as any).stringData.LOG_LEVEL).toBe("info"); // one shared <name>-env Secret
});

// ---- H2: schedule (cron) ----

test("appManifests: schedule → a CronJob (batch/v1), Forbid concurrency, history limits, one retry, Never restart", () => {
  const app = sanitizeAppConfig({ image: "cron:1", schedule: "0 3 * * *" })!;
  const m = appManifests(app, { name: "nightly", namespace: "drop-acme", host: "nightly.drop.example.com" });
  const cj = m.cronJob as any;
  expect(cj.apiVersion).toBe("batch/v1");
  expect(cj.kind).toBe("CronJob");
  expect(cj.metadata).toMatchObject({ name: "nightly", namespace: "drop-acme" });
  expect(cj.metadata.labels["drop.dev/kind"]).toBe("cron"); // distinguishes it from a Deployment for teardown/stop-start
  expect(cj.metadata.labels["drop.dev/workload"]).toBe("nightly");
  expect(cj.spec.schedule).toBe("0 3 * * *");
  expect(cj.spec.concurrencyPolicy).toBe("Forbid");
  expect(cj.spec.successfulJobsHistoryLimit).toBe(3);
  expect(cj.spec.failedJobsHistoryLimit).toBe(3);
  expect(cj.spec.startingDeadlineSeconds).toBe(120);
  expect(cj.spec.jobTemplate.spec.backoffLimit).toBe(1);
  expect(cj.spec.jobTemplate.spec.template.spec.restartPolicy).toBe("Never");
});

test("appManifests: schedule → NO Deployment/Service/HTTPScaledObject/ingressPolicy/workers", () => {
  const app = sanitizeAppConfig({ image: "cron:1", schedule: "0 3 * * *" })!;
  const m = appManifests(app, { name: "nightly", namespace: "ns", host: "h" });
  expect(m.deployment).toBeUndefined();
  expect(m.service).toBeUndefined();
  expect(m.httpScaledObject).toBeUndefined();
  expect(m.ingressPolicy).toBeUndefined();
  expect(m.workers).toBeUndefined();
  expect(m.cronJob).toBeDefined();
});

test("appManifests: cron container parity with the web path — image, uses+CA, write-only secret, resources, securityContext", () => {
  const shared = { image: "cron:1", env: { LOG_LEVEL: "info" }, uses: [{ database: "tododb" }], resources: { cpu: "0.5", memory: "512Mi" } };
  const cronApp = sanitizeAppConfig({ ...shared, schedule: "0 3 * * *", command: "python job.py" })!;
  const webApp = sanitizeAppConfig(shared)!;
  const cronCtr = (appManifests(cronApp, { name: "nightly", namespace: "drop-acme", host: "h" }).cronJob as any).spec.jobTemplate.spec.template.spec.containers[0];
  const webCtr = (appManifests(webApp, { name: "nightly", namespace: "drop-acme", host: "h" }).deployment as any).spec.template.spec.containers[0];
  expect(cronCtr.image).toBe(webCtr.image);
  expect(cronCtr.envFrom).toEqual(webCtr.envFrom); // tododb-app, nightly-env, nightly-secret (optional)
  expect(cronCtr.env).toEqual(webCtr.env); // PGSSLMODE/PGSSLROOTCERT, identical to the web container
  expect(cronCtr.resources).toEqual(webCtr.resources);
  expect(cronCtr.securityContext).toEqual(webCtr.securityContext);
  expect(cronCtr.command).toEqual(["/bin/sh", "-c", "python job.py"]); // app.command, shell-form
  expect(cronCtr.ports).toBeUndefined(); // a CronJob isn't routed
  expect(cronCtr.readinessProbe).toBeUndefined(); // schedule+healthcheck is rejected at assertProcesses
  const cronPod = (appManifests(cronApp, { name: "nightly", namespace: "drop-acme", host: "h" }).cronJob as any).spec.jobTemplate.spec.template.spec;
  expect(cronPod.volumes).toEqual([{ name: "db-ca-tododb", secret: { secretName: "tododb-ca", items: [{ key: "ca.crt", path: "ca.crt" }] } }]);
});

test("appManifests: schedule keeps the shared <name>-env config Secret", () => {
  const app = sanitizeAppConfig({ image: "cron:1", schedule: "0 3 * * *", env: { LOG_LEVEL: "info" } })!;
  const m = appManifests(app, { name: "nightly", namespace: "ns", host: "h" });
  expect((m.secret as any).stringData.LOG_LEVEL).toBe("info");
});

test("appManifests: schedule stamps drop.dev/version on the CronJob's pod template (same rollout-forcing mechanism as the web path)", () => {
  const app = sanitizeAppConfig({ image: "cron:1", schedule: "0 3 * * *" })!;
  const noVersion = appManifests(app, { name: "nightly", namespace: "ns", host: "h" });
  expect((noVersion.cronJob as any).spec.jobTemplate.spec.template.metadata.annotations).toBeUndefined();
  const versioned = appManifests(app, { name: "nightly", namespace: "ns", host: "h", versionId: "v_1" });
  expect((versioned.cronJob as any).spec.jobTemplate.spec.template.metadata.annotations).toEqual({ "drop.dev/version": "v_1" });
});

// ---- L1b: queue-scaled workers (KEDA on Valkey lists) ----

test("appManifests: scale_on worker emits a redis-trigger ScaledObject + TriggerAuthentication alongside its Deployment", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    uses: [{ cache: "sessions" }],
    processes: { web: {}, worker: { command: "node worker.js", scale_on: { queue: "jobs", target: 10 } } },
  })!;
  const m = appManifests(app, { name: "app", namespace: "drop-acme", host: "app.example.com" });
  expect(m.workers).toHaveLength(1);
  const w = m.workers![0]!;
  expect(w.name).toBe("app-worker");

  // Deployment: replicas = min (default 0 for a scale_on worker) as the INITIAL value; KEDA takes over.
  expect((w.deployment as any).spec.replicas).toBe(0);

  const so = w.scaledObject as any;
  expect(so.apiVersion).toBe("keda.sh/v1alpha1");
  expect(so.kind).toBe("ScaledObject");
  expect(so.metadata).toMatchObject({ name: "app-worker", namespace: "drop-acme" });
  expect(so.spec.scaleTargetRef).toEqual({ name: "app-worker", kind: "Deployment" });
  expect(so.spec.minReplicaCount).toBe(0);
  expect(so.spec.maxReplicaCount).toBe(3); // scale_on default max
  expect(so.spec.triggers).toEqual([
    {
      type: "redis",
      metadata: { address: "sessions.drop-acme.svc.cluster.local:6379", listName: "jobs", listLength: "10" },
      authenticationRef: { name: "app-worker" },
    },
  ]);

  const ta = w.triggerAuth as any;
  expect(ta.apiVersion).toBe("keda.sh/v1alpha1");
  expect(ta.kind).toBe("TriggerAuthentication");
  expect(ta.metadata).toMatchObject({ name: "app-worker", namespace: "drop-acme" });
  expect(ta.spec.secretTargetRef).toEqual([{ parameter: "password", name: "sessions-cache", key: "password" }]);
});

test("appManifests: a plain worker (no scale_on) has NO ScaledObject/TriggerAuthentication", () => {
  const app = sanitizeAppConfig({ image: "app:1", processes: { web: {}, worker: { command: "w" } } })!;
  const m = appManifests(app, { name: "app", namespace: "ns", host: "h" });
  const w = m.workers![0]!;
  expect(w.scaledObject).toBeUndefined();
  expect(w.triggerAuth).toBeUndefined();
  expect((w.deployment as any).spec.replicas).toBe(1); // unchanged plain-worker min≥1 default
});

test("appManifests: scale_on worker respects an explicit scale.min/max (min may be >0)", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    uses: [{ cache: "sessions" }],
    processes: { worker: { command: "w", scale: { min: 1, max: 5 }, scale_on: { queue: "jobs", target: 20 } } },
  })!;
  const m = appManifests(app, { name: "app", namespace: "ns", host: "h" });
  const w = m.workers![0]!;
  expect((w.deployment as any).spec.replicas).toBe(1);
  expect((w.scaledObject as any).spec.minReplicaCount).toBe(1);
  expect((w.scaledObject as any).spec.maxReplicaCount).toBe(5);
  expect((w.scaledObject as any).spec.triggers[0].metadata.listLength).toBe("20");
});

test("appManifests: multi-cache uses → the ScaledObject address points at the FIRST cache binding", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    uses: [{ database: "db1" }, { cache: "sessions" }, { cache: "jobs-cache" }],
    processes: { worker: { command: "w", scale_on: { queue: "jobs", target: 10 } } },
  })!;
  const m = appManifests(app, { name: "app", namespace: "drop-acme", host: "h" });
  const so = m.workers![0]!.scaledObject as any;
  expect(so.spec.triggers[0].metadata.address).toBe("sessions.drop-acme.svc.cluster.local:6379");
});

test("appManifests: two scale_on workers each get their OWN uniquely-named ScaledObject/TriggerAuthentication", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    uses: [{ cache: "sessions" }],
    processes: {
      emailer: { command: "e", scale_on: { queue: "emails", target: 5 } },
      thumbnailer: { command: "t", scale_on: { queue: "thumbs", target: 20 } },
    },
  })!;
  const m = appManifests(app, { name: "app", namespace: "ns", host: "h" });
  expect(m.workers).toHaveLength(2);
  const names = m.workers!.map((w) => w.name).sort();
  expect(names).toEqual(["app-emailer", "app-thumbnailer"]);
  for (const w of m.workers!) {
    expect((w.scaledObject as any).metadata.name).toBe(w.name);
    expect((w.triggerAuth as any).metadata.name).toBe(w.name);
  }
  const emailer = m.workers!.find((w) => w.process === "emailer")!;
  expect((emailer.scaledObject as any).spec.triggers[0].metadata.listName).toBe("emails");
  const thumbnailer = m.workers!.find((w) => w.process === "thumbnailer")!;
  expect((thumbnailer.scaledObject as any).spec.triggers[0].metadata.listName).toBe("thumbs");
});

test("appManifests: scale_on on the web process throws (assertProcesses re-enforced at the manifest layer)", () => {
  const app = sanitizeAppConfig({
    image: "app:1",
    uses: [{ cache: "sessions" }],
    processes: { web: { scale_on: { queue: "jobs", target: 10 } } },
  })!;
  expect(() => appManifests(app, { name: "app", namespace: "ns", host: "h" })).toThrow(/scale_on.*web process/i);
});

test("appManifests: scale_on without a {cache} binding throws (assertProcesses re-enforced at the manifest layer)", () => {
  const app = sanitizeAppConfig({ image: "app:1", processes: { worker: { command: "w", scale_on: { queue: "jobs", target: 10 } } } })!;
  expect(() => appManifests(app, { name: "app", namespace: "ns", host: "h" })).toThrow(/requires at least one \{cache\}/);
});

test("appManifests: schedule + processes/explicit non-default services/healthcheck throw (exclusivity re-enforced at the manifest layer)", () => {
  const ctx = { name: "x", namespace: "ns", host: "h" };
  expect(() => appManifests(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", processes: { worker: { command: "w" } } })!, ctx)).toThrow(/schedule/i);
  expect(() => appManifests(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", services: [{ internal_port: 9090 }] })!, ctx)).toThrow(/schedule/i);
  expect(() => appManifests(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *", healthcheck: { path: "/h" } })!, ctx)).toThrow(/schedule/i);
  // implicit default service alongside schedule is fine (no explicit services declared)
  expect(() => appManifests(sanitizeAppConfig({ image: "x:1", schedule: "0 3 * * *" })!, ctx)).not.toThrow();
});
