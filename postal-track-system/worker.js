// worker.js оптимизированная версия

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

let indexesCreated = false;
async function ensureIndexes(env) {
  if (indexesCreated) return;
  try {
    await env.DB.exec(`
      CREATE INDEX IF NOT EXISTS idx_statuses_tracking ON statuses(tracking_number);
      CREATE INDEX IF NOT EXISTS idx_statuses_tracking_date ON statuses(tracking_number, status_date DESC);
      CREATE INDEX IF NOT EXISTS idx_statuses_location ON statuses(location_index);
      CREATE INDEX IF NOT EXISTS idx_statuses_status_date ON statuses(status, status_date);
      CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_number);
    `);
    indexesCreated = true;
  } catch (err) {
    console.error('Index creation error:', err);
  }
}

async function getTracking(env, tracking) {
  if (!validateTracking(tracking)) return sendError('Неверный трек-номер');
  
  const result = await env.DB.prepare(`
    SELECT 
      s.*,
      st.status as current_status,
      st.location_index as current_location,
      st.status_date as current_status_date,
      st.notes as current_notes,
      po.address as location_address,
      json_group_array(
        json_object(
          'status', st2.status,
          'location_index', st2.location_index,
          'status_date', st2.status_date,
          'notes', st2.notes,
          'location_address', po2.address
        )
      ) as history_json
    FROM shipments s
    LEFT JOIN (
      SELECT tracking_number, status, location_index, status_date, notes,
        ROW_NUMBER() OVER (PARTITION BY tracking_number ORDER BY status_date DESC) as rn
      FROM statuses
    ) st ON s.tracking_number = st.tracking_number AND st.rn = 1
    LEFT JOIN post_offices po ON st.location_index = po.index_code
    LEFT JOIN (
      SELECT * FROM statuses ORDER BY status_date ASC
    ) st2 ON s.tracking_number = st2.tracking_number
    LEFT JOIN post_offices po2 ON st2.location_index = po2.index_code
    WHERE s.tracking_number = ?
    GROUP BY s.tracking_number
  `).bind(tracking).first();
  
  if (!result) return sendError('Отправление не найдено', 404);
  
  let history = [];
  if (result.history_json) {
    try { history = JSON.parse(result.history_json); } catch(e) {}
  }
  
  const shipment = {
    tracking_number: result.tracking_number,
    recipient_name: result.recipient_name,
    recipient_address: result.recipient_address,
    sender_name: result.sender_name,
    weight_kg: result.weight_kg,
    type: result.type,
    created_at: result.created_at
  };
  
  const currentStatus = {
    status: result.current_status,
    location_index: result.current_location,
    status_date: result.current_status_date,
    notes: result.current_notes,
    location_address: result.location_address
  };
  
  return sendJson({ success: true, shipment, currentStatus, history });
}

async function getStuck(env) {
  const stuck = await env.DB.prepare(`
    SELECT 
      s.tracking_number,
      s.recipient_name,
      s.type,
      julianday('now') - julianday(MAX(st.status_date)) as days_stuck
    FROM shipments s
    JOIN statuses st ON s.tracking_number = st.tracking_number
    WHERE st.status = 'sorting'
    GROUP BY s.tracking_number, s.recipient_name, s.type
    HAVING days_stuck > 2
    ORDER BY days_stuck DESC
  `).all();
  return sendJson(stuck.results || []);
}

const workloadCache = new Map();
async function getWorkload(env) {
  const cacheKey = 'workload';
  const cached = workloadCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 300000) {
    return sendJson({ success: true, data: cached.data });
  }
  
  const totals = await env.DB.prepare(`
    SELECT location_index, COUNT(DISTINCT tracking_number) as total_shipments
    FROM statuses GROUP BY location_index
  `).all();
  
  const actives = await env.DB.prepare(`
    WITH last_status AS (
      SELECT tracking_number, status, location_index,
        ROW_NUMBER() OVER (PARTITION BY tracking_number ORDER BY status_date DESC) as rn
      FROM statuses
    )
    SELECT location_index, COUNT(*) as active_shipments
    FROM last_status WHERE rn = 1 AND status NOT IN ('delivered','returned')
    GROUP BY location_index
  `).all();
  
  const totalMap = new Map();
  for (const t of totals.results || []) totalMap.set(t.location_index, t.total_shipments);
  const activeMap = new Map();
  for (const a of actives.results || []) activeMap.set(a.location_index, a.active_shipments);
  
  const offices = await env.DB.prepare(`
    SELECT index_code, address, phone FROM post_offices WHERE is_active = 1 ORDER BY index_code
  `).all();
  
  const result = (offices.results || []).map(o => ({
    index_code: o.index_code,
    address: o.address,
    phone: o.phone,
    total_shipments: totalMap.get(o.index_code) || 0,
    active_shipments: activeMap.get(o.index_code) || 0
  }));
  result.sort((a, b) => b.active_shipments - a.active_shipments);
  
  workloadCache.set(cacheKey, { timestamp: Date.now(), data: result });
  return sendJson({ success: true, data: result });
}

