'use strict';

function errorHandler(err, req, res, _next) {
  console.error(`[API] ${req.method} ${req.path} —`, err.message || err);
  if (err.stack) console.error(err.stack);

  if (err.code === '23505') {
    return res.status(409).json({ error: 'DUPLICATE', message: 'Duplicate key', detail: err.detail });
  }
  if (err.status === 409 || err.code === 'VERSION_CONFLICT') {
    return res.status(409).json({ error: 'VERSION_CONFLICT', message: err.message, current: err.current });
  }
  if (err.status === 422) {
    return res.status(422).json({ error: 'VALIDATION_ERROR', message: err.message, fields: err.fields });
  }
  const status = err.status || 500;
  res.status(status).json({
    error: err.error || 'INTERNAL_ERROR',
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

function notFound(req, res) {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
}

module.exports = { errorHandler, notFound };
