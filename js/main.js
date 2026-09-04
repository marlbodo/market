// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용
console.log('%c[market] main.js v2026-09-04-r (마지막 업데이트 표시)', 'color:#16305c;font-weight:bold');

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

// ---------- 마지막 업데이트 표시 ----------
// rows: DB에서 가져온 배열, fields: 우선순위대로 확인할 타임스탬프 컬럼명들
// 배열/컬럼에서 값을 못 찾으면 현재 시각(페이지 로드 시각)으로 대체 표시
function getMaxTimestamp(rows, fields = ['updated_at', 'created_at']) {
  if (!rows || rows.length === 0) return null;
  let max = null;
  rows.forEach((row) => {
    fields.forEach((f) => {
      const v = row[f];
      if (v && (!max || v > max)) max = v;
    });
  });
  return max;
}

function setLastUpdated(elementId, timestamp) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const d = timestamp ? new Date(timestamp) : new Date();
  const formatted = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

  const CLOCK_ICON = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="6.5"/><path d="M9 5.5V9l3 1.7"/></svg>';
  el.innerHTML = `${CLOCK_ICON}마지막 업데이트: ${formatted}`;
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
    setLastUpdated('news-updated', getMaxTimestamp(data, ['created_at']));
  } catch (err) {
    showError(el, '채권·금리 뉴스', err);
  }
}

// ---------- 주요지표 정렬 순서 ----------
const RATE_ORDER = [
  '기준금리', 'CD', '산금6M', '산금1Y', '은행AA+1Y',
  '국고3Y', '국고5Y', '국고10Y', '공사3Y', '공사5Y',
  'Fed금리',
];

// DB에는 계속 쌓이지만(수집은 유지) 메인 화면 표에는 표시하지 않을 지표
const HIDDEN_INDICATORS = new Set(['미국 10Y']);
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
    // created_at이 있다면 함께 가져와 "마지막 업데이트" 시각으로 활용
    const { data: latestRows, error: latestErr } = await db
      .from('interest_rates')
      .select('indicator, date, value, created_at')
      .order('date', { ascending: false })
      .limit(60);
    if (latestErr) throw latestErr;

    if (!latestRows || latestRows.length === 0) {
      el.innerHTML = '<tr><td colspan="5" class="list-empty">지표 데이터가 아직 없습니다.</td></tr>';
      if (dateThEl) dateThEl.textContent = '금리';
      setLastUpdated('rate-updated', null);
      return;
    }

    const currentByIndicator = {};
    latestRows.forEach((row) => {
      if (!currentByIndicator[row.indicator]) currentByIndicator[row.indicator] = row; // 먼저 나온(=가장 최신) 것만 유지
    });
    const indicatorList = Object.entries(currentByIndicator)
      .filter(([name]) => !HIDDEN_INDICATORS.has(name)); // 화면에 숨길 지표 제외 (DB엔 그대로 남음)

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

    // created_at 컬럼이 있으면 그 값을, 없으면 페이지 로드 시각을 표시
    setLastUpdated('rate-updated', getMaxTimestamp(latestRows, ['created_at']));
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
    setLastUpdated('ipo-news-updated', getMaxTimestamp(data, ['created_at']));
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
      events.push({ ...base, date: r.demand_forecast_start_date, type: 'forecast', label: '수요예측', note: '' });
    }

    // 청약 시작만 표시 (기관경쟁률 · 확약률)
    if (r.subscription_start_date && r.subscription_start_date >= TODAY) {
      const subNoteParts = [];
      const inst = formatRatio(r.institutional_competition_rate, ':1');
      const lockup = formatPercent(r.lockup_commitment_ratio);
      if (inst) subNoteParts.push(`기관경쟁률 ${inst}`);
      if (lockup) subNoteParts.push(`확약률 ${lockup}`);
      events.push({ ...base, date: r.subscription_start_date, type: 'subscription', label: '청약', note: subNoteParts.join(' · ') });
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
    // ipo_history는 2006년부터 쌓이는 이력 테이블이라 전체를 다 가져오면 무거우므로,
    // "아직 지나지 않은 일정을 하나라도 가진 행"만 서버에서 걸러서 가져온다.
    // (실제 표시 여부는 이전과 동일하게 buildIpoEvents에서 date >= TODAY로 다시 필터링)
    const { data, error } = await db
      .from('ipo_history')
      .select('*')
      .or(`listing_date.is.null,listing_date.gte.${TODAY},subscription_end_date.gte.${TODAY},demand_forecast_end_date.gte.${TODAY}`);
    if (error) throw error;

    ALL_IPO_EVENTS = buildIpoEvents(data || []);
    applyIpoFilter();

    // updated_at/created_at 컬럼이 존재하면 그 값을, 없으면 페이지 로드 시각을 표시
    setLastUpdated('ipo-schedule-updated', getMaxTimestamp(data, ['updated_at', 'created_at']));
  } catch (err) {
    console.error('공모주 일정', err);
    const msg = (err && err.message) ? err.message : String(err);
    el.innerHTML = `<tr><td colspan="4" class="list-empty">⚠ 공모주 일정 실패: ${escapeHtml(msg)}</td></tr>`;
  }
}

