const { createApp } = require('./app');
const { environment } = require('./config/env');
const logger = require('./config/logger');
const { getPool } = require('./db/pool');
const { PostgresRecoveryRepository } = require('./models/postgresRecoveryRepository');

const repository = new PostgresRecoveryRepository(getPool());
const app = createApp(repository);

app.listen(environment.PORT, '0.0.0.0', () => logger.info('Revflow backend listening', { host: '0.0.0.0', port: environment.PORT }));
