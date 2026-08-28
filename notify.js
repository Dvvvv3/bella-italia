// notify.js
// 新订单通知。默认只是 console.log,配置了 WEBHOOK_URL 环境变量后
// 会同时推一条消息到企业微信群机器人(其他平台的群机器人比如飞书/Slack 格式类似,改一下 body 结构就行)

async function notifyNewOrder(order) {
  const lines = order.lines.map(l => `· ${l.name} x${l.qty} = €${(l.qty * l.unitPrice).toFixed(2)}`).join('\n');
  const text = `【新订单】${order.customerName}\n${lines}\n合计: €${order.total}\n备注: ${order.note || '无'}\n订单号: ${order.id.slice(0, 8)}`;

  console.log('\n📦 ' + text.replace(/\n/g, '\n   ') + '\n');

  const webhook = process.env.WEBHOOK_URL;
  if (!webhook) return; // 没配置就只打日志

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }), // 企业微信群机器人格式
    });
  } catch (err) {
    console.error('通知推送失败(不影响订单本身):', err.message);
  }
}

module.exports = { notifyNewOrder };
