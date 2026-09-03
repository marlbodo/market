// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용
console.log('%c[market] main.js v2026-09-03 (금리표 기준일 헤더 이동)', 'color:#16305c;font-weight:bold');

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

// ---------- 날짜 유틸 ----------
function dayGap(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00`);
  const b = new Date(`${dateB}T00:00:00`);
  return Math.round((a - b) / 86400000);
}
function dowKo(dateStr) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return days[new Date(`${dateStr}T00:00:00`).getDay()];
}
// 기준일이 속한 달의 1일 (예: 2026-09-01 → 2026-09-01, 2026-09-15 → 2026-09-01)
function firstOfMonth(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
// 기준일이 속한 연도의 1월 1일
function firstOfYear(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getFullYear()}-01-01`;
}

// 진단용: 에러가 나면 스피너에 멈춰있지 않고 실제 에러를 화면에 표시
function showError(el, label, err) {
  console.error(label, err);
  const msg = (err && err.message) ? err.message : String(err);
  el.innerHTML = `<div class="list-empty">⚠ ${label} 실패: ${escapeHtml(msg)}</div>`;
}

// ---------- 최신 채권·금리 뉴스 ----------
async function loadFinancialNews() {
  const el = document.getElementById('news-list');
  try {
    const { data, error } = await db
      .from('financial_news')
      .select('id, title, summary, link, article_published_at, created_at')
      .order('article_published_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    renderNewsList(el, data);
  } catch (err) {
    showError(el, '채권·금리 뉴스', err);
  }
}

// ---------- 주요지표 정렬 순서 ----------
const RATE_ORDER = [
  '기준금리', 'CD', '산금6M', '산금1Y', '은행AA+1Y',
  '국고3Y', '국고5Y', '국고10Y', '공사3Y', '공사5Y',
  '미국정책금리', '미국10Y',
];
function rateSortKey(name) {
  const norm = name.replace(/\s+/g, '');
  const idx = RATE_ORDER.findIndex((k) => norm.includes(k) || k.includes(norm));
  return idx === -1 ? 999 : idx;
}

// ---------- 주요금리 (전일·전월말·전년말 대비, 표 형태) ----------
function deltaTd(base, compareRow) {
  if (!compareRow) return '<td class="rate-td-delta">-</td>';
  const diff = Number(base.value) - Number(compareRow.value);
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  return `<td class="rate-td-delta ${dir}">${arrow}${Math.abs(diff).toFixed(3)}</td>`;
}

async function loadIndicators() {
  const el = document.getElementById('rate-list');
  const dateThEl = document.getElementById('rate-date-th');
  try {
    // 1) 지표별 "현재값" 가져오기 (모든 지표가 최신일자를 공유한다고 가정, 여유 있게 60행)
    const { data: latestRows, error: latestErr } = await db
      .from('interest_rates')
      .select('indicator, date, value')
      .order('date', { ascending: false })
      .limit(60);
    if (latestErr) throw latestErr;

    if (!latestRows || latestRows.length === 0) {
      el.innerHTML = '<tr><td colspan="5" class="list-empty">지표 데이터가 아직 없습니다.</td></tr>';
      if (dateThEl) dateThEl.textContent = '금리';
      return;
    }

    const currentByIndicator = {};
    latestRows.forEach((row) => {
      if (!currentByIndicator[row.indicator]) currentByIndicator[row.indicator] = row; // 먼저 나온(=가장 최신) 것만 유지
    });
    const indicatorList = Object.entries(currentByIndicator); // [ [name, currentRow], ... ]

    // 2) 지표 하나당, 특정 날짜보다 "작은" 날짜 중 가장 큰 값을 정확히 targeted 조회
    const fetchBefore = async (name, thresholdDate) => {
      const { data, error } = await db
        .from('interest_rates')
        .select('date, value')
        .eq('indicator', name)
        .lt('date', thresholdDate)
        .order('date', { ascending: false })
        .limit(1);
      if (error) { console.error('fetchBefore', name, error); return null; }
      return (data && data[0]) ? data[0] : null;
    };

    const results = await Promise.all(indicatorList.map(async ([name, current]) => {
      const [dayRow, monthRow, yearRow] = await Promise.all([
        fetchBefore(name, current.date),
        fetchBefore(name, firstOfMonth(current.date)),
        fetchBefore(name, firstOfYear(current.date)),
      ]);
      return { name, current, dayRow, monthRow, yearRow };
    }));

    results.sort((a, b) => rateSortKey(a.name) - rateSortKey(b.name) || a.name.localeCompare(b.name, 'ko'));

    const rows_html = results.map((r) => `
      <tr>
        <td class="rate-td-name">${escapeHtml(r.name)}</td>
        <td class="rate-td-value">${Number(r.current.value).toFixed(3)}</td>
        ${deltaTd(r.current, r.dayRow)}
        ${deltaTd(r.current, r.monthRow)}
        ${deltaTd(r.current, r.yearRow)}
      </tr>`).join('');

    const latestDate = indicatorList.reduce((max, [, row]) => (row.date > max ? row.date : max), indicatorList[0][1].date);
    if (dateThEl) dateThEl.textContent = formatDateShort(latestDate);

    el.innerHTML = rows_html || '<tr><td colspan="5" class="list-empty">지표 데이터가 아직 없습니다.</td></tr>';
  } catch (err) {
    console.error('주요금리', err);
    if (dateThEl) dateThEl.textContent = '오류';
    const msg = (err && err.message) ? err.message : String(err);
    el.innerHTML = `<tr><td colspan="5" class="list-empty">⚠ 주요금리 실패: ${escapeHtml(msg)}</td></tr>`;
  }
}

// ---------- 공모주 뉴스 ----------
async function loadIpoNews() {
  const el = document.getElementById('ipo-news-list');
  try {
    const { data, error } = await db
      .from('ipo_news')
      .select('id, title, summary, link, article_published_at, created_at')
      .order('article_published_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    renderNewsList(el, data);
  } catch (err) {
    showError(el, '공모주 뉴스', err);
  }
}

// ---------- 공모주 일정: 오늘 이후 모든 일정(수요예측/청약/상장) — 표 형식 ----------
function formatEok(n) {
  if (n === null || n === undefined) return '-';
  return `${Math.round(Number(n)).toLocaleString('ko-KR')}억원`;
}
function formatRatio(n, suffix) {
  if (n === null || n === undefined) return null;
  return `${Number(n).toLocaleString('ko-KR')}${suffix}`;
}
function formatPercent(n) {
  if (n === null || n === undefined) return null;
  // DB에 저장된 값 자체가 이미 %값 (예: 0.17 → 0.17%)
  return `${Number(n).toFixed(2)}%`;
}

function buildIpoEvents(rows) {
  const events = [];

  rows.forEach((r) => {
    const base = { stock: r.stock_name, amount: r.offering_amount_eok };

    // 수요예측 시작만 표시
    if (r.demand_forecast_start_date && r.demand_forecast_start_date >= TODAY) {
      events.push({ ...base, date: r.demand_forecast_start_date, type: 'forecast', label: '수요예측 시작', note: '' });
    }

    // 청약 마감만 표시 (기관경쟁률 · 확약률)
    if (r.subscription_end_date && r.subscription_end_date >= TODAY) {
      const subNoteParts = [];
      const inst = formatRatio(r.institutional_competition_rate, ':1');
      const lockup = formatPercent(r.lockup_commitment_ratio);
      if (inst) subNoteParts.push(`기관경쟁률 ${inst}`);
      if (lockup) subNoteParts.push(`확약률 ${lockup}`);
      events.push({ ...base, date: r.subscription_end_date, type: 'subscription', label: '청약 마감', note: subNoteParts.join(' · ') });
    }

    // 상장: 기관경쟁률 · 확약률 · 청약(개인)경쟁률
    if (r.listing_date && r.listing_date >= TODAY) {
      const listNoteParts = [];
      const inst2 = formatRatio(r.institutional_competition_rate, ':1');
      const lockup2 = formatPercent(r.lockup_commitment_ratio);
      const sub2 = formatRatio(r.subscription_competition_rate, ':1');
      if (inst2) listNoteParts.push(`기관경쟁률 ${inst2}`);
      if (lockup2) listNoteParts.push(`확약률 ${lockup2}`);
      if (sub2) listNoteParts.push(`청약경쟁률 ${sub2}`);
      events.push({ ...base, date: r.listing_date, type: 'listing', label: '상장', note: listNoteParts.join(' · ') });
    }
  });

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.stock.localeCompare(b.stock, 'ko');
  });
  return events;
}

