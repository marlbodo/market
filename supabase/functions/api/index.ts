// 헛소리 대마왕 — 단일 Edge Function API (공개 + 관리자)
// 모든 DB 접근은 이 함수(service_role)를 통해서만 이뤄진다. 비밀번호·요청 본문은 로그에 남기지 않는다.
import { createClient } from "npm:@supabase/supabase-js@2";

const enc = new TextEncoder();
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const ADMIN_HASH = Deno.env.get("ADMIN_PASSWORD_HASH") ?? "";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
const BUCKET = "post-images";
const BIG_JSON = 450_000; // 글 본문 10만자(이스케이프 포함) 요청용
const PAGE_SIZE = 20;
const ADMIN_SESSION_HOURS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

// ---------- 공통 유틸 ----------
const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let hmacKeyP: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  if (!hmacKeyP) {
    hmacKeyP = (async () => {
      const { data, error } = await db.from("app_secrets").select("value").eq("name", "hmac_key").single();
      if (error || !data) throw new Error("hmac_key_missing");
      return crypto.subtle.importKey("raw", enc.encode(data.value), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    hmacKeyP.catch(() => (hmacKeyP = null));
  }
  return hmacKeyP;
}
async function hmac(ctx: string, value: string) {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`${ctx}:${value}`)));
}
async function sha256hex(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function clientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for");
  return (xff?.split(",")[0] ?? req.headers.get("cf-connecting-ip") ?? "unknown").trim();
}

const KNOWN_DB_ERRORS: Record<string, [number, string]> = {
  invalid_password: [400, "invalid_password"],
  post_not_available: [404, "post_not_available"],
  invalid_parent: [400, "invalid_parent"],
  invalid_reply_target: [400, "invalid_reply_target"],
  target_not_available: [404, "target_not_available"],
  target_not_found: [404, "target_not_found"],
  invalid_vote: [400, "invalid_vote"],
  reply_too_deep: [400, "reply_too_deep"],
};
function dbFail(error: { message?: string; code?: string }): never {
  const msg = String(error?.message ?? "");
  if (error?.code === "23503") throw new HttpError(409, "has_replies"); // 답글이 달린 글은 영구 삭제 불가
  for (const k of Object.keys(KNOWN_DB_ERRORS)) {
    if (msg.includes(k)) throw new HttpError(...KNOWN_DB_ERRORS[k]);
  }
  console.error("db_error", error?.code, msg.slice(0, 200));
  throw new HttpError(500, "server_error");
}
// deno-lint-ignore no-explicit-any
async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await db.rpc(fn, args);
  if (error) dbFail(error);
  return data;
}

async function limit(req: Request, action: string, windowSec: number, max: number, scope?: string) {
  const key = await hmac("rl", scope ?? `ip:${clientIp(req)}`);
  const ok = await rpc("api_rate_limit", { p_key_hash: key, p_action: action, p_window_seconds: windowSec, p_max: max });
  if (ok === false) throw new HttpError(429, "rate_limited");
}

