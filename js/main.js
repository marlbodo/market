// helpers.js에 정의된 formatDateShort, formatDateFull, formatNumber, escapeHtml, renderNewsList 사용
console.log('%c[market] main.js v2026-09-10-r (모바일 날짜/시간 표시 정리)', 'color:#16305c;font-weight:bold');

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
function firstOfMonth(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function firstOfYear(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getFullYear()}-01-01`;
}

function showError(el, label, err) {
  console.error(label, err);
  const msg = (err && err.message) ? err.message : String(err);
  el.innerHTML = `<div class="list-empty">⚠ ${label} 실패: ${escapeHtml(msg)}</div>`;
}

// ---------- 마지막 업데이트 표시 ----------
// 메인 페이지는 "오늘" 기준 최신 데이터만 다루므로 날짜는 생략하고 시:분만 표시
// (모바일 폭이 좁을 때 "2026. 09. 09. 18:30" 같은 긴 문자열이 줄바꿈되며 깨지는 문제 해결)
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

// 주요금리 패널 전용: 한국(엑셀)과 미국(FRED)의 원천/입수 시각이 서로 다르므로 두 줄로 나눠 표시.
// 예) 한국: 09.11. 18:30 기준 / 미국: 09.12. 05:30 기준
function fmtShortDateTime(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('month')}.${get('day')}. ${get('hour')}:${get('minute')}`;
}
function setRateLastUpdated(krTimestamp, usTimestamp) {
  const el = document.getElementById('rate-updated');
  if (!el) return;
  const CLOCK_ICON = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="6.5"/><path d="M9 5.5V9l3 1.7"/></svg>';
  el.classList.add('last-updated-dual');
  el.innerHTML =
    `<div class="last-updated-row">${CLOCK_ICON}한국: ${fmtShortDateTime(krTimestamp)} 기준 <span class="rate-source-note">· 엑셀</span></div>` +
    `<div class="last-updated-row">${CLOCK_ICON}미국: ${fmtShortDateTime(usTimestamp)} 기준 <span class="rate-source-note">· 美 재무부·FRED</span></div>`;
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
    // 메인 페이지 뉴스 목록은 시:분만 표시 (renderNewsList에 timeOnly 옵션 전달, helpers.js 참고)
    renderNewsList(el, data, { timeOnly: true });
    setLastUpdated('news-updated', getMaxTimestamp(data, ['created_at']));
  } catch (err) {
    showError(el, '채권·금리 뉴스', err);
  }
}

// ---------- 주요지표 정렬 순서 ----------
const RATE_ORDER = [
  '기준금리', 'CD', '산금6M', '산금1Y', '산금2Y', '은행AA+1Y',
  '국고3Y', '국고5Y', '국고10Y', '공사3Y', '공사5Y', '공사7Y',
  'Fed금리', '미국2Y', '미국10Y',
];

// 미국 국채금리(2Y·10Y)와 Fed금리는 2026-09-12부터 FRED API 자동 수집으로 전환되어 신뢰도 문제가
// 해소되었으므로 더 이상 숨기지 않는다. (과거엔 엑셀 수기 입력값이라 '미국 10Y'를 숨겨왔음)
const HIDDEN_INDICATORS = new Set([]);

// 미국 국채금리/Fed금리는 FRED에서, 그 외는 엑셀에서 들어오므로 "마지막 업데이트" 시각을
// 두 그룹으로 나눠서 각각 계산한다 (setRateLastUpdated 참고).
const US_RATE_INDICATORS = new Set(['미국 10Y', '미국 2Y', 'Fed 금리(상단)']);

const TREASURY_SOURCED_INDICATORS = new Set(['미국 10Y', '미국 2Y']);
const FRED_SOURCED_INDICATORS = new Set(['Fed 금리(상단)']);

