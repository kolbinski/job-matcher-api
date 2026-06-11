import type { Request, Response, NextFunction } from 'express'
import { getSupabase } from '../lib/supabase'
import { AppError } from '../lib/errors'

export async function validateSupabaseJwt(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header')
  }

  const token = auth.slice(7)
  const { data: { user }, error } = await getSupabase().auth.getUser(token)

  if (error || !user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token')
  }

  req.supabase_user = { id: user.id, email: user.email ?? '' }
  next()
}
