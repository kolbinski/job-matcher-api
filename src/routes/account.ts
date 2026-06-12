import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { getSupabase } from '../lib/supabase'
import { AppError } from '../lib/errors'

export const accountRouter = Router()

const AgentBodySchema = z.object({
  client_id: z.string().uuid(),
})

async function findSupabaseUserId(email: string): Promise<string | null> {
  let page = 1
  const perPage = 1000
  while (true) {
    const { data, error } = await getSupabase().auth.admin.listUsers({ page, perPage })
    if (error || !data) return null
    const match = data.users.find(u => u.email === email)
    if (match) return match.id
    if (data.users.length < perPage) return null
    page++
  }
}

accountRouter.delete('/', validateJwt, async (req, res) => {
  let targetUserId: string
  let targetEmail: string

  if (req.jwt!.role === 'agent') {
    const parsed = AgentBodySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(422, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'client_id is required')
    }
    const { client_id } = parsed.data

    const link = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: req.jwt!.agent_id!, user_id: client_id } },
    })
    if (!link) throw new AppError(403, 'FORBIDDEN', 'Agent does not have access to this client')

    const user = await prisma.user.findUnique({
      where: { id: client_id },
      select: { id: true, email: true },
    })
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Client not found')

    targetUserId = user.id
    targetEmail = user.email
  } else {
    const user = await prisma.user.findUnique({
      where: { id: req.jwt!.user_id! },
      select: { id: true, email: true },
    })
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

    targetUserId = user.id
    targetEmail = user.email
  }

  // Step 1: Delete from Supabase auth (best-effort — password-login users have no Supabase entry)
  const supabaseUid = await findSupabaseUserId(targetEmail)
  if (supabaseUid) {
    const { error } = await getSupabase().auth.admin.deleteUser(supabaseUid)
    if (error) console.error(`[delete-account] Supabase deleteUser failed for ${supabaseUid}:`, error)
  }

  // Steps 2-4: Delete from DB — agent_clients deleted in both roles to satisfy FK constraint before user.delete()
  await prisma.pushToken.deleteMany({ where: { user_id: targetUserId } })
  await prisma.agentClient.deleteMany({ where: { user_id: targetUserId } })
  await prisma.user.delete({ where: { id: targetUserId } })

  res.status(200).json({ message: 'Account deleted' })
})
