import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { getSupabase } from '../lib/supabase'
import { validateAgentJwt } from '../middleware/validateAgentJwt'
import { generateCV } from '../services/cvGenerator'
import { CandidateProfileSchema } from '../types/profile'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'
import { getClaudeModel } from '../lib/claudeModels'

export const cvGenerateRouter = Router()

const GenerateCVSchema = z.object({
  client_id: z.string().uuid(),
  user_offer_id: z.string().uuid(),
  offer_text: z.string().min(1),
  cv_language: z.string().min(2),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
})

cvGenerateRouter.post('/generate', validateAgentJwt, async (req, res) => {
  const parsed = GenerateCVSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { client_id, user_offer_id, offer_text, cv_language, company_name, job_title } = parsed.data
  const agentId = req.agent!.id

  // Verify client belongs to this agent
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

  // Verify user_offer belongs to this client
  const userOffer = await prisma.userOffer.findUnique({ where: { id: user_offer_id } })
  if (!userOffer || userOffer.user_id !== client_id) {
    throw new AppError(404, 'NOT_FOUND', 'User offer not found')
  }

  await prisma.userOffer.update({ where: { id: user_offer_id }, data: { cv_status: 'generating' } })

  const cvModel = await getClaudeModel('cv_cl_generation')

  try {
    const { html, filename, usage } = await generateCV(profileParsed.data, offer_text, cv_language, job_title, company_name, user, cvModel)

    // Convert HTML to PDF via Gotenberg
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

    // Upload PDF to Supabase Storage
    const emailFolder = (user.email ?? '').replace(/@/g, '_at_').replace(/\./g, '_').replace(/\+/g, '_')
    const storagePath = `cvs/${emailFolder}/${filename}`
    const supabase = getSupabase()
    const { error: uploadError } = await supabase.storage
      .from('homo-digital')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadError) throw new Error(`Supabase upload error: ${uploadError.message}`)

    const { data: { publicUrl } } = supabase.storage.from('homo-digital').getPublicUrl(storagePath)

    await prisma.userOffer.update({
      where: { id: user_offer_id },
      data: { cv_status: 'done', cv_url: publicUrl, cv_language },
    })

    prisma.apiCall.create({
      data: {
        user_id: client_id,
        status: 'success',
        call_type: 'cv',
        model: cvModel,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    }).catch(err => console.error('[cvGenerate] Failed to log api_call:', err))

    return res.json({ cv_url: publicUrl, cv_status: 'done' })
  } catch (err) {
    await prisma.userOffer.update({ where: { id: user_offer_id }, data: { cv_status: 'error' } }).catch(() => {})
    throw err
  }
})