function text(v: unknown, name: string, min: number, max: number, multiline = false): string {
  if (typeof v !== "string") throw new HttpError(400, `invalid_${name}`);
  let s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  if (!multiline) s = s.replace(/\s+/g, " ");
  s = s.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `invalid_${name}`);
  return s;
}
function password(v: unknown): string {
  if (typeof v !== "string" || v.length < 4 || v.length > 64) throw new HttpError(400, "invalid_password");
  return v;
}
function uuid(v: unknown, name = "id"): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new HttpError(400, `invalid_${name}`);
  return v.toLowerCase();
}
// deno-lint-ignore no-explicit-any
async function readJson(req: Request, max = 65536): Promise<any> {
  const raw = await req.text();
  if (raw.length > max) throw new HttpError(413, "too_large");
  try {
    const j = JSON.parse(raw);
    if (j === null || typeof j !== "object") throw 0;
    return j;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
const pageParam = (u: URL) => Math.min(Math.max(parseInt(u.searchParams.get("page") ?? "1") || 1, 1), 10000);

// ---------- 유입 경로 분류 (집계용) ----------
function sourceOf(ref?: string): string {
  if (!ref) return "direct";
  let h: string;
  try {
    h = new URL(ref).hostname.toLowerCase();
  } catch {
    return "direct";
  }
  if (ALLOWED.some((o) => { try { return new URL(o).hostname === h; } catch { return false; } })) return "direct";
  if (h === "search.naver.com" || h.endsWith(".search.naver.com")) return "naver";
  if (/^(www\.)?google\.[a-z.]+$/.test(h)) return "google";
  if (/(^|\.)(bing\.com|search\.daum\.net|duckduckgo\.com|search\.yahoo\.com|zum\.com|ecosia\.org)$/.test(h)) return "other_search";
  return "external";
}

// ---------- 이미지 검증 ----------
const ascii = (b: Uint8Array, s: number, e: number) => String.fromCharCode(...b.slice(s, e));
function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length < 16) return null;
  // 매직 바이트(파일 머리)만 확인한다. 카카오톡·카메라 앱 등은 파일 끝에 여분 데이터를 붙이는 경우가 많아
  // 끝부분 검사는 하지 않는다. 저장 시 content-type 을 고정하고 비공개 버킷+서명 URL 로만 내려주므로 안전하다.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: "image/png", ext: "png" };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

// ---------- 관리자 인증 ----------
function timingEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
// 형식: pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>  (tools/make-admin-hash.mjs 로 생성)
async function verifyAdminPassword(pw: string): Promise<boolean> {
  const [scheme, algo, iterS, saltB64, hashB64] = ADMIN_HASH.split("$");
  if (scheme !== "pbkdf2" || algo !== "sha256") return false;
  const iter = parseInt(iterS);
  if (!(iter >= 100000 && iter <= 2000000)) return false;
  const want = b64d(hashB64);
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const got = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: iter }, key, want.length * 8),
  );
  return timingEqual(got, want);
}
async function audit(action: string, targetType?: string, targetId?: string, detail?: unknown) {
  const { error } = await db.from("admin_audit").insert({
    action, target_type: targetType ?? null, target_id: targetId ?? null, detail: detail ?? null,
  });
  if (error) console.error("audit_error", error.code);
}
async function requireAdmin(req: Request): Promise<string> {
  const token = req.headers.get("x-admin-token") ?? "";
  if (token.length < 32 || token.length > 128) throw new HttpError(401, "unauthorized");
  const th = await sha256hex(token);
  const { data } = await db.from("admin_sessions").select("token_hash")
    .eq("token_hash", th).is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!data) throw new HttpError(401, "unauthorized");
  await limit(req, "admin", 60, 300, `admin:${th}`);
  return th;
}

// ---------- 응답 ----------
type Out = { status?: number; body: unknown };
const ok = (body: unknown, status = 200): Out => ({ status, body });

function baseHeaders(req: Request) {
  const h = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-admin-token",
    "Access-Control-Max-Age": "86400",
  });
  const origin = req.headers.get("origin");
  if (ALLOWED.includes("*")) h.set("Access-Control-Allow-Origin", "*");
  else if (origin && ALLOWED.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  return h;
}

// ---------- 공개 API ----------
async function listPosts(req: Request, u: URL): Promise<Out> {
  await limit(req, "read", 60, 120);
  const sort = u.searchParams.get("sort") === "popular" ? "popular" : "latest";
  const q = (u.searchParams.get("q") ?? "").slice(0, 50);
  const page = pageParam(u);
  const rows = await rpc("api_list_posts", { p_sort: sort, p_query: q, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE });
  return ok({ page, page_size: PAGE_SIZE, total: Number(rows[0]?.total_count ?? 0), posts: rows.map(({ total_count: _t, ...r }: Record<string, unknown>) => r) });
}

async function feed(req: Request, u: URL): Promise<Out> {
  await limit(req, "feed", 60, 120);
  const page = pageParam(u);
  const rows = await rpc("api_feed", { p_limit: 50, p_offset: (page - 1) * 50 });
  return ok({ page, page_size: 50, posts: rows });
}

