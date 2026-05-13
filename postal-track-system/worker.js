// worker.js – Почтовое отслеживание (API, статика через Assets)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json'
};

function sendJson(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}
function sendError(message, status = 400) {
  return sendJson({ success: false, error: message }, status);
}
function validateTracking(t) {
  return t && /^[A-Z0-9]{6,20}$/i.test(t);
}

async function getTracking(env, tracking) {
  if (!validateTracking(tracking)) return sendError('Неверный трек-номер');
  const shipment = await env.DB.prepare('SELECT * FROM shipments WHERE tracking_number = ?')
    .bind(tracking).first();
  if (!shipment) return sendError('Отправление не найдено', 404);
  
  const current = await env.DB.prepare(`
    SELECT s.*, po.address as location_address 
    FROM statuses s 
    LEFT JOIN post_offices po ON s.location_index = po.index_code 
    WHERE s.tracking_number = ? 
    ORDER BY s.status_date DESC LIMIT 1
  `).bind(tracking).first();
  
  const history = await env.DB.prepare(`
    SELECT s.*, po.address as location_address 
    FROM statuses s 
    LEFT JOIN post_offices po ON s.location_index = po.index_code 
    WHERE s.tracking_number = ? 
    ORDER BY s.status_date ASC
  `).bind(tracking).all();
  
  return sendJson({
    success: true,
    shipment,
    currentStatus: current,
    history: history.results || []
  });
}

async function getStuck(env) {
  const stuck = await env.DB.prepare(`
    WITH latest AS (
      SELECT tracking_number, status, status_date,
        ROW_NUMBER() OVER (PARTITION BY tracking_number ORDER BY status_date DESC) as rn
      FROM statuses
    )
    SELECT s.tracking_number, s.recipient_name, s.type,
           julianday('now') - julianday(l.status_date) as days_stuck
    FROM shipments s 
    JOIN latest l ON s.tracking_number = l.tracking_number AND l.rn = 1
    WHERE l.status = 'sorting' 
      AND julianday('now') - julianday(l.status_date) > 2
    ORDER BY days_stuck DESC
  `).all();
  return sendJson(stuck.results || []);
}

async function getWorkload(env) {
  const workload = await env.DB.prepare(`
    SELECT 
      po.index_code, 
      po.address, 
      po.phone,
      COUNT(DISTINCT s.tracking_number) as total_shipments,
      SUM(CASE WHEN st.status NOT IN ('delivered','returned') THEN 1 ELSE 0 END) as active_shipments
    FROM post_offices po
    LEFT JOIN statuses st ON po.index_code = st.location_index
    LEFT JOIN shipments s ON st.tracking_number = s.tracking_number
    WHERE po.is_active = 1
    GROUP BY po.index_code, po.address, po.phone
    ORDER BY active_shipments DESC
  `).all();
  return sendJson({ success: true, data: workload.results || [] });
}

async function registerShipment(env, data) {
  const { recipient_name, recipient_address, sender_name, weight_kg, type, location_index } = data;
  if (!recipient_name || !recipient_address) return sendError('Укажите получателя и адрес');
  
  let nextNumber = 1;
  try {
    const updateResult = await env.DB.prepare(`
      UPDATE tracking_counter SET last_number = last_number + 1 WHERE id = 1
    `).run();
    
    if (updateResult.changes === 0) {
      await env.DB.prepare(`
        INSERT INTO tracking_counter (id, last_number) VALUES (1, 1)
      `).run();
      nextNumber = 1;
    } else {
      const counter = await env.DB.prepare(`
        SELECT last_number FROM tracking_counter WHERE id = 1
      `).first();
      nextNumber = counter.last_number;
    }
  } catch (err) {
    console.error('Counter error:', err);
    return sendError('Ошибка генерации трек-номера');
  }
  
  const trackingNumber = `TRK${String(nextNumber).padStart(3, '0')}`;
  
  const existing = await env.DB.prepare('SELECT tracking_number FROM shipments WHERE tracking_number = ?')
    .bind(trackingNumber).first();
  if (existing) {
    return registerShipment(env, data);
  }
  
  const office = await env.DB.prepare('SELECT index_code FROM post_offices WHERE index_code = ? AND is_active = 1')
    .bind(location_index).first();
  const defaultOffice = (office && location_index) ? location_index : '101000';
  
  await env.DB.prepare(`
    INSERT INTO shipments (tracking_number, recipient_name, recipient_address, sender_name, weight_kg, type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(trackingNumber, recipient_name, recipient_address, sender_name || null, weight_kg || 0, type || 'parcel').run();
  
  await env.DB.prepare(`
    INSERT INTO statuses (tracking_number, status, location_index, status_date, notes)
    VALUES (?, 'registered', ?, datetime('now'), 'Зарегистрировано')
  `).bind(trackingNumber, defaultOffice).run();
  
  return sendJson({ success: true, tracking_number: trackingNumber, message: 'Отправление зарегистрировано' });
}

async function updateStatus(env, data) {
  const { tracking_number, status, location_index, notes } = data;
  if (!tracking_number || !status) return sendError('Укажите трек-номер и статус');
  
  const shipment = await env.DB.prepare('SELECT 1 FROM shipments WHERE tracking_number = ?')
    .bind(tracking_number).first();
  if (!shipment) return sendError('Отправление не найдено', 404);
  
  const last = await env.DB.prepare(`
    SELECT status, status_date FROM statuses 
    WHERE tracking_number = ? ORDER BY status_date DESC LIMIT 1
  `).bind(tracking_number).first();
  if (last && (last.status === 'delivered' || last.status === 'returned')) 
    return sendError(`Отправление уже ${last.status === 'delivered' ? 'доставлено' : 'возвращено'}`);
  
  if (location_index) {
    const office = await env.DB.prepare('SELECT 1 FROM post_offices WHERE index_code = ? AND is_active = 1')
      .bind(location_index).first();
    if (!office) return sendError('Отделение не найдено или закрыто');
  }
  
  if (status === 'delivered') {
    const hasOut = await env.DB.prepare(`
      SELECT 1 FROM statuses 
      WHERE tracking_number = ? AND status = 'out_for_delivery'
    `).bind(tracking_number).first();
    if (!hasOut) return sendError('Невозможно выдать без статуса "Доставляется"');
  }
  
  try {
    await env.DB.prepare(`
      INSERT INTO statuses (tracking_number, status, location_index, status_date, notes)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).bind(tracking_number, status, location_index || null, notes || null).run();
    return sendJson({ success: true, message: 'Статус обновлён' });
  } catch (err) {
    if (err.message.includes('не может быть раньше')) 
      return sendError('Дата статуса не может быть раньше предыдущей');
    return sendError(err.message);
  }
}

