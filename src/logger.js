function createLogger(component, { level = 'info' } = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevel = levels[level] ?? levels.info;

  function format(lvl, msg, data) {
    const ts = new Date().toISOString();
    const suffix = data !== undefined ? ' ' + JSON.stringify(data) : '';
    return `${ts} [${lvl}] [${component}]${msg ? ' ' + msg : ''}${suffix}`;
  }

  return {
    debug(msg, data) {
      if (minLevel <= levels.debug) console.log(format('DEBUG', msg, data));
    },
    info(msg, data) {
      if (minLevel <= levels.info) console.log(format('INFO', msg, data));
    },
    warn(msg, data) {
      if (minLevel <= levels.warn) console.warn(format('WARN', msg, data));
    },
    error(msg, data) {
      if (minLevel <= levels.error) console.error(format('ERROR', msg, data));
    },
  };
}

module.exports = { createLogger };
