import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { validateSupabaseJwt } from '../middleware/validateSupabaseJwt';
import { getSupabase } from '../lib/supabase';
import { updateExchangeRates } from '../lib/exchangeRates';

export const authRouter = Router();

function getDefaultCurrency(tz: string): string {
  if (tz?.startsWith('Europe/')) {
    if (tz === 'Europe/Warsaw') return 'PLN';
    if (tz === 'Europe/London') return 'GBP';
    if (['Europe/Zurich', 'Europe/Geneva'].includes(tz)) return 'CHF';
    if (['Europe/Oslo'].includes(tz)) return 'NOK';
    if (['Europe/Stockholm'].includes(tz)) return 'SEK';
    if (['Europe/Copenhagen'].includes(tz)) return 'DKK';
    return 'EUR';
  }
  if (tz?.startsWith('America/')) return 'USD';
  if (tz?.startsWith('Australia/')) return 'AUD';
  return 'USD';
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'INVALID_REQUEST', message: 'Invalid request body' });
  }
  const { email, password } = parsed.data;

  // 1. Agent lookup — uses password_hash column
  const agent = await prisma.agent.findUnique({ where: { email } });
  if (agent) {
    const valid = await bcrypt.compare(password, agent.password_hash);
    if (!valid) {
      return res
        .status(401)
        .json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { role: 'agent', agent_id: agent.id, email: agent.email },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    );
    return res.json({ token, role: 'agent', agent_id: agent.id });
  }

  // 2. Client/user lookup — uses password column
  const user = await prisma.user.findUnique({ where: { email } });
  if (user?.password) {
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res
        .status(401)
        .json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { role: 'client', user_id: user.id, email: user.email },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    );
    return res.json({ token, role: 'client', user_id: user.id });
  }

  // 3. Not found or no password set
  return res
    .status(401)
    .json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
});

authRouter.post('/social-login', validateSupabaseJwt, async (req, res) => {
  const { email } = req.supabase_user!;
  const timezone =
    typeof req.body?.timezone === 'string'
      ? (req.body.timezone as string)
      : undefined;

  const token = req.headers.authorization!.slice(7);
  const {
    data: { user: supabaseUser },
  } = await getSupabase().auth.getUser(token);
  const photoUrl =
    (supabaseUser?.user_metadata?.['avatar_url'] as string | undefined) ?? null;

  const [freePlan, existingUser] = await Promise.all([
    prisma.plan.findUnique({ where: { name: 'free' } }),
    prisma.user.findUnique({
      where: { email },
      select: {
        cv_counter_max: true,
        cl_counter_max: true,
        scan_page_counter_max: true,
        profile_relevant_change_counter_max: true,
        review_by_ai_counter_max: true,
        status_change_counter_max: true,
      },
    }),
  ]);
  const freeLimits = freePlan?.limits as
    | {
        max_cv?: number;
        max_cl?: number;
        max_scan_page?: number;
        profile_relevant_change_max?: number;
        max_review_by_ai?: number;
        max_status_change?: number | null;
      }
    | undefined;
  const defaultTimezone = timezone ?? 'America/New_York';
  const defaultCurrency = getDefaultCurrency(defaultTimezone);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      jobmatcher_api_key: `jm_live_${crypto.randomBytes(16).toString('hex')}`,
      photo_url: photoUrl,
      cv_counter_max: freeLimits?.max_cv ?? 0,
      cl_counter_max: freeLimits?.max_cl ?? 0,
      scan_page_counter_max: freeLimits?.max_scan_page ?? 0,
      profile_relevant_change_counter_max:
        freeLimits?.profile_relevant_change_max ?? 0,
      review_by_ai_counter_max: freeLimits?.max_review_by_ai ?? 0,
      status_change_counter_max: freePlan?.max_status_change ?? null,
      timezone: defaultTimezone,
      preferred_currency: defaultCurrency,
    },
    update: {
      email,
      ...(photoUrl ? { photo_url: photoUrl } : {}),
      ...(existingUser?.cv_counter_max === 0
        ? { cv_counter_max: freeLimits?.max_cv ?? 0 }
        : {}),
      ...(existingUser?.cl_counter_max === 0
        ? { cl_counter_max: freeLimits?.max_cl ?? 0 }
        : {}),
      ...(existingUser?.scan_page_counter_max === 0
        ? { scan_page_counter_max: freeLimits?.max_scan_page ?? 0 }
        : {}),
      ...(existingUser?.profile_relevant_change_counter_max === 0
        ? {
            profile_relevant_change_counter_max:
              freeLimits?.profile_relevant_change_max ?? 0,
          }
        : {}),
      ...(existingUser?.review_by_ai_counter_max === 0
        ? { review_by_ai_counter_max: freeLimits?.max_review_by_ai ?? 0 }
        : {}),
      ...(existingUser?.status_change_counter_max === null
        ? { status_change_counter_max: freePlan?.max_status_change ?? null }
        : {}),
    },
    select: {
      id: true,
      cv_counter_max: true,
      cl_counter_max: true,
      scan_page_counter_max: true,
      profile_relevant_change_counter_max: true,
    },
  });
  if (freePlan) {
    await prisma.subscription.upsert({
      where: { user_id: user.id },
      create: {
        user_id: user.id,
        plan_id: freePlan.id,
        status: 'active',
        stripe_subscription_id: null,
        current_period_start: null,
        current_period_end: null,
      },
      update: {},
    });
  }

  updateExchangeRates().catch(err =>
    console.error('[social-login] exchange rate refresh error:', err),
  );

  const jmToken = jwt.sign(
    { role: 'client', user_id: user.id, email },
    env.JWT_SECRET,
    { expiresIn: '30d' },
  );

  res.json({ token: jmToken, role: 'client', user_id: user.id });
});
