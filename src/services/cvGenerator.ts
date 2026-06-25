import fs from 'fs';
import path from 'path';
import slugify from 'slugify';
import type { CandidateProfile } from '../types/profile';
import { env } from '../lib/env';
import { getClaudeModel } from '../lib/claudeModels';
import { prisma } from '../lib/prisma';

const TEMPLATE_PATH = path.resolve(process.cwd(), 'src/templates/cv.html');

interface CvLabels {
  summary: string
  experience: string
  own_projects: string
  skills: string
  highlighted: string
  education: string
  languages: string
  certifications: string
}

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
  present_label?: string
  rtl?: boolean
  native_label?: string
  language_names?: Record<string, string>
  cv_labels?: CvLabels
}

const FALLBACK_GDPR_EN = 'I hereby consent to the processing of my personal data included in this application for the purposes of the recruitment process, in accordance with the GDPR (Regulation (EU) 2016/679).'

async function getLanguageEntry(cvLanguage: string): Promise<LangEntry | undefined> {
  const row = await prisma.settings.findUnique({ where: { key: 'general_settings' } })
  if (!row) return undefined
  const languages: LangEntry[] = (JSON.parse(row.value) as { languages?: LangEntry[] }).languages ?? []
  const code = cvLanguage.toLowerCase()
  return languages.find(l => l.code === code)
    ?? languages.find(l => l.name.toLowerCase() === code)
    ?? languages.find(l => l.code === 'en')
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function fmtDate(
  raw: string | null | undefined,
  locale: string,
  presentLabel: string,
): string {
  if (!raw) return presentLabel;
  const [year, mm] = raw.split('-');
  const d = new Date(parseInt(year), parseInt(mm ?? '1', 10) - 1, 1);
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short' });
}

function fmtYear(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.split('-')[0] ?? '';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPhone(phone: string): string {
  const match = phone.match(/^(\+\d{1,3})(\d{9})$/)
  if (!match) return phone
  const [, prefix, digits] = match
  return `${prefix} ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
}

// ─── Claude JSON response types ───────────────────────────────────────────────

interface CvProject {
  name: string;
  skills: string[];
  highlighted_achievements: string[];
}

interface CvJob {
  company: string;
  title: string;
  date_from: string;
  date_to: string | null;
  work_model?: string;
  industry?: string;
  projects: CvProject[];
}

interface CvOwnProject {
  name: string;
  url?: string | null;
  skills: string[];
  description: string;
}

interface CvCert {
  name: string;
  issuer?: string;
  date?: string;
}

interface CvContent {
  detected_language: string;
  target_role: string;
  summary: string;
  highlighted_skills: string[];
  work_experience: CvJob[];
  own_projects: CvOwnProject[];
  certifications: CvCert[];
}

// ─── Work model / location formatting ────────────────────────────────────────

function formatWorkModel(work_model?: string, location?: string): string {
  if (work_model === 'remote') return 'Remote';
  if (work_model === 'hybrid' && location) return `Hybrid · ${location}`;
  if (work_model === 'onsite' && location) return location;
  if (location) return location;
  return '';
}

// ─── Section labels ───────────────────────────────────────────────────────────
// Labels are sourced per-language from general_settings.languages[].cv_labels.
// This English map is the in-code fallback when a language entry has no cv_labels.

const SECTION_LABELS: Record<'en', CvLabels> = {
  en: {
    summary: 'Summary',
    experience: 'Experience',
    own_projects: 'Own Projects',
    skills: 'Skills',
    highlighted: 'Highlighted for this Role',
    education: 'Education',
    languages: 'Languages',
    certifications: 'Certifications',
  },
};

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(
  cv: CvContent,
  profile: CandidateProfile,
  locale: string,
  labels: CvLabels,
  presentLabel: string,
  isRtl: boolean,
  translateCategory: (name: string) => string,
  nativeLabel: string,
  translateLanguageName: (name: string) => string,
  categoryOrder: string[],
): string {

  const {
    basic_info,
    education,
    own_projects: profileProjects,
    skills: technologies,
  } = profile;

  // In RTL documents, force dates left-to-right so month/year keep their order.
  const wrapDate = (d: string): string =>
    isRtl ? `<span dir="ltr">${d}</span>` : d;

  // Header contacts
  const contactParts = [
    basic_info.email
      ? `<a href="mailto:${esc(basic_info.email)}">${esc(basic_info.email)}</a>`
      : null,
    basic_info.phone ? esc(basic_info.phone) : null,
    basic_info.location?.city ? esc(basic_info.location.city) : null,
    basic_info.linkedin
      ? `<a href="https://${esc(basic_info.linkedin)}">${esc(basic_info.linkedin)}</a>`
      : null,
    basic_info.github
      ? `<a href="https://${esc(basic_info.github)}">${esc(basic_info.github)}</a>`
      : null,
  ].filter((x): x is string => x !== null);
  const contactsHtml = contactParts.join('<span class="sep">·</span>');

  // Experience
  const expHtml = cv.work_experience
    .map(job => {
      const projHtml = job.projects
        .map(p => {
          const uniqueSkills = [...new Set(p.skills)];
          const techsHtml = uniqueSkills.length
            ? `<div class="project-techs">${uniqueSkills.map(t => esc(t)).join(' · ')}</div>`
            : '';
          const achieveHtml = p.highlighted_achievements.length
            ? `<ul class="project-achievements">${p.highlighted_achievements.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
            : '';
          return `<div class="project">
          ${p.name ? `<div class="project-name">${esc(p.name)}</div>` : ''}
          ${techsHtml}${achieveHtml}
        </div>`;
        })
        .join('\n');

      const profileJob = (profile.work_experience ?? []).find(
        pj => pj.company === job.company,
      );
      const workModelStr = formatWorkModel(
        profileJob?.work_model,
        profileJob?.location ?? undefined,
      );
      const metaParts = [
        job.industry ? esc(job.industry) : null,
        workModelStr || null,
      ].filter((x): x is string => x !== null);
      const metaHtml = metaParts.length
        ? `<span class="job-company-meta"> · ${metaParts.join(' · ')}</span>`
        : '';
      return `<div class="job">
        <div class="job-header">
          <span>
            <span class="job-company-name">${esc(job.company)}</span>${metaHtml}
          </span>
          <span class="job-dates">${wrapDate(fmtDate(job.date_from, locale, presentLabel))} – ${profileJob?.currently_working || !job.date_to ? presentLabel : wrapDate(fmtDate(job.date_to, locale, presentLabel))}</span>
          <span class="job-title">${esc(job.title)}</span>
        </div>
        ${projHtml}
      </div>`;
    })
    .join('\n');

  // Own projects section — only if Claude selected any
  const showOwnProjects =
    (profileProjects ?? []).length > 0 && cv.own_projects.length > 0;
  const ownProjectsSection = showOwnProjects
    ? `<h2>${labels.own_projects}</h2>
  <div class="own-projects">
  ${cv.own_projects
    .map(p => {
      const urlSpan = p.url
        ? ` <span style="font-weight:400; color:#4a4a4a; font-size:12px;">· ${esc(p.url)}</span>`
        : '';
      const techsHtml = p.skills.length
        ? `<div class="own-project-techs">${p.skills.map(t => esc(t)).join(' · ')}</div>`
        : '';
      return `<div class="own-project">
          <div class="own-project-name">${esc(p.name)}${urlSpan}</div>
          ${techsHtml}
          <div class="own-project-desc">${esc(p.description)}</div>
        </div>`;
    })
    .join('\n')}
  </div>`
    : '';

  // Skills — highlighted first, then profile categories
  const highlightedSkillsHtml = cv.highlighted_skills.length
    ? `<div class="highlighted-row">
    <div class="highlighted-label">${labels.highlighted}</div>
    <div class="skills-pills">${cv.highlighted_skills.map(s => `<span class="pill highlighted">${esc(s)}</span>`).join('')}</div>
  </div>`
    : '';

  // Render categories in skill_categories.sort_order (categoryOrder). Skip empty
  // or unknown categories. Append any profile categories not present in categoryOrder
  // (defensive: a category without a DB row still renders, just last).
  const orderedCats = [
    ...categoryOrder,
    ...Object.keys(technologies).filter(c => !categoryOrder.includes(c)),
  ];
  const categorySkillsHtml = orderedCats
    .map(cat => [cat, technologies[cat]] as const)
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
      Array.isArray(entry[1]) && entry[1].length > 0)
    .map(
      ([cat, techs]) =>
        `<div class="skills-row">
          <div class="skills-label">${esc(translateCategory(cat))}</div>
          <div class="skills-pills">${techs.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>
        </div>`,
    )
    .join('\n');

  // Education
  const eduHtml = (education ?? [])
    .map(e => {
      const dateRange = [fmtYear(e.date_from), fmtYear(e.date_to)]
        .filter(Boolean)
        .join(' – ');
      return `<div class="education-item">
        <div style="display:flex; justify-content:space-between;">
          <span class="edu-institution">${esc(e.institution)}</span>
          <span class="edu-dates">${dateRange}</span>
        </div>
        ${
          e.degree || e.field
            ? `<div class="edu-degree">${[e.degree, e.field]
                .filter(Boolean)
                .map(s => esc(s!))
                .join(', ')}</div>`
            : ''
        }
      </div>`;
    })
    .join('\n');

  // Languages — translate the language name and replace the "native" level with its
  // localized label; keep CEFR levels (C1, B2, …) as-is.
  const langsText = (basic_info.languages ?? [])
    .map(l => {
      const translated = translateLanguageName(l.name);
      const name = translated.charAt(0).toUpperCase() + translated.slice(1);
      const level = l.level.toLowerCase() === 'native' ? nativeLabel : l.level;
      return esc(`${name} (${level})`);
    })
    .join(', ');

  // Certifications
  const certificationsSection = cv.certifications.length
    ? `<h2>${labels.certifications}</h2>
  ${cv.certifications
    .map(c => {
      const meta = [
        c.issuer ? esc(c.issuer) : null,
        c.date ? wrapDate(fmtDate(c.date, locale, presentLabel)) : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `<div class="cert-item">
        <span class="cert-name">${esc(c.name)}</span>
        ${meta ? `<span class="cert-meta"> — ${meta}</span>` : ''}
      </div>`;
    })
    .join('\n')}`
    : '';

  const fullName = `${esc(basic_info.first_name)} ${esc(basic_info.last_name)}`;
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  return template
    .replace('{{FULL_NAME}}', fullName)
    .replace('{{TARGET_ROLE}}', esc(cv.target_role))
    .replace('{{CONTACTS}}', contactsHtml)
    .replace('{{LABEL_SUMMARY}}', labels.summary)
    .replace('{{SUMMARY}}', esc(cv.summary))
    .replace('{{LABEL_EXPERIENCE}}', labels.experience)
    .replace('{{EXPERIENCE}}', expHtml)
    .replace('{{OWN_PROJECTS_SECTION}}', ownProjectsSection)
    .replace('{{HIGHLIGHTED_SKILLS}}', highlightedSkillsHtml)
    .replace('{{LABEL_SKILLS}}', labels.skills)
    .replace('{{CATEGORY_SKILLS}}', categorySkillsHtml)
    .replace('{{LABEL_EDUCATION}}', labels.education)
    .replace('{{EDUCATION}}', eduHtml)
    .replace('{{LABEL_LANGUAGES}}', labels.languages)
    .replace('{{LANGUAGES}}', langsText)
    .replace('{{CERTIFICATIONS_SECTION}}', certificationsSection);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateCV(
  profile: CandidateProfile,
  offerText: string,
  cvLanguage: string,
  jobTitle?: string,
  companyName?: string,
  user?: { id: string; show_agent_info_in_cv: boolean },
  model?: string,
): Promise<{ html: string; filename: string; usage: { input_tokens: number; output_tokens: number }; detected_language: string }> {
  const resolvedModel = model ?? await getClaudeModel('cv_generation')
  const profileForClaude = {
    basic_info: {
      first_name: profile.basic_info.first_name,
      last_name: profile.basic_info.last_name,
      experience_level: profile.basic_info.experience_level,
      experience_since: profile.basic_info.experience_since,
      experience_in_country_markets:
        profile.basic_info.experience_in_country_markets,
      experience_in_industry: profile.basic_info.experience_in_industry,
      languages: profile.basic_info.languages,
      cv_summary_bullets: profile.basic_info.cv_summary_bullets,
      soft_skills: profile.basic_info.soft_skills,
    },
    work_experience: profile.work_experience ?? [],
    own_projects: profile.own_projects ?? [],
    certifications: profile.certifications ?? [],
    skills: profile.skills,
  };

  const prompt = `Detect the language of the job offer from the JOB OFFER section below and generate the entire CV in that same language. Do not use any other language.

The JOB OFFER section may contain UI elements, navigation, and page chrome in a different language than the actual job offer. Detect the language of the JOB OFFER ITSELF — focus on: job title, job description, requirements, responsibilities, and qualifications sections. Ignore any navigation menus, buttons, footer text, or unrelated page elements when determining the language.

CRITICAL: You must output ONLY valid text in the detected language. Never mix characters from other writing systems. If uncertain about a word, use a simpler alternative in the detected language. Any character that is not part of the detected language's writing system must be removed.

CRITICAL INSTRUCTION: You MUST generate ALL text content EXCLUSIVELY in the detected language of the job offer. This is non-negotiable. Every sentence, every description, every achievement must be written in that language. The candidate's profile may be in Polish or English — ignore the source language and translate everything to the detected language.

You are a professional CV writer. Analyse the candidate profile and job offer, then return a JSON object with tailored CV content.

LANGUAGE: Detect the language from the job title, job description, requirements, responsibilities, and qualifications in the JOB OFFER section — not from UI chrome or navigation. Generate ALL text content in that language. Translate the candidate's summary, work experience achievements, and any other descriptive text. Keep proper nouns (company names, technology names, product names) in their original form.

CANDIDATE PROFILE:
${JSON.stringify(profileForClaude, null, 2)}

JOB OFFER:
${offerText.slice(0, 3000)}

Return ONLY valid JSON (no markdown, no code fences, no explanation) matching this exact structure:
{
  "detected_language": "ISO 639-1 code of the detected offer language (e.g. 'en', 'de', 'pl', 'fr')",
  "target_role": "job title tailored to this offer",
  "summary": "2-3 sentence professional summary in the detected language tailored to this offer. Write in first person (I, my, me) — never third person (he, she, they). Example: 'I led a cross-functional team...' not 'He led a cross-functional team...'. Use cv_summary_bullets as inspiration. Highlight experience_in_industry and experience_in_country_markets where relevant. Weave soft_skills naturally into prose — do not list them verbatim.",
  "highlighted_skills": ["skill1", "skill2"],
  "work_experience": [
    {
      "company": "company name from profile",
      "title": "job title from profile",
      "date_from": "YYYY-MM",
      "date_to": "YYYY-MM or null if current",
      "work_model": "Remote/Hybrid/Office",
      "industry": "industry name",
      "projects": [
        {
          "name": "project name",
          "skills": ["tech1", "tech2"],
          "highlighted_achievements": ["most relevant achievement for this offer"]
        }
      ]
    }
  ],
  "own_projects": [
    {
      "name": "project name",
      "url": "url or null",
      "skills": ["tech1", "tech2"],
      "description": "1 sentence tailored to this offer in the detected language"
    }
  ],
  "certifications": [
    { "name": "cert name", "issuer": "issuer or null", "date": "YYYY-MM or null" }
  ]
}

Rules:
- highlighted_skills: 6–10 skills from the job offer requirements that match the candidate's profile
- work_experience: include ALL jobs; per job select 1–2 most relevant projects with 1–2 achievements each
- own_projects: include all provided projects with a tailored 1-sentence description in the detected language
- certifications: include only if relevant to this offer, otherwise return []
- date_to: null means currently employed there
- dates must be in YYYY-MM format (e.g. "2021-03")
- IMPORTANT: if a project has name="" (empty string) in the profile, do NOT invent or generate a project name — output name="" in your JSON response. The CV template hides it automatically.`;

  console.log('[cvGenerator] calling Claude API, prompt length:', prompt.length);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolvedModel,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(55_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('[cvGenerator] Claude API error status:', response.status);
    console.error('[cvGenerator] Claude API error body:', errorBody);
    console.error('[cvGenerator] prompt length (chars):', prompt.length);
    throw new Error(`Claude API error: ${response.status} ${errorBody}`);
  }

  const data = (await response.json()) as {
    content: Array<{ text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  const raw = data.content[0].text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const cv = JSON.parse(raw) as CvContent;
  const detectedLanguage = cv.detected_language ?? cvLanguage;
  const langEntry = await getLanguageEntry(detectedLanguage);

  // Enforce empty project names regardless of what Claude generated.
  // Claude may invent a name even when told not to — the profile is the source of truth.
  const profileWorkExp = profile.work_experience ?? [];
  for (const cvJob of cv.work_experience) {
    const profileJob = profileWorkExp.find(pj => pj.company === cvJob.company);
    if (!profileJob?.projects) continue;
    cvJob.projects.forEach((cvProj, idx) => {
      const profileProj = profileJob.projects?.[idx];
      if (profileProj && profileProj.name === '') {
        cvProj.name = '';
      }
    });
  }

  // Sort experience: currently-working jobs first, then by start date descending.
  // currently_working lives on the profile job; fall back to a null date_to.
  const isCurrent = (job: CvJob): boolean =>
    profileWorkExp.find(pj => pj.company === job.company)?.currently_working ??
    job.date_to === null;
  cv.work_experience.sort((a, b) => {
    if (isCurrent(a) && !isCurrent(b)) return -1;
    if (!isCurrent(a) && isCurrent(b)) return 1;
    return new Date(b.date_from).getTime() - new Date(a.date_from).getTime();
  });

  const opts = { lower: true, strict: true };
  const slug = (s: string) => slugify(s, opts);
  const { first_name, last_name } = profile.basic_info;
  const filenameParts = [
    'cv',
    slug(first_name),
    slug(last_name),
    jobTitle ? slug(jobTitle) : null,
    companyName ? slug(companyName) : null,
  ].filter((p): p is string => p !== null && p.length > 0);
  const filename = filenameParts.join('-') + '.pdf';

  const locale = langEntry?.locale ?? 'en-US';
  const labels = langEntry?.cv_labels ?? SECTION_LABELS['en'];
  const presentLabel = langEntry?.present_label ?? 'present';
  const nativeLabel = langEntry?.native_label ?? 'native';
  const isRtl = langEntry?.rtl ?? false;
  const textDirection = isRtl ? 'rtl' : 'ltr';

  // Translate skill category headers (profile.skills is keyed by category name).
  // Fetch in sort_order so skill sections render in the configured order.
  const categories = await prisma.skillCategory.findMany({ orderBy: { sort_order: 'asc' } });
  const categoryOrder = categories.map(c => c.name);
  const translateCategory = (name: string): string => {
    const cat = categories.find(c => c.name === name);
    const t = cat?.translations as Record<string, string> | null | undefined;
    return t?.[cvLanguage] ?? t?.['en'] ?? name;
  };

  // Translate language names (e.g. "English") into the CV language.
  const languageNames = langEntry?.language_names ?? {};
  const translateLanguageName = (name: string): string => languageNames[name] ?? name;

  let html = buildHtml(cv, profile, locale, labels, presentLabel, isRtl, translateCategory, nativeLabel, translateLanguageName, categoryOrder)
    .replace('{{CV_TITLE}}', filename.replace('.pdf', ''))
    .replace('{{LANG}}', cvLanguage)
    .replace('{{TEXT_DIRECTION}}', textDirection);

  // Agent info + GDPR footer
  const isPl =
    cvLanguage.toLowerCase() === 'pl' ||
    cvLanguage.toLowerCase().startsWith('pol');
  const footerParts: string[] = [];

  if (user?.show_agent_info_in_cv) {
    const agentClient = await prisma.agentClient.findFirst({
      where: { user_id: user.id },
      include: { agent: true },
    });
    if (agentClient) {
      const { agent } = agentClient;
      const agentPhone = agent.phone ? ` · ${esc(formatPhone(agent.phone))}` : '';
      const agentFirstName = (isPl && agent.first_name_genitive) ? agent.first_name_genitive : agent.first_name;
      const agentLastName = (isPl && agent.last_name_genitive) ? agent.last_name_genitive : agent.last_name;
      const agentLine = isPl
        ? `Reprezentuje mnie ${esc(agentFirstName)} ${esc(agentLastName)} z Homo Digital — ${esc(agent.email)}${agentPhone}`
        : `I am represented by ${esc(agentFirstName)} ${esc(agentLastName)} from Homo Digital — ${esc(agent.email)}${agentPhone}`;
      footerParts.push(
        `<div class="cert-item" style="margin-bottom: 16px;">${agentLine}</div>`,
      );
    }
  }

  const gdprText = esc(langEntry?.gdpr ?? FALLBACK_GDPR_EN);

  html = html.replace('{{FOOTER_NOTES}}', footerParts.join('\n'));
  html = html.replace('{{GDPR_CONSENT}}', gdprText);
  html = html.replace(/—/g, '-');

  return { html, filename, usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 }, detected_language: detectedLanguage };
}