let ALL_IPO_EVENTS = [];
let IPO_FILTER = 'all';

function renderIpoEvents(el, events) {
  if (events.length === 0) {
    el.innerHTML = '<tr><td colspan="4" class="list-empty">해당하는 일정이 없습니다.</td></tr>';
    return;
  }
  el.innerHTML = events.map((ev) => {
    const titleAttr = ev.note ? ` title="${escapeHtml(ev.note)}"` : '';
    return `
    <tr>
      <td class="ipo-td-date"${titleAttr}>${formatDateShort(ev.date)}(${dowKo(ev.date)})</td>
      <td class="ipo-td-stock"${titleAttr}>${escapeHtml(ev.stock)}</td>
      <td class="ipo-td-amount"${titleAttr}>${formatEok(ev.amount)}</td>
      <td class="ipo-td-type"${titleAttr}><span class="event-tag tag-${ev.type}">${ev.label}</span></td>
    </tr>`;
  }).join('');
}

function applyIpoFilter() {
  const el = document.getElementById('ipo-schedule-list');
  const countEl = document.getElementById('ipo-count');
  const filtered = IPO_FILTER === 'all' ? ALL_IPO_EVENTS : ALL_IPO_EVENTS.filter((ev) => ev.type === IPO_FILTER);
  renderIpoEvents(el, filtered);
  if (countEl) countEl.textContent = `일정: ${filtered.length}개`;
}

