const { Pool } = require('pg');
const { environment } = require('../config/env');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: environment.DATABASE_URL });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, closePool };
