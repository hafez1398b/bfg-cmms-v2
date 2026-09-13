'use strict';

/**
 * Realtime service — end-to-end (Requirement #3)
 * Architecture: User Action → Backend/API → DB Transaction → Event → Realtime Channel → Authorized Clients
 *
 * Channels:
 *  - global: system-wide (for authenticated users, role-filtered on client)
 *  - factory:{id}  e.g. factory:bfg-company
 *  - equipment:{id}
 *  - user:{id}     targeted notifications
 *
 * Events: data-changed, equipment-changed, notification:new, failure:*, health:*, ai:*
 */

class RealtimeService {
  constructor(io) {
    this.io = io;
  }

  // Join rooms after auth — called from connection handler
  joinUserRooms(socket) {
    if (!socket.user) return;
    socket.join(`user:${socket.user.id}`);
    socket.join(`role:${socket.user.role}`);
    // Optionally join factory rooms if user has factory assignment — left generic
    socket.join('global');
  }

  // Generic emit helpers — always authorized server-side, client filters again
  emitToAll(event, payload) {
    this.io.to('global').emit(event, payload);
    // Also emit without room for legacy clients that don't join rooms yet
    this.io.emit(event, payload);
  }

  emit(event, payload, opts = {}) {
    const { rooms = [], users = [], roles = [] } = opts;
    if (rooms.length === 0 && users.length === 0 && roles.length === 0) {
      return this.emitToAll(event, payload);
    }
    const targets = new Set();
    rooms.forEach(r => this.io.to(r).emit(event, payload) && targets.add(r));
    users.forEach(uid => this.io.to(`user:${uid}`).emit(event, payload) && targets.add(`user:${uid}`));
    roles.forEach(role => this.io.to(`role:${role}`).emit(event, payload) && targets.add(`role:${role}`));
    // Debug log
    if (process.env.NODE_ENV !== 'production') {
      // console.log(`[realtime] ${event} → rooms:${rooms} users:${users} roles:${roles}`);
    }
  }

  // Convenience wrappers for domain events
  dataChanged(collection, id, data, opts) {
    this.emit('data-changed', { collection, id, data, ts: new Date().toISOString() }, opts);
  }
  equipmentChanged(payload, opts) {
    this.emit('equipment-changed', { ...payload, ts: new Date().toISOString() }, opts);
  }
  notificationNew(userId, notification) {
    this.io.to(`user:${userId}`).emit('notification:new', notification);
    this.io.to(`user:${userId}`).emit('notifications:refresh', { ts: new Date().toISOString() });
  }
  failureEvent(action, failure, opts) {
    this.emit(`failure:${action}`, { failure, ts: new Date().toISOString() }, opts);
    this.emit('data-changed', { collection: 'failures', id: failure.id, data: failure }, opts);
  }
  healthUpdated(assetId, health, opts) {
    this.emit('health:updated', { assetId, health, ts: new Date().toISOString() }, opts);
  }
  aiEvent(type, payload, opts) {
    this.emit(`ai:${type}`, { ...payload, ts: new Date().toISOString() }, opts);
  }
}

let singleton = null;
function initRealtime(io) {
  singleton = new RealtimeService(io);
  return singleton;
}
function getRealtime() {
  if (!singleton) throw new Error('Realtime not initialized');
  return singleton;
}

module.exports = { RealtimeService, initRealtime, getRealtime };
