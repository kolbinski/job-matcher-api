import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'

const prisma = new PrismaClient()

const TEST_USER_ID = '7ca43c93-edfb-461f-a67f-0a047fc29b4a'

async function main() {
  const passwordHash = await bcrypt.hash('agent123', 10)

  const agent = await prisma.agent.upsert({
    where: { email: 'krzysztof.olbinski@homodigital.io' },
    update: { first_name: 'Krzysztof', last_name: 'Olbiński' },
    create: {
      email: 'krzysztof.olbinski@homodigital.io',
      password_hash: passwordHash,
      first_name: 'Krzysztof',
      last_name: 'Olbiński',
    },
  })

  await prisma.agentClient.upsert({
    where: { agent_id_user_id: { agent_id: agent.id, user_id: TEST_USER_ID } },
    update: {},
    create: { agent_id: agent.id, user_id: TEST_USER_ID },
  })

  console.log('Seeded agent:', agent.email, '→ linked to user:', TEST_USER_ID)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
