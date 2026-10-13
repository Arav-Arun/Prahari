'use client';

import React from 'react';
import { ArrowRight } from 'lucide-react';

interface MeshRouteBadgeProps {
  transportType?: string;
  hopCount?: number;
  originDeviceId?: string;
  originalTimestamp?: string;
  receivedTimestamp?: string;
  relayPath?: string[];
}

/** How an SOS reached the desk: directly, or relayed across nearby devices. */
export default function MeshRouteBadge({
  transportType = 'INTERNET',
  hopCount = 0,
  originDeviceId,
  originalTimestamp,
  receivedTimestamp,
  relayPath,
}: MeshRouteBadgeProps) {
  const time = (value?: string) => (value ? new Date(value).toLocaleTimeString() : '—');

  if (transportType === 'INTERNET' && !hopCount) {
    return (
      <p className="text-sm text-ink-soft">
        Delivered directly over the internet at <span className="font-mono text-ink">{time(receivedTimestamp)}</span>.
      </p>
    );
  }

  const path = relayPath?.filter(Boolean) ?? [];
  const origin = originDeviceId || path[0] || 'origin device';
  const relays = path.filter((node) => node !== origin);

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4 text-sm">
      <p className="font-medium">Relayed offline · {hopCount} hop{hopCount === 1 ? '' : 's'}</p>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-xs text-ink-soft">
        <span>{origin}</span>
        {relays.map((node) => (
          <React.Fragment key={node}>
            <ArrowRight className="size-3" /> <span>{node}</span>
          </React.Fragment>
        ))}
        <ArrowRight className="size-3" /> <span className="text-ink">authority desk</span>
      </p>
      <p className="mt-2 text-xs text-ink-soft">
        Sent {time(originalTimestamp)} · received {time(receivedTimestamp)}
      </p>
    </div>
  );
}
