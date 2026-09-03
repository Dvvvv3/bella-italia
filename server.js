// server.js
// 极简批发下单系统 - 后端
// 客户端: /o/:token 免密下单页
// 管理端: /admin.html 后台(改价/加商品/看订单),用 x-admin-key 头做简单权限校验

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { randomUUID } = require('crypto');
const db = require('./db');
const { notifyNewOrder } = require('./notify');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 极简 cookie 解析(不额外装 cookie-parser 包),用于"链接首次打开绑定设备"功能
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[decodeURIComponent(pair.slice(0, idx).trim())] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
const DEVICE_COOKIE_MAXAGE = 10 * 365 * 24 * 3600; // 10年,基本相当于永久

// 校验"该链接是否已绑定到别的设备"。用在客户 API 上,防止链接激活后被直接用 API 绕过页面
function requireBoundDevice(req, res, next) {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效或已过期' });
  if (customer.activated_at) {
    const cookies = parseCookies(req);
    const deviceId = cookies['bi_device_' + customer.id];
    if (!deviceId || deviceId !== customer.device_id) {
      return res.status(403).json({ error: 'link_locked', message: '该链接已在别的设备上使用过,已失效' });
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// 图片上传:存到 DATA_DIR/uploads(和数据库同一个持久化目录),
// 用单独的 /uploads 静态路由提供访问,和 public/ 里的前端代码分开
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || __dirname;
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, randomUUID() + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB 上限
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('只能上传图片文件'));
    cb(null, true);
  },
});

// 后台管理密钥。上线前一定要改,不要用默认值。
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-123';

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: '密钥错误,无权访问' });
  }
  next();
}

// 打印页是直接用浏览器新标签页打开的,没法带自定义请求头,所以这个专用中间件
// 允许密钥放在 URL 参数里(?key=xxx)。仅供这一个只读打印路由使用。
function requireAdminViaQuery(req, res, next) {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send('密钥错误');
  }
  next();
}

// ---------------------------------------------------------------------------
// 客户端 API
// ---------------------------------------------------------------------------

// 给每个客户生成专属的 manifest,添加到主屏幕后打开的是他自己的下单页,不是首页
// 上架/下架商品(下架后客户下单页看不到这个商品)
app.put('/api/admin/products/:id/toggle-active', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  const next = p.active ? 0 : 1;
  db.prepare('UPDATE products SET active = ? WHERE id = ?').run(next, req.params.id);
  res.json({ ok: true, active: next });
});

// 加入/移出 New Arrivals —— 跟商品原本的分类归属完全独立,
// 一个商品可以照常挂在自己的分类下,同时也在 New Arrivals 文件夹里额外展示
app.put('/api/admin/products/:id/toggle-new-arrival', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  const next = p.is_new_arrival ? 0 : 1;
  db.prepare('UPDATE products SET is_new_arrival = ? WHERE id = ?').run(next, req.params.id);
  res.json({ ok: true, is_new_arrival: next });
});

// 修改商品编号(相当于给这条记录换主键),同时把历史订单里的关联记录也一并改掉,
// 不然老订单打印/查询时会因为找不到旧编号对应的商品而丢失图片/条码等信息
app.put('/api/admin/products/:id/rename', requireAdmin, (req, res) => {
  const oldId = req.params.id;
  const newId = (req.body.newId || '').trim();
  if (!newId) return res.status(400).json({ error: '新编号不能为空' });
  if (newId === oldId) return res.json({ ok: true, id: oldId });
  const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(newId);
  if (exists) return res.status(400).json({ error: '这个编号已经被别的商品占用了' });
  const p = db.prepare('SELECT id FROM products WHERE id = ?').get(oldId);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  db.prepare('UPDATE products SET id = ? WHERE id = ?').run(newId, oldId);
  db.prepare('UPDATE order_items SET product_id = ? WHERE product_id = ?').run(newId, oldId);
  res.json({ ok: true, id: newId });
});

