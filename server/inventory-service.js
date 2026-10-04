'use strict';

const crypto = require('crypto');
const { isRecipientAllowed } = require('./maintenance-service');

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function versionOf(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw coded(422, 'ROW_VERSION_REQUIRED');
  return version;
}

function qtyOf(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty <= 0) throw coded(422, 'QUANTITY_REQUIRED');
  return Math.round(qty * 1000) / 1000;
}

function moneyOf(value, code = 'AMOUNT_REQUIRED') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw coded(422, code);
  return Math.round(amount);
}

function noteOf(value) {
  const note = String(value || '').trim();
  return note ? note.slice(0, 500) : null;
}

function nextAverage(oldStock, oldPrice, qty, unitCost) {
  const stock = Number(oldStock) || 0;
  const price = Number(oldPrice) || 0;
  const cost = Number(unitCost);
  const next = stock + qty;
  if (!(next > 0) || !Number.isFinite(cost) || cost < 0) return price;
  return Math.round(((stock * price) + (qty * cost)) / next);
}

function summarize(lines) {
  const active = (lines || []).filter(line => !line.voided_at && !line.voidedAt);
  const signed = line => Number(line.amount) * ((line.direction || 'debit') === 'credit' ? -1 : 1);
  const sum = kind => active.filter(line => line.kind === kind).reduce((total, line) => total + signed(line), 0);
  const labor = sum('labor');
  const parts = sum('part');
  const externalServices = sum('external_service');
  return { labor, parts, externalServices, total: labor + parts + externalServices };
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function nextNumber(client, name, prefix) {
  const { rows } = await client.query(
    `INSERT INTO maintenance_counters(name, value) VALUES($1, 1)
     ON CONFLICT(name) DO UPDATE SET value = maintenance_counters.value + 1
     RETURNING value`,
    [name]
  );
  return `${prefix}-${String(rows[0].value).padStart(6, '0')}`;
}

async function audit(client, user, action, module, entity, before, after, note) {
  await client.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [crypto.randomUUID(), user.name || user.username, user.id, user.role, action, module, entity, note,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

async function factoryOf(client, equipmentId) {
  if (!equipmentId) return null;
  const { rows } = await client.query(
    `SELECT c.factory_asset_id FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id WHERE a.id=$1`,
    [equipmentId]
  );
  return rows[0] ? rows[0].factory_asset_id : null;
}

async function publish(client, user, event) {
  const factoryId = await factoryOf(client, event.equipmentId || null);
  const { rows } = await client.query(
    `SELECT u.id, u.role,
      COALESCE((SELECT jsonb_agg(rp.permission) FROM role_permissions rp WHERE rp.role=u.role AND rp.granted=true), '[]'::jsonb) AS permissions,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('scope_type', s.scope_type, 'scope_id', s.scope_id)) FROM user_scopes s WHERE s.user_id=u.id), '[]'::jsonb) AS scopes
     FROM users u WHERE u.active=true`
  );
  const recipients = rows.filter(row => isRecipientAllowed(row, event.permission, event.equipmentId || null, factoryId)).map(row => row.id);
  await client.query(
    `INSERT INTO event_outbox(id,event_type,aggregate_type,aggregate_id,actor_id,payload,recipient_ids)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [crypto.randomUUID(), event.type, event.aggregateType, event.aggregateId, user.id, JSON.stringify(event.payload), JSON.stringify(recipients)]
  );
  return recipients;
}

function itemDto(row, balances = []) {
  return {
    id: row.id, code: row.code, name: row.name, unit: row.unit, cat: row.cat, loc: row.loc,
    stock: Number(row.stock) || 0, min: Number(row.min_stock) || 0, minStock: Number(row.min_stock) || 0,
    price: Number(row.price) || 0, rowVersion: Number(row.row_version), deletedAt: row.deleted_at || null,
    balances: balances.map(balance => ({
      locationId: balance.location_id, warehouseId: balance.warehouse_id, code: balance.location_code || null,
      onHand: Number(balance.on_hand) || 0, reserved: Number(balance.reserved) || 0,
      available: (Number(balance.on_hand) || 0) - (Number(balance.reserved) || 0)
    }))
  };
}

function ledgerDto(row) {
  return {
    id: row.id, no: row.entry_no, movement: row.movement, itemId: row.item_id, locationId: row.location_id,
    warehouseId: row.warehouse_id, qty: Number(row.qty), unitCost: Number(row.unit_cost) || 0,
    workOrderId: row.work_order_id || null, equipmentId: row.equipment_id || null,
    reservationId: row.reservation_id || null, reversesEntryId: row.reverses_entry_id || null,
    note: row.note || null, createdAt: row.created_at, createdBy: row.created_by
  };
}

function costDto(row) {
  return {
    id: row.id, workOrderId: row.work_order_id, workOrderNo: row.work_order_no || null, equipmentId: row.equipment_id || null,
    kind: row.kind, direction: row.direction, description: row.description || '', hours: row.hours == null ? null : Number(row.hours),
    rate: row.rate == null ? null : Number(row.rate), amount: Number(row.amount) || 0, source: row.source,
    createdAt: row.created_at, rowVersion: Number(row.row_version) || 1
  };
}

async function lockItem(client, id, rowVersion) {
  const { rows } = await client.query('SELECT * FROM items WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0] || rows[0].deleted_at) throw coded(404, 'ITEM_NOT_FOUND');
  if (Number(rows[0].row_version) !== versionOf(rowVersion)) throw coded(409, 'VERSION_CONFLICT');
  return rows[0];
}

async function lockLocation(client, id) {
  const { rows } = await client.query('SELECT * FROM storage_locations WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0] || rows[0].deleted_at) throw coded(404, 'LOCATION_NOT_FOUND');
  return rows[0];
}

async function lockBalance(client, itemId, locationId) {
  await client.query(
    `INSERT INTO item_balances(item_id, location_id, on_hand, reserved) VALUES($1,$2,0,0)
     ON CONFLICT(item_id, location_id) DO NOTHING`,
    [itemId, locationId]
  );
  const { rows } = await client.query('SELECT * FROM item_balances WHERE item_id=$1 AND location_id=$2 FOR UPDATE', [itemId, locationId]);
  if (!rows[0]) throw coded(409, 'NEGATIVE_STOCK_NOT_ALLOWED');
  return rows[0];
}

async function writeBalance(client, itemId, locationId, onHand, reserved) {
  if (onHand < -0.0001 || reserved < -0.0001 || reserved - onHand > 0.0001) throw coded(409, 'NEGATIVE_STOCK_NOT_ALLOWED');
  const { rows } = await client.query(
    `UPDATE item_balances SET on_hand=$3, reserved=$4, row_version=row_version+1, updated_at=now()
     WHERE item_id=$1 AND location_id=$2 RETURNING *`,
    [itemId, locationId, onHand, reserved]
  );
  if (!rows[0]) throw coded(409, 'NEGATIVE_STOCK_NOT_ALLOWED');
  return rows[0];
}

async function refreshItem(client, item, userId, price) {
  const sum = await client.query('SELECT COALESCE(SUM(on_hand),0) AS on_hand FROM item_balances WHERE item_id=$1', [item.id]);
  const updated = await client.query(
    `UPDATE items SET stock=$2, price=$3, updated_at=now(), updated_by=$4, row_version=row_version+1
     WHERE id=$1 AND row_version=$5 AND deleted_at IS NULL RETURNING *`,
    [item.id, Number(sum.rows[0].on_hand), price == null ? Number(item.price) || 0 : price, userId, Number(item.row_version)]
  );
  if (!updated.rows[0]) throw coded(409, 'VERSION_CONFLICT');
  return updated.rows[0];
}

async function insertLedger(client, entry) {
  const id = crypto.randomUUID();
  const no = await nextNumber(client, 'inventory', 'STK');
  const { rows } = await client.query(
    `INSERT INTO inventory_ledger(id,entry_no,movement,item_id,location_id,warehouse_id,qty,unit_cost,work_order_id,equipment_id,reservation_id,reverses_entry_id,note,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [id, no, entry.movement, entry.itemId, entry.locationId, entry.warehouseId, entry.qty, entry.unitCost || 0,
      entry.workOrderId || null, entry.equipmentId || null, entry.reservationId || null, entry.reversesEntryId || null,
      entry.note || null, entry.userId]
  );
  return rows[0];
}

async function lockWorkOrder(client, id) {
  const { rows } = await client.query('SELECT * FROM work_orders WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0] || rows[0].deleted_at) throw coded(404, 'WORK_ORDER_NOT_FOUND');
  if (rows[0].status === 'cancel') throw coded(409, 'RECORD_LOCKED');
  return rows[0];
}

async function applyReceipt(client, user, item, input) {
  const location = await lockLocation(client, input.locationId || 'loc-main');
  const qty = qtyOf(input.qty);
  const unitCost = input.unitCost == null ? Number(item.price) || 0 : moneyOf(input.unitCost, 'AMOUNT_REQUIRED');
  const balance = await lockBalance(client, item.id, location.id);
  await writeBalance(client, item.id, location.id, Number(balance.on_hand) + qty, Number(balance.reserved));
  const price = nextAverage(item.stock, item.price, qty, unitCost);
  const updated = await refreshItem(client, item, user.id, price);
  const ledger = await insertLedger(client, {
    movement: 'receipt', itemId: item.id, locationId: location.id, warehouseId: location.warehouse_id,
    qty, unitCost, userId: user.id, note: noteOf(input.note)
  });
  return { item: updated, ledger, location };
}

async function receive(pool, user, input) {
  return withTransaction(pool, async client => {
    const item = await lockItem(client, input.itemId, input.rowVersion);
    const result = await applyReceipt(client, user, item, input);
    await audit(client, user, 'receipt', 'inventory', item.id, item, result.item, result.ledger.entry_no);
    await publish(client, user, {
      type: 'inventory.received', aggregateType: 'inventory', aggregateId: result.ledger.id, permission: 'inventory.view',
      payload: { id: result.ledger.id, itemId: item.id, qty: Number(result.ledger.qty) }
    });
    return { item: itemDto(result.item), entry: ledgerDto(result.ledger) };
  });
}

async function issue(pool, user, input) {
  return withTransaction(pool, async client => {
    const item = await lockItem(client, input.itemId, input.rowVersion);
    const location = await lockLocation(client, input.locationId || 'loc-main');
    const qty = qtyOf(input.qty);
    const balance = await lockBalance(client, item.id, location.id);
    if (Number(balance.on_hand) - Number(balance.reserved) < qty) throw coded(409, 'NEGATIVE_STOCK_NOT_ALLOWED');
    await writeBalance(client, item.id, location.id, Number(balance.on_hand) - qty, Number(balance.reserved));
    const updated = await refreshItem(client, item, user.id, Number(item.price) || 0);
    const ledger = await insertLedger(client, {
      movement: 'issue', itemId: item.id, locationId: location.id, warehouseId: location.warehouse_id,
      qty, unitCost: Number(item.price) || 0, workOrderId: input.workOrderId || null, userId: user.id, note: noteOf(input.note)
    });
    await audit(client, user, 'issue', 'inventory', item.id, item, updated, ledger.entry_no);
    await publish(client, user, {
      type: 'inventory.issued', aggregateType: 'inventory', aggregateId: ledger.id, permission: 'inventory.view',
      payload: { id: ledger.id, itemId: item.id, qty }
    });
    return { item: itemDto(updated), entry: ledgerDto(ledger) };
  });
}

async function reserve(pool, user, input) {
  return withTransaction(pool, async client => {
    const item = await lockItem(client, input.itemId, input.rowVersion);
    const order = await lockWorkOrder(client, input.workOrderId);
    if (!order.asset_id) throw coded(422, 'EQUIPMENT_REQUIRED');
    const location = await lockLocation(client, input.locationId || 'loc-main');
    const qty = qtyOf(input.qty);
    const balance = await lockBalance(client, item.id, location.id);
    if (Number(balance.on_hand) - Number(balance.reserved) < qty) throw coded(409, 'NEGATIVE_STOCK_NOT_ALLOWED');
    await writeBalance(client, item.id, location.id, Number(balance.on_hand), Number(balance.reserved) + qty);
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO inventory_reservations(id,item_id,location_id,warehouse_id,work_order_id,equipment_id,qty,remaining,status,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,'open',$8)`,
      [id, item.id, location.id, location.warehouse_id, order.id, order.asset_id, qty, user.id]
    );
    const ledger = await insertLedger(client, {
      movement: 'reserve', itemId: item.id, locationId: location.id, warehouseId: location.warehouse_id,
      qty, unitCost: Number(item.price) || 0, workOrderId: order.id, equipmentId: order.asset_id,
      reservationId: id, userId: user.id, note: noteOf(input.note)
    });
    await audit(client, user, 'reserve', 'inventory', item.id, null, { reservationId: id, qty }, ledger.entry_no);
    await publish(client, user, {
      type: 'inventory.reserved', aggregateType: 'inventory', aggregateId: id, permission: 'inventory.view',
      equipmentId: order.asset_id, payload: { id, itemId: item.id, workOrderId: order.id, qty }
    });
    return { reservationId: id, entry: ledgerDto(ledger) };
  });
}

async function releaseReservation(pool, user, reservationId, input) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM inventory_reservations WHERE id=$1 FOR UPDATE', [reservationId]);
    const reservation = rows[0];
    if (!reservation || reservation.status !== 'open') throw coded(409, 'RECORD_LOCKED');
    if (Number(reservation.row_version) !== versionOf(input.rowVersion)) throw coded(409, 'VERSION_CONFLICT');
    const item = await lockItem(client, reservation.item_id, input.itemRowVersion);
    const balance = await lockBalance(client, reservation.item_id, reservation.location_id);
    const remaining = Number(reservation.remaining);
    await writeBalance(client, reservation.item_id, reservation.location_id, Number(balance.on_hand), Number(balance.reserved) - remaining);
    await client.query(
      `UPDATE inventory_reservations SET remaining=0, status='released', closed_at=now(), row_version=row_version+1
       WHERE id=$1 AND row_version=$2`,
      [reservationId, reservation.row_version]
    );
    const ledger = await insertLedger(client, {
      movement: 'release', itemId: reservation.item_id, locationId: reservation.location_id, warehouseId: reservation.warehouse_id,
      qty: remaining, unitCost: Number(item.price) || 0, workOrderId: reservation.work_order_id, equipmentId: reservation.equipment_id,
      reservationId, userId: user.id, note: noteOf(input.note)
    });
    await audit(client, user, 'release', 'inventory', reservation.item_id, reservation, { status: 'released' }, ledger.entry_no);
    await publish(client, user, {
      type: 'inventory.released', aggregateType: 'inventory', aggregateId: reservationId, permission: 'inventory.view',
      equipmentId: reservation.equipment_id, payload: { id: reservationId, qty: remaining }
    });
    return { released: true, entry: ledgerDto(ledger) };
  });
}

async function consume(pool, user, input) {
  return withTransaction(pool, async client => {
    const item = await lockItem(client, input.itemId, input.rowVersion);
    const order = await lockWorkOrder(client, input.workOrderId);
    if (!order.asset_id) throw coded(422, 'EQUIPMENT_REQUIRED');
    const location = await lockLocation(client, input.locationId || 'loc-main');
    const qty = qtyOf(input.qty);
    const balance = await lockBalance(client, item.id, location.id);
    let reservationId = input.reservationId || null;
    if (reservationId) {
      const locked = await client.query('SELECT * FROM inventory_reservations WHERE id=$1 FOR UPDATE', [reservationId]);
      const reservation = locked.rows[0];
      if (!reservation || reservation.status !== 'open' || reservation.item_id !== item.id || Number(reservation.remaining) < qty) {
        throw coded(409, 'RESERVATION_EXCEEDED');
      }
      await writeBalance(client, item.id, location.id, Number(balance.on_hand) - qty, Number(balance.reserved) - qty);
      const remaining = Number(reservation.remaining) - qty;
      await client.query(
        `UPDATE inventory_reservations SET remaining=$2, status=$3, closed_at=CASE WHEN $2=0 THEN now() ELSE closed_at END, row_version=row_version+1
         WHERE id=$1`,
        [reservationId, remaining, remaining === 0 ? 'consumed' : 'open']
      );
    } else {
      if (Number(balance.on_hand) - Number(balance.reserved) < qty) throw coded(409, 'NEGATIVE_STOCK_NOT_ALLOWED');
      await writeBalance(client, item.id, location.id, Number(balance.on_hand) - qty, Number(balance.reserved));
    }
    const unitCost = Number(item.price) || 0;
    const updated = await refreshItem(client, item, user.id, unitCost);
    const ledger = await insertLedger(client, {
      movement: 'consume', itemId: item.id, locationId: location.id, warehouseId: location.warehouse_id,
      qty, unitCost, workOrderId: order.id, equipmentId: order.asset_id, reservationId, userId: user.id, note: noteOf(input.note)
    });
    await client.query(
      `INSERT INTO work_order_parts(id,work_order_id,item_id,equipment_id,location_id,ledger_entry_id,qty,unit_cost,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [crypto.randomUUID(), order.id, item.id, order.asset_id, location.id, ledger.id, qty, unitCost, user.id]
    );
    const amount = Math.round(qty * unitCost);
    await client.query(
      `INSERT INTO work_order_costs(id,work_order_id,equipment_id,kind,direction,description,amount,ledger_entry_id,source,created_by)
       VALUES($1,$2,$3,'part','debit',$4,$5,$6,'server',$7)`,
      [crypto.randomUUID(), order.id, order.asset_id, noteOf(input.note) || item.name, amount, ledger.id, user.id]
    );
    await audit(client, user, 'consume', 'inventory', item.id, item, updated, ledger.entry_no);
    await publish(client, user, {
      type: 'inventory.consumed', aggregateType: 'inventory', aggregateId: ledger.id, permission: 'inventory.view',
      equipmentId: order.asset_id, payload: { id: ledger.id, itemId: item.id, workOrderId: order.id, equipmentId: order.asset_id, qty, amount }
    });
    return { item: itemDto(updated), entry: ledgerDto(ledger), cost: { amount, kind: 'part', source: 'server' } };
  });
}

async function returnedQty(client, entryId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(qty),0) AS returned FROM inventory_ledger WHERE reverses_entry_id=$1 AND movement='return'`,
    [entryId]
  );
  return Number(rows[0].returned) || 0;
}

async function returnParts(pool, user, input) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM inventory_ledger WHERE id=$1', [input.entryId]);
    const original = rows[0];
    if (!original || !['consume', 'issue'].includes(original.movement)) throw coded(409, 'RETURN_NOT_ALLOWED');
    const qty = qtyOf(input.qty);
    if ((await returnedQty(client, original.id)) + qty > Number(original.qty)) throw coded(409, 'RETURN_EXCEEDS_ISSUE');
    const item = await lockItem(client, original.item_id, input.rowVersion);
    const balance = await lockBalance(client, original.item_id, original.location_id);
    await writeBalance(client, original.item_id, original.location_id, Number(balance.on_hand) + qty, Number(balance.reserved));
    const updated = await refreshItem(client, item, user.id, Number(item.price) || 0);
    const ledger = await insertLedger(client, {
      movement: 'return', itemId: original.item_id, locationId: original.location_id, warehouseId: original.warehouse_id,
      qty, unitCost: Number(original.unit_cost) || 0, workOrderId: original.work_order_id, equipmentId: original.equipment_id,
      reversesEntryId: original.id, userId: user.id, note: noteOf(input.note)
    });
    if (original.movement === 'consume') {
      await client.query(
        `INSERT INTO work_order_costs(id,work_order_id,equipment_id,kind,direction,description,amount,ledger_entry_id,source,created_by)
         VALUES($1,$2,$3,'part','credit',$4,$5,$6,'return',$7)`,
        [crypto.randomUUID(), original.work_order_id, original.equipment_id, noteOf(input.note) || 'برگشت قطعه',
          Math.round(qty * (Number(original.unit_cost) || 0)), ledger.id, user.id]
      );
    }
    await audit(client, user, 'return', 'inventory', item.id, original, ledger, ledger.entry_no);
    await publish(client, user, {
      type: 'inventory.returned', aggregateType: 'inventory', aggregateId: ledger.id, permission: 'inventory.view',
      equipmentId: original.equipment_id, payload: { id: ledger.id, itemId: item.id, qty, reversesEntryId: original.id }
    });
    return { item: itemDto(updated), entry: ledgerDto(ledger) };
  });
}

async function createItem(pool, user, input) {
  const name = String(input.name || '').trim();
  if (!name) throw coded(422, 'NAME_REQUIRED');
  const initialQty = input.initialQty == null && input.stock == null ? 0 : Number(input.initialQty ?? input.stock);
  if (!Number.isFinite(initialQty) || initialQty < 0) throw coded(422, 'QUANTITY_REQUIRED');
  return withTransaction(pool, async client => {
    const id = crypto.randomUUID();
    const code = input.code ? String(input.code).trim() : await nextNumber(client, 'item', 'SP');
    const price = moneyOf(input.price || 0, 'AMOUNT_REQUIRED');
    const inserted = await client.query(
      `INSERT INTO items(id,code,name,unit,stock,min_stock,price,loc,cat) VALUES($1,$2,$3,$4,0,$5,$6,$7,$8) RETURNING *`,
      [id, code, name, input.unit || 'عدد', Number(input.min ?? input.minStock) || 0, price, input.loc || null, input.cat || 'عمومی']
    );
    let item = inserted.rows[0];
    if (initialQty > 0) {
      const received = await applyReceipt(client, user, item, { locationId: input.locationId || 'loc-main', qty: initialQty, unitCost: price, note: 'موجودی اولیه' });
      item = received.item;
    }
    await audit(client, user, 'create', 'inventory', id, null, item, 'تعریف قلم انبار');
    await publish(client, user, {
      type: 'inventory.item_created', aggregateType: 'inventory', aggregateId: id, permission: 'inventory.view',
      payload: { id, code: item.code }
    });
    return itemDto(item);
  });
}

async function updateItem(pool, user, id, input) {
  return withTransaction(pool, async client => {
    const current = await lockItem(client, id, input.rowVersion);
    const name = String(input.name ?? current.name ?? '').trim();
    if (!name) throw coded(422, 'NAME_REQUIRED');
    const { rows } = await client.query(
      `UPDATE items SET name=$2, unit=$3, min_stock=$4, price=$5, loc=$6, cat=$7, updated_at=now(), updated_by=$8, row_version=row_version+1
       WHERE id=$1 AND row_version=$9 AND deleted_at IS NULL RETURNING *`,
      [id, name, input.unit || current.unit, Number(input.min ?? input.minStock ?? current.min_stock) || 0,
        moneyOf(input.price ?? current.price, 'AMOUNT_REQUIRED'), input.loc === undefined ? current.loc : input.loc,
        input.cat || current.cat, user.id, current.row_version]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    if (Number(rows[0].stock) !== Number(current.stock)) throw coded(409, 'STOCK_CHANGE_REQUIRES_LEDGER');
    await audit(client, user, 'edit', 'inventory', id, current, rows[0], 'ویرایش قلم انبار');
    await publish(client, user, {
      type: 'inventory.item_updated', aggregateType: 'inventory', aggregateId: id, permission: 'inventory.view',
      payload: { id, rowVersion: Number(rows[0].row_version) }
    });
    return itemDto(rows[0]);
  });
}

async function archiveItem(pool, user, id, input) {
  const reason = noteOf(input.reason);
  if (!reason) throw coded(422, 'ARCHIVE_REASON_REQUIRED');
  return withTransaction(pool, async client => {
    const current = await lockItem(client, id, input.rowVersion);
    const balances = await client.query(
      'SELECT COALESCE(SUM(on_hand),0) AS on_hand, COALESCE(SUM(reserved),0) AS reserved FROM item_balances WHERE item_id=$1',
      [id]
    );
    if (Number(balances.rows[0].on_hand) !== 0 || Number(balances.rows[0].reserved) !== 0) throw coded(409, 'NONZERO_STOCK_CANNOT_BE_ARCHIVED');
    const history = await client.query(
      `SELECT COUNT(*)::int AS entries FROM inventory_ledger WHERE item_id=$1 AND movement IN ('consume','issue','return')`,
      [id]
    );
    if (Number(history.rows[0].entries) > 0) throw coded(409, 'CONSUMPTION_HISTORY_CANNOT_BE_DELETED');
    const { rows } = await client.query(
      `UPDATE items SET deleted_at=now(), updated_at=now(), updated_by=$3, row_version=row_version+1
       WHERE id=$1 AND row_version=$2 AND deleted_at IS NULL RETURNING *`,
      [id, current.row_version, user.id]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'archive', 'inventory', id, current, rows[0], reason);
    await publish(client, user, {
      type: 'inventory.item_archived', aggregateType: 'inventory', aggregateId: id, permission: 'inventory.view',
      payload: { id, archived: true }
    });
    return { archived: true, historyPreserved: true };
  });
}

async function listItems(pool) {
  const { rows } = await pool.query(
    `SELECT i.*, COALESCE(b.on_hand, i.stock, 0) AS stock
     FROM items i
     LEFT JOIN (SELECT item_id, SUM(on_hand) AS on_hand FROM item_balances GROUP BY item_id) b ON b.item_id=i.id
     WHERE i.deleted_at IS NULL ORDER BY i.code LIMIT 500`
  );
  return rows.map(row => itemDto(row));
}

async function getItem(pool, id) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!rows[0]) throw coded(404, 'ITEM_NOT_FOUND');
  const balances = await pool.query(
    `SELECT bal.location_id, loc.warehouse_id, loc.code AS location_code, bal.on_hand, bal.reserved
     FROM item_balances bal JOIN storage_locations loc ON loc.id=bal.location_id WHERE bal.item_id=$1`,
    [id]
  );
  const stock = balances.rows.reduce((sum, row) => sum + Number(row.on_hand), 0);
  return itemDto({ ...rows[0], stock }, balances.rows);
}

async function listWarehouses(pool) {
  const warehouses = await pool.query('SELECT * FROM warehouses WHERE deleted_at IS NULL ORDER BY code');
  const locations = await pool.query('SELECT * FROM storage_locations WHERE deleted_at IS NULL ORDER BY code');
  return warehouses.rows.map(row => ({
    id: row.id, code: row.code, name: row.name, factoryAssetId: row.factory_asset_id, active: row.active !== false,
    rowVersion: Number(row.row_version),
    locations: locations.rows.filter(location => location.warehouse_id === row.id).map(location => ({
      id: location.id, code: location.code, name: location.name, rowVersion: Number(location.row_version)
    }))
  }));
}

async function createWarehouse(pool, user, input) {
  const name = String(input.name || '').trim();
  const code = String(input.code || '').trim();
  if (!name || !code) throw coded(422, 'NAME_REQUIRED');
  return withTransaction(pool, async client => {
    const id = crypto.randomUUID();
    const { rows } = await client.query(
      `INSERT INTO warehouses(id,code,name,factory_asset_id) VALUES($1,$2,$3,$4) RETURNING *`,
      [id, code, name, input.factoryAssetId || null]
    );
    await audit(client, user, 'create', 'inventory', id, null, rows[0], 'تعریف انبار');
    return { id, code, name, rowVersion: 1, locations: [] };
  });
}

async function createLocation(pool, user, warehouseId, input) {
  const name = String(input.name || '').trim();
  const code = String(input.code || '').trim();
  if (!name || !code) throw coded(422, 'NAME_REQUIRED');
  return withTransaction(pool, async client => {
    const warehouse = await client.query('SELECT * FROM warehouses WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [warehouseId]);
    if (!warehouse.rows[0]) throw coded(404, 'WAREHOUSE_NOT_FOUND');
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO storage_locations(id,warehouse_id,code,name) VALUES($1,$2,$3,$4)`,
      [id, warehouseId, code, name]
    );
    await audit(client, user, 'create', 'inventory', id, null, { warehouseId, code, name }, 'تعریف محل نگهداری');
    return { id, warehouseId, code, name, rowVersion: 1 };
  });
}

async function listLedger(pool, filters = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM inventory_ledger
     WHERE ($1::text IS NULL OR item_id=$1) AND ($2::text IS NULL OR work_order_id=$2)
     ORDER BY created_at DESC LIMIT 200`,
    [filters.itemId || null, filters.workOrderId || null]
  );
  return rows.map(ledgerDto);
}

async function addCost(pool, user, workOrderId, input) {
  const kind = String(input.kind || '');
  if (kind === 'part') throw coded(422, 'PART_COST_CALCULATED_BY_SERVER');
  if (!['labor', 'external_service'].includes(kind)) throw coded(422, 'COST_KIND_INVALID');
  return withTransaction(pool, async client => {
    const order = await lockWorkOrder(client, workOrderId);
    let hours = null;
    let rate = null;
    let amount;
    if (kind === 'labor') {
      hours = Number(input.hours);
      rate = Number(input.rate);
      if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(rate) || rate < 0) throw coded(422, 'LABOR_INPUT_REQUIRED');
      amount = Math.round(hours * rate);
    } else {
      amount = moneyOf(input.amount);
      if (amount <= 0) throw coded(422, 'AMOUNT_REQUIRED');
    }
    const id = crypto.randomUUID();
    const description = noteOf(input.description || input.title) || (kind === 'labor' ? 'نفرساعت' : 'خدمات بیرونی');
    const { rows } = await client.query(
      `INSERT INTO work_order_costs(id,work_order_id,equipment_id,kind,direction,description,hours,rate,amount,source,created_by)
       VALUES($1,$2,$3,$4,'debit',$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, order.id, order.asset_id, kind, description, hours, rate, amount, kind, user.id]
    );
    await audit(client, user, 'create', 'cost', id, null, rows[0], description);
    await publish(client, user, {
      type: 'cost.created', aggregateType: 'cost', aggregateId: id, permission: 'cost.view',
      equipmentId: order.asset_id, payload: { id, workOrderId: order.id, kind, amount }
    });
    const totals = await costSummary(client, order.id);
    return { line: costDto(rows[0]), totals };
  });
}

