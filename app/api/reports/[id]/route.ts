import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireRole } from '@/lib/auth/guard'
import { ROLE } from '@/lib/authz'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { isRetryableDbError } from '@/lib/prisma-errors'
import { fieldErrors, reportResolutionSchema } from '@/lib/validation'

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireRole([ROLE.ADMIN, ROLE.MODERATOR])
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await ctx.params
  if (!id || id.length > 64) {
    return fail(400, 'Id de reporte invalido')
  }

  const raw = await readJson(req)
  const parsed = reportResolutionSchema.safeParse(raw)
  if (!parsed.success) {
    return fail(400, parsed.error.issues[0]?.message ?? 'Datos invalidos', {
      fields: fieldErrors(parsed.error),
    })
  }
  const { status, note } = parsed.data

  const prisma = getPrisma()
  const abierto = await prisma.moderationReport.findFirst({
    where: { id, status: 'OPEN' },
    select: { id: true },
  })
  if (!abierto) {
    return fail(409, 'El reporte ya fue resuelto o no existe mas', {
      code: 'YA_CERRADO',
    })
  }

  try {
    const cerrado = await prisma.moderationReport.update({
      where: { id: abierto.id },
      data: {
        status,
        resolvedById: gate.user.id,
        resolvedAt: new Date(),
        resolutionNote: note ?? null,
      },
      select: {
        id: true,
        status: true,
        resolvedAt: true,
        resolutionNote: true,
      },
    })

    return NextResponse.json({ report: cerrado }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return fail(409, 'El reporte ya fue resuelto o no existe mas', { code: 'YA_CERRADO' })
    }
    if (isRetryableDbError(err)) {
      return fail(503, 'No pudimos cerrar el reporte; reintenta en un momento')
    }
    throw err
  }
}