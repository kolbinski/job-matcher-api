import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { getSupabase } from '../lib/supabase'
import { validateJwt } from '../middleware/validateJwt'
import { generateCoverLetter } from '../services/coverLetterGenerator'
import { CandidateProfileSchema } from '../types/profile'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'
import { getClaudeModel } from '../lib/claudeModels'
import { calculateCost } from '../lib/aiCost'

export const clGenerateRouter = Router()

const AgentGenerateCLSchema = z.object({
  client_id: z.string().uuid(),
  user_offer_id: z.string().uuid(),
  offer_text: z.string().min(1),
  cl_language: z.string().min(2),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
})

const ClientGenerateCLSchema = z.object({
  user_offer_id: z.string().uuid(),
  offer_text: z.string().min(1),
  cl_language: z.string().min(2),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
})

async function runGeneration(
  userId: string,
  userOfferId: string,
  offerText: string,
  clLanguage: string,
  jobTitle: string | undefined,
  companyName: string | undefined,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, profile: true, email: true, show_agent_info_in_cv: true, photo_url: true, cl_counter: true, cl_counter_max: true },
  })
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found')

  if (user.cl_counter_max > 0 && user.cl_counter >= user.cl_counter_max) {
    throw new AppError(402, 'CL_LIMIT_REACHED', 'Cover letter generation limit reached')
  }

  if (!user.profile) throw new AppError(422, 'INVALID_PROFILE', 'No profile configured for this client')
  const profileParsed = CandidateProfileSchema.safeParse(user.profile)
  if (!profileParsed.success) throw new AppError(422, 'INVALID_PROFILE', 'Profile file is invalid')

  const userOffer = await prisma.userOffer.findUnique({ where: { id: userOfferId } })
  if (!userOffer || userOffer.user_id !== userId) throw new AppError(404, 'NOT_FOUND', 'User offer not found')

  await prisma.userOffer.update({ where: { id: userOfferId }, data: { cl_status: 'generating' } })

  const clModel = await getClaudeModel('cl_generation')

  try {
    const { html, filename, usage } = await generateCoverLetter(profileParsed.data, offerText, clLanguage, jobTitle, companyName, user, clModel)

    const formData = new FormData()
    formData.append('files', new Blob([html], { type: 'text/html' }), 'index.html')
    const gotenbergRes = await fetch(`${env.GOTENBERG_URL}/forms/chromium/convert/html`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(55_000),
    })
    if (!gotenbergRes.ok) {
      const errBody = await gotenbergRes.text()
      throw new Error(`Gotenberg error ${gotenbergRes.status}: ${errBody}`)
    }
    const pdfBuffer = Buffer.from(await gotenbergRes.arrayBuffer())

    const storagePath = `cls/${user.id}/${filename}`
    const supabase = getSupabase()
    const { error: uploadError } = await supabase.storage
      .from('homo-digital')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadError) throw new Error(`Supabase upload error: ${uploadError.message}`)

    const { data: { publicUrl } } = supabase.storage.from('homo-digital').getPublicUrl(storagePath)

    await prisma.userOffer.update({
      where: { id: userOfferId },
      data: { cl_status: 'done', cl_url: publicUrl },
    })

    await prisma.user.update({ where: { id: userId }, data: { cl_counter: { increment: 1 } } })

    prisma.apiCall.create({
      data: {
        user_id: userId,
        status: 'success',
        call_type: 'cl',
        model: clModel,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    }).catch(err => console.error('[clGenerate] Failed to log api_call:', err))

    calculateCost(clModel, usage.input_tokens, usage.output_tokens)
      .then(cost => prisma.aiUsage.create({
        data: {
          user_id: userId,
          email: user?.email ?? null,
          type: 'cl_generation',
          model: clModel,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cost,
        },
      }))
      .catch(err => console.error('[ai_usage] insert failed:', err))

    return { cl_url: publicUrl, cl_status: 'done' }
  } catch (err) {
    await prisma.userOffer.update({ where: { id: userOfferId }, data: { cl_status: 'error' } }).catch(() => {})
    throw err
  }
}

clGenerateRouter.post('/generate', validateJwt, async (req, res) => {
  const { role, user_id, agent_id } = req.jwt!

  if (role === 'client') {
    const parsed = ClientGenerateCLSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
    }
    const { user_offer_id, offer_text, cl_language, company_name, job_title } = parsed.data
    return res.json(await runGeneration(user_id!, user_offer_id, offer_text, cl_language, job_title, company_name))
  }

  // agent path
  if (!agent_id) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Agent ID missing from token' })
  }

  const parsed = AgentGenerateCLSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { client_id, user_offer_id, offer_text, cl_language, company_name, job_title } = parsed.data

  const link = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id, user_id: client_id } },
  })
  if (!link) throw new AppError(403, 'FORBIDDEN', 'Client not found or not linked to this agent')

  return res.json(await runGeneration(client_id, user_offer_id, offer_text, cl_language, job_title, company_name))
})
