import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  GOTENBERG_URL: z.string().default(''),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  JWT_SECRET: z.string().min(1).default('dev-jwt-secret-change-in-production'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

const requireInProduction = ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'GOTENBERG_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'] as const

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Missing or invalid environment variables:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

if (parsed.data.NODE_ENV === 'production') {
  for (const key of requireInProduction) {
    if (!parsed.data[key]) {
      console.error(`Missing required production environment variable: ${key}`)
      process.exit(1)
    }
  }
}

export const env = parsed.data
