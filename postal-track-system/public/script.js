// script.js – клиентская логика Postal Track
// Защита от двойных кликов + автоматические повторные попытки при сетевых сбоях

const STATUS_MAP = {
    'registered': { name: 'Зарегистрировано', class: 'status-registered' },
    'accepted': { name: 'Принято', class: 'status-registered' },
    'in_transit': { name: 'В пути', class: 'status-transit' },
    'sorting': { name: 'На сортировке', class: 'status-sorting' },
    'arrived': { name: 'Прибыло', class: 'status-transit' },
    'out_for_delivery': { name: 'Доставляется', class: 'status-transit' },
    'delivered': { name: 'Доставлено', class: 'status-delivered' },
    'failed_delivery': { name: 'Неудачная доставка', class: 'status-registered' },
    'returned': { name: 'Возвращено', class: 'status-registered' }
};

class RequestLock {
    constructor() { this.active = new Map(); }
    
    // Для любых асинхронных операций (без кнопки)
    async execute(key, fn, ...args) {
        if (this.active.get(key)) return null;
        this.active.set(key, true);
        try { return await fn(...args); }
        finally { this.active.delete(key); }
    }
    
    // Для кнопок с визуальной обратной связью
    async executeWithButton(btnId, fn, ...args) {
        const btn = document.getElementById(btnId);
        if (this.active.get(btnId)) {
            this.setButtonState(btn, '⏳ Подождите...', true);
            // Через 2 секунды сменим текст, если всё ещё ждём
            setTimeout(() => {
                if (this.active.get(btnId) && btn) {
                    this.setButtonState(btn, '⏳ Ожидание ответа...', true);
                }
            }, 2000);
            return null;
        }
        this.active.set(btnId, true);
        const originalText = btn?.textContent;
        this.setButtonState(btn, '⏳ Отправка...', true);
        try {
            return await fn(...args);
        } finally {
            this.active.delete(btnId);
            this.setButtonState(btn, originalText, false);
        }
    }
    
    setButtonState(btn, text, disabled) {
        if (!btn) return;
        btn.textContent = text;
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.6' : '1';
        btn.style.cursor = disabled ? 'wait' : 'pointer';
    }
}

const lock = new RequestLock();

function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[m])); }
function formatDate(d) { if (!d) return '—'; try { let date = new Date(d); return isNaN(date) ? d : date.toLocaleString('ru-RU'); } catch(e) { return d; } }
function getStatusName(s) { return STATUS_MAP[s]?.name || s; }
function getStatusClass(s) { return STATUS_MAP[s]?.class || 'status-registered'; }
function showLoad(id) { let el = document.getElementById(id); if (el) el.innerHTML = '<div class="loader">Загрузка...</div>'; }
function showErr(id, msg) { let el = document.getElementById(id); if (el) el.innerHTML = `<div class="error">❌ ${escapeHtml(msg)}</div>`; }
function showOk(id, msg) { let el = document.getElementById(id); if (el) el.innerHTML = `<div class="success">✅ ${escapeHtml(msg)}</div>`; }

// ============ УСТОЙЧИВЫЙ fetch с таймаутом и повторными попытками ============
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return response;
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error(`Превышено время ожидания (${timeout/1000} сек)`);
        throw err;
    }
}

async function fetchWithRetry(url, options = {}, retries = 3, baseDelay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetchWithTimeout(url, options, 30000);
        } catch (err) {
            if (i === retries - 1) throw err;
            const delay = baseDelay * Math.pow(2, i);
            console.warn(`Retry ${i+1}/${retries} for ${url} after ${delay}ms:`, err.message);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('Не удалось выполнить запрос после нескольких попыток');
}

async function apiReq(url, opts) {
    try {
        const resp = await fetchWithRetry(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) } });
        return await resp.json();
    } catch (err) {
        console.error(`API error (${url}):`, err);
        throw new Error(err.message || 'Сетевая ошибка. Проверьте соединение.');
    }
}

// ============ API ФУНКЦИИ ============
async function trackShipment(t) { return apiReq(`/api/postal/track/${t}`); }
async function getStuck() { let r = await apiReq('/api/postal/stuck'); return Array.isArray(r) ? r : (r.data || []); }
async function getWorkload() { let r = await apiReq('/api/postal/office-workload'); return r.success ? r.data : []; }
async function getBusiest() { let r = await apiReq('/api/postal/busiest-office'); return r.success ? r.data : null; }
async function searchByRecipient(name, addr) { let p = new URLSearchParams(); if (name) p.append('name', name); if (addr) p.append('address', addr); let r = await apiReq(`/api/postal/recipient-shipments?${p.toString()}`); return r.success ? r.data : []; }
async function createShipment(d) { return apiReq('/api/admin/shipment', { method: 'POST', body: JSON.stringify(d) }); }
async function updateStatusAPI(d) { return apiReq('/api/admin/status', { method: 'POST', body: JSON.stringify(d) }); }
async function closeOfficeAPI(code) { return apiReq('/api/admin/close-office', { method: 'POST', body: JSON.stringify({ index_code: code }) }); }

