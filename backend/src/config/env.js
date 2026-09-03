const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config();

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  RAZORPAY_ACTION_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(30),
  AUTONOMOUS_RECOVERY_ENABLED: z.coerce.boolean().default(false),
  AUTONOMY_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  AUTONOMY_WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  AUTONOMY_WORKER_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  AUTONOMY_WORKER_BASE_BACKOFF_SECONDS: z.coerce.number().int().positive().default(30),
  COMMUNICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  COMMUNICATION_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(30),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().default('whatsapp:+14155238886'),
  WHATSAPP_PROVIDER_MODE: z.enum(['SANDBOX', 'TEST', 'SIMULATED', 'DISABLED', 'UNCONFIGURED']).default('SANDBOX'),
  TWILIO_STATUS_CALLBACK_URL: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production') {
    if (!data.RAZORPAY_KEY_ID || data.RAZORPAY_KEY_ID.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_KEY_ID'],
        message: 'RAZORPAY_KEY_ID is required in production mode.'
      });
    }
    if (!data.RAZORPAY_KEY_SECRET || data.RAZORPAY_KEY_SECRET.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_KEY_SECRET'],
        message: 'RAZORPAY_KEY_SECRET is required in production mode.'
      });
    }
    if (!data.RAZORPAY_WEBHOOK_SECRET || data.RAZORPAY_WEBHOOK_SECRET.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_WEBHOOK_SECRET'],
        message: 'RAZORPAY_WEBHOOK_SECRET is required in production mode.'
      });
    }
    if (!data.AI_API_KEY || data.AI_API_KEY.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_API_KEY'],
        message: 'AI_API_KEY is required in production mode.'
      });
    }
  }
});

function parseEnvironment(env = process.env) {
  return environmentSchema.parse({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    DATABASE_URL: env.DATABASE_URL,
    LOG_LEVEL: env.LOG_LEVEL,
    FRONTEND_ORIGIN: env.FRONTEND_ORIGIN,
    RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
    AI_PROVIDER: env.AI_PROVIDER,
    AI_API_KEY: env.AI_API_KEY,
    AI_MODEL: env.AI_MODEL,
    AI_BASE_URL: env.AI_BASE_URL,
    AI_CONFIDENCE_THRESHOLD: env.AI_CONFIDENCE_THRESHOLD,
    RAZORPAY_MAX_AUTOMATED_ATTEMPTS: env.RAZORPAY_MAX_AUTOMATED_ATTEMPTS,
    RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE: env.RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE,
    RAZORPAY_ACTION_COOLDOWN_MINUTES: env.RAZORPAY_ACTION_COOLDOWN_MINUTES,
    AUTONOMOUS_RECOVERY_ENABLED: env.AUTONOMOUS_RECOVERY_ENABLED,
    AUTONOMY_WORKER_POLL_INTERVAL_MS: env.AUTONOMY_WORKER_POLL_INTERVAL_MS,
    AUTONOMY_WORKER_LEASE_SECONDS: env.AUTONOMY_WORKER_LEASE_SECONDS,
    AUTONOMY_WORKER_MAX_RETRIES: env.AUTONOMY_WORKER_MAX_RETRIES,
    AUTONOMY_WORKER_BASE_BACKOFF_SECONDS: env.AUTONOMY_WORKER_BASE_BACKOFF_SECONDS
  });
}

const environment = parseEnvironment(process.env);

function getRazorpayWebhookSecret() {
  return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null;
}

module.exports = { environment, environmentSchema, parseEnvironment, getRazorpayWebhookSecret };
