import { z } from 'zod'

const LocationSchema = z.object({
  country_code: z.string().optional(),
  city: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  max_distance_km: z.number().optional(),
})

const BasicInfoSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  current_title: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  location: LocationSchema.optional(),
  experience_level: z.enum(['junior', 'mid', 'senior', 'c_level']).optional(),
  experience_since: z.number().int().optional(),
  languages: z.array(z.object({ name: z.string(), level: z.string() })).optional(),
  job_search_status: z.string().optional(),
  experience_in_country_markets: z.array(z.string()).optional(),
  experience_in_industry: z.array(z.string()).optional(),
  cv_summary_bullets: z.array(z.string()).optional(),
  soft_skills: z.array(z.string()).optional(),
})

const SalaryRangeSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
})


const WorkStyleSchema = z.object({
  environment_preferences: z.record(z.string(), z.string()).optional(),
  collaboration_style: z.record(z.string(), z.string()).optional(),
})

const EducationSchema = z.object({
  institution: z.string(),
  degree: z.string().optional(),
  field: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  gpa: z.string().optional(),
  thesis: z.string().optional(),
})

const ProjectSchema = z.object({
  name: z.string(),
  skills: z.array(z.string()).optional(),
  team_size: z.number().int().positive().optional(),
  role: z.string().optional(),
  achievements: z.array(z.string()).optional(),
})

const WorkExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  date_from: z.string(),
  date_to: z.string().optional(),
  company_type: z.string().optional(),
  company_size: z.string().optional(),
  industry: z.string().optional(),
  work_model: z.string().optional(),
  location: z.string().optional(),
  projects: z.array(ProjectSchema).optional(),
  technologies: z.array(z.string()).optional(),
  achievements: z.array(z.string()).optional(),
})

const OwnProjectSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  skills: z.array(z.string()),
  achievements: z.array(z.string()),
})

const TechnologySchema = z.object({
  name: z.string(),
  since: z.number().int().optional(),
  last_used: z.number().int().optional(),
  context: z.string().optional(),
})

const SoftSkillSchema = z.object({
  skill: z.string(),
  evidence: z.string().optional(),
})

const CertificationSchema = z.object({
  name: z.string(),
  issuer: z.string().optional(),
  date: z.string().optional(),
  url: z.string().optional(),
  status: z.string().optional(),
  planned_date: z.string().optional(),
  issued_date: z.string().optional(),
})

const SalaryPreferenceSchema = z.object({
  type: z.enum(['contract', 'permanent']),
  currency: z.string(),
  min: z.number().nonnegative(),
})

const PreferencesSchema = z.object({
  company_type: z.array(z.string()).optional(),
  company_type_excluded: z.array(z.string()).optional(),
  work_model: z.array(z.string()).optional(),
  max_office_days_per_week: z.number().int().nonnegative().optional(),
  office_location_cities: z.array(z.string()).optional(),
  team_size: SalaryRangeSchema.optional(),
  industries: z.array(z.string()).optional(),
  employment_type: z.array(z.string()).optional(),
  salary: z.array(SalaryPreferenceSchema).optional(),
  markets: z.array(z.string()).optional(),
  learning_goals: z.array(z.string()).optional(),
  target_role: z.array(z.string()).optional(),
})

const RedFlagSchema = z.object({
  category: z.string(),
  description: z.union([z.string(), z.array(z.string())]),
})

export const CandidateProfileSchema = z.object({
  profile_version: z.string().optional(),
  created_at: z.string().optional(),
  basic_info: BasicInfoSchema,
  work_style: WorkStyleSchema.optional(),
  education: z.array(EducationSchema).optional(),
  work_experience: z.array(WorkExperienceSchema).optional(),
  own_projects: z.array(OwnProjectSchema).optional(),
  skills: z.record(z.string(), z.array(TechnologySchema)),
  soft_skills: z.array(SoftSkillSchema).optional(),
  certifications: z.array(CertificationSchema).optional(),
  preferences: PreferencesSchema,
  red_flags: z.array(RedFlagSchema),
  strengths: z.array(z.string()).optional(),
})

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>
export type Technology = z.infer<typeof TechnologySchema>
export type RedFlag = z.infer<typeof RedFlagSchema>
export type Preferences = z.infer<typeof PreferencesSchema>
export type SalaryPreference = z.infer<typeof SalaryPreferenceSchema>