// ---------- 리서치센터 ----------
function renderResearchCards(el, data) {
  el.innerHTML = data.map((r, i) => {
    const titleInner = escapeHtml(r.title);
    const hasFile = !!r.file_url;
    const titleHtml = hasFile
      ? `<a class="research-title" href="${escapeHtml(r.file_url)}" target="_blank" rel="noopener" download>${titleInner}</a>`
      : `<div class="research-title">${titleInner}</div>`;
    const downloadBtn = hasFile
      ? `<a class="research-download-btn" href="${escapeHtml(r.file_url)}" target="_blank" rel="noopener" download>파일 열기</a>`
      : '';
    const summaryText = escapeHtml(truncateText(r.summary, 100));
    return `
      <div class="research-card">
        <div class="research-card-head">
          <div class="research-kicker">No.${i + 1} · ${formatDateTimeFull(r.created_at)}</div>
          ${downloadBtn}
        </div>
        ${titleHtml}
        <div class="research-desc">${summaryText}</div>
      </div>`;
  }).join('');
}

async function loadResearchReports() {
  const el = document.getElementById('research-list');
  if (!el) return;
  try {
    const { data, error } = await db
      .from('research_reports')
      .select('id, title, summary, file_url, file_name, created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = '<div class="list-empty">등록된 리서치 자료가 없습니다.</div>';
      return;
    }

    renderResearchCards(el, data);
  } catch (err) {
    showError(el, '리서치센터', err);
  }
}

// ---------- init ----------
// ---------- 헤더 여의도 날씨 (Open-Meteo, API 키 불필요) ----------
const WEATHER_CODE_INFO = {
  0: ['☀️', '맑음'], 1: ['🌤️', '대체로 맑음'], 2: ['⛅', '구름 조금'], 3: ['☁️', '흐림'],
  45: ['🌫️', '안개'], 48: ['🌫️', '안개'],
  51: ['🌦️', '이슬비'], 53: ['🌦️', '이슬비'], 55: ['🌦️', '이슬비'],
  61: ['🌧️', '비'], 63: ['🌧️', '비'], 65: ['🌧️', '강한 비'],
  71: ['🌨️', '눈'], 73: ['🌨️', '눈'], 75: ['❄️', '많은 눈'],
  80: ['🌦️', '소나기'], 81: ['🌦️', '소나기'], 82: ['⛈️', '강한 소나기'],
  95: ['⛈️', '뇌우'], 96: ['⛈️', '뇌우'], 99: ['⛈️', '뇌우'],
};
function weatherCodeInfo(code) {
  return WEATHER_CODE_INFO[code] || ['🌡️', ''];
}
function weatherComment(temp, code) {
  if ([95, 96, 99].includes(code)) return '천둥 조심하세요';
  if ([61, 63, 65, 80, 81, 82].includes(code)) return '우산 챙기세요';
  if ([71, 73, 75].includes(code)) return '눈길 조심하세요';
  if (temp >= 30) return '푹푹 찌네요';
  if (temp >= 25) return '완연한 더위';
  if (temp >= 18) return '나들이 좋은 날씨';
  if (temp >= 10) return '선선하네요';
  if (temp >= 0) return '쌀쌀해요';
  return '패딩 필수';
}
async function loadWeather() {
  const el = document.getElementById('weather-widget');
  if (!el) return;
  try {
    const res = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=37.5219&longitude=126.9245' +
      '&current=temperature_2m,weather_code&timezone=Asia%2FSeoul'
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code;
    const [emoji, label] = weatherCodeInfo(code);
    const comment = weatherComment(temp, code);
    el.innerHTML =
      `<span class="w-emoji">${emoji}</span>여의도 <span class="w-temp">${temp}°C</span> ${label}` +
      `<span class="w-comment">· ${comment}</span>`;
  } catch (err) {
    console.error('날씨 정보를 불러오지 못했습니다', err);
    el.textContent = ''; // 실패해도 조용히 숨김 (핵심 기능이 아니므로 에러 노출 안 함)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupIpoFilter();
  loadFinancialNews();
  loadIndicators();
  loadIpoNews();
  loadIpoSchedule();
  loadResearchReports();
  loadWeather();
});
