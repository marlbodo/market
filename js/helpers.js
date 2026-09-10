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
// 날짜 없이 시:분만 (KST 고정) - 메인 페이지의 채권/공모주 뉴스처럼
// "거의 실시간"으로 갱신되는 목록에서, 항상 오늘 날짜이므로 날짜 표기를 생략할 때 사용
function formatTimeOnly(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('hour')}:${get('minute')}`;
}
function formatDateFull(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
function formatDateTimeFull(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  // 접속자의 로컬 시간대와 무관하게 항상 한국시간(KST)으로 고정, 연도까지 포함
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}.${get('month')}.${get('day')} ${get('hour')}:${get('minute')}`;
}
function truncateText(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
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
// ---------- 뉴스 리스트 공통 렌더러 (제목 클릭 시 새 창으로 이동) ----------
// options.timeOnly가 true면 날짜 없이 시:분만 표시 (메인 페이지처럼 항상 "오늘" 뉴스인 목록용).
// 기본값(false)은 기존과 동일하게 "MM.DD HH:MM" 표시 (news-all.html 등 며칠 전 기사까지 보이는 목록용).
function renderNewsList(el, rows, options) {
  const timeOnly = !!(options && options.timeOnly);
  if (!rows || rows.length === 0) {
    el.innerHTML = '<li class="list-empty">불러올 뉴스가 없습니다.</li>';
    return;
  }
  el.innerHTML = rows.map((row) => {
    const ts = row.article_published_at || row.created_at;
    const dateLabel = timeOnly ? formatTimeOnly(ts) : formatDateTimeShort(ts);
    return `
      <li class="news-item">
        <div class="news-row">
          <span class="news-date">${dateLabel}</span>
          <a class="news-title" href="${escapeHtml(row.link)}" target="_blank" rel="noopener">${escapeHtml(row.title)}</a>
        </div>
      </li>`;
  }).join('');
}
