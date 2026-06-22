import type { SecretStore, SecretScope } from "./types.ts";

// In-memory SecretStore for tests (mirrors FakeKube/FakeBlob). Records values so tests can assert
// what WOULD be stored — but the API/CLI/MCP layers must never surface them.
export class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, Map<string, string>>(); // "ns/app" -> { KEY: value }
  readonly bindings: { scope: string; keys: string[] }[] = [];
  readonly destroyed: string[] = [];

  private k(s: SecretScope): string {
    return `${s.namespace}/${s.app}`;
  }
  private bag(s: SecretScope): Map<string, string> {
    const k = this.k(s);
    let b = this.values.get(k);
    if (!b) this.values.set(k, (b = new Map()));
    return b;
  }

  async setSecret(s: SecretScope, key: string, value: string): Promise<void> {
    this.bag(s).set(key, value);
  }
  async deleteSecret(s: SecretScope, key: string): Promise<void> {
    this.values.get(this.k(s))?.delete(key);
  }
  async listKeys(s: SecretScope): Promise<string[]> {
    return [...(this.values.get(this.k(s))?.keys() ?? [])].sort();
  }
  async ensureBinding(s: SecretScope, keys: string[]): Promise<void> {
    this.bindings.push({ scope: this.k(s), keys: [...keys].sort() });
  }
  async destroy(s: SecretScope): Promise<void> {
    this.values.delete(this.k(s));
    this.destroyed.push(this.k(s));
  }
}
