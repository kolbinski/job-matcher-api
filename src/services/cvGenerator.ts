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
- Output ONLY raw HTML starting with <!DOCTYPE html> or <html>.
  No markdown, no code fences, no explanation before or after the HTML.
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
  const raw = data.content[0].text
  const html = raw
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const puppeteer = await import('puppeteer-core')
  const chromium = await import('@sparticuz/chromium')

  // In production (Railway), use @sparticuz/chromium binary with its Lambda-optimised args.
  // Locally, use system Chrome — the Lambda binary and its args don't work on macOS.
  const isProduction = env.NODE_ENV === 'production'
  const executablePath = isProduction
    ? await chromium.default.executablePath()
    : (process.env.PUPPETEER_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  const args = isProduction
    ? chromium.default.args
    : ['--no-sandbox', '--disable-dev-shm-usage']

  const browser = await puppeteer.default.launch({ args, executablePath, headless: true })

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
