// The last row of every expanded limits card: when the limits were polled,
// a button that polls them now and one that opens the plugin's settings.

import type { ReactNode } from "react";
import { formatAgo } from "./format";
import { useOpenSettings, useRefreshLimits, useStrings } from "./hooks";
import { Toned } from "./ui";
import { cn } from "../../lib/utils";

const ICON = "size-3.5";

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={cn(ICON, spinning && "animate-spin")} aria-hidden>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={ICON} aria-hidden>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
    </svg>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/** `polledAt`: the shown host's last poll, null before the first. `children` go at the row's end. */
export function CardActions({ polledAt, now, onNavigate, children }: { polledAt: number | null; now: number; onNavigate?: () => void; children?: ReactNode }) {
  const s = useStrings();
  const { refresh, pending, error } = useRefreshLimits();
  const openSettings = useOpenSettings();
  return (
    <div className="flex flex-col gap-0.5" data-testid="card-actions">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {pending ? s.refreshing : polledAt === null ? s.notPolledYet : s.updated(formatAgo(s, polledAt, now))}
        </span>
        <IconButton label={s.refreshLimits} onClick={refresh} disabled={pending}>
          <RefreshIcon spinning={pending} />
        </IconButton>
        <IconButton
          label={s.openSettings}
          onClick={() => {
            onNavigate?.();
            openSettings();
          }}
        >
          <GearIcon />
        </IconButton>
        {children}
      </div>
      {error === null ? null : <Toned tone="red">{error}</Toned>}
    </div>
  );
}
