'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config');

// Role permission matrix — backend-enforced (Requirement #1)
const PERMISSIONS = {
  admin: new Set(['*']),
  mgr: new Set([
    'equipment.view','equipment.create','equipment.edit','equipment.move','equipment.delete','equipment.export',
    'requests.*','wos.*','pm.*','inventory.*','failures.*','ai.*','notifications.*','audit.view','users.view'
  ]),
  planner: new Set([
    'equipment.view','equipment.create','equipment.edit','equipment.move','equipment.export',
    'requests.*','wos.*','pm.*','inventory.view','inventory.edit','failures.view','failures.create','ai.view'
  ]),
  tech: new Set([
    'equipment.view','requests.create','requests.view','wos.view','wos.edit_assigned','failures.create','failures.view','ai.view','notifications.view'
  ]),
  op: new Set([
    'equipment.view','requests.create','requests.view_own','wos.view','failures.create','failures.view'
  ]),
  store: new Set(['inventory.*','equipment.view','wos.view','notifications.view']),
  hse: new Set(['equipment.view','permits.*','failures.view','notifications.view']),
  cal: new Set(['calibration.*','equipment.view','notifications.view']),
};

function hasPermission(role, perm) {
  if (!role || !perm) return false;
  const set = PERMISSIONS[role];
  if (!set) return false;
  if (set.has('*')) return true;
  if (set.has(perm)) return true;
  const [mod] = perm.split('.');
  if (set.has(`${mod}.*`)) return true;
  return false;
}

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing token' });
  jwt.verify(token, config.jwtSecret, (err, user) => {
    if (err) return res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Socket.io auth — handshake
function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) return next(new Error('UNAUTHORIZED'));
    const user = jwt.verify(token, config.jwtSecret);
    socket.user = user;
    next();
  } catch (e) {
    next(new Error('FORBIDDEN'));
  }
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (req.user.role === 'admin') return next();
    if (hasPermission(req.user.role, perm)) return next();
    return res.status(403).json({ error: 'PERMISSION_DENIED', permission: perm });
  };
}

// For tech who can only edit their own assigned WOs
function requireOwnOrPermission(perm, getAssignee) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (req.user.role === 'admin') return next();
    if (hasPermission(req.user.role, perm)) return next();
    // check own assignment
    const assignee = getAssignee(req);
    if (assignee && assignee === req.user.id && hasPermission(req.user.role, 'wos.edit_assigned')) return next();
    return res.status(403).json({ error: 'PERMISSION_DENIED', permission: perm });
  };
}

module.exports = { authenticateToken, authenticateSocket, requirePermission, requireOwnOrPermission, hasPermission, PERMISSIONS };
