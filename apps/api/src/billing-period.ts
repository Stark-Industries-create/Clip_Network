import type { PrismaClient, Workspace } from '@prisma/client';

/**
 * Returns the UTC start of the current calendar month (YYYY-MM-01T00:00:00.000Z).
 * Eliminates local timezone boundary bugs across multi-region workspaces.
 */
export function getUtcBillingMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function isBillingPeriodExpired(periodResetAt: Date, now = new Date()): boolean {
  const currentMonthStart = getUtcBillingMonthStart(now);
  return periodResetAt.getTime() < currentMonthStart.getTime();
}

/**
 * Ensures workspace.clipsUsedThisPeriod reflects the current UTC billing month.
 * Atomically resets usage to 0 and advances periodResetAt when a new UTC month starts.
 */
export async function ensureCurrentBillingPeriod(
  prisma: PrismaClient,
  workspaceId: string,
  now = new Date(),
): Promise<Workspace | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return null;

  if (!isBillingPeriodExpired(workspace.periodResetAt, now)) {
    return workspace;
  }

  const currentMonth = getUtcBillingMonthStart(now);
  await prisma.workspace.updateMany({
    where: { id: workspace.id, periodResetAt: { lt: currentMonth } },
    data: {
      clipsUsedThisPeriod: 0,
      analysisSecondsUsed: 0,
      periodResetAt: currentMonth,
    },
  });
  return prisma.workspace.findUnique({ where: { id: workspaceId } });
}
