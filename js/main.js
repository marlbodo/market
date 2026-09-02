// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용

// ---------- 최신 금융 뉴스 ----------
async function loadFinancialNews() {
  const el = document.getElementById('news-list');
  const { data, error } = await db
    .from('financial_news')
    .select('id, title, summary, link, article_published_at, created_at')
    .order('article_published_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error(error);
    el.innerHTML = '<li class="list-empty">뉴스를 불러오지 못했습니다.</li>';
    return;
  }
  renderNewsList(el, data);
}

// ---------- 주요지표 현황 ----------
async function loadIndicators() {
  const el = document.getElementById('indicator-grid');
  const { data, error } = await db
    .from('interest_rates')
    .select('indicator, date, value')
    .order('date', { ascending: false })
    .limit(120);

  if (error || !data || data.length === 0) {
    console.error(error);
    el.innerHTML = '<div class="list-empty">지표 데이터가 없습니다.</div>';
    return;
  }

  const byIndicator = {};
  data.forEach((row) => {
    if (!byIndicator[row.indicator]) byIndicator[row.indicator] = [];
    if (byIndicator[row.indicator].length < 2) byIndicator[row.indicator].push(row);
  });

  const cards = Object.entries(byIndicator).map(([name, rows]) => {
    const latest = rows[0];
    const prev = rows[1];
    let diffHtml = '';
    let dirClass = '';
    if (prev) {
      const diff = Number(latest.value) - Number(prev.value);
      if (diff !== 0) dirClass = diff > 0 ? 'up' : 'down';
      const sign = diff > 0 ? '+' : '';
      diffHtml = `<div class="indicator-delta ${dirClass}">${sign}${diff.toFixed(2)}%p 전일대비</div>`;
    }
    return `
      <div class="indicator-card">
        <div class="indicator-name">${escapeHtml(name)}</div>
        <div class="indicator-value ${dirClass}">${Number(latest.value).toFixed(2)}%</div>
        ${diffHtml}
        <div class="indicator-date">${formatDateFull(latest.date)} 기준</div>
      </div>`;
  }).join('');

  el.innerHTML = cards || '<div class="list-empty">지표 데이터가 없습니다.</div>';
}

// ---------- 공모주 뉴스 ----------
async function loadIpoNews() {
  const el = document.getElementById('ipo-news-list');
  const { data, error } = await db
    .from('ipo_news')
    .select('id, title, summary, link, article_published_at, created_at')
    .order('article_published_at', { ascending: false })
    .limit(6);

  if (error) {
    console.error(error);
    el.innerHTML = '<li class="list-empty">공모주 뉴스를 불러오지 못했습니다.</li>';
    return;
  }
  renderNewsList(el, data);
}

// ---------- 공모주 일정 ----------
async function loadIpoSchedule() {
  const el = document.getElementById('ipo-schedule-body');
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await db
    .from('ipo_schedule')
    .select('*')
    .order('listing_date', { ascending: true });

  if (error || !data) {
    console.error(error);
    el.innerHTML = '<tr><td colspan="5" class="list-empty">공모주 일정을 불러오지 못했습니다.</td></tr>';
    return;
  }

  let rows = data.filter((r) => r.listing_date && r.listing_date >= today);
  if (rows.length === 0) {
    rows = [...data].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  rows = rows.slice(0, 8);

  if (rows.length === 0) {
    el.innerHTML = '<tr><td colspan="5" class="list-empty">등록된 공모주 일정이 없습니다.</td></tr>';
    return;
  }

  el.innerHTML = rows.map((r) => {
    const priceBand = (r.price_band_low && r.price_band_high)
      ? `${formatNumber(r.price_band_low)} ~ ${formatNumber(r.price_band_high)}원`
      : '-';
    const confirmed = r.confirmed_price ? `확정가 ${formatNumber(r.confirmed_price)}원` : '희망밴드';
    const subPeriod = (r.subscription_start_date && r.subscription_end_date)
      ? `${formatDateFull(r.subscription_start_date)} ~ ${formatDateFull(r.subscription_end_date)}`
      : '미정';
    const competition = r.subscription_competition_rate
      ? `<span class="rate-tag">${Number(r.subscription_competition_rate).toLocaleString('ko-KR')} : 1</span>`
      : '-';

    return `
      <tr>
        <td>
          <div class="ipo-stock">${escapeHtml(r.stock_name)}</div>
          <div class="ipo-sub">${confirmed}</div>
        </td>
        <td>${priceBand}</td>
        <td>${subPeriod}</td>
        <td>${formatDateFull(r.listing_date)}</td>
        <td>${competition}</td>
      </tr>`;
  }).join('');
}

// ---------- 탭 전환 (공모주 뉴스 / 일정) ----------
function setupIpoTabs() {
  const tabs = document.querySelectorAll('[data-ipo-tab]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('is-active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      document.getElementById(tab.getAttribute('data-ipo-tab')).classList.add('is-active');
    });
  });
}

// ---------- 헤더 업데이트 시각 ----------
function setUpdatedAt() {
  const el = document.getElementById('updated-at');
  if (!el) return;
  const now = new Date();
  el.textContent = `업데이트 ${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')} 기준`;
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
  setUpdatedAt();
  setupIpoTabs();
  loadFinancialNews();
  loadIndicators();
  loadIpoNews();
  loadIpoSchedule();
});