async function getPost(req: Request, id: string): Promise<Out> {
  await limit(req, "read", 60, 120);
  const rows = await rpc("api_get_post", { p_id: id });
  if (!rows?.length) throw new HttpError(404, "not_found");
  const post = rows[0];
  const comments = post.status === "hidden" ? [] : await rpc("api_get_comments", { p_post_id: id });
  const replies = await rpc("api_get_replies", { p_post_id: id });
  return ok({ post, comments, replies });
}

async function createPost(req: Request): Promise<Out> {
  await limit(req, "post", 300, 3);
  await limit(req, "post_day", 86400, 30);
  const b = await readJson(req, BIG_JSON);
  const id = await rpc("api_create_post", {
    p_nickname: text(b.nickname, "nickname", 1, 20),
    p_title: text(b.title, "title", 1, 100),
    p_body: text(b.body, "body", 1, 100000, true),
    p_password: password(b.password),
    p_reply_to: b.reply_to_id == null ? null : uuid(b.reply_to_id, "reply_to_id"),
  });
  return ok({ id }, 201);
}

async function checkPwLimits(req: Request, id: string) {
  await limit(req, "pw_ip", 600, 10);
  await limit(req, "pw_target", 600, 10, `t:${id}`); // 분산 대입 방지: 대상별 제한
}

async function postMutation(req: Request, id: string, action: "edit" | "delete"): Promise<Out> {
  await checkPwLimits(req, id);
  const b = await readJson(req, BIG_JSON);
  const done = action === "edit"
    ? await rpc("api_edit_post", { p_id: id, p_password: password(b.password), p_title: text(b.title, "title", 1, 100), p_body: text(b.body, "body", 1, 100000, true) })
    : await rpc("api_delete_post", { p_id: id, p_password: password(b.password) });
  if (!done) throw new HttpError(403, "wrong_password");
  return ok({ ok: true });
}

async function commentMutation(req: Request, id: string, action: "edit" | "delete"): Promise<Out> {
  await checkPwLimits(req, id);
  const b = await readJson(req, BIG_JSON);
  const done = action === "edit"
    ? await rpc("api_edit_comment", { p_id: id, p_password: password(b.password), p_body: text(b.body, "body", 1, 100000, true) })
    : await rpc("api_delete_comment", { p_id: id, p_password: password(b.password) });
  if (!done) throw new HttpError(403, "wrong_password");
  return ok({ ok: true });
}

async function createComment(req: Request, postId: string): Promise<Out> {
  await limit(req, "comment", 300, 10);
  await limit(req, "comment_day", 86400, 200);
  const b = await readJson(req, BIG_JSON);
  let parent = b.parent_id == null ? null : uuid(b.parent_id, "parent_id");
  let replyTo = b.reply_to_id == null ? null : uuid(b.reply_to_id, "reply_to_id");
  if (parent && !replyTo) replyTo = parent;
  if (replyTo && !parent) parent = replyTo;
  const id = await rpc("api_create_comment", {
    p_post_id: postId, p_parent_id: parent, p_reply_to_id: replyTo,
    p_nickname: text(b.nickname, "nickname", 1, 20),
    p_body: text(b.body, "body", 1, 100000, true),
    p_password: password(b.password),
  });
  return ok({ id }, 201);
}

async function vote(req: Request): Promise<Out> {
  await limit(req, "vote", 60, 60);
  const b = await readJson(req);
  if (b.target_type !== "post" && b.target_type !== "comment") throw new HttpError(400, "invalid_target_type");
  if (b.value !== 1 && b.value !== -1) throw new HttpError(400, "invalid_vote");
  if (typeof b.voter_token !== "string" || b.voter_token.length < 16 || b.voter_token.length > 128) throw new HttpError(400, "invalid_voter_token");
  const rows = await rpc("api_vote", {
    p_target_type: b.target_type, p_target_id: uuid(b.target_id, "target_id"),
    p_voter_hash: await hmac("vote", b.voter_token), p_value: b.value,
  });
  return ok(rows[0]);
}

