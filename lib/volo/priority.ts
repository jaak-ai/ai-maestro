/**
 * Priority mapping, safe to import from client components.
 *
 * Kept out of `lib/volo/client.ts` on purpose: that module reaches OAuth
 * storage and therefore `fs`, so importing a value from it inside a client
 * component pulls server-only code into the browser bundle and the build
 * fails with "Can't resolve 'fs'".
 *
 * Volo boards define priorities with a `code` (P0..P3) and an `order`, but the
 * task payload carries only the lowercase name. Boards that define no custom
 * priorities fall back to this standard mapping, which is what the main board
 * uses: P0=critical, P1=high, P2=medium, P3=low.
 */

export const PRIORITY_CODES: Record<string, { code: string; rank: number }> = {
  critical: { code: 'P0', rank: 0 },
  urgent: { code: 'P0', rank: 0 },
  high: { code: 'P1', rank: 1 },
  medium: { code: 'P2', rank: 2 },
  low: { code: 'P3', rank: 3 },
}

/** Sort rank for a priority. Unknown or absent priorities sort last. */
export function priorityRank(priority?: string): number {
  return PRIORITY_CODES[priority || '']?.rank ?? 99
}

/** P0..P3 label, or null when the priority is unknown. */
export function priorityCode(priority?: string): string | null {
  return PRIORITY_CODES[priority || '']?.code ?? null
}
