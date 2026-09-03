const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('./pool');

async function migrate(pool = getPool()) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  return true;
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log('Revflow database schema is ready.');
    })
    .catch((error) => {
      console.error(`Database migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = { migrate };
