import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { AppError } from '../lib/errors'

export const skillsRouter = Router()

const QuerySchema = z.object({
  category: z.string().min(1),
  q: z.string().optional(),
})

skillsRouter.get('/search', async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim()

  if (!q) {
    res.json({ skills: [] })
    return
  }

  const base = { category: { market: 'IT' } }
  const select = { name: true, category: { select: { name: true } } } as const
  const order = { name: 'asc' } as const

  const [startsWith, contains] = await Promise.all([
    prisma.skill.findMany({
      where: { ...base, name: { startsWith: q, mode: 'insensitive' } },
      orderBy: order,
      take: 20,
      select,
    }),
    prisma.skill.findMany({
      where: {
        ...base,
        name: { contains: q, mode: 'insensitive' },
        NOT: { name: { startsWith: q, mode: 'insensitive' } },
      },
      orderBy: order,
      take: 20,
      select,
    }),
  ])

  const merged = [...startsWith, ...contains].slice(0, 20)

  res.json({
    skills: merged
      .filter(s => s.category)
      .map(s => ({ name: s.name, category: s.category!.name })),
  })
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

  if (!q) {
    res.json({ skills: [] })
    return
  }

  const base = { category_id: skillCategory.id, category: { market: 'IT' } }
  const order = { name: 'asc' } as const

  const [startsWith, contains] = await Promise.all([
    prisma.skill.findMany({
      where: { ...base, name: { startsWith: q, mode: 'insensitive' } },
      orderBy: order,
      take: 20,
      select: { name: true },
    }),
    prisma.skill.findMany({
      where: {
        ...base,
        name: { contains: q, mode: 'insensitive' },
        NOT: { name: { startsWith: q, mode: 'insensitive' } },
      },
      orderBy: order,
      take: 20,
      select: { name: true },
    }),
  ])

  res.json({ skills: [...startsWith, ...contains].slice(0, 20).map(s => s.name) })
})
