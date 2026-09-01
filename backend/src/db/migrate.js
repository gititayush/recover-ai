const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('./pool');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await getPool().query(schema);
  console.log('Revflow database schema is ready.');
}

migrate()
  .catch((error) => {
    console.error(`Database migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
