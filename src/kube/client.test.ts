import { test, expect } from "bun:test";
import { inClusterConn } from "./client.ts";

test("inClusterConn builds server/token/ca from the pod ServiceAccount", () => {
  const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT_HTTPS: "443" };
  const read = (p: string) => Buffer.from(p.endsWith("/token") ? "tok-abc\n" : "ca-pem");
  const c = inClusterConn(env, read, "/sa");
  expect(c.server).toBe("https://10.0.0.1:443");
  expect(c.token).toBe("tok-abc"); // trailing newline trimmed
  expect(c.ca?.toString()).toBe("ca-pem");
});

test("inClusterConn falls back to KUBERNETES_SERVICE_PORT and errors outside a pod", () => {
  const c = inClusterConn({ KUBERNETES_SERVICE_HOST: "h", KUBERNETES_SERVICE_PORT: "6443" }, () => Buffer.from("x"));
  expect(c.server).toBe("https://h:6443");
  expect(() => inClusterConn({}, () => Buffer.from("x"))).toThrow(/KUBERNETES_SERVICE_HOST/);
});
