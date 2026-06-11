import { Router } from 'express'
import { prisma } from '../lib/prisma'

export const skillCategoriesRouter = Router()

skillCategoriesRouter.get('/', async (_req, res) => {
  const categories = await prisma.skillCategory.findMany({
    where: { market: 'IT' },
    orderBy: { sort_order: 'asc' },
    select: { name: true },
  })

  res.json({ categories: categories.map(c => c.name) })
})
