// ---------- Helpers ----------
function formatDateShort(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}.${dd}`;
}

function formatDateTimeShort(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  // 접속자의 로컬 시간대와 무관하게 항상 한국시간(KST)으로 고정
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('month')}.${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatDateFull(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatNumber(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('ko-KR');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 뉴스 리스트 공통 렌더러 (요약/원문보기 버튼을 제목 옆에 배치) ----------
function renderNewsList(el, rows) {
  if (!rows || rows.length === 0) {
    el.innerHTML = '<li class="list-empty">불러올 뉴스가 없습니다.</li>';
    return;
  }
  el.innerHTML = rows.map((row, i) => {
    const hasSummary = !!row.summary;
    const uid = `${el.id}-${i}`;
    return `
      <li class="news-item">
        <div class="news-row">
          <span class="news-date">${formatDateTimeShort(row.article_published_at || row.created_at)}</span>
          <div class="news-body">
            <div class="news-title-row">
              <a class="news-title" href="${escapeHtml(row.link)}" target="_blank" rel="noopener">${escapeHtml(row.title)}</a>
              <div class="news-actions">
                ${hasSummary ? `<button class="pill-btn" data-summary-toggle="${uid}">요약</button>` : ''}
                <a class="pill-btn" href="${escapeHtml(row.link)}" target="_blank" rel="noopener">원문보기</a>
              </div>
            </div>
            ${hasSummary ? `<p class="news-summary" id="summary-${uid}">${escapeHtml(row.summary)}</p>` : ''}
          </div>
        </div>
      </li>`;
  }).join('');

  el.querySelectorAll('[data-summary-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const uid = btn.getAttribute('data-summary-toggle');
      const box = document.getElementById(`summary-${uid}`);
      box.classList.toggle('is-open');
      btn.classList.toggle('is-active');
      btn.textContent = box.classList.contains('is-open') ? '요약 닫기' : '요약';
    });
  });
}