app.get('/api/customer/:token/manifest.json', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效' });
  const manifest = {
    name: 'INGROSSO',
    short_name: 'INGROSSO',
    description: 'Bella Italia Cosmetics Wholesale',
    start_url: `/o/${req.params.token}`,
    scope: '/',
    display: 'standalone',
    background_color: '#fff8f4',
    theme_color: '#cf7e93',
    icons: [
      { src: '/img/logo.jpg', sizes: '192x192', type: 'image/jpeg', purpose: 'any' },
      { src: '/img/logo.jpg', sizes: '512x512', type: 'image/jpeg', purpose: 'any maskable' }
    ]
  };
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(manifest);
});

app.get('/api/customer/:token', requireBoundDevice, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效或已过期' });

  // 记录这次访问(时间由数据库默认值自动填,不用手动传)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  db.prepare('INSERT INTO access_logs (customer_id, ip, user_agent) VALUES (?, ?, ?)').run(customer.id, ip, ua);

  if (!customer.profile_done) {
    return res.json({ needProfile: true, customer: { name: customer.name } });
  }
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
  const products = db.prepare('SELECT * FROM products WHERE active = 1 OR active IS NULL').all().map(p => ({
    id: p.id, name: p.name, unit: p.unit, image: p.image, stock: p.stock,
    price: p.price, category_id: p.category_id, is_new_arrival: p.is_new_arrival,
  }));
  res.json({ needProfile: false, customer: { name: customer.name, tier: customer.tier, ragione_sociale: customer.ragione_sociale, piva: customer.piva },
    categories: cats.map(c => ({ id: c.id, code: c.code, name: c.name, image: c.image||'', show_new_arrivals: c.show_new_arrivals })), products });
});

app.post('/api/customer/:token/profile', requireBoundDevice, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效或已过期' });
  const f = req.body || {};
  const required = { ragione_sociale: 'Ragione Sociale', piva: 'P.IVA', indirizzo: 'Indirizzo', cap: 'CAP', citta: 'Citta', telefono: 'Telefono' };
  const missing = Object.keys(required).filter(k => !String(f[k] || '').trim());
  if (missing.length) return res.status(400).json({ error: '请填写: ' + missing.map(k => required[k]).join(', ') });
  db.prepare('UPDATE customers SET profile_done=1, ragione_sociale=?, piva=?, codice_fiscale=?, indirizzo=?, cap=?, citta=?, sdi=?, pec=?, telefono=?, email=? WHERE token=?').run(
    f.ragione_sociale.trim(), f.piva.trim(), (f.codice_fiscale||'').trim(),
    f.indirizzo.trim(), f.cap.trim(), f.citta.trim(), (f.sdi||'').trim(),
    (f.pec||'').trim(), f.telefono.trim(), (f.email||'').trim(), req.params.token
  );
  res.json({ ok: true });
});