// ============ UI ФУНКЦИИ (с защитой от повторных вызовов через RequestLock) ============
async function loadTracking() {
    const tracking = document.getElementById('trackingInput')?.value.trim().toUpperCase();
    if (!tracking) { showErr('trackResult', 'Введите трек-номер'); return; }
    showLoad('trackResult');
    try {
        const data = await trackShipment(tracking);
        if (!data.success) throw new Error(data.error);
        const statusClass = getStatusClass(data.currentStatus?.status);
        document.getElementById('trackResult').innerHTML = `
            <div><strong>📦 Трек:</strong> ${escapeHtml(data.shipment.tracking_number)}</div>
            <div><strong>👤 Получатель:</strong> ${escapeHtml(data.shipment.recipient_name)}</div>
            <div><strong>📍 Адрес:</strong> ${escapeHtml(data.shipment.recipient_address)}</div>
            <div><strong>📊 Статус:</strong> <span class="status-badge ${statusClass}">${getStatusName(data.currentStatus?.status)}</span></div>
            <div><strong>🕐 Обновлено:</strong> ${formatDate(data.currentStatus?.status_date)}</div>
            <hr><div><strong>📜 История:</strong></div>
            <div style="font-size:13px">${(data.history || []).map(h => `<div>• ${formatDate(h.status_date)} - ${getStatusName(h.status)} (${h.location_index})</div>`).join('')}</div>
        `;
    } catch(e) { showErr('trackResult', e.message); }
}

async function loadStuck() {
    showLoad('stuckResult');
    try {
        const items = await getStuck();
        if (!items.length) { document.getElementById('stuckResult').innerHTML = '<div class="success">✅ Нет застрявших</div>'; return; }
        document.getElementById('stuckResult').innerHTML = `
            <table><thead><tr><th>Трек</th><th>Получатель</th><th>Тип</th><th>Дней</th></tr></thead>
            <tbody>${items.map(s => `<tr><td>${escapeHtml(s.tracking_number)}</td><td>${escapeHtml(s.recipient_name)}</td><td>${s.type}</td><td style="text-align:center">${Math.round(s.days_stuck)}</td></tr>`).join('')}</tbody>
            </table>
        `;
    } catch(e) { showErr('stuckResult', e.message); }
}

async function loadWorkload() {
    showLoad('workloadResult');
    try {
        const data = await getWorkload();
        if (!data.length) { showErr('workloadResult', 'Нет данных'); return; }
        document.getElementById('workloadResult').innerHTML = `
            <table><thead><tr><th>Индекс</th><th>Адрес</th><th>Телефон</th><th>Всего</th><th>Активных</th></tr></thead>
            <tbody>${data.map(o => `<tr><td><strong>${escapeHtml(o.index_code)}</strong></td><td>${escapeHtml(o.address)}</td><td>${escapeHtml(o.phone)}</td><td style="text-align:center">${o.total_shipments||0}</td><td style="text-align:center"><span class="status-badge ${(o.active_shipments||0)>0?'status-transit':'status-delivered'}">${o.active_shipments||0}</span></td></tr>`).join('')}</tbody>
            </table>
        `;
    } catch(e) { showErr('workloadResult', e.message); }
}

async function loadBusiestOffice() {
    showLoad('busiestResult');
    try {
        const office = await getBusiest();
        if (!office) { document.getElementById('busiestResult').innerHTML = '<div class="loader">Нет данных за 30 дней</div>'; return; }
        document.getElementById('busiestResult').innerHTML = `<div class="success"><strong>🏆 ${escapeHtml(office.index_code)}</strong><br>📍 ${escapeHtml(office.address)}<br>📊 Отправлений: ${office.shipment_count}</div>`;
    } catch(e) { showErr('busiestResult', e.message); }
}