const REASONS = ["abuse", "hate", "bad_image", "personal_info", "spam", "illegal", "other"];
async function report(req: Request): Promise<Out> {
  await limit(req, "report", 600, 5);
  const b = await readJson(req);
  if (!["post", "comment", "image"].includes(b.target_type)) throw new HttpError(400, "invalid_target_type");
  if (!REASONS.includes(b.reason)) throw new HttpError(400, "invalid_reason");
  const reporter = typeof b.voter_token === "string" && b.voter_token.length >= 16 && b.voter_token.length <= 128
    ? await hmac("report", b.voter_token) : await hmac("report", `ip:${clientIp(req)}`);
  const created = await rpc("api_report", {
    p_target_type: b.target_type, p_target_id: uuid(b.target_id, "target_id"),
    p_reason: b.reason, p_detail: b.detail == null ? null : text(b.detail, "detail", 0, 1000, true), p_reporter_hash: reporter,
  });
  return ok({ ok: true, duplicate: created === false });
}

async function track(req: Request): Promise<Out> {
  await limit(req, "track", 60, 120);
  const b = await readJson(req);
  const isNew = b.new_session === true;
  const postId = b.post_id == null ? null : uuid(b.post_id, "post_id");
  const src = isNew ? sourceOf(typeof b.referrer === "string" ? b.referrer.slice(0, 500) : undefined) : null;
  await rpc("api_track", { p_new_session: isNew, p_post_id: postId, p_source: src });
  return ok({ ok: true });
}

async function visiblePost(id: string) {
  const { data } = await db.from("posts").select("id").eq("id", id).eq("is_deleted", false).eq("is_hidden", false).maybeSingle();
  return !!data;
}

async function imageUrl(req: Request, id: string): Promise<Out> {
  await limit(req, "img", 60, 30);
  if (!(await visiblePost(id))) throw new HttpError(404, "not_found");
  const { data: att } = await db.from("post_attachments").select("storage_path").eq("post_id", id).eq("is_hidden", false).maybeSingle();
  if (!att) throw new HttpError(404, "not_found");
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(att.storage_path, 60);
  if (error || !data) throw new HttpError(404, "not_found");
  return ok({ url: data.signedUrl, expires_in: 60 });
}

async function uploadImage(req: Request, id: string): Promise<Out> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 5_600_000) throw new HttpError(413, "too_large");
  await limit(req, "upload", 3600, 5);
  await checkPwLimits(req, id);
  const form = await req.formData().catch(() => { throw new HttpError(400, "invalid_form"); });
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1 || file.size > 5_242_880) throw new HttpError(413, "invalid_file_size");
  const pw = password(form.get("password"));
  if (!(await rpc("api_check_password", { p_kind: "post", p_id: id, p_password: pw }))) throw new HttpError(403, "wrong_password");
  if (!(await visiblePost(id))) throw new HttpError(404, "not_found");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new HttpError(415, "unsupported_image");
  const path = `${id}/${crypto.randomUUID()}.${kind.ext}`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: kind.mime, upsert: false });
  if (up.error) { console.error("upload_error", up.error.message?.slice(0, 120)); throw new HttpError(500, "server_error"); }
  const ins = await db.from("post_attachments").insert({ post_id: id, storage_path: path, mime_type: kind.mime, size_bytes: bytes.length });
  if (ins.error) {
    await db.storage.from(BUCKET).remove([path]);
    if (ins.error.code === "23505") throw new HttpError(409, "image_already_attached");
    dbFail(ins.error);
  }
  return ok({ ok: true }, 201);
}

