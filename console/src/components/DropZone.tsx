// The publish drop zone: an unobtrusive dashed-border box + a full-page overlay that
// highlights while a folder is dragged anywhere over the window, plus a keyboard-
// accessible "choose folder" picker button (the <input webkitdirectory> fallback —
// `webkitdirectory` isn't in React's InputHTMLAttributes typing, so it's set
// imperatively on the element via a ref instead of as a JSX prop).
import { createPortal } from "react-dom";
import { useEffect } from "react";
import { Button } from "./Button.tsx";
import type { DroppedFile } from "../lib/dropFiles.ts";
import { useFolderDrop } from "../lib/useFolderDrop.ts";

export interface DropZoneProps {
  label: string;
  /** Disables the zone entirely (e.g. a publish is already in flight). */
  disabled?: boolean;
  /** 0..1 upload progress; renders a progress bar in place of the hint text when set. */
  progress?: number | null;
  onFiles: (files: DroppedFile[]) => void;
}

export function DropZone({ label, disabled = false, progress = null, onFiles }: DropZoneProps) {
  const { dragging, reading, pick, inputRef, onInputChange } = useFolderDrop(onFiles, disabled);
  const busy = disabled || reading;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Not a typed JSX attribute (see file header) — set directly on the DOM node.
    el.webkitdirectory = true;
    el.multiple = true;
  }, [inputRef]);

  return (
    <div className={`dropzone${busy ? " disabled" : ""}`}>
      <p>{reading ? "reading folder…" : label}</p>
      {progress != null ? (
        <div className="drop-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : (
        <Button size="sm" onClick={pick} disabled={busy}>
          choose folder…
        </Button>
      )}
      <input ref={inputRef} type="file" onChange={onInputChange} disabled={busy} style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
      {dragging &&
        !disabled &&
        createPortal(
          <div className="drop-overlay" aria-hidden="true">
            drop to publish
          </div>,
          document.body,
        )}
    </div>
  );
}
