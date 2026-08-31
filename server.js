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

app.get('/api/customer/:token', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效或已过期' });
  if (!customer.profile_done) {
    return res.json({ needProfile: true, customer: { name: customer.name } });
  }
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
  const products = db.prepare('SELECT * FROM products').all().map(p => ({
    id: p.id, name: p.name, unit: p.unit, image: p.image, stock: p.stock,
    price: p.price, category_id: p.category_id,
  }));
  res.json({ needProfile: false, customer: { name: customer.name, tier: customer.tier },
    categories: cats.map(c => ({ id: c.id, code: c.code, name: c.name })), products });
});

app.post('/api/customer/:token/profile', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '链接无效或已过期' });
  const f = req.body || {};
  const required = { ragione_sociale: 'Ragione Sociale', piva: 'P.IVA', indirizzo: 'Indirizzo', cap: 'CAP', citta: 'Citta', sdi: 'SDI', pec: 'PEC', telefono: 'Telefono', email: 'Email' };
  const missing = Object.keys(required).filter(k => !String(f[k] || '').trim());
  if (missing.length) return res.status(400).json({ error: '请填写: ' + missing.map(k => required[k]).join(', ') });
  db.prepare('UPDATE customers SET profile_done=1, ragione_sociale=?, piva=?, codice_fiscale=?, indirizzo=?, cap=?, citta=?, sdi=?, pec=?, telefono=?, email=? WHERE token=?').run(
    f.ragione_sociale.trim(), f.piva.trim(), (f.codice_fiscale||'').trim(),
    f.indirizzo.trim(), f.cap.trim(), f.citta.trim(), f.sdi.trim(),
    f.pec.trim(), f.telefono.trim(), f.email.trim(), req.params.token
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

app.post('/api/order/:token', async (req, res) => {
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
    if (item.qty > p.stock) {
      return res.status(400).json({ error: `${p.name} 库存不足,现有 ${p.stock}` });
    }
    const unitPrice = p.price; // 单支/单件价,qty 就是件数,直接相乘即可
    total += unitPrice * item.qty;
    lines.push({ id: p.id, name: p.name, qty: item.qty, unitPrice });
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
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
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
  const { code, name, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: '缺少分类名称' });
  db.prepare('INSERT INTO categories (code, name, sort_order) VALUES (?, ?, ?)').run((code||'').trim(), name.trim(), Number(sort_order)||0);
  res.json({ ok: true });
});
app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const { code, name, sort_order } = req.body;
  db.prepare('UPDATE categories SET code=?, name=?, sort_order=? WHERE id=?').run((code||'').trim(), name.trim(), Number(sort_order)||0, req.params.id);
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
  const { id, name, name_cn, unit, image, stock, price, category_id } = req.body;
  if (!id || !name) return res.status(400).json({ error: '缺少商品编号或名称' });
  db.prepare(
    `INSERT INTO products (id, name, name_cn, unit, image, stock, price, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, (name_cn||'').trim(), unit || '', image || '', Number(stock) || 0, Number(price) || 0, category_id || null);
  res.json({ ok: true });
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { name, name_cn, unit, image, stock, price, category_id } = req.body;
  const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: '商品不存在' });
  db.prepare(
    `UPDATE products SET name=?, name_cn=?, unit=?, image=?, stock=?, price=?, category_id=? WHERE id=?`
  ).run(name, (name_cn||'').trim(), unit, image, Number(stock) || 0, Number(price) || 0, category_id || null, req.params.id);
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

// 单个客户详情+历史订单
app.get('/api/admin/customers/:token', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(req.params.token);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(customer.id);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  res.json({ customer, orders: orders.map(o => ({ ...o, items: itemsStmt.all(o.id) })) });
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
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) || {};

  const rows = items.map(i => `
    <tr>
      <td>${i.product_name}</td>
      <td class="num">${i.qty}</td>
      <td class="num">€${i.unit_price.toFixed(2)}</td>
      <td class="num">€${(i.qty * i.unit_price).toFixed(2)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><title>送货单 #${order.id.slice(0,8)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif; color: #222; padding: 20px; }
  .brand { font-size: 22px; font-weight: 700; letter-spacing: 0.02em; }
  .brand small { display:block; font-size: 11px; font-weight: 400; color: #888; margin-top: 2px; }
  .meta { display: flex; justify-content: space-between; margin: 18px 0; font-size: 13px; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 10px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  th, td { border-bottom: 1px solid #e2e2e2; padding: 8px 6px; text-align: left; }
  th { font-size: 11px; text-transform: uppercase; color: #888; }
  .num { text-align: right; }
  tfoot td { border-top: 2px solid #222; border-bottom: none; font-weight: 700; padding-top: 10px; }
  .note { margin-top: 18px; font-size: 13px; color: #555; }
  .print-btn { margin-top: 24px; padding: 8px 16px; }
  @media print { .print-btn { display: none; } }
</style></head>
<body>
  <div class="brand">BELLA ITALIA <small>Cosmetics Wholesale · Documento di Trasporto</small></div>
  <div style="display:flex;justify-content:space-between;margin-top:18px;gap:20px">
    <div style="flex:1">
      <div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:6px">Destinatario</div>
      <div style="font-size:13px;font-weight:600">${customer.ragione_sociale||order.customer_name}</div>
      ${customer.piva ? '<div style="font-size:12px;color:#555">P.IVA: '+customer.piva+'</div>' : ''}
      ${customer.codice_fiscale ? '<div style="font-size:12px;color:#555">C.F.: '+customer.codice_fiscale+'</div>' : ''}
      ${customer.indirizzo ? '<div style="font-size:12px;color:#555">'+customer.indirizzo+'</div>' : ''}
      ${(customer.cap||customer.citta) ? '<div style="font-size:12px;color:#555">'+(customer.cap||'')+' '+(customer.citta||'')+'</div>' : ''}
      ${customer.sdi ? '<div style="font-size:12px;color:#555">SDI: '+customer.sdi+'</div>' : ''}
      ${customer.pec ? '<div style="font-size:12px;color:#555">PEC: '+customer.pec+'</div>' : ''}
      ${customer.telefono ? '<div style="font-size:12px;color:#555">Tel: '+customer.telefono+'</div>' : ''}
      ${customer.email ? '<div style="font-size:12px;color:#555">Email: '+customer.email+'</div>' : ''}
    </div>
    <div style="text-align:right;font-size:12px;color:#555;min-width:160px">
      <div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:6px">Documento</div>
      <div><b>Data:</b> ${new Date(order.created_at).toLocaleDateString('it-IT')}</div>
      <div><b>N. Ordine:</b> #${order.id.slice(0,8)}</div>
    </div>
  </div>
  <table style="margin-top:18px">
    <thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">合计</td><td class="num">€${order.total.toFixed(2)}</td></tr></tfoot>
  </table>
  ${order.note ? `<div class="note">备注: ${order.note}</div>` : ''}
  <button class="print-btn" onclick="window.print()">打印 / 存为 PDF</button>
</body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`跑起来了: http://localhost:${PORT}/o/a1b2c3`);
  console.log(`后台管理: http://localhost:${PORT}/admin.html (密钥: ${ADMIN_KEY})`);
});
