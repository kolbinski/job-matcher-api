import type { CandidateProfile } from '../types/profile'
import { env } from '../lib/env'

export async function generateCV(
  profile: CandidateProfile,
  offerText: string,
  cvLanguage: string,
): Promise<string> {
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
    const errorBody = await response.text()
    console.error('[cvGenerator] Claude API error status:', response.status)
    console.error('[cvGenerator] Claude API error body:', errorBody)
    console.error('[cvGenerator] prompt length (chars):', prompt.length)
    console.error('[cvGenerator] offer_text length:', offerText.length)
    throw new Error(`Claude API error: ${response.status} ${errorBody}`)
  }

  const data = await response.json() as { content: Array<{ text: string }> }
  const raw = data.content[0].text
  return raw
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}
