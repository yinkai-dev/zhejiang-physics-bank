// Shared publication HTTP boundary. Responses are consumed inside the request
// so transport failures while reading a body are handled at the same seam.
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const RETRY_HTTP = new Set([502, 503, 504]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function describeError(error) {
  const parts = [];
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    parts.push([e.code || e.name, e.message].filter(Boolean).join(': '));
    if (Array.isArray(e.errors)) parts.push(...e.errors.map(x => [x.code, x.message].filter(Boolean).join(': ')));
  }
  return parts.join(' <- ');
}

function transient(error) {
  if (RETRY_HTTP.has(error.httpStatus) || error.name === 'TimeoutError') return true;
  if (NETWORK_CODES.has(error.code)) return true;
  if (Array.isArray(error.errors) && error.errors.length) return error.errors.every(transient);
  return error.cause ? transient(error.cause) : false;
}

export async function request(url, init = {}, {
  read = r => r.text(), fetcher = fetch, sleep = delay, log = () => {},
  idempotent = false, timeoutMs = 20000,
} = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const retryable = ['GET', 'HEAD'].includes(method) || idempotent;
  const endpoint = new URL(url);
  const label = `${method} ${endpoint.origin}${endpoint.pathname}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await fetcher(url, { cache: 'no-store', ...init, signal });
      const value = await read(response);
      if (RETRY_HTTP.has(response.status)) throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status });
      return { response, value };
    } catch (cause) {
      const detail = `${label}（第 ${attempt} 次）：${describeError(cause)}`;
      if (!retryable || !transient(cause) || init.signal?.aborted || attempt >= 3) {
        throw new Error(detail, { cause });
      }
      const ms = attempt === 1 ? 2000 : 5000;
      log(`  ${detail}；${ms / 1000} 秒后重试`);
      await sleep(ms);
    }
  }
}
