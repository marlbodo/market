// 게시글 상세: 본문, 이미지(클릭 시에만 로딩), 추천·신고·공유, 댓글 트리(들여쓰기 최대 3단계)
(function () {
  const { h, api, icon } = NS;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || ((location.pathname.match(/\/p\/([0-9a-f-]{36})/i) || [])[1]) || "";
  const root = document.getElementById("post-root");
  const ROOT = document.documentElement.getAttribute("data-root") || ""; // 정적 페이지(/p/<id>/)에서는 "../../"
  let data = null;
  let editing = null; // { pw }
  let tracked = false;
  const ADMIN = NS.isAdmin(); // 화면 표시용. 실제 권한은 서버가 모든 /admin/* 요청에서 검증한다.

  const canonicalUrl = () => {
    const c = document.querySelector('link[rel="canonical"]');
    return (c && c.href) || location.href.split("#")[0];
  };
  const wasEdited = (x) => new Date(x.updated_at) - new Date(x.created_at) > 2000;
  async function copyLink(url) {
    try { await navigator.clipboard.writeText(url); NS.toast("링크를 복사했습니다."); }
    catch { window.prompt("링크를 복사하세요", url); }
  }

  // 관리자 응답(원본 포함)을 공개 응답과 같은 모양으로 맞춘다. 삭제·숨김 글의 원문도 그대로 들어 있다.
  function fromAdmin(d) {
    const p = d.post;
    const byId = new Map(d.comments.map((c) => [c.id, c]));
    return {
      post: {
        id: p.id, status: p.is_deleted ? "deleted" : p.is_hidden ? "hidden" : "visible",
        is_deleted: p.is_deleted, is_hidden: p.is_hidden,
        nickname: p.nickname, title: p.title, body: p.body, created_at: p.created_at, updated_at: p.updated_at,
        up_count: p.up_count, down_count: p.down_count, comment_count: p.comment_count,
        has_image: !!d.attachment, _attachment: d.attachment,
      },
      comments: d.comments.map((c) => ({
        ...c, status: c.is_deleted ? "deleted" : c.is_hidden ? "hidden" : "visible",
        reply_to_nickname: (byId.get(c.reply_to_id) || {}).nickname || null,
      })),
    };
  }

  async function load(keepScroll) {
    const y = window.scrollY;
    try {
      data = ADMIN ? fromAdmin(await api("/admin/posts/" + id, { admin: true })) : await api("/posts/" + id);
    } catch (e) {
      if (ADMIN && e.status === 401) { location.reload(); return; }
      root.replaceChildren(e.code === "not_found"
        ? h("div", { class: "notice", text: "존재하지 않는 게시글입니다." })
        : NS.errorBox(e, () => load(false)));
      return;
    }
    render();
    if (keepScroll) window.scrollTo(0, y);
    if (!tracked) { tracked = true; NS.track(id); }
  }

  function render() {
    const p = data.post;
    document.title = p.status === "visible" ? p.title + " - 헛소리 대마왕" : "헛소리 대마왕";
    const parts = [postSection(p)];
    if (data.replies && data.replies.length) parts.push(repliesSection(data.replies));
    if (p.status !== "hidden") parts.push(commentsSection(p));
    root.replaceChildren(...parts);
  }

  // ---------- 이 글에 달린 답글 (직속 답글만 한 번 들여쓰고, 더 깊은 답글도 같은 위치에 "@대상"으로 표시) ----------
  function repliesSection(list) {
    return h("section", { class: "replies-box", "aria-label": "답글" },
      h("h2", { text: `답글 ${list.length}` }),
      h("ul", { class: "post-list" }, list.map((r) => h("li", { class: "post-item reply" },
        h("a", { href: ROOT + "post.html?id=" + encodeURIComponent(r.id) },
          h("div", { class: "row1" }, h("span", { class: "title", text: r.title }), r.has_image ? h("span", { class: "muted", title: "이미지 첨부" }, icon("image", 16)) : null),
          h("p", { class: "preview", text: (r.preview || "").replace(/\s+/g, " ").trim() }),
          h("div", { class: "meta" },
            h("span", { class: "to" }, icon("corner-down-right", 13), " @" + (r.reply_to_nickname || "삭제된 글")),
            h("span", { text: r.nickname }),
            h("span", { text: NS.fmtDate(r.created_at) }),
            h("span", { class: "stat", title: "추천" }, icon("thumbs-up", 14), String(r.up_count)),
            h("span", { class: "stat", title: "댓글" }, icon("message-circle", 14), String(r.comment_count))))))));
  }

  // ---------- 추천/비추천 ----------
  function voteButtons(type, item, compact) {
    const cls = compact ? "btn text" : "btn";
    const up = h("button", { type: "button", class: cls, "aria-label": "추천" }, icon("thumbs-up", 15), h("span", { text: String(item.up_count) }));
    const down = h("button", { type: "button", class: cls, "aria-label": "비추천" }, icon("thumbs-down", 15), h("span", { text: String(item.down_count) }));
    const key = type + ":" + item.id;
    const apply = (my) => { up.setAttribute("aria-pressed", String(my === 1)); down.setAttribute("aria-pressed", String(my === -1)); };
    apply(NS.myVote(key));
    const act = async (v) => {
      try {
        const r = await api("/vote", { json: { target_type: type, target_id: item.id, value: v, voter_token: NS.voterToken() } });
        up.lastChild.textContent = String(r.up_count);
        down.lastChild.textContent = String(r.down_count);
        NS.setMyVote(key, r.my_value);
        apply(r.my_value);
      } catch (e) { NS.toast(NS.errMsg(e)); }
    };
    up.addEventListener("click", () => act(1));
    down.addEventListener("click", () => act(-1));
    return [up, down];
  }

  // ---------- 게시글 ----------
  function postSection(p) {
    if (!ADMIN && p.status === "deleted") return h("div", { class: "post-state", text: "삭제된 게시글입니다." });
    if (!ADMIN && p.status === "hidden") return h("div", { class: "post-state", text: "관리자에 의해 숨김 처리된 게시글입니다." });
    if (editing) return editorView(p);
    const art = h("article");
    if (p.status !== "visible") {
      art.append(h("div", { class: "post-state", text: p.status === "deleted"
        ? "삭제된 글입니다. (일반 방문자에게는 '삭제된 게시글입니다'만 보입니다)"
        : "숨김 처리된 글입니다. (일반 방문자에게는 보이지 않습니다)" }));
    }
    if (p.reply_to_id) {
      const target = p.reply_to_status === "visible"
        ? [h("a", { href: ROOT + "post.html?id=" + encodeURIComponent(p.reply_to_id), text: p.reply_to_title }), " 글에 대한 답글 ", h("span", { class: "to" }, icon("corner-down-right", 13), " @" + p.reply_to_nickname)]
        : ["삭제되었거나 숨겨진 글에 대한 답글입니다."];
      art.append(h("p", { class: "reply-line" }, ...target));
    }
    art.append(
      h("h1", { class: "post-title", text: p.title }),
      h("div", { class: "meta" },
        h("span", { text: p.nickname }),
        h("span", { text: NS.fmtDate(p.created_at, true) }),
        wasEdited(p) ? h("span", { text: "(수정됨)" }) : null,
        ADMIN ? [
          h("span", { class: "stat", title: "추천" }, icon("thumbs-up", 14), String(p.up_count)),
          h("span", { class: "stat", title: "비추천" }, icon("thumbs-down", 14), String(p.down_count)),
        ] : null),
      h("div", { class: "post-body", text: p.body }));
    if (p.has_image) art.append(ADMIN ? adminImageBlock(p) : imageBlock(p));
    art.append(...(ADMIN ? [adminPostBar(p)] : [h("div", { class: "bar-actions" }, voteButtons("post", p, false)), actionBar(p)]));
    return art;
  }

  function imageBlock(p, asAdmin) {
    const label = "첨부 이미지 1장 · 이미지 보기";
    const wrap = h("div", { class: "image-block" });
    const btn = h("button", { type: "button", class: "btn", "aria-expanded": "false" }, icon("image"), h("span", { text: label }));
    let img = null, rep = null;
    btn.addEventListener("click", async () => {
      if (img) {
        img.remove(); rep.remove(); img = rep = null;
        btn.lastChild.textContent = label;
        btn.setAttribute("aria-expanded", "false");
        return;
      }
      btn.disabled = true;
      try {
        const r = asAdmin ? await api(`/admin/posts/${p.id}/image`, { admin: true }) : await api(`/posts/${p.id}/image`);
        img = h("img", { src: r.url, alt: "첨부 이미지", referrerpolicy: "no-referrer", decoding: "async" });
        img.addEventListener("error", () => NS.toast("이미지를 불러오지 못했습니다."));
        rep = asAdmin ? h("span") : h("button", { type: "button", class: "btn text", onclick: () => NS.report("image", p.id) }, icon("flag", 14), "이미지 신고");
        wrap.append(img, rep);
        btn.lastChild.textContent = "이미지 접기";
        btn.setAttribute("aria-expanded", "true");
      } catch (e) { NS.toast(NS.errMsg(e)); }
      btn.disabled = false;
    });
    wrap.append(btn);
    return wrap;
  }

  function actionBar(p) {
    const url = canonicalUrl();
    return h("div", { class: "bar-actions" },
      h("a", { class: "btn text", href: ROOT + "write.html?reply_to=" + encodeURIComponent(p.id) }, icon("corner-down-right", 14), "답글 쓰기"),
      h("button", { type: "button", class: "btn text", onclick: () => editPost(p) }, icon("pencil", 14), "수정"),
      h("button", { type: "button", class: "btn text", onclick: () => deletePost(p) }, icon("trash-2", 14), "삭제"),
      h("button", { type: "button", class: "btn text", onclick: () => NS.report("post", p.id) }, icon("flag", 14), "신고"),
      h("span", { class: "spacer" }),
      navigator.share ? h("button", { type: "button", class: "btn text", onclick: () => navigator.share({ title: p.title, url }).catch(() => {}) }, icon("share-2", 14), "공유") : null,
      h("button", { type: "button", class: "btn text", onclick: () => copyLink(url) }, icon("link", 14), "링크 복사"));
  }

  async function editPost(p) {
    const pw = await NS.askPassword("글 수정", "작성할 때 정한 비밀번호를 입력하세요.");
    if (!pw) return;
    editing = { pw };
    render();
  }

  async function deletePost(p) {
    const pw = await NS.askPassword("글 삭제", "삭제하면 목록과 검색에서 사라집니다. 달린 댓글은 유지됩니다.");
    if (!pw) return;
    try {
      await api(`/posts/${p.id}/delete`, { json: { password: pw } });
      NS.toast("삭제했습니다.");
      await load(true);
    } catch (e) { NS.toast(NS.errMsg(e)); }
  }

  function editorView(p) {
    const title = h("input", { type: "text", maxlength: 100 });
    title.value = p.title;
    const body = h("textarea", { rows: 12, maxlength: 100000 });
    body.value = p.body;
    const asAdmin = !!editing.admin;
    const delImg = p.has_image && !asAdmin ? h("input", { type: "checkbox" }) : null;
    const file = p.has_image || asAdmin ? null : h("input", { type: "file", accept: "image/jpeg,image/png,image/gif,image/webp" });
    const save = h("button", { type: "submit", class: "btn primary", text: "저장" });
    const cancel = h("button", { type: "button", class: "btn", text: "취소", onclick: () => { editing = null; render(); } });
    const form = h("form", { class: "editor" },
      h("label", { class: "field" }, h("span", { text: "제목" }), title),
      h("label", { class: "field" }, h("span", { text: "내용" }), body), NS.emojiBar(body),
      delImg ? h("label", { class: "field" }, delImg, " 첨부 이미지 삭제") : null,
      file ? h("label", { class: "field" }, h("span", { text: "이미지 첨부 (선택, 5MB 이하)" }), file) : null,
      h("div", { class: "actions" }, cancel, save));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (asAdmin) {
        save.disabled = true;
        const done = await adminCall(`posts/${p.id}/edit`, { title: title.value, body: body.value }, "수정했습니다.");
        if (done) { editing = null; await load(true); } else save.disabled = false;
        return;
      }
      const pw = editing.pw;
      const picked = file ? file.files[0] || null : null;
      const imgErr = NS.checkImage(picked);
      if (imgErr) return NS.toast(NS.errMsg({ code: imgErr }));
      save.disabled = true;
      try {
        await api(`/posts/${p.id}/edit`, { json: { password: pw, title: title.value, body: body.value } });
      } catch (err) {
        save.disabled = false;
        if (err.code === "wrong_password") {
          const np = await NS.askPassword("비밀번호 다시 입력", "비밀번호가 일치하지 않습니다. 다시 입력해 주세요.");
          if (np) { editing.pw = np; form.requestSubmit(); }
        } else NS.toast(NS.errMsg(err));
        return;
      }
      let warn = null;
      try {
        if (delImg && delImg.checked) await api(`/posts/${p.id}/image/delete`, { json: { password: pw } });
        if (picked) await NS.uploadImage(p.id, pw, picked);
      } catch (err) { warn = NS.errMsg(err); }
      editing = null;
      await load(true);
      NS.toast(warn ? "글은 수정되었지만 이미지 처리에 실패했습니다: " + warn : "수정했습니다.");
    });
    return form;
  }

  // ---------- 댓글 ----------
  function commentForm(parent, onCancel) {
    const nick = h("input", { type: "text", maxlength: 20, placeholder: "별명", required: true, autocomplete: "off", "aria-label": "별명" });
    nick.value = NS.store.get("nv_nick") || "";
    const pw = h("input", { type: "password", minlength: 4, maxlength: 64, placeholder: "비밀번호 (4자 이상)", required: true, autocomplete: "new-password", "aria-label": "비밀번호" });
    const ta = h("textarea", { rows: 3, maxlength: 100000, required: true, placeholder: parent ? "답글을 입력하세요" : "댓글을 입력하세요", "aria-label": "내용" });
    const btn = h("button", { type: "submit", class: "btn primary", text: "등록" });
    const form = h("form", { class: "cform" },
      h("div", { class: "row2" }, nick, pw), ta, NS.emojiBar(ta),
      h("div", { class: "actions" }, onCancel ? h("button", { type: "button", class: "btn", text: "취소", onclick: onCancel }) : null, btn));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        await api(`/posts/${id}/comments`, {
          json: { parent_id: parent ? parent.id : null, reply_to_id: parent ? parent.id : null, nickname: nick.value, body: ta.value, password: pw.value },
        });
        NS.store.set("nv_nick", nick.value.trim());
        NS.toast("등록했습니다.");
        await load(true);
      } catch (err) { NS.toast(NS.errMsg(err)); btn.disabled = false; }
    });
    return form;
  }

  function commentsSection(p) {
    const list = data.comments || [];
    const sec = h("section", { class: "comments", id: "comments" }, h("h2", { text: "댓글 " + p.comment_count }));
    if (p.status === "visible" && !ADMIN) sec.append(commentForm(null, null));
    if (!list.length) { sec.append(h("p", { class: "muted", text: "아직 댓글이 없습니다." })); return sec; }
    const ids = new Set(list.map((c) => c.id));
    const byParent = new Map();
    for (const c of list) {
      const k = c.parent_id && ids.has(c.parent_id) ? c.parent_id : "root";
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(c);
    }
    sec.append(...(byParent.get("root") || []).map((c) => commentNode(c, 0, byParent)));
    return sec;
  }

  const countDesc = (c, m) => (m.get(c.id) || []).reduce((n, k) => n + 1 + countDesc(k, m), 0);

  // 최상위 댓글의 직속 답글만 한 번 들여쓰고 그 아래는 같은 위치에 둔다. 모든 답글에는 "→ @대상" 을 표시
  function commentNode(c, depth, byParent) {
    const kids = byParent.get(c.id) || [];
    const visible = c.status === "visible";
    const showContent = visible || (ADMIN && c.body != null); // 관리자는 삭제·숨김 댓글의 원문도 본다
    const el = h("div", { class: "comment" + (visible ? "" : " gone"), id: "c-" + c.id });
    const head = h("div", { class: "c-head" });
    if (showContent) {
      head.append(h("strong", { text: c.nickname }), h("span", { class: "muted", text: NS.fmtDate(c.created_at, true) }));
      if (!visible) head.append(h("span", { class: "badge", text: c.status === "deleted" ? "삭제됨" : "숨김" }));
      if (wasEdited(c)) head.append(h("span", { class: "muted", text: "(수정됨)" }));
      if (depth > 0) head.append(h("span", { class: "to" }, icon("corner-down-right", 13), " @" + (c.reply_to_nickname || "삭제된 댓글")));
    } else {
      head.append(h("span", { text: c.status === "deleted" ? "삭제된 댓글입니다." : "관리자에 의해 숨김 처리된 댓글입니다." }));
    }
    el.append(head);

    const tools = h("div", { class: "c-tools" });
    const slot = h("div", { class: "reply-slot" });
    let bodyEl = null;
    if (showContent) {
      bodyEl = h("div", { class: "c-body", text: c.body });
      el.append(bodyEl);
      if (ADMIN) tools.append(...adminCommentTools(c, bodyEl));
      else tools.append(
        ...voteButtons("comment", c, true),
        h("button", {
          type: "button", class: "btn text",
          onclick: () => {
            if (slot.firstChild) { slot.replaceChildren(); return; }
            document.querySelectorAll(".reply-slot").forEach((s) => s.replaceChildren());
            slot.append(commentForm(c, () => slot.replaceChildren()));
          },
        }, icon("corner-down-right", 14), "답글"),
        h("button", { type: "button", class: "btn text", onclick: () => editComment(c, bodyEl) }, icon("pencil", 14), "수정"),
        h("button", { type: "button", class: "btn text", onclick: () => deleteComment(c) }, icon("trash-2", 14), "삭제"),
        h("button", { type: "button", class: "btn text", onclick: () => NS.report("comment", c.id) }, icon("flag", 14), "신고"));
    }

    let wrap = null;
    if (kids.length) {
      wrap = h("div", { class: "replies" + (depth >= 1 ? " flat" : "") }, kids.map((k) => commentNode(k, depth + 1, byParent)));
      const n = countDesc(c, byParent);
      const cbtn = h("button", { type: "button", class: "btn text", "aria-expanded": "true" }, icon("chevron-up", 14), h("span", { text: `답글 ${n}개 접기` }));
      cbtn.addEventListener("click", () => {
        const open = wrap.hidden;
        wrap.hidden = !open;
        cbtn.setAttribute("aria-expanded", String(open));
        cbtn.replaceChildren(icon(open ? "chevron-up" : "chevron-down", 14), h("span", { text: `답글 ${n}개 ${open ? "접기" : "펼치기"}` }));
      });
      tools.append(cbtn);
    }
    if (tools.childNodes.length) el.append(tools);
    el.append(slot);
    if (wrap) el.append(wrap);
    return el;
  }

  async function editComment(c, bodyEl) {
    let pw = await NS.askPassword("댓글 수정", "작성할 때 정한 비밀번호를 입력하세요.");
    if (!pw) return;
    const ta = h("textarea", { rows: 3, maxlength: 100000 });
    ta.value = c.body;
    const save = h("button", { type: "button", class: "btn primary small", text: "저장" });
    const cancel = h("button", { type: "button", class: "btn small", text: "취소" });
    const box = h("div", { class: "editor" }, ta, NS.emojiBar(ta), h("div", { class: "actions" }, cancel, save));
    bodyEl.replaceWith(box);
    cancel.addEventListener("click", () => box.replaceWith(bodyEl));
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api(`/comments/${c.id}/edit`, { json: { password: pw, body: ta.value } });
        NS.toast("수정했습니다.");
        await load(true);
      } catch (e) {
        save.disabled = false;
        if (e.code === "wrong_password") {
          const np = await NS.askPassword("비밀번호 다시 입력", "비밀번호가 일치하지 않습니다. 다시 입력해 주세요.");
          if (np) { pw = np; save.click(); }
        } else NS.toast(NS.errMsg(e));
      }
    });
  }

  async function deleteComment(c) {
    const pw = await NS.askPassword("댓글 삭제", "삭제하면 '삭제된 댓글입니다'로 표시되고, 달린 답글은 유지됩니다.");
    if (!pw) return;
    try {
      await api(`/comments/${c.id}/delete`, { json: { password: pw } });
      NS.toast("삭제했습니다.");
      await load(true);
    } catch (e) { NS.toast(NS.errMsg(e)); }
  }

  // ---------- 관리자 기능 (서버가 매 요청마다 관리자 세션을 다시 검증한다) ----------
  async function adminCall(path, body, okMsg) {
    try {
      await api("/admin/" + path, { json: body || {}, admin: true });
      NS.toast(okMsg || "처리했습니다.");
      return true;
    } catch (e) {
      if (e.status === 401) {
        NS.toast("관리자 세션이 만료되었습니다. 다시 로그인해 주세요.");
        setTimeout(() => { location.href = ROOT + "admin/index.html"; }, 1200);
      } else NS.toast(NS.errMsg(e));
      return false;
    }
  }
  const tbtn = (label, ic, fn, cls) => h("button", { type: "button", class: cls || "btn text", onclick: fn }, icon(ic, 14), label);
  const PURGE_DESC = "DB에서 완전히 삭제되며 복구할 수 없습니다. 개인정보·불법정보 파기처럼 꼭 필요한 경우에만 사용하세요.";

  async function adminPostAct(p, action, msg) {
    if (await adminCall(`posts/${p.id}/${action}`, {}, msg)) await load(true);
  }
  async function adminPostPurge(p) {
    if (!(await NS.confirm("글 영구 삭제", "이 글과 달린 댓글, 첨부 이미지가 모두 " + PURGE_DESC, "영구 삭제"))) return;
    if (await adminCall(`posts/${p.id}/purge`, { confirm: true }, "영구 삭제했습니다.")) location.href = ROOT + "index.html";
  }
  async function adminImageAct(p, action, msg) {
    if (action === "purge" && !(await NS.confirm("이미지 영구 삭제", "첨부 이미지 파일이 " + PURGE_DESC, "영구 삭제"))) return;
    if (await adminCall(`posts/${p.id}/image/${action}`, {}, msg)) await load(true);
  }

  function adminImageBlock(p) {
    const a = p._attachment;
    const wrap = h("div", { class: "image-block" });
    if (a && a.is_hidden) wrap.append(h("p", { class: "muted", text: "첨부 이미지: 숨김 처리됨 (관리자만 볼 수 있습니다)" }));
    if (a) wrap.append(imageBlock(p, true));
    wrap.append(h("div", { class: "bar-actions" },
      a && a.is_hidden
        ? tbtn("이미지 숨김 해제", "eye", () => adminImageAct(p, "unhide", "이미지 숨김을 해제했습니다."))
        : tbtn("이미지 숨기기", "eye-off", () => adminImageAct(p, "hide", "이미지를 숨겼습니다.")),
      tbtn("이미지 영구 삭제", "trash-2", () => adminImageAct(p, "purge", "이미지를 영구 삭제했습니다."), "btn text danger")));
    return wrap;
  }

  function adminPostBar(p) {
    return h("div", { class: "bar-actions" },
      tbtn("수정", "pencil", () => { editing = { admin: true }; render(); }),
      p.is_hidden
        ? tbtn("숨김 해제", "eye", () => adminPostAct(p, "unhide", "숨김을 해제했습니다."))
        : tbtn("숨기기", "eye-off", () => adminPostAct(p, "hide", "숨겼습니다.")),
      p.is_deleted
        ? tbtn("복구", "rotate-ccw", () => adminPostAct(p, "restore", "복구했습니다."))
        : tbtn("삭제", "trash-2", () => adminPostAct(p, "delete", "삭제했습니다. (복구할 수 있습니다)")),
      tbtn("영구 삭제", "trash-2", () => adminPostPurge(p), "btn text danger"),
      h("span", { class: "spacer" }),
      tbtn("링크 복사", "link", () => copyLink(canonicalUrl())));
  }

  async function adminCommentAct(c, action, msg) {
    if (await adminCall(`comments/${c.id}/${action}`, {}, msg)) await load(true);
  }
  function adminCommentTools(c, bodyEl) {
    return [
      tbtn("수정", "pencil", () => adminEditComment(c, bodyEl)),
      c.is_hidden
        ? tbtn("숨김 해제", "eye", () => adminCommentAct(c, "unhide", "숨김을 해제했습니다."))
        : tbtn("숨기기", "eye-off", () => adminCommentAct(c, "hide", "숨겼습니다.")),
      c.is_deleted
        ? tbtn("복구", "rotate-ccw", () => adminCommentAct(c, "restore", "복구했습니다."))
        : tbtn("삭제", "trash-2", () => adminCommentAct(c, "delete", "삭제했습니다. (복구할 수 있습니다)")),
      tbtn("영구 삭제", "trash-2", async () => {
        if (!(await NS.confirm("댓글 영구 삭제", "이 댓글이 " + PURGE_DESC + " 달린 답글은 유지됩니다.", "영구 삭제"))) return;
        if (await adminCall(`comments/${c.id}/purge`, { confirm: true }, "영구 삭제했습니다.")) await load(true);
      }, "btn text danger"),
    ];
  }
  function adminEditComment(c, bodyEl) {
    const ta = h("textarea", { rows: 3, maxlength: 100000 });
    ta.value = c.body;
    const save = h("button", { type: "button", class: "btn primary small", text: "저장" });
    const cancel = h("button", { type: "button", class: "btn small", text: "취소" });
    const box = h("div", { class: "editor" }, ta, NS.emojiBar(ta), h("div", { class: "actions" }, cancel, save));
    bodyEl.replaceWith(box);
    cancel.addEventListener("click", () => box.replaceWith(bodyEl));
    save.addEventListener("click", async () => {
      save.disabled = true;
      if (await adminCall(`comments/${c.id}/edit`, { body: ta.value }, "수정했습니다.")) await load(true);
      else save.disabled = false;
    });
  }

  NS.renderHeader(ROOT, { back: true });
  if (!UUID.test(id)) {
    root.replaceChildren(h("div", { class: "notice", text: "존재하지 않는 게시글입니다." }));
  } else {
    load(false);
  }
})();
