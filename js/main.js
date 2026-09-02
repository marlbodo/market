// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용
console.log('%c[market] main.js v2026-09-02-d (지표별 targeted 조회로 전년대비 수정)', 'color:#16305c;font-weight:bold');

const TODAY = new Date().toISOString().slice(0, 10);

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
  const asofEl = document.getElementById('rate-asof');
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
      if (asofEl) asofEl.textContent = '-';
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
    if (asofEl) asofEl.textContent = `${formatDateFull(latestDate)} 기준`;

    el.innerHTML = rows_html || '<tr><td colspan="5" class="list-empty">지표 데이터가 아직 없습니다.</td></tr>';
  } catch (err) {
    console.error('주요금리', err);
    if (asofEl) asofEl.textContent = '오류';
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
      .limit(6);
    if (error) throw error;
    renderNewsList(el, data);
  } catch (err) {
    showError(el, '공모주 뉴스', err);
  }
}

// ---------- 공모주 일정: 오늘 이후 모든 일정(수요예측/청약/상장) ----------
function buildIpoEvents(rows) {
  const events = [];

  rows.forEach((r) => {
    if (r.demand_forecast_start_date && r.demand_forecast_start_date >= TODAY) {
      events.push({
        date: r.demand_forecast_start_date, type: 'forecast', label: '수요예측 시작',
        stock: r.stock_name,
        sub: r.demand_forecast_end_date ? `~${formatDateFull(r.demand_forecast_end_date)} 마감` : '',
      });
    } else if (r.demand_forecast_end_date && r.demand_forecast_end_date >= TODAY) {
      events.push({
        date: r.demand_forecast_end_date, type: 'forecast', label: '수요예측 마감',
        stock: r.stock_name, sub: '',
      });
    }

    if (r.subscription_start_date && r.subscription_start_date >= TODAY) {
      events.push({
        date: r.subscription_start_date, type: 'subscription', label: '청약 시작',
        stock: r.stock_name,
        sub: r.subscription_end_date ? `~${formatDateFull(r.subscription_end_date)} 마감` : '',
      });
    } else if (r.subscription_end_date && r.subscription_end_date >= TODAY) {
      events.push({
        date: r.subscription_end_date, type: 'subscription', label: '청약 마감',
        stock: r.stock_name, sub: '',
      });
    }

    if (r.listing_date && r.listing_date >= TODAY) {
      let sub = '';
      if (r.confirmed_price) sub = `확정가 ${formatNumber(r.confirmed_price)}원`;
      else if (r.price_band_low && r.price_band_high) sub = `밴드 ${formatNumber(r.price_band_low)}~${formatNumber(r.price_band_high)}원`;
      events.push({ date: r.listing_date, type: 'listing', label: '상장일', stock: r.stock_name, sub });
    }
  });

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.stock.localeCompare(b.stock, 'ko');
  });
  return events;
}

function renderIpoEvents(el, events) {
  if (events.length === 0) {
    el.innerHTML = '<div class="list-empty">예정된 공모주 일정이 없습니다.</div>';
    return;
  }
  let html = '';
  let lastDate = null;
  events.forEach((ev) => {
    if (ev.date !== lastDate) {
      html += `<div class="event-date-head">${formatDateFull(ev.date)} <span class="event-dow">(${dowKo(ev.date)})</span></div>`;
      lastDate = ev.date;
    }
    html += `
      <div class="event-row">
        <span class="event-tag tag-${ev.type}">${ev.label}</span>
        <div class="event-body">
          <span class="event-stock">${escapeHtml(ev.stock)}</span>
          ${ev.sub ? `<span class="event-sub">${escapeHtml(ev.sub)}</span>` : ''}
        </div>
      </div>`;
  });
  el.innerHTML = html;
}

async function loadIpoSchedule() {
  const el = document.getElementById('ipo-schedule-list');
  try {
    const { data, error } = await db
      .from('ipo_schedule')
      .select('*');
    if (error) throw error;

    const events = buildIpoEvents(data || []);
    renderIpoEvents(el, events);
  } catch (err) {
    showError(el, '공모주 일정', err);
  }
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
  loadFinancialNews();
  loadIndicators();
  loadIpoNews();
  loadIpoSchedule();
});
