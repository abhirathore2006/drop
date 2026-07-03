// Wires a page-wide drag-and-drop listener (dropping works anywhere on the page — the
// "zone" is really the whole viewport, Netlify-style) plus a hidden `<input
// webkitdirectory>` fallback for the keyboard-accessible picker button. Calls `onFiles`
// once traversal finishes; the caller decides what happens next (prompt for a name, or
// publish straight to a known site).
import { useCallback, useEffect, useRef, useState } from "react";
import { readDataTransfer, readFileList, type DroppedFile } from "./dropFiles.ts";

export interface FolderDropState {
  /** A file/folder drag is over the page — drives the full-page overlay highlight. */
  dragging: boolean;
  /** Folder traversal is in flight (reading a large drop can take a moment). */
  reading: boolean;
  /** Opens the file picker — the keyboard-accessible fallback for the drag gesture. */
  pick: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function useFolderDrop(onFiles: (files: DroppedFile[]) => void, disabled = false): FolderDropState {
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (disabled) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required for the element to accept a drop
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const items = e.dataTransfer?.items;
      if (!items) return;
      setReading(true);
      readDataTransfer(items)
        .then((files) => onFilesRef.current(files))
        .finally(() => setReading(false));
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [disabled]);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // COPY before clearing: `input.files` is a LIVE FileList in real browsers — resetting
    // `value` empties it, so reading it afterwards would see zero files (happy-dom snapshots
    // it, which is why only a real browser catches this).
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same folder again later
    if (!files.length) return;
    setReading(true);
    readFileList(files)
      .then((f) => onFilesRef.current(f))
      .finally(() => setReading(false));
  }, []);

  return { dragging, reading, pick, inputRef, onInputChange };
}
