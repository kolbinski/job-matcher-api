import type { Offer } from '@prisma/client'
import { prisma } from '../lib/prisma'

export const FIXTURE_SLUG_PREFIX = 'test-match-fixture-'

// 6 controlled offers covering different pre-filter outcomes for Marek's profile.
// Profile: work_model=["office","remote"], contract PLN min=22000, senior, php=red flag,
// office_location_cities=["Gdańsk","Gdansk","Kraków","Bruksela"]
//
// 2 PASS: remote-ts-senior, office-krakow-senior
// 4 FAIL: low-salary (contract PLN 14k), hybrid-rejected, php-redflag, office-warsaw-rejected
export async function createFixtureOffers(): Promise<Offer[]> {
  const base = {
    source: 'test',
    company_name: 'FixtureCo',
    nice_to_have_skills: [] as string[],
    languages: [] as string[],
  }

  return Promise.all([
    prisma.offer.create({
      data: {
        ...base,
        slug: `${FIXTURE_SLUG_PREFIX}remote-ts-senior`,
        title: 'Senior TypeScript Engineer',
        workplace_type: 'remote',
        experience_level: 'senior',
        required_skills: ['typescript', 'react', 'node.js'],
        employment_types: [{ type: 'contract', from: 25000, to: 30000, currency: 'PLN', unit: 'Month' }],
      },
    }),
    prisma.offer.create({
      data: {
        ...base,
        slug: `${FIXTURE_SLUG_PREFIX}office-krakow-senior`,
        title: 'Senior Frontend Developer',
        workplace_type: 'office',
        city: 'Kraków',
        experience_level: 'senior',
        required_skills: ['typescript', 'react'],
        employment_types: [{ type: 'contract', from: 24000, to: 28000, currency: 'PLN', unit: 'Month' }],
      },
    }),
    prisma.offer.create({
      data: {
        ...base,
        slug: `${FIXTURE_SLUG_PREFIX}low-salary`,
        title: 'TypeScript Developer',
        workplace_type: 'remote',
        experience_level: 'mid',
        required_skills: ['typescript'],
        employment_types: [{ type: 'contract', from: 10000, to: 14000, currency: 'PLN', unit: 'Month' }],
      },
    }),
    prisma.offer.create({
      data: {
        ...base,
        slug: `${FIXTURE_SLUG_PREFIX}hybrid-rejected`,
        title: 'Fullstack Developer',
        workplace_type: 'hybrid',
        experience_level: 'senior',
        required_skills: ['react', 'typescript'],
        employment_types: [{ type: 'contract', from: 25000, to: 28000, currency: 'PLN', unit: 'Month' }],
      },
    }),
    prisma.offer.create({
      data: {
        ...base,
        slug: `${FIXTURE_SLUG_PREFIX}php-redflag`,
        title: 'PHP Developer',
        workplace_type: 'remote',
        experience_level: 'senior',
        required_skills: ['php', 'mysql'],
        employment_types: [{ type: 'contract', from: 25000, to: 28000, currency: 'PLN', unit: 'Month' }],
      },
    }),
    prisma.offer.create({
      data: {
        ...base,
        slug: `${FIXTURE_SLUG_PREFIX}office-warsaw-rejected`,
        title: 'Backend Developer',
        workplace_type: 'office',
        city: 'Warsaw',
        experience_level: 'senior',
        required_skills: ['typescript', 'node.js'],
        employment_types: [{ type: 'contract', from: 25000, to: 28000, currency: 'PLN', unit: 'Month' }],
      },
    }),
  ])
}

export async function deleteFixtureOffers(): Promise<void> {
  await prisma.offer.deleteMany({ where: { slug: { startsWith: FIXTURE_SLUG_PREFIX } } })
}
