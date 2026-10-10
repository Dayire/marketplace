"use client";
import { useId } from "react";
import { Check, Link2, X } from "lucide-react";
import { XIcon } from "@/components/layout/social-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { xShareUrl } from "./share-links";
import type { ShareTarget } from "./share-menu";
import { COPY_STATUS_TEXT, useCopyLink } from "./use-copy-link";

const DISMISSED_KEY = "realms-market-share-prompt-dismissed";

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Whether the seller already dismissed the prompt for this listing. */
export function isSharePromptDismissed(listingId: string) {
  if (typeof window === "undefined") return false;
  return readDismissed().includes(listingId);
}

/** Remembers a dismissal on this device; the last 50 listings are kept. */
export function rememberSharePromptDismissed(listingId: string) {
  if (typeof window === "undefined") return;
  try {
    const ids = [...readDismissed().filter((id) => id !== listingId), listingId].slice(-50);
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable; the dismissal then lasts for this visit.
  }
}

/**
 * Shown to a seller once their listing is indexed. Preview data is cached for
 * up to a minute, so the copy does not promise the price is already there.
 */
export function ListingSharePrompt({
  target,
  price,
  onDismiss,
  className,
}: {
  target: ShareTarget;
  /** Display price including currency, e.g. "27.16 STRK". */
  price: string;
  onDismiss: () => void;
  className?: string;
}) {
  const { status, copy } = useCopyLink(target.url);
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={cn("realm-panel relative space-y-3 p-4 pr-12 sm:p-5 sm:pr-14", className)}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-11"
        aria-label="Dismiss share suggestion"
        onClick={onDismiss}
      >
        <X aria-hidden />
      </Button>
      <div className="space-y-1">
        <h2 id={titleId} className="text-base leading-tight">
          Your listing is live
        </h2>
        <p className="text-sm text-muted-foreground">
          Share it. Link previews show the artwork and your price of{" "}
          <span className="whitespace-nowrap text-foreground">{price}</span>, usually
          within a minute of listing.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11" onClick={() => void copy()}>
          {status === "copied" ? <Check aria-hidden /> : <Link2 aria-hidden />}
          Copy link
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <a href={xShareUrl(target)} target="_blank" rel="noopener noreferrer">
            <XIcon className="size-4" />
            Post on X
          </a>
        </Button>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "text-xs",
            status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {COPY_STATUS_TEXT[status]}
        </span>
      </div>
    </section>
  );
}
