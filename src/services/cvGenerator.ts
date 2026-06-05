import type { CandidateProfile } from '../types/profile'
import { env } from '../lib/env'

export async function generateCV(
  profile: CandidateProfile,
  offerText: string,
  cvLanguage: string,
): Promise<Buffer> {
  const prompt = `
You are an expert CV writer. Generate a professional CV in ${cvLanguage} language.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOB OFFER:
${offerText.slice(0, 3000)}

Instructions:
- Write the CV in ${cvLanguage}
- Tailor the CV to match the job offer requirements
- Highlight relevant skills and experience
- Use clean, professional HTML with inline CSS
- No external dependencies — fully self-contained HTML
- Include sections: Summary, Experience, Skills, Education
- Output ONLY the HTML, no markdown, no explanation
`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    throw new Error(`[cvGenerator] Claude API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as { content: Array<{ text: string }> }
  const html = data.content[0].text

  const puppeteer = await import('puppeteer-core')
  const chromium = await import('@sparticuz/chromium')
  const browser = await puppeteer.default.launch({
    args: chromium.default.args,
    executablePath: await chromium.default.executablePath(),
    headless: true,
  })

  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
