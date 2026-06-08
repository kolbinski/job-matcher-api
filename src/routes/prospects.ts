import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validateAgentJwt } from '../middleware/validateAgentJwt';

export const prospectsRouter = Router();

const CreateProspectSchema = z.object({
  email: z.string().email(),
  role: z.enum(['client', 'agent']),
  notes: z.string().optional(),
});

prospectsRouter.post('/', async (req, res) => {
  const parsed = CreateProspectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({
        error: 'INVALID_REQUEST',
        message: 'Invalid request body',
        issues: parsed.error.issues,
      });
  }
  const { email, role, notes } = parsed.data;

  const existing = await prisma.prospect.findUnique({ where: { email } });
  if (existing) {
    return res.status(200).json(existing);
  }

  const prospect = await prisma.prospect.create({
    data: { email, role, notes },
  });
  return res.status(201).json(prospect);
});

prospectsRouter.get('/', validateAgentJwt, async (_req, res) => {
  const prospects = await prisma.prospect.findMany({
    orderBy: { created_at: 'desc' },
  });
  res.json({ count: prospects.length, prospects });
});