// 从规格文字里提取"每件数量",比如 "盒(24支/盒)" -> 24, "箱(30包/箱)" -> 30
// 提取不到就当作 1(按件卖)。商品价格 price 字段存的是单支/单件价,
// 客户下单选的是"几盒/几箱",所以整件价 = price * packSize
// 从规格文字里提取"每件数量",比如 "盒(24支/盒)" -> 24, "箱(30包/箱)" -> 30
// 提取不到就当作 1(按件卖)
function packSizeFromUnit(unit) {
  if (!unit) return 1;
  const m = String(unit).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

app.post('/api/order/:token', requireBoundDevice, async (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效或已过期' });

  const { items, note } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '购物车是空的' });
  }

  let total = 0;
  const lines = [];
  for (const item of items) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
    if (!p) return res.status(400).json({ error: `商品不存在: ${item.id}` });
    const packSize = packSizeFromUnit(p.unit);
    if (item.qty % packSize !== 0) {
      return res.status(400).json({ error: `${p.name} 只能整件购买,每件 ${packSize} 支/片,请修改数量` });
    }
    const unitPrice = p.price; // 单支/单件价,qty 就是件数,直接相乘即可
    total += unitPrice * item.qty;
    lines.push({ id: p.id, name: p.name, qty: item.qty, unitPrice });
  }

  // 最低起订金额校验(前端可被绕过,服务端必须自己再判一次)
  const MIN_ORDER = 300;
  if (total < MIN_ORDER) {
    return res.status(400).json({ error: `订单最低金额 €${MIN_ORDER},当前 €${total.toFixed(2)}` });
  }

  const orderId = randomUUID();
  const createdAt = new Date().toISOString();
  total = Math.round(total * 100) / 100;

  // 扣库存 + 写订单 + 写明细(简单起见没上事务,量大了再加)
  const insertOrder = db.prepare(
    `INSERT INTO orders (id, customer_id, customer_name, note, total, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  );
  insertOrder.run(orderId, customer.id, customer.name, note || '', total, createdAt);

  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, qty, unit_price) VALUES (?, ?, ?, ?, ?)`
  );
  const updateStock = db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`);
  for (const l of lines) {
    insertItem.run(orderId, l.id, l.name, l.qty, l.unitPrice);
    updateStock.run(l.qty, l.id);
  }

  await notifyNewOrder({ id: orderId, customerName: customer.name, lines, note, total });

  res.json({ ok: true, orderId, total });
});

app.get('/o/:token', (req, res) => {
  const token = req.params.token;
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(token);
  if (!customer) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'link-expired.html'));
  }

  const cookies = parseCookies(req);
  const cookieName = 'bi_device_' + customer.id;
  const deviceIdFromCookie = cookies[cookieName];

  if (!customer.activated_at) {
    // 首次打开:把这台设备的 cookie 写进数据库,链接从此"锁定"到这台设备
    const deviceId = deviceIdFromCookie || randomUUID();
    db.prepare('UPDATE customers SET device_id = ?, activated_at = ? WHERE token = ?')
      .run(deviceId, new Date().toISOString(), token);
    res.setHeader('Set-Cookie', `${cookieName}=${deviceId}; Max-Age=${DEVICE_COOKIE_MAXAGE}; Path=/; SameSite=Lax`);
    return res.sendFile(path.join(__dirname, 'public', 'order.html'));
  }

  if (deviceIdFromCookie && deviceIdFromCookie === customer.device_id) {
    // 同一台设备(比如从主屏幕图标打开),放行
    return res.sendFile(path.join(__dirname, 'public', 'order.html'));
  }

  // 已经被别的设备激活过,当前设备的 cookie 对不上 => 拒绝
  return res.status(403).sendFile(path.join(__dirname, 'public', 'link-expired.html'));
});

// ---------------------------------------------------------------------------
// 管理端 API(都要带 x-admin-key 请求头)
// ---------------------------------------------------------------------------

// 上传商品图片,成功后返回可直接存进商品 image 字段的 URL
app.post('/api/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  res.json({ url: `/uploads/${req.file.filename}` });
}, (err, req, res, next) => {
  // multer 的错误(比如文件太大、类型不对)会走到这里
  res.status(400).json({ error: err.message || '上传失败' });
});

// 商品:列表 / 新增 / 修改 / 删除

// 分类管理接口
app.get('/api/admin/categories', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all());
});
app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { code, name, sort_order, image, show_new_arrivals } = req.body;
  if (!name) return res.status(400).json({ error: '缺少分类名称' });
  if (show_new_arrivals) db.prepare('UPDATE categories SET show_new_arrivals = 0').run();
  db.prepare('INSERT INTO categories (code, name, sort_order, image, show_new_arrivals) VALUES (?, ?, ?, ?, ?)')
    .run((code||'').trim(), name.trim(), Number(sort_order)||0, (image||'').trim(), show_new_arrivals ? 1 : 0);
  res.json({ ok: true });
});
app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const { code, name, sort_order, image, show_new_arrivals } = req.body;
  if (show_new_arrivals) db.prepare('UPDATE categories SET show_new_arrivals = 0 WHERE id != ?').run(req.params.id);
  db.prepare('UPDATE categories SET code=?, name=?, sort_order=?, image=?, show_new_arrivals=? WHERE id=?')
    .run((code||'').trim(), name.trim(), Number(sort_order)||0, (image||'').trim(), show_new_arrivals ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(req.params.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT p.*, c.name AS category_name, c.code AS category_code FROM products p LEFT JOIN categories c ON p.category_id = c.id ORDER BY c.sort_order, p.name`).all());
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { id, name, name_cn, barcode, unit, image, stock, price, category_id, is_new_arrival } = req.body;
  if (!id || !name) return res.status(400).json({ error: '缺少商品编号或名称' });
  db.prepare(
    `INSERT INTO products (id, name, name_cn, barcode, unit, image, stock, price, category_id, is_new_arrival) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, (name_cn||'').trim(), (barcode||'').trim(), unit || '', image || '', Number(stock) || 0, Number(price) || 0, category_id || null, is_new_arrival ? 1 : 0);
  res.json({ ok: true });
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { name, name_cn, barcode, unit, image, stock, price, category_id, is_new_arrival } = req.body;
  const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: '商品不存在' });
  db.prepare(
    `UPDATE products SET name=?, name_cn=?, barcode=?, unit=?, image=?, stock=?, price=?, category_id=?, is_new_arrival=? WHERE id=?`
  ).run(name, (name_cn||'').trim(), (barcode||'').trim(), unit, image, Number(stock) || 0, Number(price) || 0, category_id || null, is_new_arrival ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});




// 客户列表
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM customers').all());
});

// 新增客户
app.post('/api/admin/customers', requireAdmin, (req, res) => {
  const { name, tier } = req.body;
  if (!name) return res.status(400).json({ error: '缺少客户名称' });
  const { randomUUID } = require('crypto');
  const token = randomUUID().slice(0, 8);
  const id = 'c_' + randomUUID().slice(0, 6);
  db.prepare('INSERT INTO customers (token, id, name, tier) VALUES (?, ?, ?, ?)').run(token, id, name, tier === 'B' ? 'B' : 'A');
  res.json({ ok: true, token, orderUrl: '/o/' + token });
});

// 解绑设备:链接本身不变,客户换手机/清了浏览器数据打不开时用这个,
// 下次谁打开这个链接就会重新绑定到那台设备(如果链接没被泄露,应该还是客户自己先打开)
app.post('/api/admin/customers/:token/reset-device', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  db.prepare('UPDATE customers SET device_id = NULL, activated_at = NULL WHERE token = ?').run(req.params.token);
  res.json({ ok: true });
});

// 生成全新链接:旧链接(不管谁手上拿着)立刻失效,客户需要重新添加到主屏幕。
// 用在怀疑链接已经被转发/泄露给不相关的人时
app.post('/api/admin/customers/:token/regenerate-link', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  const newToken = randomUUID().slice(0, 8);
  db.prepare('UPDATE customers SET token = ?, device_id = NULL, activated_at = NULL WHERE token = ?')
    .run(newToken, req.params.token);
  res.json({ ok: true, token: newToken, orderUrl: '/o/' + newToken });
});

// 单个客户详情+历史订单
// 全部客户的访客记录(类似"谁看过我"的动态流),按时间倒序
app.get('/api/admin/access-logs', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT al.*, c.name AS customer_name, c.token AS customer_token
    FROM access_logs al
    JOIN customers c ON c.id = al.customer_id
    ORDER BY al.created_at DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

app.get('/api/admin/customers/:token', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(customer.id);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');

  const accessLogs = db.prepare('SELECT * FROM access_logs WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50').all(customer.id);
  const recentRows = db.prepare(
    "SELECT DISTINCT ip, user_agent FROM access_logs WHERE customer_id = ? AND created_at >= datetime('now','-1 day')"
  ).all(customer.id);
  const anomaly = recentRows.length >= 3;

  res.json({ customer, orders: orders.map(o => ({ ...o, items: itemsStmt.all(o.id) })), accessLogs, anomaly });
});

// 删除客户
app.delete('/api/admin/customers/:token', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM customers WHERE token = ?').run(req.params.token);
  res.json({ ok: true });
});

// 订单:列表(带明细)/ 改状态
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  res.json(orders.map(o => ({ ...o, items: itemsStmt.all(o.id) })));
});

app.put('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body; // pending | confirmed | shipped
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// 可打印的送货单页面。浏览器打开后用 Cmd/Ctrl+P 打印,或"打印"对话框里选
// "存储为PDF"就能下载 PDF——不用额外的 PDF 生成库,中文字体也不会有问题。
app.get('/api/admin/orders/:id/print', requireAdminViaQuery, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('订单不存在');
  const items = db.prepare(`
    SELECT oi.*, p.id as p_id, p.name_cn, p.barcode, p.image, p.unit
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) || {};

  const host = req.protocol + '://' + req.get('host');

  const rows = items.map(i => {
    const imgSrc = i.image
      ? (i.image.startsWith('http') ? i.image : host + i.image)
      : '';
    const imgCell = imgSrc
      ? `<img src="${imgSrc}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;display:block">`
      : `<div style="width:56px;height:56px;border-radius:8px;background:#f5e8ec;display:flex;align-items:center;justify-content:center;color:#ddd;font-size:20px">☁</div>`;
    return `
    <tr>
      <td class="c-img">${imgCell}</td>
      <td class="c-id"><span class="mono">${i.p_id||'—'}</span></td>
      <td class="c-bc"><span class="mono">${i.barcode||'—'}</span></td>
      <td class="c-name">
        <div class="name-it">${i.product_name}</div>
        ${i.name_cn ? `<div class="name-cn">${i.name_cn}</div>` : ''}
      </td>
      <td class="c-qty num">${i.qty}<div class="sub">${i.unit||''}</div></td>
      <td class="c-price num">€${i.unit_price.toFixed(2)}</td>
      <td class="c-total num">€${(i.qty * i.unit_price).toFixed(2)}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>DDT #${order.id.slice(0,8)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "PingFang SC","Helvetica Neue",Arial,sans-serif; color: #1a1a1a; margin:0; padding:16px 20px; font-size:12px; }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: 0.04em; color: #a85068; }
  .brand small { display:block; font-size: 10px; font-weight: 400; color: #aaa; margin-top: 2px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 2px solid #a85068; padding-bottom:12px; margin-bottom:14px; }
  .dest-label { font-size:9px; text-transform:uppercase; color:#aaa; letter-spacing:0.08em; margin-bottom:4px; }
  .dest-name { font-size:14px; font-weight:700; margin-bottom:3px; }
  .dest-info { font-size:11px; color:#555; line-height:1.7; }
  .doc-box { text-align:right; min-width:160px; }
  .doc-box .doc-num { font-size:20px; font-weight:700; color:#a85068; }
  .doc-box .doc-date { font-size:11px; color:#888; margin-top:2px; }

  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  col.c-img   { width: 72px; }
  col.c-id    { width: 90px; }
  col.c-bc    { width: 110px; }
  col.c-name  { width: auto; }
  col.c-qty   { width: 70px; }
  col.c-price { width: 80px; }
  col.c-total { width: 90px; }

  thead tr { background: #a85068; color: #fff; }
  thead th { font-size:10px; text-transform:uppercase; letter-spacing:0.05em; padding:8px 6px; text-align:left; font-weight:600; }
  thead th.num { text-align:right; }

  tbody tr { border-bottom: 1px solid #f0e6ea; }
  tbody tr:nth-child(even) { background: #fdf5f7; }
  tbody tr:last-child { border-bottom: 2px solid #c0a0aa; }

  td { padding: 7px 6px; vertical-align: middle; }
  .c-img { padding: 5px 4px; }
  .num { text-align: right; }
  .mono { font-family: "Courier New", monospace; font-size: 11px; color: #555; }
  .name-it { font-weight: 600; font-size: 12px; }
  .name-cn { font-size: 11px; color: #999; margin-top: 2px; }
  .sub { font-size: 10px; color: #aaa; margin-top: 2px; }
  .c-total { font-weight: 700; color: #a85068; }

  tfoot tr { background: #f9f0f3; }
  tfoot td { padding: 10px 6px; font-weight: 700; font-size: 13px; border-top: 2px solid #a85068; }
  .total-val { color: #a85068; font-size: 16px; }

  .note-box { margin-top:14px; padding:8px 12px; background:#fdf5f7; border-left:3px solid #cf7e93; border-radius:4px; font-size:11px; color:#666; }
  .footer { margin-top:20px; border-top:1px solid #e0d0d5; padding-top:8px; font-size:10px; color:#bbb; display:flex; justify-content:space-between; }
  .print-btn { margin-top:16px; padding:9px 22px; background:#a85068; color:#fff; border:none; border-radius:999px; font-size:13px; cursor:pointer; }
  @media print { .print-btn { display:none; } body { padding:0; } }
</style></head>
<body>
  <div class="header">
    <div>
      <div class="brand">BELLA ITALIA <small>Cosmetics Wholesale · Documento di Trasporto</small></div>
      <div style="margin-top:16px">
        <div class="dest-label">Destinatario</div>
        <div class="dest-name">${customer.ragione_sociale||order.customer_name}</div>
        <div class="dest-info">
          ${customer.piva ? 'P.IVA: '+customer.piva+'<br>' : ''}
          ${customer.codice_fiscale ? 'C.F.: '+customer.codice_fiscale+'<br>' : ''}
          ${customer.indirizzo ? customer.indirizzo+'<br>' : ''}
          ${(customer.cap||customer.citta) ? (customer.cap||'')+' '+(customer.citta||'')+'<br>' : ''}
          ${customer.sdi ? 'SDI: '+customer.sdi+'<br>' : ''}
          ${customer.pec ? 'PEC: '+customer.pec+'<br>' : ''}
          ${customer.telefono ? 'Tel: '+customer.telefono : ''}
        </div>
      </div>
    </div>
    <div class="doc-box">
      <div class="doc-label">Documento</div>
      <div class="doc-num">#${order.id.slice(0,8)}</div>
      <div class="doc-date">${new Date(order.created_at).toLocaleDateString('it-IT',{day:'2-digit',month:'long',year:'numeric',timeZone:'Europe/Rome'})}</div>
    </div>
  </div>

  <table>
    <colgroup>
      <col class="c-img"><col class="c-id"><col class="c-bc">
      <col class="c-name"><col class="c-qty"><col class="c-price"><col class="c-total">
    </colgroup>
    <thead>
      <tr>
        <th>图片</th>
        <th>编号</th>
        <th>条码</th>
        <th>产品名称 / 名称</th>
        <th class="num">总数量</th>
        <th class="num">价格/pz</th>
        <th class="num">合计</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="6" class="num" style="color:#888;font-size:12px">Totale Ordine</td>
        <td class="num total-val">€${order.total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${order.note ? `<div class="note-box">📝 Note: ${order.note}</div>` : ''}

  <div class="footer">
    <span>TNC GOLD A8 · Via Galileo Ferraris 136, 80146 Napoli NA · Tel: +39 348 518 0143</span>
    <span>Bella Italia Cosmetics Wholesale</span>
  </div>

  <button class="print-btn" onclick="window.print()">🖨️ Stampa / Salva PDF</button>
</body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`跑起来了: http://localhost:${PORT}/o/a1b2c3`);
  console.log(`后台管理: http://localhost:${PORT}/admin.html (密钥: ${ADMIN_KEY})`);
});
