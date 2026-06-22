import { test, expect } from "bun:test";
import { externalSecret } from "./eso.ts";
import { AwsSecretsManagerStore, type EsoApplier, type SmClient } from "./aws-store.ts";

const scope = { owner: "alice@example.com", app: "billing", namespace: "drop-t-alice" };

test("externalSecret: explicit per-key remoteRefs targeting <app>-secret", () => {
  const es = externalSecret({
    name: "billing-secret",
    namespace: "drop-t-alice",
    storeName: "floci",
    refs: [
      { key: "API_KEY", remoteName: "drop/drop-t-alice/billing/API_KEY" },
      { key: "DB_URL", remoteName: "drop/drop-t-alice/billing/DB_URL" },
    ],
  }) as any;
  expect(es.apiVersion).toBe("external-secrets.io/v1");
  expect(es.kind).toBe("ExternalSecret");
  expect(es.spec.secretStoreRef).toEqual({ name: "floci", kind: "ClusterSecretStore" });
  expect(es.spec.target).toEqual({ name: "billing-secret", creationPolicy: "Owner" });
  expect(es.spec.data).toEqual([
    { secretKey: "API_KEY", remoteRef: { key: "drop/drop-t-alice/billing/API_KEY" } },
    { secretKey: "DB_URL", remoteRef: { key: "drop/drop-t-alice/billing/DB_URL" } },
  ]);
});

function fakes() {
  const sent: { type: string; input: any }[] = [];
  const applied: { ns: string; n: string; data: any }[] = [];
  const deletedEs: string[] = [];
  const client: SmClient = { async send(cmd: any) { sent.push({ type: cmd.constructor.name, input: cmd.input }); return {}; } };
  const kube: EsoApplier = {
    async applyExternalSecret(ns, n, obj: any) { applied.push({ ns, n, data: obj.spec.data }); },
    async deleteExternalSecret(ns, n) { deletedEs.push(`${ns}/${n}`); },
    async deleteSecretObject() {},
  };
  return { sent, applied, deletedEs, client, kube };
}

test("AwsSecretsManagerStore: per-key SM write at drop/<ns>/<app>/<KEY>", async () => {
  const { sent, client, kube } = fakes();
  const store = new AwsSecretsManagerStore({ region: "us-east-1", storeName: "floci", pathPrefix: "drop", kube, client });
  await store.setSecret(scope, "API_KEY", "v1");
  expect(sent[0].type).toBe("CreateSecretCommand");
  expect(sent[0].input.Name).toBe("drop/drop-t-alice/billing/API_KEY");
  expect(sent[0].input.SecretString).toBe("v1");
});

test("AwsSecretsManagerStore: existing secret → PutSecretValue (no merge of siblings)", async () => {
  const sent: string[] = [];
  const client: SmClient = {
    async send(cmd: any) {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "CreateSecretCommand") {
        const e: any = new Error("exists");
        e.name = "ResourceExistsException";
        throw e;
      }
      return {};
    },
  };
  const { kube } = fakes();
  const store = new AwsSecretsManagerStore({ region: "us-east-1", storeName: "floci", pathPrefix: "drop", kube, client });
  await store.setSecret(scope, "API_KEY", "v2");
  expect(sent).toEqual(["CreateSecretCommand", "PutSecretValueCommand"]);
});

test("AwsSecretsManagerStore: ensureBinding writes/removes the ExternalSecret", async () => {
  const { applied, deletedEs, client, kube } = fakes();
  const store = new AwsSecretsManagerStore({ region: "us-east-1", storeName: "floci", pathPrefix: "drop", kube, client });
  await store.ensureBinding(scope, ["API_KEY"]);
  expect(applied[0]).toEqual({ ns: "drop-t-alice", n: "billing-secret", data: [{ secretKey: "API_KEY", remoteRef: { key: "drop/drop-t-alice/billing/API_KEY" } }] });
  await store.ensureBinding(scope, []); // no keys → remove the ExternalSecret (ESO drops the Secret)
  expect(deletedEs).toContain("drop-t-alice/billing-secret");
});
