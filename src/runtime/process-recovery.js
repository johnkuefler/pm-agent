'use strict';

function describeError(error) {
  if (error instanceof Error) {
    return {
      name: String(error.name || 'Error').slice(0, 80),
      message: String(error.message || error).slice(0, 500),
      stack: String(error.stack || '').slice(0, 4000) || null,
    };
  }
  return { name: 'NonError', message: String(error).slice(0, 500), stack: null };
}

function createProcessRecovery({ stop, beforeStop = () => {}, exit = code => process.exit(code),
  logger = console, setTimer = setTimeout, clearTimer = clearTimeout,
  gracefulTimeoutMs = 25000, fatalTimeoutMs = 12000, now = Date.now } = {}) {
  if (typeof stop !== 'function') throw new Error('process recovery requires a stop function');
  const state = {
    state: 'running', reason: null, fatal: false, requested_at: null, completed_at: null,
    exit_code: null, forced: false, error: null, duplicate_requests: 0,
  };
  let shutdownPromise = null;
  let forceTimer = null;
  let installed = null;

  function snapshot() { return { ...state, error: state.error ? { ...state.error } : null }; }

  function requestShutdown(reason, { fatal = false, error = null } = {}) {
    if (shutdownPromise) {
      state.duplicate_requests += 1;
      return shutdownPromise;
    }
    const exitCode = fatal ? 1 : 0;
    const timeoutMs = Math.max(1000, Number(fatal ? fatalTimeoutMs : gracefulTimeoutMs) || 1000);
    Object.assign(state, {
      state: 'draining', reason: String(reason || 'shutdown').slice(0, 120), fatal: Boolean(fatal),
      requested_at: new Date(now()).toISOString(), exit_code: exitCode,
      error: error == null ? null : describeError(error),
    });
    try { beforeStop(snapshot()); }
    catch (hookError) { logger.error('Process shutdown readiness hook failed:', hookError); }
    if (fatal) logger.error(`Fatal process event (${state.reason}); draining before restart: ${state.error?.name}: ${state.error?.message}`);
    else logger.log(`Received ${state.reason}; draining Nora before shutdown`);

    forceTimer = setTimer(() => {
      state.state = 'forced_exit';
      state.forced = true;
      state.completed_at = new Date(now()).toISOString();
      logger.error(`Process drain exceeded ${timeoutMs}ms; forcing exit ${exitCode}`);
      exit(exitCode);
    }, timeoutMs);

    shutdownPromise = Promise.resolve().then(stop)
      .then(() => {
        if (forceTimer) clearTimer(forceTimer);
        state.state = 'completed';
        state.completed_at = new Date(now()).toISOString();
        exit(exitCode);
      })
      .catch(stopError => {
        if (forceTimer) clearTimer(forceTimer);
        state.state = 'drain_failed';
        state.completed_at = new Date(now()).toISOString();
        if (!state.error) state.error = describeError(stopError);
        logger.error('Graceful process drain failed:', stopError);
        exit(1);
      });
    return shutdownPromise;
  }

  function install(target = process) {
    if (installed) return installed.remove;
    const onSigterm = () => requestShutdown('SIGTERM');
    const onSigint = () => requestShutdown('SIGINT');
    const onUnhandled = reason => requestShutdown('unhandledRejection', { fatal: true, error: reason });
    const onUncaught = error => requestShutdown('uncaughtException', { fatal: true, error });
    target.once('SIGTERM', onSigterm);
    target.once('SIGINT', onSigint);
    target.on('unhandledRejection', onUnhandled);
    target.on('uncaughtException', onUncaught);
    const remove = () => {
      target.off('SIGTERM', onSigterm);
      target.off('SIGINT', onSigint);
      target.off('unhandledRejection', onUnhandled);
      target.off('uncaughtException', onUncaught);
      installed = null;
    };
    installed = { remove };
    return remove;
  }

  return { requestShutdown, install, snapshot };
}

module.exports = { createProcessRecovery, describeError };
