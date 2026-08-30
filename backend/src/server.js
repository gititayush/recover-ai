const { createApp } = require('./app');
const { environment } = require('./config/env');
const logger = require('./config/logger');
const { getPool } = require('./db/pool');
const { PostgresRecoveryRepository } = require('./models/postgresRecoveryRepository');

const repository = new PostgresRecoveryRepository(getPool());
const app = createApp(repository);

app.listen(environment.PORT, () => logger.info('RecoverAI backend listening', { port: environment.PORT }));