// 미국10Y·Fed금리(상단)는 엑셀 임포트가 재무부/FRED보다 먼저 그날 값을 써넣을 수 있는데, 그 값은
// updated_at이 비어있는 엑셀발 미검증 값이다. 공식 소스가 그 날짜를 확정(overwrite)하기 전까지는
// "최신값"으로 채택하지 않는다 (미국2Y는 엑셀에 없던 신규 지표라 해당 없음).
const STALE_GUARDED_INDICATORS = new Set(['미국 10Y', 'Fed 금리(상단)']);

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
    const { data: latestRows, error: latestErr } = await db
      .from('interest_rates')
      .select('indicator, date, value, created_at, updated_at')
      .order('date', { ascending: false })
      .limit(60);
    if (latestErr) throw latestErr;

    if (!latestRows || latestRows.length === 0) {
      el.innerHTML = '<tr><td colspan="5" class="list-empty">지표 데이터가 아직 없습니다.</td></tr>';
      if (dateThEl) dateThEl.textContent = '금리';
      setRateLastUpdated(null, null);
      return;
    }

    const currentByIndicator = {};
    latestRows.forEach((row) => {
      if (currentByIndicator[row.indicator]) return;
      // 엑셀이 FRED보다 먼저 써넣은 미검증 값(updated_at 없음)은 최신값 후보에서 제외
      if (STALE_GUARDED_INDICATORS.has(row.indicator) && !row.updated_at) return;
      currentByIndicator[row.indicator] = row;
    });
    const indicatorList = Object.entries(currentByIndicator)
      .filter(([name]) => !HIDDEN_INDICATORS.has(name));

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

    const rows_html = results.map((r) => {
      const sourceBadge = TREASURY_SOURCED_INDICATORS.has(r.name)
        ? ' <span class="rate-source-badge" title="미 재무부(Treasury.gov) 공식 종가 기준. 하루 한 번 발표되며 실시간 장중 시세와는 다를 수 있습니다.">美 재무부</span>'
        : FRED_SOURCED_INDICATORS.has(r.name)
        ? ' <span class="rate-source-badge" title="FRED(세인트루이스 연준) 기준. FOMC 회의가 있을 때만 실제로 바뀝니다.">FRED</span>'
        : '';
      return `
      <tr>
        <td class="rate-td-name">${escapeHtml(r.name)}${sourceBadge}</td>
        <td class="rate-td-value">${Number(r.current.value).toFixed(3)}</td>
        ${deltaTd(r.current, r.dayRow)}
        ${deltaTd(r.current, r.monthRow)}
        ${deltaTd(r.current, r.yearRow)}
      </tr>`;
    }).join('');

    const latestDate = indicatorList.reduce((max, [, row]) => (row.date > max ? row.date : max), indicatorList[0][1].date);
    if (dateThEl) dateThEl.textContent = formatDateShort(latestDate);

    el.innerHTML = rows_html || '<tr><td colspan="5" class="list-empty">지표 데이터가 아직 없습니다.</td></tr>';

    // 한국(엑셀) 지표는 created_at, 미국(FRED) 지표는 updated_at 기준으로 각각 "마지막 업데이트" 계산
    let krTs = null;
    let usTs = null;
    Object.entries(currentByIndicator).forEach(([name, row]) => {
      if (US_RATE_INDICATORS.has(name)) {
        if (row.updated_at && (!usTs || row.updated_at > usTs)) usTs = row.updated_at;
      } else {
        if (row.created_at && (!krTs || row.created_at > krTs)) krTs = row.created_at;
      }
    });
    setRateLastUpdated(krTs, usTs);
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
    renderNewsList(el, data, { timeOnly: true });
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
  return `${Number(n).toFixed(2)}%`;
}