function setupIpoFilter() {
  const row = document.getElementById('ipo-filter-row');
  if (!row) return;
  row.querySelectorAll('[data-ipo-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      row.querySelectorAll('[data-ipo-filter]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      IPO_FILTER = btn.getAttribute('data-ipo-filter');
      applyIpoFilter();
    });
  });
}

async function loadIpoSchedule() {
  const el = document.getElementById('ipo-schedule-list');
  try {
    const { data, error } = await db
      .from('ipo_schedule')
      .select('*');
    if (error) throw error;

    ALL_IPO_EVENTS = buildIpoEvents(data || []);
    applyIpoFilter();
  } catch (err) {
    console.error('공모주 일정', err);
    const msg = (err && err.message) ? err.message : String(err);
    el.innerHTML = `<tr><td colspan="4" class="list-empty">⚠ 공모주 일정 실패: ${escapeHtml(msg)}</td></tr>`;
  }
}

// ---------- 리서치센터 ----------
async function loadResearchReports() {
  const el = document.getElementById('research-list');
  if (!el) return;
  try {
    const { data, error } = await db
      .from('research_reports')
      .select('id, title, summary, file_url, file_name')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = '<div class="list-empty">등록된 리서치 자료가 없습니다.</div>';
      return;
    }

    el.innerHTML = data.map((r, i) => {
      const titleInner = escapeHtml(r.title);
      const titleHtml = r.file_url
        ? `<a class="research-title" href="${escapeHtml(r.file_url)}" target="_blank" rel="noopener">${titleInner}</a>`
        : `<div class="research-title">${titleInner}</div>`;
      return `
        <div class="research-card">
          <div class="research-kicker">No.${i + 1}</div>
          ${titleHtml}
          <div class="research-desc">${escapeHtml(r.summary)}</div>
        </div>`;
    }).join('');
  } catch (err) {
    showError(el, '리서치센터', err);
  }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
  setupIpoFilter();
  loadFinancialNews();
  loadIndicators();
  loadIpoNews();
  loadIpoSchedule();
  loadResearchReports();
});
