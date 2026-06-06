import { Resend } from 'resend'
import { env } from '../lib/env'

const resend = new Resend(env.RESEND_API_KEY)

export async function sendMatchReport(
  fromEmail: string,
  fromName: string,
  toEmail: string,
  emailReport: string,
): Promise<void> {
  await resend.emails.send({
    from: `${fromName} @ Homo Digital <${fromEmail}>`,
    to: toEmail,
    subject: `Your job report — ${new Date().toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    text: emailReport,
  })
}
