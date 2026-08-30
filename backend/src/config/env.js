const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config();

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/recoverai'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info')
});

const environment = environmentSchema.parse({
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL
});

module.exports = { environment };
