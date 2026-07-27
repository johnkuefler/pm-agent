'use strict';

const DEFAULT_READ_TIMEOUT_MS = 12000;
const DEFAULT_WRITE_TIMEOUT_MS = 15000;

function boundedTimeout(value, fallback, ceiling) {
  return Math.max(1, Math.min(ceiling, Number(value) || fallback));
}

function createTeamworkClient({
  httpClient,
  getConfig,
  readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
  writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
} = {}) {
  if (!httpClient || typeof httpClient.get !== 'function' || typeof httpClient.request !== 'function') {
    throw new TypeError('Teamwork client requires an HTTP client with get and request methods');
  }
  if (typeof getConfig !== 'function') {
    throw new TypeError('Teamwork client requires a getConfig function');
  }

  function config() {
    const current = getConfig() || {};
    return {
      apiKey: current.apiKey,
      baseUrl: current.baseUrl,
    };
  }

  function enabled() {
    const current = config();
    return Boolean(current.apiKey && current.baseUrl);
  }

  function requestAuth(current) {
    return `Basic ${Buffer.from(`${current.apiKey}:`).toString('base64')}`;
  }

  async function get(pathAndQuery, { signal, timeoutMs = readTimeoutMs } = {}) {
    const current = config();
    const response = await httpClient.get(`${current.baseUrl}${pathAndQuery}`, {
      headers: {
        Authorization: requestAuth(current),
        'Content-Type': 'application/json',
      },
      timeout: boundedTimeout(timeoutMs, readTimeoutMs, DEFAULT_READ_TIMEOUT_MS),
      signal,
    });
    return response.data;
  }

  async function send(method, pathAndQuery, body) {
    const current = config();
    const response = await httpClient.request({
      method,
      url: `${current.baseUrl}${pathAndQuery}`,
      headers: {
        Authorization: requestAuth(current),
        'Content-Type': 'application/json',
      },
      data: body,
      timeout: boundedTimeout(writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, DEFAULT_WRITE_TIMEOUT_MS),
    });
    return response.data;
  }

  return Object.freeze({
    enabled,
    get,
    send,
  });
}

module.exports = {
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  boundedTimeout,
  createTeamworkClient,
};