async function costSummary(client, workOrderId) {
  const { rows } = await client.query(
    'SELECT kind, direction, amount, voided_at FROM work_order_costs WHERE work_order_id=$1 AND voided_at IS NULL',
    [workOrderId]
  );
  return summarize(rows);
}

async function listCosts(pool, workOrderId) {
  const { rows } = await pool.query(
    `SELECT c.*, w.no AS work_order_no FROM work_order_costs c
     JOIN work_orders w ON w.id=c.work_order_id
     WHERE c.voided_at IS NULL AND ($1::text IS NULL OR c.work_order_id=$1)
     ORDER BY c.created_at DESC LIMIT 500`,
    [workOrderId || null]
  );
  const lines = rows.map(costDto);
  const totalsByWorkOrder = {};
  lines.forEach(line => {
    if (!totalsByWorkOrder[line.workOrderId]) totalsByWorkOrder[line.workOrderId] = summarize(lines.filter(item => item.workOrderId === line.workOrderId));
  });
  return { lines, totalsByWorkOrder };
}

async function saveAttachment(pool, user, workOrderId, file, phase) {
  const safePhase = ['before', 'during', 'after'].includes(phase) ? phase : null;
  return withTransaction(pool, async client => {
    const order = await lockWorkOrder(client, workOrderId);
    const id = file.id || crypto.randomUUID();
    const stored = file.storedName || `${id}.${file.ext}`;
    const { rows } = await client.query(
      `INSERT INTO work_order_files(id,work_order_id,original_name,stored_name,media_type,byte_size,sha256,phase,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, order.id, file.originalName, stored, file.mediaType, file.byteSize, file.sha256, safePhase, user.id]
    );
    await audit(client, user, 'attach', 'work_order', order.id, null, { id, name: file.originalName, sha256: file.sha256 }, 'پیوست دستورکار');
    await publish(client, user, {
      type: 'work_order.attachment_added', aggregateType: 'work_order_file', aggregateId: id, permission: 'work_order.view',
      equipmentId: order.asset_id, payload: { id, workOrderId: order.id, name: file.originalName, byteSize: file.byteSize }
    });
    return {
      id, workOrderId: order.id, name: file.originalName, storedName: stored, mediaType: file.mediaType,
      byteSize: file.byteSize, sha256: file.sha256, phase: safePhase, createdAt: rows[0].created_at
    };
  });
}

async function listAttachments(pool, workOrderId) {
  const { rows } = await pool.query(
    'SELECT * FROM work_order_files WHERE work_order_id=$1 AND deleted_at IS NULL ORDER BY created_at',
    [workOrderId]
  );
  return rows.map(row => ({
    id: row.id, workOrderId: row.work_order_id, name: row.original_name, mediaType: row.media_type,
    byteSize: Number(row.byte_size), sha256: row.sha256, phase: row.phase, createdAt: row.created_at
  }));
}

async function getAttachment(pool, workOrderId, fileId) {
  const { rows } = await pool.query(
    'SELECT * FROM work_order_files WHERE id=$1 AND work_order_id=$2 AND deleted_at IS NULL',
    [fileId, workOrderId]
  );
  if (!rows[0]) throw coded(404, 'FILE_NOT_FOUND');
  return rows[0];
}

async function confirmDelivery(pool, user, workOrderId, input) {
  return withTransaction(pool, async client => {
    const order = await lockWorkOrder(client, workOrderId);
    if (order.status !== 'closed') throw coded(409, 'DELIVERY_NOT_READY');
    if (order.requester_confirmed_at) throw coded(409, 'DELIVERY_ALREADY_CONFIRMED');
    if (Number(order.row_version) !== versionOf(input.rowVersion)) throw coded(409, 'VERSION_CONFLICT');
    const request = order.req_id
      ? (await client.query('SELECT id, requester_id FROM requests WHERE id=$1', [order.req_id])).rows[0]
      : null;
    if (!request || !request.requester_id) throw coded(409, 'REQUESTER_REQUIRED');
    if (user.role !== 'admin' && user.id !== request.requester_id) throw coded(403, 'REQUESTER_CONFIRMATION_REQUIRED');
    const note = noteOf(input.note);
    const { rows } = await client.query(
      `UPDATE work_orders SET requester_confirmed_at=now(), requester_confirmed_by=$2, requester_confirmed_name=$3,
         requester_confirmation_note=$4, updated_at=now(), updated_by=$2, row_version=row_version+1
       WHERE id=$1 AND row_version=$5 AND requester_confirmed_at IS NULL RETURNING *`,
      [workOrderId, user.id, user.name || user.username, note, order.row_version]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'confirm_delivery', 'work_order', workOrderId, order, rows[0], note || 'تأیید تحویل درخواست‌کننده');
    await publish(client, user, {
      type: 'work_order.delivery_confirmed', aggregateType: 'work_order', aggregateId: workOrderId, permission: 'work_order.view',
      equipmentId: order.asset_id, payload: { id: workOrderId, confirmedBy: user.id }
    });
    return {
      id: workOrderId, status: rows[0].status, rowVersion: Number(rows[0].row_version),
      requesterOK: { by: rows[0].requester_confirmed_name, t: rows[0].requester_confirmed_at, note }
    };
  });
}

module.exports = {
  nextAverage, summarize, receive, issue, reserve, releaseReservation, consume, returnParts,
  createItem, updateItem, archiveItem, listItems, getItem, listWarehouses, createWarehouse, createLocation,
  listLedger, addCost, listCosts, saveAttachment, listAttachments, getAttachment, confirmDelivery
};