async function registerShipment(env, data) {
  const { recipient_name, recipient_address, sender_name, weight_kg, type, location_index } = data;
  if (!recipient_name || !recipient_address) return sendError('Укажите получателя и адрес');
  
  const office = await env.DB.prepare('SELECT index_code FROM post_offices WHERE index_code = ? AND is_active = 1')
    .bind(location_index).first();
  const defaultOffice = (office && location_index) ? location_index : '101000';
  
  let trackingNumber;
  try {
    await env.DB.exec('BEGIN TRANSACTION');
    
    const updateResult = await env.DB.prepare(`
      UPDATE tracking_counter SET last_number = last_number + 1 WHERE id = 1
    `).run();
    
    let nextNumber;
    if (updateResult.changes === 0) {
      await env.DB.prepare(`INSERT INTO tracking_counter (id, last_number) VALUES (1, 1)`).run();
      nextNumber = 1;
    } else {
      const counter = await env.DB.prepare(`SELECT last_number FROM tracking_counter WHERE id = 1`).first();
      nextNumber = counter.last_number;
    }
    
    trackingNumber = `TRK${String(nextNumber).padStart(3, '0')}`;
    
    let existing = await env.DB.prepare('SELECT tracking_number FROM shipments WHERE tracking_number = ?')
      .bind(trackingNumber).first();
    if (existing) {
      await env.DB.prepare(`UPDATE tracking_counter SET last_number = last_number + 1 WHERE id = 1`).run();
      const counter = await env.DB.prepare(`SELECT last_number FROM tracking_counter WHERE id = 1`).first();
      trackingNumber = `TRK${String(counter.last_number).padStart(3, '0')}`;
    }
    
    await env.DB.prepare(`
      INSERT INTO shipments (tracking_number, recipient_name, recipient_address, sender_name, weight_kg, type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(trackingNumber, recipient_name, recipient_address, sender_name || null, weight_kg || 0, type || 'parcel').run();
    
    await env.DB.prepare(`
      INSERT INTO statuses (tracking_number, status, location_index, status_date, notes)
      VALUES (?, 'registered', ?, datetime('now'), 'Зарегистрировано')
    `).bind(trackingNumber, defaultOffice).run();
    
    await env.DB.exec('COMMIT');
    return sendJson({ success: true, tracking_number: trackingNumber, message: 'Отправление зарегистрировано' });
  } catch (err) {
    await env.DB.exec('ROLLBACK');
    console.error('Register error:', err);
    return sendError('Ошибка регистрации: ' + err.message);
  }
}

async function updateStatus(env, data) {
  const { tracking_number, status, location_index, notes } = data;
  if (!tracking_number || !status) return sendError('Укажите трек-номер и статус');
  
  const shipment = await env.DB.prepare('SELECT 1 FROM shipments WHERE tracking_number = ?')
    .bind(tracking_number).first();
  if (!shipment) return sendError('Отправление не найдено', 404);
  
  const last = await env.DB.prepare(`
    SELECT status FROM statuses WHERE tracking_number = ? ORDER BY status_date DESC LIMIT 1
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
      SELECT 1 FROM statuses WHERE tracking_number = ? AND status = 'out_for_delivery'
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
  
  // Проверка существования и активности
  const office = await env.DB.prepare('SELECT is_active FROM post_offices WHERE index_code = ?')
    .bind(index_code).first();
  if (!office) return sendError(`Отделение с индексом ${index_code} не найдено`);
  if (office.is_active === 0) return sendError(`Отделение ${index_code} уже закрыто`);
  
  const undelivered = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT tracking_number
      FROM (
        SELECT tracking_number, status,
          ROW_NUMBER() OVER (PARTITION BY tracking_number ORDER BY status_date DESC) as rn
        FROM statuses WHERE location_index = ?
      ) WHERE rn = 1 AND status NOT IN ('delivered', 'returned')
    )
  `).bind(index_code).first();
  
  if (undelivered && undelivered.count > 0) 
    return sendError(`Невозможно закрыть: ${undelivered.count} невыданных отправлений`);
  
  const result = await env.DB.prepare(`
    UPDATE post_offices SET is_active = 0, closed_at = datetime('now')
    WHERE index_code = ?
  `).bind(index_code).run();
  
  if (result.changes === 0) return sendError('Не удалось закрыть отделение');
  return sendJson({ success: true, message: `Отделение ${index_code} закрыто` });
}

const busiestCache = new Map();
async function getBusiestOffice(env) {
  const cacheKey = 'busiest';
  const cached = busiestCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 3600000) {
    return sendJson({ success: true, data: cached.data });
  }
  
  const busiest = await env.DB.prepare(`
    SELECT po.index_code, po.address, COUNT(*) as shipment_count
    FROM statuses s JOIN post_offices po ON s.location_index = po.index_code
    WHERE s.status_date >= datetime('now', '-30 days')
    GROUP BY po.index_code, po.address
    ORDER BY shipment_count DESC LIMIT 1
  `).first();
  busiestCache.set(cacheKey, { timestamp: Date.now(), data: busiest });
  return sendJson({ success: true, data: busiest });
}

async function getRecipientShipments(env, query) {
  const { name, address, limit = 100 } = query;
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
  sql += ` ORDER BY st.status_date DESC LIMIT ?`;
  params.push(Number(limit));
  
  const shipments = await env.DB.prepare(sql).bind(...params).all();
  return sendJson({ success: true, data: shipments.results || [] });
}

async function addOffice(env, params) {
  const { index_code, address, phone } = params;
  
  if (!index_code || !/^\d{6}$/.test(index_code)) {
    return sendError('Индекс отделения должен состоять из 6 цифр');
  }
  if (!address || address.trim() === '') return sendError('Адрес обязателен');
  if (!phone || phone.trim() === '') return sendError('Телефон обязателен');
  
  const existing = await env.DB.prepare('SELECT index_code, is_active FROM post_offices WHERE index_code = ?')
    .bind(index_code).first();
  if (existing) {
    if (existing.is_active === 1) {
      return sendError(`Отделение ${index_code} уже существует и активно`);
    } else {
      return sendError(`Отделение ${index_code} существует, но закрыто. Используйте реактивацию`, 409);
    }
  }
  
  try {
    await env.DB.prepare(`
      INSERT INTO post_offices (index_code, address, phone, is_active, created_at)
      VALUES (?, ?, ?, 1, datetime('now'))
    `).bind(index_code, address, phone).run();
    return sendJson({
      success: true,
      message: `Отделение ${index_code} добавлено`,
      office: { index_code, address, phone, is_active: 1 }
    });
  } catch (err) {
    return sendError('Ошибка добавления: ' + err.message);
  }
}

async function reactivateOffice(env, params) {
  const { index_code } = params;
  if (!index_code || !/^\d{6}$/.test(index_code)) {
    return sendError('Индекс должен состоять из 6 цифр');
  }
  
  const office = await env.DB.prepare('SELECT is_active FROM post_offices WHERE index_code = ?')
    .bind(index_code).first();
  if (!office) return sendError(`Отделение ${index_code} не найдено`);
  if (office.is_active === 1) return sendError(`Отделение ${index_code} уже активно`);
  
  try {
    await env.DB.prepare(`
      UPDATE post_offices SET is_active = 1, closed_at = NULL WHERE index_code = ?
    `).bind(index_code).run();
    return sendJson({ success: true, message: `Отделение ${index_code} реактивировано` });
  } catch (err) {
    return sendError('Ошибка реактивации: ' + err.message);
  }
}


async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  await ensureIndexes(env);

  // GET маршруты
  if (method === 'GET') {
    const trackMatch = path.match(/^\/api\/postal\/track\/([A-Z0-9]+)$/i);
    if (trackMatch) return getTracking(env, trackMatch[1]);
    if (path === '/api/postal/stuck') return getStuck(env);
    if (path === '/api/postal/office-workload') return getWorkload(env);
    if (path === '/api/postal/busiest-office') return getBusiestOffice(env);
    if (path === '/api/postal/recipient-shipments')
      return getRecipientShipments(env, Object.fromEntries(url.searchParams));
  }
  // POST маршруты
  if (method === 'POST') {
    if (path === '/api/admin/shipment') return registerShipment(env, await request.json());
    if (path === '/api/admin/status') return updateStatus(env, await request.json());
    if (path === '/api/admin/close-office') return closeOffice(env, (await request.json()).index_code);
    if (path === '/api/admin/add-office') return addOffice(env, Object.fromEntries(url.searchParams));
    if (path === '/api/admin/reactivate-office') return reactivateOffice(env, Object.fromEntries(url.searchParams));
  }

  // Статика через Assets
  return env.ASSETS.fetch(request);
}

// Keep-warm каждые 15 минут (чтобы избежать холодного старта)
async function scheduled(event, env, ctx) {
  await fetch('https://demo-proj.cloudkot.workers.dev/api/postal/stuck');
  console.log('Keep-warm ping executed');
}

export default { fetch: handleRequest, scheduled };
