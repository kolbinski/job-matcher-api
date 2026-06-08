import bcrypt from 'bcrypt'
import { prisma } from '../lib/prisma'

const AGENT_EMAIL = 'krzysztof.olbinski@homodigital.io'
const AGENT_PASSWORD = 'agent123'

const CLIENT_ID = '7ca43c93-edfb-461f-a67f-0a047fc29b4a'
const CLIENT_PASSWORD = 'client123'

const SALT_ROUNDS = 10

async function main(): Promise<void> {
  const agentHash = await bcrypt.hash(AGENT_PASSWORD, SALT_ROUNDS)
  const agent = await prisma.agent.update({
    where: { email: AGENT_EMAIL },
    data: { password_hash: agentHash },
    select: { id: true, email: true },
  })
  console.log(`Agent password set for ${agent.email} (${agent.id})`)

  const clientHash = await bcrypt.hash(CLIENT_PASSWORD, SALT_ROUNDS)
  const user = await prisma.user.update({
    where: { id: CLIENT_ID },
    data: { password: clientHash },
    select: { id: true, email: true },
  })
  console.log(`Client password set for ${user.email} (${user.id})`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
