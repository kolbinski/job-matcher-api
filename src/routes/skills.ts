import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { AppError } from '../lib/errors'

export const skillsRouter = Router()

const QuerySchema = z.object({
  category: z.string().min(1),
  q: z.string().optional(),
})

skillsRouter.get('/', async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(422, 'INVALID_REQUEST', 'Missing required query param: category')
  }

  const { category, q } = parsed.data

  const skillCategory = await prisma.skillCategory.findFirst({
    where: { name: { equals: category, mode: 'insensitive' } },
    select: { id: true },
  })

  if (!skillCategory) {
    throw new AppError(422, 'INVALID_REQUEST', `Unknown category: ${category}`)
  }

  const skills = await prisma.skill.findMany({
    where: {
      category_id: skillCategory.id,
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    },
    orderBy: { name: 'asc' },
    take: 20,
    select: { name: true },
  })

  res.json({ skills: skills.map(s => s.name) })
})
