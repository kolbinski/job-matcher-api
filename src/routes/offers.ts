import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'
import { validateJwt } from '../middleware/validateJwt'

export const offersRouter = Router()

const EmploymentTypeSchema = z.object({
  from: z.number().optional(),
  to: z.number().optional(),
  currency: z.string().optional(),
  type: z.string().optional(),
  unit: z.string().optional(),
  gross: z.boolean().optional(),
})

const PatchEmploymentTypesSchema = z.object({
  employment_types: z.array(EmploymentTypeSchema),
})

offersRouter.patch('/:id/employment-types', validateAgentJwt, async (req, res) => {
  const id = req.params['id'] as string
  const parsed = PatchEmploymentTypesSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }

  const offer = await prisma.offer.findUnique({ where: { id }, select: { id: true } })
  if (!offer) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Offer not found' })
  }

  const updated = await prisma.offer.update({
    where: { id },
    data: { employment_types: parsed.data.employment_types as Prisma.InputJsonValue },
    select: { id: true, employment_types: true },
  })

  return res.json(updated)
})

offersRouter.patch('/:id/employment-types/client', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const id = req.params['id'] as string
  const parsed = PatchEmploymentTypesSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }

  const offer = await prisma.offer.findUnique({ where: { id }, select: { id: true, source: true } })
  if (!offer || offer.source !== 'manual') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Offer not found or not editable' })
  }

  const userOffer = await prisma.userOffer.findFirst({ where: { offer_id: id, user_id: user_id! } })
  if (!userOffer) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Offer not found or not editable' })
  }

  const updated = await prisma.offer.update({
    where: { id },
    data: { employment_types: parsed.data.employment_types as Prisma.InputJsonValue },
    select: { id: true, employment_types: true },
  })

  return res.json(updated)
})
