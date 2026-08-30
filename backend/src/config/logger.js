function log(level, message, context = {}) {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context }));
}

module.exports = {
  info: (message, context) => log('info', message, context),
  warn: (message, context) => log('warn', message, context),
  error: (message, context) => log('error', message, context)
};
