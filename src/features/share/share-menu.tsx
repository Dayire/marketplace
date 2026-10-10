"use client";
import { useSyncExternalStore } from "react";
import { Check, Link2, Share, Share2 } from "lucide-react";
import { XIcon } from "@/components/layout/social-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { xShareUrl } from "./share-links";
import { COPY_STATUS_TEXT, useCopyLink } from "./use-copy-link";

export type ShareTarget = {
  /** Absolute page URL; its link preview is the share card. */
  url: string;
  title: string;
  /** Short message for posts, e.g. "Realms #4 for 27.16 STRK on Realms.market". */
  text: string;
};

const subscribeNothing = () => () => {};

/** The system share sheet exists on most phones and some desktop browsers. */
function useCanShareNatively() {
  return useSyncExternalStore(
    subscribeNothing,
    () => typeof navigator.share === "function",
    () => false,
  );
}

/** Share a page: copy its link, post it on X, or use the system share sheet. */
export function ShareMenu({ target, className }: { target: ShareTarget; className?: string }) {
  const { status, copy } = useCopyLink(target.url);
  const canShareNatively = useCanShareNatively();

  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="min-h-11">
            {status === "copied" ? <Check aria-hidden /> : <Share2 aria-hidden />}
            Share
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem className="min-h-11" onSelect={() => void copy()}>
            <Link2 aria-hidden />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="min-h-11">
            <a href={xShareUrl(target)} target="_blank" rel="noopener noreferrer">
              <XIcon className="size-4" />
              Post on X
            </a>
          </DropdownMenuItem>
          {canShareNatively ? (
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => {
                navigator.share({ title: target.title, text: target.text, url: target.url }).catch(() => {
                  // Dismissing the share sheet is not an error worth reporting.
                });
              }}
            >
              <Share aria-hidden />
              More options…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
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
  );
}
