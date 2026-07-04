import { test, expect } from "bun:test";
import { bucketPrefix, prefixScopedPolicy } from "./types.ts";

test("bucketPrefix: namespace-first, name-scoped, trailing slash", () => {
  expect(bucketPrefix("drop-t-abc", "avatars")).toBe("buckets/drop-t-abc/avatars/");
});

// The critical isolation guarantee: two tenants' prefixes NEVER overlap, and the rendered IAM
// policy grants disjoint object ARNs + disjoint list-prefix conditions. This is the table-test the
// plan demands — the prod aws-iam store MUST render prefixScopedPolicy() so the guarantee holds.
test("ISOLATION: two tenants get disjoint prefixes AND disjoint policy grants", () => {
  const bucket = "platform-bucket";
  const tenants = [
    { ns: "drop-t-alice", name: "uploads" },
    { ns: "drop-t-bob", name: "uploads" }, // same bucket name, different tenant namespace
  ];

  const prefixes = tenants.map((t) => bucketPrefix(t.ns, t.name));
  expect(prefixes[0]).not.toBe(prefixes[1]);
  // Neither prefix is a prefix of the other → no path-traversal overlap.
  expect(prefixes[1]!.startsWith(prefixes[0]!)).toBe(false);
  expect(prefixes[0]!.startsWith(prefixes[1]!)).toBe(false);

  const policies = prefixes.map((p) => prefixScopedPolicy(bucket, p));

  const objectArns = policies.map((pol) => pol.Statement.find((s) => s.Sid === "TenantObjectAccess")!.Resource[0]!);
  expect(objectArns[0]).toBe(`arn:aws:s3:::${bucket}/${prefixes[0]}*`);
  expect(objectArns[0]).not.toBe(objectArns[1]);

  const listPrefixes = policies.map((pol) => pol.Statement.find((s) => s.Sid === "TenantListScoped")!.Condition!.StringLike!["s3:prefix"]![0]!);
  expect(listPrefixes[0]).toBe(`${prefixes[0]}*`);
  expect(listPrefixes[0]).not.toBe(listPrefixes[1]);

  // Cross-check: tenant A's object grant must NOT authorize any key under tenant B's prefix. The ARN
  // pattern is `<A-prefix>*`, and B's prefix is not under A's prefix, so B's keys fall outside it.
  expect(prefixes[1]!.startsWith(objectArns[0]!.split("/").slice(1).join("/").replace(/\*$/, ""))).toBe(false);
});

test("prefixScopedPolicy: only Get/Put/Delete on objects + scoped ListBucket, nothing global", () => {
  const pol = prefixScopedPolicy("b", "buckets/ns/x/");
  const obj = pol.Statement.find((s) => s.Sid === "TenantObjectAccess")!;
  expect(obj.Action.sort()).toEqual(["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]);
  const list = pol.Statement.find((s) => s.Sid === "TenantListScoped")!;
  expect(list.Action).toEqual(["s3:ListBucket"]);
  expect(list.Resource).toEqual(["arn:aws:s3:::b"]); // bucket-level, but CONDITIONED to the prefix
  expect(list.Condition!.StringLike!["s3:prefix"]).toEqual(["buckets/ns/x/*"]);
});
