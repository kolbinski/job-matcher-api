import { app } from './app'
import { env } from './lib/env'
import { prisma } from './lib/prisma'
import { startScheduler } from './lib/scheduler'

const server = app.listen(env.PORT, () => {
  console.log(`[jobmatcher] Listening on port ${env.PORT} (${env.NODE_ENV})`)
})

if (env.NODE_ENV !== 'test') {
  prisma.notificationLock.deleteMany({ where: { lock_key: { startsWith: 'sync:' } } })
    .then(() => console.log('[startup] Cleared stale sync locks'))
    .catch(err => console.error('[startup] Failed to clear sync locks:', err))
    .finally(() => {
      startScheduler().catch(err => console.error('[scheduler] Failed to start:', err))
    })
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
