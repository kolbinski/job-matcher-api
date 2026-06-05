import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../lib/env'
import { AppError } from '../lib/errors'

interface AgentJwtPayload {
  agentId: string
  email: string
}

export function validateAgentJwt(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header')
  }

  const token = auth.slice(7)
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AgentJwtPayload
    req.agent = { id: payload.agentId, email: payload.email }
    next()
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token')
  }
}
