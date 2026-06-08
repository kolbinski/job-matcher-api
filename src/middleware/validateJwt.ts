import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../lib/env'
import { AppError } from '../lib/errors'

interface NewJwtPayload {
  role: 'agent' | 'client'
  agent_id?: string
  user_id?: string
  email: string
}

interface OldAgentJwtPayload {
  agentId: string
  email: string
}

export function validateJwt(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header')
  }

  const token = auth.slice(7)
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as NewJwtPayload | OldAgentJwtPayload

    if ('role' in payload) {
      req.jwt = { role: payload.role, agent_id: payload.agent_id, user_id: payload.user_id, email: payload.email }
    } else if ('agentId' in payload) {
      // old agent token format from POST /v1/auth/agent/login — backward compat
      req.jwt = { role: 'agent', agent_id: payload.agentId, email: payload.email }
    } else {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid token format')
    }

    next()
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token')
  }
}
