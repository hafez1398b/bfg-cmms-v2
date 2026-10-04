'use strict';
const express=require('express');
const {createNotification}=require('./notification-service');

function createNotificationRouter({pool,authenticateToken,authorize}){
  const router=express.Router();
  router.use(authenticateToken);

  router.get('/',authorize('notification.view'),async(req,res,next)=>{try{
    const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
    const unread=req.query.unread==='true';
    const values=[req.user.id,limit];
    const {rows}=await pool.query(
      `SELECT n.*,r.delivered_at,r.read_at,r.archived_at
       FROM notification_recipients r JOIN notifications n ON n.id=r.notification_id
       WHERE r.user_id=$1 AND r.archived_at IS NULL ${unread?'AND r.read_at IS NULL':''}
       AND (n.expires_at IS NULL OR n.expires_at>now())
       ORDER BY n.created_at DESC LIMIT $2`,values);
    const count=await pool.query(
      `SELECT count(*)::int unread FROM notification_recipients r JOIN notifications n ON n.id=r.notification_id
       WHERE r.user_id=$1 AND r.read_at IS NULL AND r.archived_at IS NULL AND (n.expires_at IS NULL OR n.expires_at>now())`,[req.user.id]);
    res.json({data:rows,unread:count.rows[0].unread});
  }catch(error){next(error);}});

  router.post('/',authorize('notification.create'),async(req,res,next)=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const notification=await createNotification(client,req.body,req.user.id);await client.query('COMMIT');res.status(201).json({data:notification});}
    catch(error){await client.query('ROLLBACK').catch(()=>{});next(error);}finally{client.release();}
  });

  router.patch('/:id/read',authorize('notification.view'),async(req,res,next)=>{try{
    const {rows}=await pool.query(
      `UPDATE notification_recipients SET read_at=COALESCE(read_at,now())
       WHERE notification_id=$1 AND user_id=$2 RETURNING notification_id,read_at`,[req.params.id,req.user.id]);
    if(!rows[0])return res.sendStatus(404);res.json({data:rows[0]});
  }catch(error){next(error);}});

  router.patch('/read-all',authorize('notification.view'),async(req,res,next)=>{try{
    const result=await pool.query(
      'UPDATE notification_recipients SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND read_at IS NULL',[req.user.id]);
    res.json({updated:result.rowCount});
  }catch(error){next(error);}});

  router.use((error,_req,res,_next)=>{
    const status=Number(error.status)||500;
    console.error('Notification API:', error.code || 'request_failed');
    if(status>=500) return res.status(500).json({error:'NOTIFICATION_API_ERROR'});
    res.status(status).json({error:error.code||error.message||'NOTIFICATION_API_ERROR',fields:error.fields});
  });
  return router;
}
module.exports={createNotificationRouter};
