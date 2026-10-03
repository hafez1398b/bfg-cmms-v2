'use strict';

const jwt = require('jsonwebtoken');

function bearerToken(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : null;
}

function createSecurity({ pool, jwtSecret }) {
  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  async function resolveUser(claims) {
    const { rows } = await pool.query(
      'SELECT id,username,name,role,unit,active FROM users WHERE id=$1 AND active=true',
      [claims.id]
    );
    return rows[0] || null;
  }

  async function authenticateToken(req, res, next) {
    try {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
      const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      const user = await resolveUser(claims);
      if (!user) return res.status(401).json({ error: 'USER_INACTIVE_OR_MISSING' });
      req.user = user;
      next();
    } catch (error) {
      const status = error.name === 'TokenExpiredError' ? 401 : 403;
      res.status(status).json({ error: 'INVALID_ACCESS_TOKEN' });
    }
  }

  async function hasPermission(user, permission) {
    if (!user) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM role_permissions
       WHERE role=$1 AND granted=true AND (permission=$2 OR permission='*') LIMIT 1`,
      [user.role, permission]
    );
    return !!rows[0];
  }

  function authorize(permission) {
    return async (req, res, next) => {
      try {
        if (await hasPermission(req.user, permission)) return next();
        return res.status(403).json({ error: 'PERMISSION_DENIED', permission });
      } catch (error) { next(error); }
    };
  }

  async function scopesFor(userId) {
    const { rows } = await pool.query(
      'SELECT scope_type,scope_id FROM user_scopes WHERE user_id=$1', [userId]
    );
    return rows;
  }

  async function socketUser(token) {
    const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    const user = await resolveUser(claims);
    if (!user) throw new Error('USER_INACTIVE_OR_MISSING');
    user.scopes = await scopesFor(user.id);
    return user;
  }

  return { authenticateToken, authorize, hasPermission, scopesFor, socketUser };
}

module.exports = { createSecurity, bearerToken };