async function deleteOwnImage(req: Request, id: string): Promise<Out> {
  await checkPwLimits(req, id);
  const b = await readJson(req);
  if (!(await rpc("api_check_password", { p_kind: "post", p_id: id, p_password: password(b.password) }))) throw new HttpError(403, "wrong_password");
  await purgeImage(id);
  return ok({ ok: true });
}
async function purgeImage(postId: string) {
  const { data } = await db.from("post_attachments").select("storage_path").eq("post_id", postId).maybeSingle();
  if (!data) return false;
  await db.storage.from(BUCKET).remove([data.storage_path]);
  await db.from("post_attachments").delete().eq("post_id", postId);
  return true;
}

// ---------- 관리자 API ----------
async function adminLogin(req: Request): Promise<Out> {
  if (!ADMIN_HASH) throw new HttpError(503, "admin_not_configured");
  await limit(req, "admin_login", 900, 5);
  await limit(req, "admin_login_global", 3600, 40, "global:admin");
  const b = await readJson(req);
  if (typeof b.password !== "string" || b.password.length < 1 || b.password.length > 200) throw new HttpError(400, "invalid_password");
  if (!(await verifyAdminPassword(b.password))) {
    await audit("login_failed");
    throw new HttpError(401, "wrong_password");
  }
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + ADMIN_SESSION_HOURS * 3600_000).toISOString();
  const { error } = await db.from("admin_sessions").insert({ token_hash: await sha256hex(token), expires_at: expires });
  if (error) dbFail(error);
  await audit("login");
  return ok({ token, expires_at: expires });
}

const POST_ADMIN_COLS = "id,nickname,title,created_at,is_deleted,deleted_by,is_hidden,up_count,down_count,comment_count,has_image";

async function adminListPosts(u: URL): Promise<Out> {
  const filter = u.searchParams.get("filter") ?? "all";
  const page = pageParam(u);
  let q = db.from("posts").select(POST_ADMIN_COLS, { count: "exact" });
  if (filter === "deleted") q = q.eq("is_deleted", true);
  else if (filter === "hidden") q = q.eq("is_hidden", true);
  else if (filter === "reported") {
    const { data } = await db.from("reports").select("target_id").eq("status", "pending").in("target_type", ["post", "image"]);
    const ids = [...new Set((data ?? []).map((r) => r.target_id))];
    if (!ids.length) return ok({ page, page_size: PAGE_SIZE, total: 0, posts: [] });
    q = q.in("id", ids);
  }
  const { data, count, error } = await q.order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) dbFail(error);
  return ok({ page, page_size: PAGE_SIZE, total: count ?? 0, posts: data });
}

async function adminGetPost(id: string): Promise<Out> {
  const [p, c, a] = await Promise.all([
    db.from("posts").select("*").eq("id", id).maybeSingle(),
    db.from("comments").select("id,post_id,parent_id,reply_to_id,nickname,body,created_at,is_deleted,deleted_by,is_hidden,up_count,down_count").eq("post_id", id).order("created_at").limit(500),
    db.from("post_attachments").select("id,mime_type,size_bytes,is_hidden,created_at").eq("post_id", id).maybeSingle(),
  ]);
  if (!p.data) throw new HttpError(404, "not_found");
  return ok({ post: p.data, comments: c.data ?? [], attachment: a.data });
}