async function closeOffice(env, index_code) {
  if (!index_code) return sendError('Укажите индекс');
  
  const undelivered = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT st.tracking_number
      FROM statuses st
      WHERE st.location_index = ? 
        AND st.id IN (
          SELECT MAX(id) FROM statuses 
          WHERE location_index = ? GROUP BY tracking_number
        )
        AND st.status NOT IN ('delivered', 'returned')
    )
  `).bind(index_code, index_code).first();
  
  if (undelivered && undelivered.count > 0) 
    return sendError(`Невозможно закрыть: ${undelivered.count} невыданных отправлений`);
  
  const result = await env.DB.prepare(`
    UPDATE post_offices 
    SET is_active = 0, closed_at = datetime('now')
    WHERE index_code = ?
  `).bind(index_code).run();
  
  if (result.changes === 0) return sendError('Отделение не найдено');
  return sendJson({ success: true, message: `Отделение ${index_code} закрыто` });
}

async function getBusiestOffice(env) {
  const busiest = await env.DB.prepare(`
    SELECT po.index_code, po.address, COUNT(*) as shipment_count
    FROM statuses s 
    JOIN post_offices po ON s.location_index = po.index_code
    WHERE s.status_date >= datetime('now', '-30 days')
    GROUP BY po.index_code, po.address
    ORDER BY shipment_count DESC LIMIT 1
  `).first();
  return sendJson({ success: true, data: busiest || null });
}

async function getRecipientShipments(env, query) {
  const { name, address } = query;
  if (!name && !address) return sendError('Укажите имя или адрес');
  
  let sql = `
    SELECT s.tracking_number, s.recipient_name, s.recipient_address, s.type,
           st.status, st.status_date, st.location_index
    FROM shipments s
    JOIN (
      SELECT tracking_number, status, status_date, location_index,
        ROW_NUMBER() OVER (PARTITION BY tracking_number ORDER BY status_date DESC) as rn
      FROM statuses
    ) st ON s.tracking_number = st.tracking_number AND st.rn = 1
    WHERE 1=1
  `;
  const params = [];
  if (name) { sql += ` AND s.recipient_name LIKE ?`; params.push(`%${name}%`); }
  if (address) { sql += ` AND s.recipient_address LIKE ?`; params.push(`%${address}%`); }
  sql += ` ORDER BY st.status_date DESC`;
  
  const shipments = await env.DB.prepare(sql).bind(...params).all();
  return sendJson({ success: true, data: shipments.results || [] });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method === 'GET') {
    const trackMatch = path.match(/^\/api\/postal\/track\/([A-Z0-9]+)$/i);
    if (trackMatch) return getTracking(env, trackMatch[1]);
    if (path === '/api/postal/stuck') return getStuck(env);
    if (path === '/api/postal/office-workload') return getWorkload(env);
    if (path === '/api/postal/busiest-office') return getBusiestOffice(env);
    if (path === '/api/postal/recipient-shipments')
      return getRecipientShipments(env, Object.fromEntries(url.searchParams));
  }
  if (method === 'POST') {
    if (path === '/api/admin/shipment') return registerShipment(env, await request.json());
    if (path === '/api/admin/status') return updateStatus(env, await request.json());
    if (path === '/api/admin/close-office') return closeOffice(env, (await request.json()).index_code);
  }

  return env.ASSETS.fetch(request);
}

export default { fetch: handleRequest };
