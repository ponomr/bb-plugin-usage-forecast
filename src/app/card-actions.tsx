// The last row of every expanded limits card: when the limits were polled,
// a button that polls them now and one that opens the plugin's settings.

import type { ReactNode } from "react";
import { formatAgo, formatSpan } from "./format";
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

/** An eight-toothed cog with a hole: the usual settings sign. */
function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className={ICON} aria-hidden data-icon="gear">
      <path d="M12.68 6.55L14.47 6.69L14.47 9.31L12.68 9.45L12.33 10.29L13.50 11.65L11.65 13.50L10.29 12.33L9.45 12.68L9.31 14.47L6.69 14.47L6.55 12.68L5.71 12.33L4.35 13.50L2.50 11.65L3.67 10.29L3.32 9.45L1.53 9.31L1.53 6.69L3.32 6.55L3.67 5.71L2.50 4.35L4.35 2.50L5.71 3.67L6.55 3.32L6.69 1.53L9.31 1.53L9.45 3.32L10.29 3.67L11.65 2.50L13.50 4.35L12.33 5.71Z" />
      <circle cx="8" cy="8" r="2" />
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

/**
 * `polledAt`: the shown host's last poll, null before the first. `children` go at the row's end.
 * `short`: only the data's age ("2m") before the buttons, the full sentence in its tooltip.
 */
export function CardActions({
  polledAt,
  now,
  onNavigate,
  short = false,
  children,
}: {
  polledAt: number | null;
  now: number;
  onNavigate?: () => void;
  short?: boolean;
  children?: ReactNode;
}) {
  const s = useStrings();
  const { refresh, pending, error } = useRefreshLimits();
  const openSettings = useOpenSettings();
  const full = pending ? s.refreshing : polledAt === null ? s.notPolledYet : s.updated(formatAgo(s, polledAt, now));
  const text = short && !pending && polledAt !== null ? formatSpan(s, Math.max(0, now - polledAt)) : full;
  return (
    <div className="flex flex-col gap-0.5" data-testid="card-actions">
      <div className="flex items-center gap-1">
        <span
          className={cn("min-w-0 flex-1 truncate text-muted-foreground", short && "text-right tabular-nums")}
          title={short ? full : undefined}
          data-testid="card-age"
        >
          {text}
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