async function adminMutate(req: Request, kind: "post" | "comment", id: string, action: string): Promise<Out> {
  const table = kind === "post" ? "posts" : "comments";
  const now = new Date().toISOString();
  // deno-lint-ignore no-explicit-any
  let patch: Record<string, any>;
  // deno-lint-ignore no-explicit-any
  let detail: any = null;
  switch (action) {
    case "hide": patch = { is_hidden: true, hidden_at: now }; break;
    case "unhide": patch = { is_hidden: false, hidden_at: null }; break;
    case "delete": patch = { is_deleted: true, deleted_at: now, deleted_by: "admin" }; break;
    case "restore": patch = { is_deleted: false, deleted_at: null, deleted_by: null }; break;
    case "edit": {
      const b = await readJson(req, BIG_JSON);
      const { data: before } = await db.from(table).select(kind === "post" ? "title,body" : "body").eq("id", id).maybeSingle();
      if (!before) throw new HttpError(404, "not_found");
      patch = kind === "post"
        ? { title: text(b.title, "title", 1, 100), body: text(b.body, "body", 1, 100000, true) }
        : { body: text(b.body, "body", 1, 100000, true) };
      detail = { before };
      break;
    }
    case "purge": {
      const b = await readJson(req);
      if (b.confirm !== true) throw new HttpError(400, "confirm_required");
      if (kind === "post") {
        const { count } = await db.from("posts").select("id", { count: "exact", head: true }).eq("reply_to_id", id);
        if ((count ?? 0) > 0) throw new HttpError(409, "has_replies");
        await purgeImage(id);
      } else {
        const { data: c } = await db.from("comments").select("parent_id").eq("id", id).maybeSingle();
        if (!c) throw new HttpError(404, "not_found");
        await db.from("comments").update({ parent_id: c.parent_id }).eq("parent_id", id); // 하위 답글 보존
      }
      const { data, error } = await db.from(table).delete().eq("id", id).select("id");
      if (error) dbFail(error);
      if (!data?.length) throw new HttpError(404, "not_found");
      await audit("purge", kind, id);
      return ok({ ok: true });
    }
    default: throw new HttpError(404, "not_found");
  }
  const { data, error } = await db.from(table).update(patch).eq("id", id).select("id");
  if (error) dbFail(error);
  if (!data?.length) throw new HttpError(404, "not_found");
  await audit(action, kind, id, detail);
  return ok({ ok: true });
}

async function adminImage(kind: string, id: string): Promise<Out> {
  if (kind === "purge") {
    if (!(await purgeImage(id))) throw new HttpError(404, "not_found");
  } else {
    const { data, error } = await db.from("post_attachments").update({ is_hidden: kind === "hide" }).eq("post_id", id).select("id");
    if (error) dbFail(error);
    if (!data?.length) throw new HttpError(404, "not_found");
  }
  await audit(`image_${kind}`, "post", id);
  return ok({ ok: true });
}

async function adminReports(u: URL): Promise<Out> {
  const status = ["pending", "resolved", "dismissed"].includes(u.searchParams.get("status") ?? "") ? u.searchParams.get("status")! : "pending";
  const page = pageParam(u);
  const { data, count, error } = await db.from("reports")
    .select("id,target_type,target_id,reason,detail,status,created_at,resolved_at", { count: "exact" })
    .eq("status", status).order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) dbFail(error);
  const rows = data ?? [];
  const postIds = rows.filter((r) => r.target_type !== "comment").map((r) => r.target_id);
  const commentIds = rows.filter((r) => r.target_type === "comment").map((r) => r.target_id);
  const [ps, cs] = await Promise.all([
    postIds.length ? db.from("posts").select("id,title").in("id", postIds) : Promise.resolve({ data: [] }),
    commentIds.length ? db.from("comments").select("id,post_id,body").in("id", commentIds) : Promise.resolve({ data: [] }),
  ]);
  const titles = new Map((ps.data ?? []).map((p) => [p.id, p.title]));
  const cmts = new Map((cs.data ?? []).map((c) => [c.id, c]));
  return ok({
    page, page_size: PAGE_SIZE, total: count ?? 0,
    reports: rows.map((r) => {
      const c = cmts.get(r.target_id);
      return { ...r, post_id: r.target_type === "comment" ? c?.post_id ?? null : r.target_id,
        target_preview: r.target_type === "comment" ? (c?.body ?? "").slice(0, 120) : titles.get(r.target_id) ?? null };
    }),
  });
}

