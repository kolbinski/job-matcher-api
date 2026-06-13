import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { getSupabase } from '../lib/supabase'
import { validateAgentJwt } from '../middleware/validateAgentJwt'
import { generateCoverLetter } from '../services/coverLetterGenerator'
import { CandidateProfileSchema } from '../types/profile'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'
import { getClaudeModel } from '../lib/claudeModels'

export const clGenerateRouter = Router()

const GenerateCLSchema = z.object({
  client_id: z.string().uuid(),
  user_offer_id: z.string().uuid(),
  offer_text: z.string().min(1),
  cl_language: z.string().min(2),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
})

clGenerateRouter.post('/generate', validateAgentJwt, async (req, res) => {
  const parsed = GenerateCLSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { client_id, user_offer_id, offer_text, cl_language, company_name, job_title } = parsed.data
  const agentId = req.agent!.id

  const link = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id: agentId, user_id: client_id } },
    include: { user: true },
  })

  if (!link) {
    throw new AppError(403, 'FORBIDDEN', 'Client not found or not linked to this agent')
  }

  const { user } = link

  if (!user.profile) {
    throw new AppError(422, 'INVALID_PROFILE', 'No profile configured for this client')
  }

  const profileParsed = CandidateProfileSchema.safeParse(user.profile)
  if (!profileParsed.success) {
    throw new AppError(422, 'INVALID_PROFILE', 'Profile file is invalid')
  }

  const userOffer = await prisma.userOffer.findUnique({ where: { id: user_offer_id } })
  if (!userOffer || userOffer.user_id !== client_id) {
    throw new AppError(404, 'NOT_FOUND', 'User offer not found')
  }

  await prisma.userOffer.update({ where: { id: user_offer_id }, data: { cl_status: 'generating' } })

  const clModel = await getClaudeModel('cv_cl_generation')

  try {
    const { html, filename, usage } = await generateCoverLetter(profileParsed.data, offer_text, cl_language, job_title, company_name, user, clModel)

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

    const emailFolder = (user.email ?? '').replace(/@/g, '_at_').replace(/\./g, '_').replace(/\+/g, '_')
    const storagePath = `cls/${emailFolder}/${filename}`
    const supabase = getSupabase()
    const { error: uploadError } = await supabase.storage
      .from('homo-digital')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadError) throw new Error(`Supabase upload error: ${uploadError.message}`)

    const { data: { publicUrl } } = supabase.storage.from('homo-digital').getPublicUrl(storagePath)

    await prisma.userOffer.update({
      where: { id: user_offer_id },
      data: { cl_status: 'done', cl_url: publicUrl },
    })

    prisma.apiCall.create({
      data: {
        user_id: client_id,
        status: 'success',
        call_type: 'cl',
        model: clModel,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    }).catch(err => console.error('[clGenerate] Failed to log api_call:', err))

    return res.json({ cl_url: publicUrl, cl_status: 'done' })
  } catch (err) {
    await prisma.userOffer.update({ where: { id: user_offer_id }, data: { cl_status: 'error' } }).catch(() => {})
    throw err
  }
})