function buildIpoEvents(rows) {
  const events = [];

  rows.forEach((r) => {
    const base = { stock: r.stock_name, amount: r.offering_amount_eok };

    if (r.demand_forecast_start_date && r.demand_forecast_start_date >= TODAY) {
      events.push({ ...base, date: r.demand_forecast_start_date, type: 'forecast', label: '수요예측', note: '' });
    }

    if (r.subscription_start_date && r.subscription_start_date >= TODAY) {
      const subNoteParts = [];
      const inst = formatRatio(r.institutional_competition_rate, ':1');
      const lockup = formatPercent(r.lockup_commitment_ratio);
      if (inst) subNoteParts.push(`기관경쟁률 ${inst}`);
      if (lockup) subNoteParts.push(`확약률 ${lockup}`);
      events.push({ ...base, date: r.subscription_start_date, type: 'subscription', label: '청약', note: subNoteParts.join(' · ') });
    }

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
      <td class="ipo-td-date"${titleAttr}>${formatDateShort(ev.date)}</td>
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
      .from('ipo_history')
      .select('*')
      .or(`listing_date.is.null,listing_date.gte.${TODAY},subscription_end_date.gte.${TODAY},demand_forecast_end_date.gte.${TODAY}`);
    if (error) throw error;

    ALL_IPO_EVENTS = buildIpoEvents(data || []);
    applyIpoFilter();

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

// ---------- AI 인사이트 (매일 새벽 자동 생성된 AI 기사 2편) ----------
// 항목이 항상 같은 시각(예: 매일 08:00)에 함께 갱신되므로, 시각은 패널 헤더에 한 번만
// 표시하고 각 항목에서는 제거함 (모바일에서 제목이 3줄까지 늘어지는 문제 해결)
const AI_INSIGHT_LABELS = { bond: '채권·금리', ipo: '공모주(IPO)' };

function formatDateTimeDot(iso) {
  // "2026-09-10T08:00:00+00:00" -> "2026.09.10. 08:00" (KST 고정)
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}.${get('month')}.${get('day')}. ${get('hour')}:${get('minute')}`;
}

async function loadAiInsights() {
  const el = document.getElementById('ai-insight-list');
  const updatedEl = document.getElementById('ai-insight-updated');
  if (!el) return;
  try {
    const { data, error } = await db
      .from('ai_news_articles')
      .select('type, article_date, title, updated_at')
      .order('article_date', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(10);
    if (error) throw error;

    const latestByType = {};
    (data || []).forEach((row) => {
      if (!latestByType[row.type]) latestByType[row.type] = row;
    });

    const items = ['bond', 'ipo'].map((type) => latestByType[type]).filter(Boolean);

    if (items.length === 0) {
      el.innerHTML = '<div class="list-empty">오늘의 AI 브리핑이 아직 준비되지 않았습니다.</div>';
      if (updatedEl) updatedEl.textContent = '';
      return;
    }

    el.innerHTML = items
      .map((row) => {
        return `
        <div class="ai-insight-row">
          <span class="ai-insight-tag ${row.type}">${escapeHtml(AI_INSIGHT_LABELS[row.type] || row.type)}</span>
          <a class="ai-insight-title" href="#" data-type="${row.type}">${escapeHtml(row.title)}</a>
        </div>`;
      })
      .join('');

    if (updatedEl) {
      const latestTs = getMaxTimestamp(items, ['updated_at']);
      updatedEl.textContent = latestTs ? `${formatDateTimeDot(latestTs)} 업데이트` : '';
    }

    el.querySelectorAll('.ai-insight-title').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const type = link.getAttribute('data-type');
        openCentered(`pages/ai-article.html?type=${type}`, 'aiInsight-' + type, 760, 900);
      });
    });

    const askBtn = document.getElementById('ai-ask-btn');
    if (askBtn && !askBtn.dataset.bound) {
      askBtn.dataset.bound = '1';
      askBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openCentered(askBtn.getAttribute('href'), 'aiAsk', 760, 900);
      });
    }
  } catch (err) {
    showError(el, 'AI 인사이트', err);
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
      `<div class="w-line1">여의도</div>` +
      `<div class="w-line2"><span class="w-emoji">${emoji}</span><span class="w-temp">${temp}°C</span> ${label}` +
      `<span class="w-comment"> · ${comment}</span></div>`;
  } catch (err) {
    console.error('날씨 정보를 불러오지 못했습니다', err);
    el.textContent = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupIpoFilter();
  loadAiInsights();
  loadFinancialNews();
  loadIndicators();
  loadIpoNews();
  loadIpoSchedule();
  loadResearchReports();
  loadWeather();
});
