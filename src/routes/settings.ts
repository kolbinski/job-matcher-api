import { Router } from 'express'
import { prisma } from '../lib/prisma'

export const settingsRouter = Router()

settingsRouter.get('/', async (_req, res) => {
  const rows = await prisma.settings.findMany({ orderBy: { key: 'asc' } })
  const result: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value)
    } catch {
      result[row.key] = row.value
    }
  }
  res.json(result)
})
