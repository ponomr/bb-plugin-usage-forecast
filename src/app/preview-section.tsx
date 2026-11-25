// Settings page section «How it looks»: every display part the settings
// above switch, drawn live by the same components and data. bb's settings
// form has no images, so this is the example next to the options. A part
// turned off still shows, marked off; the header then shows its default look (numbers).

import type { ReactNode } from "react";
import { BandPreview } from "./banner";
import { FloatPreview } from "./float-widget";
import { HeaderPill } from "./header-widget";
import { useBandShown, useFloatShown, useHeaderShow, useStrings } from "./hooks";
import { RingIcon } from "./ring-icon";
import { LimitsCard } from "./sidebar-card";

function Part({ name, off, children }: { name: string; off: boolean; children: ReactNode }) {
  const s = useStrings();
  return (
    <div className="flex flex-col gap-1.5" data-part={name}>
      <span className="text-xs font-medium text-muted-foreground">
        {name}
        {off ? ` · ${s.previewOff}` : ""}
      </span>
      {children}
    </div>
  );
}

export function PreviewSection() {
  const s = useStrings();
  const header = useHeaderShow();
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="usage-preview">
      <Part name={s.previewHeader} off={header === "off"}>
        <div className="w-fit">
          <HeaderPill style={header === "off" ? "numbers" : header} />
        </div>
      </Part>
      <Part name={s.previewSidebar} off={false}>
        <span className="inline-flex size-7 items-center justify-center rounded-md border border-border">
          <RingIcon className="size-[26px]" />
        </span>
      </Part>
      <Part name={s.previewBand} off={!useBandShown()}>
        <BandPreview />
      </Part>
      <Part name={s.previewFloat} off={!useFloatShown()}>
        <FloatPreview />
      </Part>
      <Part name={s.previewCard} off={false}>
        <div className="w-full max-w-[352px] overflow-hidden rounded-lg border border-border bg-popover">
          <LimitsCard className="max-h-none" />
        </div>
      </Part>
    </div>
  );
}
