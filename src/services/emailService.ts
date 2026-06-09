import { Resend } from 'resend';
import { env } from '../lib/env';

const resend = new Resend(env.RESEND_API_KEY);

export async function sendProspectNotification(
  email: string,
  role: string,
  notes: string | undefined,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10)
  const lines = [`From: ${email}`, `Role: ${role}`, `Date: ${date}`]
  if (notes) lines.push(notes)
  await resend.emails.send({
    from: 'noreply@homodigital.io',
    to: 'contact@homodigital.io',
    subject: `[Prospect] ${email}`,
    text: lines.join('\n'),
  })
}

export async function sendFeedbackNotification(
  senderEmail: string,
  source: string,
  message: string,
  createdAt: Date,
): Promise<void> {
  await resend.emails.send({
    from: 'noreply@homodigital.io',
    to: 'contact@homodigital.io',
    subject: `[Feedback] ${source} — ${senderEmail}`,
    text: `Source: ${source}\nFrom: ${senderEmail}\nDate: ${createdAt.toISOString()}\n\n${message}`,
  })
}

export async function sendMatchReport(
  fromEmail: string,
  fromName: string,
  toEmail: string,
  emailReport: string,
): Promise<void> {
  await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: toEmail,
    subject: `Your job report — ${new Date().toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    text: emailReport,
  });
}
