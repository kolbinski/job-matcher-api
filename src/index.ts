import { app } from './app'
import { env } from './lib/env'
import { prisma } from './lib/prisma'
import { startScheduler } from './lib/scheduler'

const server = app.listen(env.PORT, () => {
  console.log(`[jobmatcher] Listening on port ${env.PORT} (${env.NODE_ENV})`)
})

if (env.NODE_ENV !== 'test') {
  startScheduler().catch(err => console.error('[scheduler] Failed to start:', err))
}

process.on('SIGTERM', () => {
  server.close(() => {
    void (async () => {
      try {
        await prisma.$disconnect()
      } finally {
        process.exit(0)
      }
    })()
  })
})
