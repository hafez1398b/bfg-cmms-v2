'use strict';

function createSecurity({ pool, jwtSecret, sessions }) {
  if (!jwtSecret) throw new Error('JWT_SECRET is required');
  if (!sessions) throw new Error('SESSION_SERVICE_REQUIRED');

  async function authenticateToken(req, res, next) {
    try {
      req.user = await sessions.authenticate(req);
      next();
    } catch (error) {
      res.status(error.status || 401).json({ error: error.code || 'AUTHENTICATION_REQUIRED' });
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

  async function socketUser(handshake) {
    try {
      const user = await sessions.socketUser(handshake || {});
      if (!user) {
        const error = new Error('INVALID_ACCESS_TOKEN');
        error.code = 'INVALID_ACCESS_TOKEN';
        throw error;
      }
      user.scopes = await scopesFor(user.id);
      return user;
    } catch (error) {
      if (!error.code) error.code = 'INVALID_ACCESS_TOKEN';
      throw error;
    }
  }

  return { authenticateToken, authorize, hasPermission, scopesFor, socketUser };
}

module.exports = { createSecurity };
