import { describe, it, expect } from 'vitest'
import { stripCodeFences } from '../src/services/claudeEvaluator'

describe('stripCodeFences', () => {
  it('returns plain JSON unchanged', () => {
    const input = '[{"offer_index":0,"score":80}]'
    expect(stripCodeFences(input)).toBe(input)
  })

  it('strips ```json opening and ``` closing fence', () => {
    const input = '```json\n[{"offer_index":0}]\n```'
    expect(stripCodeFences(input)).toBe('[{"offer_index":0}]')
  })

  it('strips ``` opening (no language tag) and ``` closing fence', () => {
    const input = '```\n[{"offer_index":0}]\n```'
    expect(stripCodeFences(input)).toBe('[{"offer_index":0}]')
  })

  it('handles uppercase JSON tag (```JSON)', () => {
    const input = '```JSON\n[{"offer_index":0}]\n```'
    expect(stripCodeFences(input)).toBe('[{"offer_index":0}]')
  })

  it('strips surrounding whitespace after fence removal', () => {
    const input = '```json\n  [{"offer_index":0}]  \n```'
    expect(stripCodeFences(input)).toBe('[{"offer_index":0}]')
  })

  it('does not corrupt JSON that contains backtick-like content in strings', () => {
    const input = '[{"role_fit":"Use `docker` for deployment"}]'
    expect(stripCodeFences(input)).toBe(input)
  })

  it('result is valid JSON after stripping ```json fence', () => {
    const input = '```json\n[{"offer_index":0,"score":75,"recommended":true}]\n```'
    const stripped = stripCodeFences(input)
    expect(() => JSON.parse(stripped)).not.toThrow()
    expect(JSON.parse(stripped)[0].score).toBe(75)
  })

  it('result is valid JSON after stripping plain ``` fence', () => {
    const input = '```\n[{"offer_index":1,"score":60}]\n```'
    const stripped = stripCodeFences(input)
    expect(() => JSON.parse(stripped)).not.toThrow()
  })
})
