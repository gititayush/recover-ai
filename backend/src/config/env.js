const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config();

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/recoverai'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  FRONTEND_ORIGIN: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  AI_PROVIDER: z.string().default('openai-compatible'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-4.1-mini'),
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  RAZORPAY_MAX_AUTOMATED_ATTEMPTS: z.coerce.number().int().positive().default(2),
  RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE: z.coerce.number().int().positive().default(2500000),
  RAZORPAY_ACTION_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(30)
});

const environment = environmentSchema.parse({
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  AI_PROVIDER: process.env.AI_PROVIDER,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_MODEL: process.env.AI_MODEL,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_CONFIDENCE_THRESHOLD: process.env.AI_CONFIDENCE_THRESHOLD,
  RAZORPAY_MAX_AUTOMATED_ATTEMPTS: process.env.RAZORPAY_MAX_AUTOMATED_ATTEMPTS,
  RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE: process.env.RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE,
  RAZORPAY_ACTION_COOLDOWN_MINUTES: process.env.RAZORPAY_ACTION_COOLDOWN_MINUTES
});

function getRazorpayWebhookSecret() {
  return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null;
}

module.exports = { environment, getRazorpayWebhookSecret };
