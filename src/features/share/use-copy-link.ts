"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

const RESET_AFTER_MS = 2500;

/** Copies a link to the clipboard and reports the outcome for a live region. */
export function useCopyLink(url: string) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    timer.current = setTimeout(() => setStatus("idle"), RESET_AFTER_MS);
  }, [url]);

  return { status, copy };
}

export const COPY_STATUS_TEXT: Record<CopyStatus, string> = {
  idle: "",
  copied: "Link copied",
  failed: "Couldn't copy. Copy the page address instead.",
};
