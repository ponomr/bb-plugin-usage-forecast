// Provider accounts across hosts. Hosts whose answers for one provider share
// the account (`sharedWith`, joined transitively) form one group, so `status`,
// `headroom` and the sidebar card show one account once and agree on its
// windows.
//
// Pure: no SDK, no clock.

import type { HostLimits, ProviderLimits } from "./contract";

interface AccountBlock {
  /** The member whose answer is printed: the newest one, the primary host on a tie. */
  provider: ProviderLimits;
  /** Every host of the account, in snapshot order (primary first). */
  members: { host: HostLimits; provider: ProviderLimits }[];
}

/** One provider account: the indices of its hosts in the given list, ascending. */
interface AccountGroup {
  providerId: string;
  members: number[];
}

/**
 * The provider accounts of `hosts`, in order of first appearance. Hosts whose
 * answers share the account (`sharedWith`, joined transitively) form one
 * group. A link counts from either side: a host that went offline keeps its
 * `sharedWith`, while the hosts still answering have dropped theirs.
 */
export function accountGroups(
  hosts: readonly { hostId: string | null; providers: readonly Pick<ProviderLimits, "providerId" | "sharedWith">[] }[],
): AccountGroup[] {
  const groups: AccountGroup[] = [];
  const placed = new Set<string>();
  const linked = (from: number, to: number, providerId: string) => {
    const id = hosts[to]!.hostId;
    return id !== null && hosts[from]!.providers.some((p) => p.providerId === providerId && p.sharedWith?.includes(id));
  };
  hosts.forEach((host, start) => {
    for (const { providerId } of host.providers) {
      if (placed.has(`${start}\n${providerId}`)) continue;
      const members = new Set([start]);
      for (const i of members) {
        hosts.forEach((other, j) => {
          if (!other.providers.some((p) => p.providerId === providerId)) return;
          if (linked(i, j, providerId) || linked(j, i, providerId)) members.add(j);
        });
      }
      const ordered = [...members].sort((a, b) => a - b);
      for (const i of ordered) placed.add(`${i}\n${providerId}`);
      groups.push({ providerId, members: ordered });
    }
  });
  return groups;
}

/** One block per provider account (see `accountGroups`). */
export function accountBlocks(hosts: readonly HostLimits[]): AccountBlock[] {
  const time = (p: ProviderLimits) => p.measuredAt ?? p.checkedAt ?? -Infinity;
  return accountGroups(hosts).map(({ providerId, members: indices }) => {
    const members = indices.map((i) => ({ host: hosts[i]!, provider: hosts[i]!.providers.find((p) => p.providerId === providerId)! }));
    const best = members.reduce((a, b) => (time(b.provider) > time(a.provider) ? b : a));
    return { provider: best.provider, members };
  });
}
