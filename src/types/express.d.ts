import type { User } from '@prisma/client'

declare global {
  namespace Express {
    interface Request {
      user?: User
      agent?: { id: string; email: string }
      jwt?: { role: 'agent' | 'client'; agent_id?: string; user_id?: string; email: string }
      supabase_user?: { id: string; email: string }
    }
  }
}

export {}
