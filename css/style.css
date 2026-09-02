// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용

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
// 기준일이 속한 달의 "전월 말일" (예: 2026-09-01 → 2026-08-31)
function prevMonthEnd(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const eom = new Date(d.getFullYear(), d.getMonth(), 0); // day 0 = 이전 달 마지막 날
  return eom.toISOString().slice(0, 10);
}
// 기준일이 속한 연도의 "전년도 12월 31일"
function prevYearEnd(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getFullYear() - 1}-12-31`;
}
// rows는 날짜 내림차순 정렬 상태. targetDate 이하인 것 중 가장 최근(=가장 가까운) 것을 찾음
function findOnOrBefore(rows, targetDate) {
  for (const r of rows) {
    if (r.date <= targetDate) return r;
  }
  return null;
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

// ---------- 주요지표 현황 (전일·전월말·전년말 대비, 압축형 한 줄) ----------
function inlineDelta(label, base, compareRow) {
  if (!compareRow) return `<span class="d">${label} -</span>`;
  const diff = Number(base.value) - Number(compareRow.value);
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  return `<span class="d ${dir}">${label} ${arrow}${Math.abs(diff).toFixed(2)}</span>`;
}

async function loadIndicators() {
  const el = document.getElementById('rate-list');
  try {
    const { data, error } = await db
      .from('interest_rates')
      .select('indicator, date, value')
      .order('date', { ascending: false })
      .limit(2000);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = '<div class="list-empty">지표 데이터가 아직 없습니다.</div>';
      return;
    }

    const byIndicator = {};
    data.forEach((row) => {
      if (!byIndicator[row.indicator]) byIndicator[row.indicator] = [];
      byIndicator[row.indicator].push(row);
    });

    const rows_html = Object.entries(byIndicator).map(([name, rows]) => {
      const current = rows[0];
      const dayRow = rows[1] || null;

      const monthTarget = prevMonthEnd(current.date);
      const monthRow = findOnOrBefore(rows.slice(1), monthTarget);

      const yearTarget = prevYearEnd(current.date);
      const yearRow = findOnOrBefore(rows.slice(1), yearTarget);

      return `
        <div class="rate-row">
          <div class="rate-name-cell">
            <span class="name">${escapeHtml(name)}</span>
            <span class="date">(${formatDateShort(current.date)})</span>
          </div>
          <div class="rate-value-cell">${Number(current.value).toFixed(2)}</div>
          <div class="rate-deltas-inline">
            ${inlineDelta('일', current, dayRow)}
            ${inlineDelta('월', current, monthRow)}
            ${inlineDelta('년', current, yearRow)}
          </div>
        </div>`;
    }).join('');

    el.innerHTML = rows_html
      ? `<div class="rate-legend">일 · 전일대비 / 월 · 전월말대비 / 년 · 전년말대비</div>${rows_html}`
      : '<div class="list-empty">지표 데이터가 아직 없습니다.</div>';
  } catch (err) {
    showError(el, '주요지표', err);
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
