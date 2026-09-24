(function(){
  fetch('/api/settings')
    .then(r => r.json())
    .then(s => {
      // data-store="key" → 替换文字
      document.querySelectorAll('[data-store]').forEach(el => {
        const key = el.getAttribute('data-store');
        if (s[key] !== undefined && s[key] !== '') el.textContent = s[key];
      });
      // data-store-href="key" → 替换 href
      document.querySelectorAll('[data-store-href]').forEach(el => {
        const key = el.getAttribute('data-store-href');
        if (s[key] !== undefined && s[key] !== '') el.href = s[key];
      });
      // data-wa="消息文案" → 拼接 WhatsApp 链接
      document.querySelectorAll('[data-wa]').forEach(el => {
        const msg = el.getAttribute('data-wa');
        if (s.whatsapp_number) el.href = 'https://wa.me/' + s.whatsapp_number + '?text=' + encodeURIComponent(msg);
      });
      // accent_color → CSS 变量
      if (s.accent_color) {
        document.documentElement.style.setProperty('--accent', s.accent_color);
      }
    })
    .catch(e => console.warn('store-settings:', e));
})();
