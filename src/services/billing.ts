import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { InsufficientCreditsError } from '../lib/errors'

export interface BillCallParams {
  userId: string
  apiKeyType: 'live' | 'test'
  profileJson: string
  offersMatched?: number
  offersTotal?: number
  responseMs?: number
  status: string
  errorMessage?: string
}

export async function billCall(params: BillCallParams): Promise<string> {
  const { userId, apiKeyType, profileJson, offersMatched, offersTotal, responseMs, status, errorMessage } = params

  const profileHash = crypto.createHash('sha256').update(profileJson).digest('hex')

  return prisma.$transaction(async (tx) => {
    let cost: Prisma.Decimal

    if (apiKeyType === 'live') {
      // Read call_cost inside transaction so price changes take effect immediately (RULE B-2)
      const setting = await tx.settings.findUnique({ where: { key: 'call_cost' } })
      if (!setting) throw new Error('settings.call_cost not found')

      cost = new Prisma.Decimal(setting.value)

      // Conditional UPDATE prevents concurrent requests both passing the credits check
      // before either deducts — the WHERE credits >= cost clause is the atomic guard (RULE B-1)
      const updated = await tx.user.updateMany({
        where: { id: userId, credits: { gte: cost } },
        data: { credits: { decrement: cost } },
      })

      if (updated.count === 0) {
        throw new InsufficientCreditsError()
      }
    } else {
      cost = new Prisma.Decimal(0)
    }

    const call = await tx.apiCall.create({
      data: {
        user_id: userId,
        cost,
        profile_hash: profileHash,
        offers_matched: offersMatched ?? null,
        offers_total: offersTotal ?? null,
        response_ms: responseMs ?? null,
        status,
        error_message: errorMessage ?? null,
      },
    })

    return call.id
  })
}
