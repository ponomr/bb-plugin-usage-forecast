// Provider accounts across hosts. Hosts whose answers for one provider share
// the account (`sharedWith`, joined transitively) form one block, so `status`
// and `headroom` print one account once and agree on its windows.
//
// Pure: no SDK, no clock.

import type { HostLimits, ProviderLimits } from "./contract";

export interface AccountBlock {
  /** The member whose answer is printed: the newest one, the primary host on a tie. */
  provider: ProviderLimits;
  /** Every host of the account, in snapshot order (primary first). */
  members: { host: HostLimits; provider: ProviderLimits }[];
}

/**
 * One block per provider account: hosts whose answers share the account
 * (`sharedWith`, joined transitively) form one block.
 */
export function accountBlocks(hosts: readonly HostLimits[]): AccountBlock[] {
  const blocks: AccountBlock[] = [];
  const placed = new Set<string>();
  const id = (h: HostLimits, providerId: string) => `${h.hostId ?? ""}\n${providerId}`;
  for (const host of hosts) {
    for (const provider of host.providers) {
      if (placed.has(id(host, provider.providerId))) continue;
      const members: AccountBlock["members"] = [];
      const queue = [host];
      while (queue.length > 0) {
        const h = queue.shift()!;
        const p = h.providers.find((x) => x.providerId === provider.providerId);
        if (p === undefined || placed.has(id(h, p.providerId))) continue;
        placed.add(id(h, p.providerId));
        members.push({ host: h, provider: p });
        for (const other of p.sharedWith ?? []) {
          const o = hosts.find((x) => x.hostId === other);
          if (o !== undefined) queue.push(o);
        }
      }
      members.sort((a, b) => hosts.indexOf(a.host) - hosts.indexOf(b.host));
      const time = (p: ProviderLimits) => p.measuredAt ?? p.checkedAt ?? -Infinity;
      const best = members.reduce((a, b) => (time(b.provider) > time(a.provider) ? b : a));
      blocks.push({ provider: best.provider, members });
    }
  }
  return blocks;
}
