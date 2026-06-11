import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { AppError } from '../lib/errors'

export const generalSettingsRouter = Router()

generalSettingsRouter.get('/', async (_req, res) => {
  const row = await prisma.settings.findUnique({
    where: { key: 'general_settings' },
  })

  if (!row) {
    throw new AppError(500, 'INTERNAL_ERROR', 'general_settings not found in settings table')
  }

  res.json(JSON.parse(row.value))
})
