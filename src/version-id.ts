import { randomBytes } from "node:crypto";

/** Lexicographically sortable version id: "v_<unixMillis padded>_<rand>". */
export function newVersionId(now: Date = new Date()): string {
  const ms = now.getTime().toString().padStart(16, "0");
  return `v_${ms}_${randomBytes(4).toString("hex")}`;
}
