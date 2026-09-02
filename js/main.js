<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>공모주 일정 전체보기 — 데일리 마켓 브리핑</title>
<link rel="stylesheet" href="../css/style.css">
<style>
  body { background: var(--bg-subtle); }
  .popup-wrap { max-width: 720px; margin: 0 auto; padding: 20px 20px 40px; }
  .popup-head {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 14px; margin-bottom: 12px; border-bottom: 2px solid var(--text);
  }
  .popup-head h1 { font-size: 16px; margin: 0; }
  .popup-close { font-size: 12.5px; color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--radius-s); padding: 4px 10px; }

  .detail-table { width: 100%; border-collapse: collapse; border: 1px solid var(--border-strong); background: var(--bg); }
  .detail-table th, .detail-table td {
    border: 1px solid var(--border);
    padding: 8px 8px;
    font-size: 12px;
    vertical-align: top;
  }
  .detail-table thead th {
    background: var(--bg-subtle);
    font-weight: 700;
    color: var(--text-muted);
    font-size: 11px;
    text-align: center;
  }
  .detail-table th:nth-child(1), .detail-table td:nth-child(1) { width: 15%; white-space: nowrap; text-align: center; color: var(--text-muted); }
  .detail-table th:nth-child(2), .detail-table td:nth-child(2) { width: 20%; font-weight: 700; }
  .detail-table th:nth-child(3), .detail-table td:nth-child(3) { width: 13%; white-space: nowrap; text-align: right; color: var(--text-muted); }
  .detail-table th:nth-child(4), .detail-table td:nth-child(4) { width: 16%; text-align: center; }
  .detail-table th:nth-child(5), .detail-table td:nth-child(5) { width: 36%; color: var(--text-muted); }

  .detail-table tbody tr:nth-child(even) td { background: var(--bg-zebra); }
  .detail-table tbody tr:hover td { background: var(--bg-hover); }
</style>
</head>
<body>
  <div class="popup-wrap">
    <div class="popup-head">
      <h1>공모주 일정 전체보기 (오늘 이후)</h1>
      <button class="popup-close" onclick="window.close()">닫기</button>
    </div>

    <div class="tag-legend" id="detail-filter-row">
      <button class="ipo-filter-btn is-active" data-ipo-filter="all">전체</button>
      <button class="ipo-filter-btn" data-ipo-filter="forecast">수요예측</button>
      <button class="ipo-filter-btn" data-ipo-filter="subscription">청약</button>
      <button class="ipo-filter-btn" data-ipo-filter="listing">상장</button>
      <span class="ipo-count" id="detail-count">일정: -</span>
    </div>

    <table class="detail-table">
      <thead>
        <tr>
          <th>일자</th>
          <th>종목명</th>
          <th>공모금액</th>
          <th>구분</th>
          <th>비고</th>
        </tr>
      </thead>
      <tbody id="detail-body">
        <tr><td colspan="5" class="list-loading">일정을 불러오는 중…</td></tr>
      </tbody>
    </table>
  </div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="../js/supabase-client.js"></script>
<script src="../js/helpers.js"></script>
<script>
  const TODAY = new Date().toISOString().slice(0, 10);
  let ALL_DETAIL_EVENTS = [];
  let DETAIL_FILTER = 'all';

  function dowKo(dateStr) {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return days[new Date(`${dateStr}T00:00:00`).getDay()];
  }
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

  // 메인 화면과 달리, 모든 이벤트(수요예측 시작/마감, 청약 시작/마감, 상장)를 다 보여줌
  function buildAllIpoEvents(rows) {
    const events = [];

    rows.forEach((r) => {
      const base = { stock: r.stock_name, amount: r.offering_amount_eok };

      if (r.demand_forecast_start_date && r.demand_forecast_start_date >= TODAY) {
        events.push({ ...base, date: r.demand_forecast_start_date, type: 'forecast', label: '수요예측 시작', note: '' });
      }
      if (r.demand_forecast_end_date && r.demand_forecast_end_date >= TODAY) {
        events.push({ ...base, date: r.demand_forecast_end_date, type: 'forecast', label: '수요예측 마감', note: '' });
      }

      const rateNoteParts = [];
      const inst = formatRatio(r.institutional_competition_rate, ':1');
      const lockup = formatPercent(r.lockup_commitment_ratio);
      if (inst) rateNoteParts.push(`기관경쟁률 ${inst}`);
      if (lockup) rateNoteParts.push(`확약률 ${lockup}`);
      const rateNote = rateNoteParts.join(' · ');

      if (r.subscription_start_date && r.subscription_start_date >= TODAY) {
        events.push({ ...base, date: r.subscription_start_date, type: 'subscription', label: '청약 시작', note: rateNote });
      }
      if (r.subscription_end_date && r.subscription_end_date >= TODAY) {
        events.push({ ...base, date: r.subscription_end_date, type: 'subscription', label: '청약 마감', note: rateNote });
      }

      if (r.listing_date && r.listing_date >= TODAY) {
        const listNoteParts = [];
        const inst2 = formatRatio(r.institutional_competition_rate, ':1');
        const lockup2 = formatPercent(r.lockup_commitment_ratio);
        const sub2 = formatRatio(r.subscription_competition_rate, ':1');
        if (inst2) listNoteParts.push(`기관경쟁률 ${inst2}`);
        if (lockup2) listNoteParts.push(`확약률 ${lockup2}`);
        if (sub2) listNoteParts.push(`청약(개인)경쟁률 ${sub2}`);
        events.push({ ...base, date: r.listing_date, type: 'listing', label: '상장', note: listNoteParts.join(' · ') });
      }
    });

    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.stock.localeCompare(b.stock, 'ko');
    });
    return events;
  }

  function renderDetail(el, events) {
    if (events.length === 0) {
      el.innerHTML = '<tr><td colspan="5" class="list-empty">해당하는 일정이 없습니다.</td></tr>';
      return;
    }
    el.innerHTML = events.map((ev) => `
      <tr>
        <td>${formatDateFull(ev.date)}(${dowKo(ev.date)})</td>
        <td>${escapeHtml(ev.stock)}</td>
        <td>${formatEok(ev.amount)}</td>
        <td><span class="event-tag tag-${ev.type}">${ev.label}</span></td>
        <td>${ev.note ? escapeHtml(ev.note) : '-'}</td>
      </tr>`).join('');
  }

  function applyDetailFilter() {
    const el = document.getElementById('detail-body');
    const countEl = document.getElementById('detail-count');
    const filtered = DETAIL_FILTER === 'all' ? ALL_DETAIL_EVENTS : ALL_DETAIL_EVENTS.filter((ev) => ev.type === DETAIL_FILTER);
    renderDetail(el, filtered);
    if (countEl) countEl.textContent = `일정: ${filtered.length}개`;
  }

  document.getElementById('detail-filter-row').querySelectorAll('[data-ipo-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#detail-filter-row [data-ipo-filter]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      DETAIL_FILTER = btn.getAttribute('data-ipo-filter');
      applyDetailFilter();
    });
  });

  (async function () {
    const el = document.getElementById('detail-body');
    try {
      const { data, error } = await db.from('ipo_schedule').select('*');
      if (error) throw error;
      ALL_DETAIL_EVENTS = buildAllIpoEvents(data || []);
      applyDetailFilter();
    } catch (err) {
      console.error(err);
      el.innerHTML = `<tr><td colspan="5" class="list-empty">⚠ 불러오기 실패: ${escapeHtml(err.message || String(err))}</td></tr>`;
    }
  })();
</script>
</body>
</html>
