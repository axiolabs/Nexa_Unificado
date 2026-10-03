import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireRole } from '@/lib/auth/guard'
import { ROLE } from '@/lib/authz'
import { getPrisma } from '@/lib/db'
import { fail, readJson } from '@/lib/http'
import { isRetryableDbError } from '@/lib/prisma-errors'
import { STATUS_LABELS } from '@/lib/reports'
import { fieldErrors, reportResolutionSchema } from '@/lib/validation'

export async function GET(req: Request) {
  const gate = await requireRole([ROLE.ADMIN, ROLE.MODERATOR])
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(req.url)
  const statusParam = url.searchParams.get('status')
  const allowed: Array<'OPEN' | 'RESOLVED' | 'DISMISSED'> = ['OPEN', 'RESOLVED', 'DISMISSED']
  const status = allowed.find((s) => s === statusParam) ?? 'OPEN'

  const prisma = getPrisma()
  const reports = await prisma.moderationReport.findMany({
    where: { status },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    take: 50,
    select: {
      id: true,
      target: true,
      reason: true,
      detail: true,
      status: true,
      resolvedById: true,
      resolvedAt: true,
      resolutionNote: true,
      placeId: true,
      planId: true,
      userId: true,
      messageId: true,
      createdAt: true,
      reporter: { select: { id: true, email: true, name: true } },
      resolvedBy: { select: { id: true, email: true, name: true } },
      place: { select: { id: true, name: true } },
      plan: { select: { id: true, title: true, startsAt: true } },
      user: { select: { id: true, email: true, name: true } },
      message: { select: { id: true, body: true } },
    },
  })

  return NextResponse.json(
    {
      status,
      statusLabel: STATUS_LABELS[status],
      count: reports.length,
      reports,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}