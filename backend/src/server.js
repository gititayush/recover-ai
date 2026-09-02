const { createApp } = require('./app');
const { environment } = require('./config/env');
const logger = require('./config/logger');
const { getPool, closePool } = require('./db/pool');
const { PostgresRecoveryRepository } = require('./models/postgresRecoveryRepository');
const { createRecoveryWorker } = require('./worker/recoveryWorker');

const repository = new PostgresRecoveryRepository(getPool());
const app = createApp(repository);

let worker = null;
if (environment.AUTONOMOUS_RECOVERY_ENABLED) {
  worker = createRecoveryWorker({ repository });
  worker.start();
}

const server = app.listen(environment.PORT, '0.0.0.0', () => {
  logger.info('Revflow backend listening', {
    host: '0.0.0.0',
    port: environment.PORT,
    autonomousRecovery: environment.AUTONOMOUS_RECOVERY_ENABLED
  });
});

function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  if (worker) {
    worker.stop();
  }
  server.close(() => {
    closePool().finally(() => {
      logger.info('Closed database connection pool. Exiting.');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
