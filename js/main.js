// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용

const TODAY = new Date().toISOString().slice(0, 10);

// ---------- 날짜 유틸 ----------
function addMonths(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setMonth(d.getMonth() + delta);
  return d.toISOString().slice(0, 10);
}
function addYears(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setFullYear(d.getFullYear() + delta);
  return d.toISOString().slice(0, 10);
}
function dayGap(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00`);
  const b = new Date(`${dateB}T00:00:00`);
  return Math.round((a - b) / 86400000);
}
function dowKo(dateStr) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return days[new Date(`${dateStr}T00:00:00`).getDay()];
}
// rows는 날짜 내림차순 정렬 상태. targetDate 이하인 것 중 가장 최근 것을 찾음
function findOnOrBefore(rows, targetDate) {
  for (const r of rows) {
    if (r.date <= targetDate) return r;
  }
  return null;
}

// ---------- 최신 채권·금리 뉴스 ----------
async function loadFinancialNews() {
  const el = document.getElementById('news-list');
  const { data, error } = await db
    .from('financial_news')
    .select('id, title, summary, link, article_published_at, created_at')
    .order('article_published_at', { ascending: false })
    .limit(8);

  if (error) {
    console.error(error);
    el.innerHTML = '<li class="list-empty">뉴스를 불러오지 못했습니다.</li>';
    return;
  }
  renderNewsList(el, data);
}

// ---------- 주요지표 현황 (전일·전월·전년 대비) ----------
function deltaCell(label, base, compareRow) {
  if (!compareRow) {
    return `<div class="rate-delta"><div class="label">${label}</div><div class="val">-</div></div>`;
  }
  const diff = Number(base.value) - Number(compareRow.value);
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const sign = diff > 0 ? '+' : '';
  return `<div class="rate-delta ${dir}"><div class="label">${label}</div><div class="val">${sign}${diff.toFixed(2)}</div></div>`;
}

async function loadIndicators() {
  const el = document.getElementById('rate-list');
  const { data, error } = await db
    .from('interest_rates')
    .select('indicator, date, value')
    .order('date', { ascending: false })
    .limit(2000);

  if (error || !data || data.length === 0) {
    console.error(error);
    el.innerHTML = '<div class="list-empty">지표 데이터가 없습니다.</div>';
    return;
  }

  const byIndicator = {};
  data.forEach((row) => {
    if (!byIndicator[row.indicator]) byIndicator[row.indicator] = [];
    byIndicator[row.indicator].push(row);
  });

  const cards = Object.entries(byIndicator).map(([name, rows]) => {
    const current = rows[0];
    const dayRow = rows[1] || null;
    const dayLabel = dayRow && dayGap(current.date, dayRow.date) > 3
      ? `${dayGap(current.date, dayRow.date)}일전대비`
      : '전일대비';

    const monthTarget = addMonths(current.date, -1);
    const monthRow = findOnOrBefore(rows.slice(1), monthTarget);

    const yearTarget = addYears(current.date, -1);
    const yearRow = findOnOrBefore(rows.slice(1), yearTarget);

    return `
      <div class="rate-card">
        <div class="rate-top">
          <span class="rate-name">${escapeHtml(name)}</span>
          <span class="rate-value">${Number(current.value).toFixed(2)}%</span>
        </div>
        <div class="rate-deltas">
          ${deltaCell(dayLabel, current, dayRow)}
          ${deltaCell('전월대비', current, monthRow)}
          ${deltaCell('전년대비', current, yearRow)}
        </div>
        <div class="rate-date">${formatDateFull(current.date)} 기준</div>
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

// ---------- 공모주 일정: 오늘 이후 모든 일정(수요예측/청약/상장) ----------
function buildIpoEvents(rows) {
  const events = [];

  rows.forEach((r) => {
    // 수요예측
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

    // 청약
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

    // 상장
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
  const { data, error } = await db
    .from('ipo_schedule')
    .select('*');

  if (error || !data) {
    console.error(error);
    el.innerHTML = '<div class="list-empty">공모주 일정을 불러오지 못했습니다.</div>';
    return;
  }

  const events = buildIpoEvents(data);
  renderIpoEvents(el, events);
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
