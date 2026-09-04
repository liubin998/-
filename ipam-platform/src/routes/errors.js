export function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function httpError(status, message, code = 'ERROR') {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.path}` });
}

export function errorMiddleware(err, req, res, next) {
  const status = err.status || 500;
  const payload = { error: err.code || (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'), message: err.message };
  if (status >= 500) console.error('[api-error]', err);
  res.status(status).json(payload);
}