async function adminRoute(req: Request, u: URL, route: string[]): Promise<Out> {
  const [, a, b, c, d] = route; // route[0] === "admin"
  const m = req.method;
  if (a === "login" && m === "POST") return adminLogin(req);
  const th = await requireAdmin(req);
  if (a === "me" && m === "GET") return ok({ ok: true });
  if (a === "logout" && m === "POST") {
    await db.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("token_hash", th);
    await audit("logout");
    return ok({ ok: true });
  }
  if (a === "stats" && m === "GET") {
    const r = u.searchParams.get("range") ?? "30";
    const days = r === "all" ? null : r === "today" ? 1 : ({ "7": 7, "30": 30 } as Record<string, number>)[r] ?? 30;
    return ok(await rpc("api_admin_stats", { p_days: days }));
  }
  if (a === "reports" && !b && m === "GET") return adminReports(u);
  if (a === "reports" && b && c === "resolve" && m === "POST") {
    const body = await readJson(req);
    if (!["resolved", "dismissed"].includes(body.status)) throw new HttpError(400, "invalid_status");
    const rid = parseInt(b);
    if (!Number.isInteger(rid)) throw new HttpError(400, "invalid_id");
    const { data, error } = await db.from("reports").update({ status: body.status, resolved_at: new Date().toISOString() }).eq("id", rid).select("id");
    if (error) dbFail(error);
    if (!data?.length) throw new HttpError(404, "not_found");
    await audit(`report_${body.status}`, "report", String(rid));
    return ok({ ok: true });
  }
  if (a === "posts" && !b && m === "GET") return adminListPosts(u);
  if (a === "posts" && b && !c && m === "GET") return adminGetPost(uuid(b));
  if (a === "posts" && b && c === "image" && !d && m === "GET") {
    const { data: att } = await db.from("post_attachments").select("storage_path").eq("post_id", uuid(b)).maybeSingle();
    if (!att) throw new HttpError(404, "not_found");
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(att.storage_path, 60);
    if (error || !data) throw new HttpError(404, "not_found");
    return ok({ url: data.signedUrl, expires_in: 60 });
  }
  if (a === "posts" && b && c === "image" && d && m === "POST" && ["hide", "unhide", "purge"].includes(d)) return adminImage(d, uuid(b));
  if (a === "posts" && b && c && m === "POST") return adminMutate(req, "post", uuid(b), c);
  if (a === "comments" && b && c && m === "POST") return adminMutate(req, "comment", uuid(b), c);
  throw new HttpError(404, "not_found");
}

// ---------- 라우터 ----------
async function route(req: Request): Promise<Out> {
  const u = new URL(req.url);
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("api");
  const r = i >= 0 ? parts.slice(i + 1) : parts;
  const [a, b, c, d] = r;
  const m = req.method;

  if (!a) return ok({ ok: true, service: "nonsense-api" });
  if (a === "admin") return adminRoute(req, u, r);
  if (a === "feed" && m === "GET") return feed(req, u); // 정적 페이지·사이트맵 생성용. 공개 글만, 비밀번호·관리 정보 없음

  if (a === "posts" && !b) {
    if (m === "GET") return listPosts(req, u);
    if (m === "POST") return createPost(req);
  }
  if (a === "posts" && b) {
    const id = uuid(b);
    if (!c && m === "GET") return getPost(req, id);
    if (c === "edit" && m === "POST") return postMutation(req, id, "edit");
    if (c === "delete" && m === "POST") return postMutation(req, id, "delete");
    if (c === "comments" && m === "POST") return createComment(req, id);
    if (c === "image" && !d && m === "GET") return imageUrl(req, id);
    if (c === "image" && !d && m === "POST") return uploadImage(req, id);
    if (c === "image" && d === "delete" && m === "POST") return deleteOwnImage(req, id);
  }
  if (a === "comments" && b && m === "POST") {
    const id = uuid(b);
    if (c === "edit") return commentMutation(req, id, "edit");
    if (c === "delete") return commentMutation(req, id, "delete");
  }
  if (m === "POST" && a === "vote") return vote(req);
  if (m === "POST" && a === "report") return report(req);
  if (m === "POST" && a === "track") return track(req);
  throw new HttpError(404, "not_found");
}

Deno.serve(async (req) => {
  const headers = baseHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  try {
    const out = await route(req);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers });
  } catch (e) {
    if (e instanceof HttpError) return new Response(JSON.stringify({ error: e.code }), { status: e.status, headers });
    console.error("unhandled", String((e as Error)?.message ?? e).slice(0, 200));
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers });
  }
});
