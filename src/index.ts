import { app } from './app'
import { env } from './lib/env'
import { prisma } from './lib/prisma'

const server = app.listen(env.PORT, () => {
  console.log(`[jobmatcher] Listening on port ${env.PORT} (${env.NODE_ENV})`)
})

process.on('SIGTERM', () => {
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
})
