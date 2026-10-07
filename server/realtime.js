'use strict';

function configureRealtime({ io, pool, security, logger=console }) {
  io.use(async (socket, next) => {
    try {
      socket.user = await security.socketUser(socket.handshake);
      next();
    } catch (error) {
      logger.warn('Realtime authentication rejected:', error.code || 'INVALID_ACCESS_TOKEN');
      next(new Error('INVALID_ACCESS_TOKEN'));
    }
  });

  io.on('connection', socket => {
    const { id, role, scopes=[] } = socket.user;
    const sessionExpiresAt = Date.parse(socket.user.sessionExpiresAt);
    if (Number.isFinite(sessionExpiresAt)) {
      const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, sessionExpiresAt - Date.now()));
      socket.once('disconnect', () => clearTimeout(expiryTimer));
    }
    socket.join(`user:${id}`);
    socket.join(`role:${role}`);
    for (const scope of scopes) socket.join(`${scope.scope_type}:${scope.scope_id}`);
    socket.emit('realtime:ready', { userId:id, connectedAt:new Date().toISOString() });
  });

  let stopped = false, lastErrorLogAt = 0;
  async function publishBatch() {
    if (stopped) return;
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id,event_type,aggregate_type,aggregate_id,payload,recipient_ids,occurred_at
         FROM event_outbox WHERE published_at IS NULL
         ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 50`
      );
      for (const event of rows) {
        const envelope = {
          id:event.id,type:event.event_type,aggregateType:event.aggregate_type,
          aggregateId:event.aggregate_id,payload:event.payload,occurredAt:event.occurred_at
        };
        const recipients = Array.isArray(event.recipient_ids) ? event.recipient_ids : [];
        for (const userId of recipients) io.to(`user:${userId}`).emit('domain:event', envelope);
        await client.query(
          'UPDATE event_outbox SET published_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1',
          [event.id]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      if(client)await client.query('ROLLBACK').catch(()=>{});
      if (Date.now()-lastErrorLogAt>60000){logger.error('Outbox publication unavailable:', error.code||'outbox_error');lastErrorLogAt=Date.now();}
    } finally { client?.release(); }
  }

  const timer = setInterval(publishBatch, Number(process.env.OUTBOX_INTERVAL_MS)||1000);
  timer.unref?.();
  return {
    publishBatch,
    stop(){ stopped=true;clearInterval(timer); }
  };
}

module.exports = { configureRealtime };