async function searchShipments() {
    const name = document.getElementById('searchName')?.value.trim();
    const addr = document.getElementById('searchAddress')?.value.trim();
    if (!name && !addr) { showErr('searchResult', 'Введите имя или адрес'); return; }
    showLoad('searchResult');
    try {
        const items = await searchByRecipient(name, addr);
        if (!items.length) { document.getElementById('searchResult').innerHTML = '<div class="loader">Не найдено</div>'; return; }
        document.getElementById('searchResult').innerHTML = `<div>Найдено: ${items.length}</div><table><thead><tr><th>Трек</th><th>Получатель</th><th>Адрес</th><th>Статус</th></tr></thead><tbody>${items.map(s => `<tr><td>${escapeHtml(s.tracking_number)}</td><td>${escapeHtml(s.recipient_name)}</td><td>${escapeHtml(s.recipient_address)}</td><td><span class="status-badge ${getStatusClass(s.status)}">${getStatusName(s.status)}</span></td></tr>`).join('')}</tbody></table>`;
    } catch(e) { showErr('searchResult', e.message); }
}

async function registerShipment() {
    const data = {
        recipient_name: document.getElementById('regRecipient')?.value,
        recipient_address: document.getElementById('regAddress')?.value,
        sender_name: document.getElementById('regSender')?.value,
        weight_kg: parseFloat(document.getElementById('regWeight')?.value || 0),
        type: document.getElementById('regType')?.value,
        location_index: document.getElementById('regOffice')?.value
    };
    if (!data.recipient_name || !data.recipient_address) { showErr('registerResult', 'Заполните получателя и адрес'); return; }
    showLoad('registerResult');
    try {
        const res = await createShipment(data);
        if (res.success) { showOk('registerResult', `Отправление зарегистрировано! Трек: ${res.tracking_number}`); document.getElementById('regRecipient').value = ''; document.getElementById('regAddress').value = ''; }
        else showErr('registerResult', res.error);
    } catch(e) { showErr('registerResult', e.message); }
}

async function updateShipmentStatus() {
    const tracking = document.getElementById('updateTracking')?.value.trim().toUpperCase();
    if (!tracking) { showErr('updateResult', 'Введите трек-номер'); return; }
    const data = {
        tracking_number: tracking,
        status: document.getElementById('updateStatus')?.value,
        location_index: document.getElementById('updateOffice')?.value,
        notes: document.getElementById('updateNotes')?.value
    };
    showLoad('updateResult');
    try {
        const res = await updateStatusAPI(data);
        if (res.success) { showOk('updateResult', 'Статус обновлён!'); document.getElementById('updateTracking').value = ''; document.getElementById('updateNotes').value = ''; }
        else showErr('updateResult', res.error);
    } catch(e) { showErr('updateResult', e.message); }
}

async function closeOfficeAction() {
    const office = document.getElementById('closeOffice')?.value.trim();
    if (!office) { showErr('closeResult', 'Введите индекс'); return; }
    showLoad('closeResult');
    try {
        const res = await closeOfficeAPI(office);
        if (res.success) showOk('closeResult', res.message);
        else showErr('closeResult', res.error || res.message);
    } catch(e) { showErr('closeResult', e.message); }
}

// ============ ИНИЦИАЛИЗАЦИЯ ============
function initTabs() {
    const btns = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    btns.forEach(btn => btn.addEventListener('click', () => {
        const id = btn.dataset.tab;
        btns.forEach(b => b.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${id}`)?.classList.add('active');
        // Защита от двойного переключения вкладок
        if (id === 'stuck') lock.execute('stuckLoad', loadStuck);
        if (id === 'workload') lock.execute('workloadLoad', loadWorkload);
        if (id === 'busiest') lock.execute('busiestLoad', loadBusiestOffice);
    }));
}

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    document.getElementById('trackBtn')?.addEventListener('click', () => lock.executeWithButton('trackBtn', loadTracking));
    document.getElementById('registerBtn')?.addEventListener('click', () => lock.executeWithButton('registerBtn', registerShipment));
    document.getElementById('updateStatusBtn')?.addEventListener('click', () => lock.executeWithButton('updateStatusBtn', updateShipmentStatus));
    document.getElementById('closeOfficeBtn')?.addEventListener('click', () => lock.executeWithButton('closeOfficeBtn', closeOfficeAction));
    document.getElementById('searchBtn')?.addEventListener('click', () => lock.executeWithButton('searchBtn', searchShipments));
    
    // Первоначальная загрузка
    lock.execute('trackingLoad', loadTracking);
    lock.execute('stuckLoad', loadStuck);
    lock.execute('workloadLoad', loadWorkload);
    lock.execute('busiestLoad', loadBusiestOffice);
});

