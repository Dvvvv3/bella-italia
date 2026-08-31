// db.js
// 用 Node 内置的 node:sqlite(Node 22.5+自带,不用 npm install 任何数据库包)
// 数据库文件存在 DATA_DIR 目录下(本地默认项目根目录;部署到 Railway 时把
// DATA_DIR 指向一个挂载了 Volume 的路径,比如 /data,数据才不会在重新部署时丢失)

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    token TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'A',
    profile_done INTEGER NOT NULL DEFAULT 0,
    ragione_sociale TEXT,
    piva TEXT,
    codice_fiscale TEXT,
    indirizzo TEXT,
    cap TEXT,
    citta TEXT,
    sdi TEXT,
    pec TEXT,
    telefono TEXT,
    email TEXT
  );

  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0);

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    image TEXT,
    stock INTEGER NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    category_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    note TEXT,
    total REAL NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price REAL NOT NULL
  );
`);

// 迁移: 给 products 表加"内部中文名"字段(只有后台管理能看到,客户下单页不显示)
const productCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
if (!productCols.includes('name_cn')) {
  db.exec(`ALTER TABLE products ADD COLUMN name_cn TEXT`);
}

// 首次启动,表是空的就塞一点示例数据,方便你直接测试
const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (productCount === 0) {
  const insertProduct = db.prepare(
    `INSERT INTO products (id, name, unit, image, stock, price, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertProduct.run('sku001', '哑光唇釉 12色可选', '盒(24支/盒)', 'https://placehold.co/200x200?text=Lip', 120, 38.5, 42.0);
  insertProduct.run('sku002', '玻尿酸面膜 5片装', '箱(30包/箱)', 'https://placehold.co/200x200?text=Mask', 60, 65.0, 70.0);
  insertProduct.run('sku003', '香水 玫瑰调 50ml', '箱(12瓶/箱)', 'https://placehold.co/200x200?text=Perfume', 0, 89.0, 95.0);

  const insertCustomer = db.prepare(
    `INSERT INTO customers (token, id, name, tier) VALUES (?, ?, ?, ?)`
  );
  insertCustomer.run('a1b2c3', 'c001', '张老板 - 温州小商品', 'A');
  insertCustomer.run('x9y8z7', 'c002', '李经理 - 米兰批发部', 'B');
}

module.exports = db;


try { require('./seed-categories')(db); } catch (e) { console.log('跳过分类种子:', e.message); }
