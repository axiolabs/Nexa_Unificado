import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'

export async function GET() {
  const result = await requireUser()
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json({ user: result.user })
}
