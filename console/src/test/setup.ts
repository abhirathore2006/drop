// Per-file DOM harness for console component tests under plain `bun test`.
//
// Deliberately NOT a bunfig preload: registering happy-dom globally would replace fetch /
// Request / Response for the whole run and could disturb the node-side API/edge tests that
// share the process. Instead every console test file imports this module FIRST and calls
// setupDom() at module scope — the DOM is registered eagerly by ./register-dom.ts (so
// module-scope imports like @testing-library/* see it), re-registered in beforeAll (files
// run sequentially; an earlier file's afterAll may have unregistered it), and torn down in
// afterAll so non-DOM test files see pristine globals.
//
// NOTE for test authors: use the queries returned by render() rather than the global
// `screen` — `screen` binds document.body once at module load and goes stale when the DOM
// is re-registered between files.
import { register, unregister } from "./register-dom.ts";
import { afterAll, afterEach, beforeAll } from "bun:test";
import { cleanup, fireEvent } from "@testing-library/react";

export function setupDom(): void {
  beforeAll(register);
  afterEach(cleanup);
  afterAll(unregister);
}

/** Change a controlled input's value in a way React sees in EVERY environment.
 *
 *  Under bun + happy-dom, react-dom's `input`-event feature detection lands on its
 *  focus-watch polyfill path, where a bare fireEvent.change never reaches onChange.
 *  Focusing first arms the polyfill's value watcher, and the trailing keyup makes it
 *  diff the tracked value; in a regular DOM the change event fires onChange directly
 *  and the extra events are no-ops — so this is safe (and single-fire) in both. */
export function changeValue(input: HTMLElement, value: string): void {
  (input as HTMLInputElement).focus();
  fireEvent.focusIn(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyUp(input, { key: "Unidentified" });
}
