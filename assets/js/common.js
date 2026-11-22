// 공통 모듈: DOM 헬퍼, API 클라이언트, 아이콘, 대화상자, 방문 집계
// 모든 사용자 입력은 textContent 로만 출력한다. (innerHTML 은 이 파일의 고정 아이콘 문자열에만 사용)
(function () {
  const NS = (window.NS = window.NS || {});
  const CFG = window.NONSENSE;

  // ---------- 저장소 (실패해도 동작) ----------
  const mem = {};
  NS.store = {
    get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return mem["s_" + k] ?? null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { mem["s_" + k] = v; } },
    del(k) { try { sessionStorage.removeItem(k); } catch { delete mem["s_" + k]; } },
  };
  NS.session = ss;

  // ---------- DOM ----------
  NS.h = function (tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const h = NS.h;

  // Lucide 아이콘 (고정 문자열)
  const ICONS = {
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    "thumbs-up": '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
    "thumbs-down": '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
    "message-circle": '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    "share-2": '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    "trash-2": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-up": '<path d="m18 15-6-6-6 6"/>',
    "arrow-left": '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    "corner-down-right": '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
    "trending-up": '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
    "trending-down": '<path d="M16 17h6v-6"/><path d="m22 17-8.5-8.5-5 5L2 7"/>',
    minus: '<path d="M5 12h14"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  };
  NS.icon = function (name, size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon");
    svg.innerHTML = ICONS[name] || "";
    return svg;
  };

  // ---------- 관리자 세션 (탭을 닫으면 사라짐) ----------
  NS.adminToken = function () {
    try {
      const j = JSON.parse(ss.get("nv_admin") || "null");
      if (j && j.token && new Date(j.exp).getTime() > Date.now()) return j.token;
    } catch { /* ignore */ }
    return null;
  };
  NS.isAdmin = () => !!NS.adminToken();
  NS.setAdmin = (token, exp) => ss.set("nv_admin", JSON.stringify({ token, exp }));
  NS.clearAdmin = () => ss.del("nv_admin");

  // ---------- API ----------
  function mkErr(code, status) {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    return e;
  }
  NS.api = async function (path, opt = {}) {
    const headers = {};
    let body;
    if (opt.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opt.json);
    } else if (opt.form) {
      body = opt.form;
    }
    if (opt.admin) {
      const t = NS.adminToken();
      if (t) headers["x-admin-token"] = t;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 15000);
    let res;
    try {
      res = await fetch(CFG.API + path, {
        method: opt.method || (body ? "POST" : "GET"),
        headers, body, signal: ctl.signal, cache: "no-store", credentials: "omit", keepalive: !!opt.keepalive,
      });
    } catch {
      throw mkErr("network", 0);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    if (!res.ok) {
      if (res.status === 401 && opt.admin) NS.clearAdmin();
      throw mkErr((data && data.error) || "http_" + res.status, res.status);
    }
    return data;
  };

  const MSG = {
    network: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    wrong_password: "비밀번호가 일치하지 않습니다.",
    invalid_password: "비밀번호는 4~64자로 입력해 주세요.",
    invalid_nickname: "별명은 1~20자로 입력해 주세요.",
    invalid_title: "제목은 1~100자로 입력해 주세요.",
    invalid_body: "내용을 확인해 주세요. (글 100,000자, 댓글 100,000자 이내)",
    not_found: "존재하지 않거나 볼 수 없는 항목입니다.",
    post_not_available: "삭제되었거나 숨겨진 글에는 댓글이나 답글을 달 수 없습니다.",
    reply_too_deep: "답글이 너무 깊게 이어졌습니다. 원글에 새 글로 써 주세요.",
    has_replies: "답글이 달린 글은 영구 삭제할 수 없습니다. 삭제(숨김)로 처리해 주세요.",
    unsupported_image: "JPG, PNG, GIF, WebP 이미지만 올릴 수 있습니다.",
    invalid_file_size: "이미지는 5MB 이하여야 합니다.",
    too_large: "파일이 너무 큽니다. (5MB 이하)",
    image_already_attached: "이미 첨부된 이미지가 있습니다.",
    unauthorized: "관리자 로그인이 필요합니다.",
    admin_not_configured: "관리자 비밀번호가 아직 설정되지 않았습니다.",
    server_error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  };
  NS.errMsg = (e) => MSG[e && e.code] || "오류가 발생했습니다. (" + ((e && e.code) || "unknown") + ")";

  // ---------- 날짜 (항상 한국시간) ----------
  NS.fmtDate = function (iso, full) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const k = new Date(d.getTime() + 9 * 3600e3);
    const p = (n) => String(n).padStart(2, "0");
    const Y = k.getUTCFullYear(), M = p(k.getUTCMonth() + 1), D = p(k.getUTCDate());
    const hh = p(k.getUTCHours()), mm = p(k.getUTCMinutes());
    if (full) return `${Y}.${M}.${D} ${hh}:${mm}`;
    const n = new Date(Date.now() + 9 * 3600e3);
    if (n.getUTCFullYear() === Y && n.getUTCMonth() + 1 === +M && n.getUTCDate() === +D) return `${hh}:${mm}`;
    if (n.getUTCFullYear() === Y) return `${M}.${D}`;
    return `${Y}.${M}.${D}`;
  };

  // ---------- 투표용 토큰·내 투표 기록 (통계에는 사용하지 않음) ----------
  NS.voterToken = function () {
    let t = NS.store.get("nv_vt");
    if (!t || t.length < 16) {
      const a = new Uint8Array(24);
      crypto.getRandomValues(a);
      t = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
      NS.store.set("nv_vt", t);
    }
    return t;
  };
  function votes() { try { return JSON.parse(NS.store.get("nv_votes") || "{}") || {}; } catch { return {}; } }
  NS.myVote = (key) => votes()[key] || 0;
  NS.setMyVote = function (key, v) {
    const m = votes();
    delete m[key];
    if (v) m[key] = v;
    const keys = Object.keys(m);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete m[k];
    NS.store.set("nv_votes", JSON.stringify(m));
  };

  // ---------- 이모지 (PC 전용 😀 버튼. 모바일은 키보드 자체 이모지를 쓴다) ----------
  const EMOJIS = ["😀","😂","🤣","😊","😍","😘","😎","🤔","😅","😭","😡","🥲","😴","🤯","🥳","😇","🙄","😏","😱","🤪","🥺","😤","🤗","🤮",
    "👍","👎","👏","🙏","💪","🤝","✌️","🙌","👀","🔥","💯","✨","💩","💀","👻","😈","❤️","💔","💜","🎉","🍜","🍺","☕","🍕","🐶","🐱","🐸","🌈"];
  NS.emojiBar = function (ta) {
    const panel = h("div", { class: "emoji-panel", role: "group", "aria-label": "이모지", hidden: true });
    const btn = h("button", { type: "button", class: "emoji-btn", "aria-label": "이모지 입력", "aria-expanded": "false", title: "이모지", text: "😀" });
    const bar = h("div", { class: "emoji-bar" }, btn, panel);
    const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", onKey, true); };
    const outside = (e) => { if (!bar.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === "Escape") { close(); e.stopPropagation(); } };
    EMOJIS.forEach((em) => panel.append(h("button", { type: "button", class: "emoji-item", text: em, "aria-label": em, onclick: () => {
      const max = ta.maxLength > 0 ? ta.maxLength : Infinity;
      if (ta.value.length + em.length > max) return;
      const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart, e = ta.selectionEnd == null ? s : ta.selectionEnd;
      ta.setRangeText(em, s, e, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
    } })));
    btn.addEventListener("click", () => {
      if (panel.hidden) { panel.hidden = false; panel.classList.toggle("up", bar.getBoundingClientRect().bottom + 230 > window.innerHeight && bar.getBoundingClientRect().top > 230); btn.setAttribute("aria-expanded", "true"); document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", onKey, true); }
      else close();
    });
    return bar;
  };

  // ---------- 알림 ----------
  NS.toast = function (msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = h("div", { id: "toast", class: "toast", role: "status" });
      document.body.append(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(NS._toastTimer);
    NS._toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  };

  // ---------- 대화상자 ----------
  NS.dialog = function ({ title, desc, fields = [], submit = "확인" }) {
    return new Promise((resolve) => {
      const dlg = h("dialog", { class: "dlg" });
      const form = h("form", { method: "dialog" });
      form.append(h("h2", { text: title }));
      if (desc) form.append(h("p", { class: "muted", text: desc }));
      const inputs = {};
      for (const f of fields) {
        let el;
        if (f.type === "select") el = h("select", { name: f.name }, f.options.map((o) => h("option", { value: o[0], text: o[1] })));
        else if (f.type === "textarea") el = h("textarea", { name: f.name, rows: 3, maxlength: f.maxlength });
        else el = h("input", { name: f.name, type: f.type || "text", maxlength: f.maxlength, autocomplete: f.autocomplete || "off" });
        inputs[f.name] = el;
        form.append(h("label", { class: "field" }, h("span", { text: f.label }), el));
      }
      const cancel = h("button", { type: "button", class: "btn", text: "취소" });
      const ok = h("button", { type: "submit", class: "btn primary", text: submit });
      form.append(h("div", { class: "dlg-actions" }, cancel, ok));
      dlg.append(form);
      document.body.append(dlg);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { dlg.close(); } catch { /* ignore */ }
        dlg.remove();
        resolve(v);
      };
      cancel.addEventListener("click", () => finish(null));
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = {};
        for (const k in inputs) v[k] = inputs[k].value;
        finish(v);
      });
      dlg.showModal();
      const first = form.querySelector("input,textarea,select");
      if (first) first.focus();
    });
  };

  NS.askPassword = async function (title, desc) {
    const v = await NS.dialog({
      title, desc,
      fields: [{ name: "password", type: "password", label: "비밀번호", maxlength: 64, autocomplete: "off" }],
    });
    if (!v) return null;
    if (v.password.length < 4) { NS.toast(MSG.invalid_password); return null; }
    return v.password;
  };

  NS.report = async function (type, id) {
    const v = await NS.dialog({
      title: "신고하기",
      desc: "운영자가 확인한 뒤 조치합니다. 신고만으로 자동 삭제되지는 않습니다.",
      fields: [
        { name: "reason", type: "select", label: "사유", options: [["abuse", "욕설·비방"], ["hate", "혐오 표현"], ["bad_image", "불쾌하거나 부적절한 이미지"], ["personal_info", "개인정보 노출"], ["spam", "스팸·광고"], ["illegal", "불법정보"], ["other", "기타"]] },
        { name: "detail", type: "textarea", label: "상세 내용 (선택)", maxlength: 1000 },
      ],
      submit: "신고",
    });
    if (!v) return;
    try {
      const r = await NS.api("/report", { json: { target_type: type, target_id: id, reason: v.reason, detail: v.detail || undefined, voter_token: NS.voterToken() } });
      NS.toast(r.duplicate ? "이미 신고하셨습니다." : "신고가 접수되었습니다.");
    } catch (e) { NS.toast(NS.errMsg(e)); }
  };

  // ---------- 이미지 ----------
  NS.checkImage = function (file) {
    if (!file) return null;
    const okType = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type) || /\.(jpe?g|png|gif|webp)$/i.test(file.name || "");
    if (!okType) return "unsupported_image";
    if (file.size < 1 || file.size > 5242880) return "invalid_file_size";
    return null;
  };
  NS.uploadImage = function (postId, password, file) {
    const f = new FormData();
    f.append("password", password);
    f.append("file", file);
    return NS.api(`/posts/${postId}/image`, { form: f, timeout: 60000 });
  };

  // ---------- 헤더 ----------
  // 뒤로: 방금 보던 목록(검색·정렬·페이지 그대로)으로. 목록에서 온 게 아니면(검색 결과 등 외부 유입) 메인으로.
  NS.goBack = function (base = "") {
    let same = false;
    try { same = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch { /* ignore */ }
    if (same && history.length > 1) history.back();
    else location.href = base + "index.html";
  };

  NS.renderHeader = function (base = "", opts = {}) {
    const el = document.getElementById("site-header");
    if (!el) return;
    const inner = h("div", { class: "container header-inner" }, h("a", { class: "site-title", href: base + "index.html", text: "😈 헛소리 대마왕" }));
    const right = h("div", { class: "header-actions" });
    if (opts.back) right.append(h("button", { type: "button", class: "btn small back-btn", onclick: () => NS.goBack(base) }, NS.icon("arrow-left", 14), "뒤로"));
    inner.append(right);
    if (NS.isAdmin()) {
      right.append(h("div", { class: "admin-bar" },
        h("span", { class: "badge", text: "관리자" }),
        h("button", {
          type: "button", class: "btn small", text: "로그아웃",
          onclick: async () => {
            try { await NS.api("/admin/logout", { method: "POST", json: {}, admin: true }); } catch { /* ignore */ }
            NS.clearAdmin();
            location.reload();
          },
        })));
    }
    const parts = [inner];
    if (NS.isAdmin()) {
      const v = new URLSearchParams(location.search).get("v") || "";
      const inAdminDir = /\/admin\//.test(location.pathname);
      const isBoard = !inAdminDir && /(^|\/)(index\.html)?$/.test(location.pathname);
      const onStats = /\/admin\/stats\.html$/.test(location.pathname);
      const links = [
        ["게시판", "index.html", isBoard && !v],
        ["신고 접수", "index.html?v=reports", isBoard && v === "reports"],
        ["신고된 글", "index.html?v=reported", isBoard && v === "reported"],
        ["숨김 글", "index.html?v=hidden", isBoard && v === "hidden"],
        ["삭제 글", "index.html?v=deleted", isBoard && v === "deleted"],
        ["방문 통계", "admin/stats.html", onStats],
      ];
      parts.push(h("nav", { class: "container admin-nav", "aria-label": "관리자 메뉴" },
        links.map(([label, href, active]) => h("a", { class: "chip", href: base + href, "aria-current": active ? "page" : null, text: label }))));
    }
    el.replaceChildren(...parts);
  };

  NS.REASON_LABEL = { abuse: "욕설·비방", hate: "혐오 표현", bad_image: "부적절한 이미지", personal_info: "개인정보 노출", spam: "스팸·광고", illegal: "불법정보", other: "기타" };

  NS.confirm = async (title, desc, label = "확인") => (await NS.dialog({ title, desc, submit: label })) !== null;

  NS.pager = function (el, page, total, size, hrefFn) {
    const pages = Math.ceil(total / size);
    el.replaceChildren();
    if (pages <= 1) return;
    const link = (n, label, cur) => cur
      ? h("span", { "aria-current": "page", text: String(label ?? n) })
      : h("a", { href: hrefFn(n), text: String(label ?? n) });
    const out = [];
    if (page > 1) out.push(link(page - 1, "이전"));
    const start = Math.max(1, Math.min(page - 2, pages - 4));
    const end = Math.min(pages, start + 4);
    if (start > 1) { out.push(link(1)); if (start > 2) out.push(h("span", { class: "gap", text: "…" })); }
    for (let n = start; n <= end; n++) out.push(link(n, n, n === page));
    if (end < pages) { if (end < pages - 1) out.push(h("span", { class: "gap", text: "…" })); out.push(link(pages)); }
    if (page < pages) out.push(link(page + 1, "다음"));
    el.append(...out);
  };

  // ---------- 방문 집계 (집계 전용, 개인 식별값 없음. 관리자 본인 방문은 제외) ----------
  NS.track = function (postId) {
    if (NS.isAdmin()) return;
    const isNew = !ss.get("nv_s");
    if (isNew) ss.set("nv_s", "1");
    const body = { new_session: isNew };
    if (postId) body.post_id = postId;
    if (isNew && document.referrer) body.referrer = document.referrer;
    NS.api("/track", { json: body, keepalive: true }).catch(() => {});
  };

  NS.errorBox = function (e, retry) {
    return h("div", { class: "notice error" },
      h("p", { text: NS.errMsg(e) }),
      retry ? h("button", { type: "button", class: "btn", text: "다시 시도", onclick: retry }) : null);
  };
})();
