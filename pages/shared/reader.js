'use strict';
(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const a = await onedm.invoke('reader:get', id);
  const art = $('#art');
  if (!a) { art.innerHTML = '<p>This article is no longer available.</p>'; return; }
  document.title = a.title + ' — Reading mode';
  art.innerHTML = '<h1 class="title"></h1><div class="meta"></div><div id="body"></div>';
  art.querySelector('.title').textContent = a.title;
  const meta = art.querySelector('.meta'); const link = document.createElement('a'); link.href = a.url; link.textContent = a.site; link.target = '_blank'; meta.appendChild(link);
  $('#body').innerHTML = a.html;
  let fs = 19; const apply = () => document.documentElement.style.setProperty('--fs', fs + 'px');
  $('#bar').onclick = e => {
    const b = e.target.closest('[data-a]'); if (!b) return; const k = b.dataset.a;
    if (k === 'inc') fs = Math.min(32, fs + 1); else if (k === 'dec') fs = Math.max(13, fs - 1);
    else if (k === 'font') art.classList.toggle('serif');
    else { document.body.classList.remove('light', 'sepia', 'dark'); document.body.classList.add(k); }
    apply();
  };
})();
