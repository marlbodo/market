-- 헛소리 대마왕 — 1/3 테이블·인덱스
-- Supabase 대시보드 > SQL Editor 에서 001 → 002 → 003 순서로 실행합니다.
-- 모든 테이블은 RLS 를 켜고 anon/authenticated 권한을 주지 않습니다. 접근은 Edge Function(service_role)만 합니다.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_cron;

-- 글 (원글과 답글 글이 같은 테이블. reply_to_id 가 있으면 답글 글)
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  nickname text not null check (char_length(btrim(nickname)) between 1 and 20),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  body text not null check (char_length(btrim(body)) between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by text check (deleted_by in ('author', 'admin')),
  is_hidden boolean not null default false,
  hidden_at timestamptz,
  up_count integer not null default 0 check (up_count >= 0),
  down_count integer not null default 0 check (down_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  has_image boolean not null default false,
  popularity integer generated always as ((up_count - down_count) + (comment_count * 2)) stored,
  reply_to_id uuid references public.posts(id) on delete restrict,
  thread_id uuid not null,
  reply_depth integer not null default 0 constraint posts_reply_depth_chk check (reply_depth between 0 and 50)
);

create table public.post_secrets (
  post_id uuid primary key references public.posts(id) on delete cascade,
  password_hash text not null
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  reply_to_id uuid references public.comments(id) on delete set null,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 20),
  body text not null check (char_length(btrim(body)) between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by text check (deleted_by in ('author', 'admin')),
  is_hidden boolean not null default false,
  hidden_at timestamptz,
  up_count integer not null default 0 check (up_count >= 0),
  down_count integer not null default 0 check (down_count >= 0)
);

create table public.comment_secrets (
  comment_id uuid primary key references public.comments(id) on delete cascade,
  password_hash text not null
);

-- 글당 이미지 1장. 파일 자체는 비공개 Storage 버킷(post-images)에 둡니다.
create table public.post_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique references public.posts(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.votes (
  id bigint generated always as identity primary key,
  target_type text not null check (target_type in ('post', 'comment')),
  target_id uuid not null,
  voter_key_hash text not null,
  value smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  unique (target_type, target_id, voter_key_hash)
);

create table public.reports (
  id bigint generated always as identity primary key,
  target_type text not null check (target_type in ('post', 'comment', 'image')),
  target_id uuid not null,
  reason text not null check (reason in ('abuse', 'hate', 'bad_image', 'personal_info', 'spam', 'illegal', 'other')),
  detail text check (char_length(detail) <= 1000),
  reporter_key_hash text,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- 관리자
create table public.admin_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create table public.admin_audit (
  id bigint generated always as identity primary key,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- 내부용
create table public.app_secrets (name text primary key, value text not null);
create table public.rate_limits (
  key_hash text not null,
  action text not null,
  window_start timestamptz not null,
  hit_count integer not null default 0,
  primary key (key_hash, action, window_start)
);

-- 방문 통계 (개인 식별값 없이 집계 숫자만 저장)
create table public.site_daily_stats (
  stat_date date primary key,
  visits integer not null default 0,
  pageviews integer not null default 0,
  new_posts integer not null default 0,
  new_comments integer not null default 0,
  up_votes integer not null default 0,
  down_votes integer not null default 0
);
create table public.site_hourly_stats (
  stat_date date not null,
  hour smallint not null check (hour between 0 and 23),
  visits integer not null default 0,
  pageviews integer not null default 0,
  primary key (stat_date, hour)
);
create table public.referrer_daily_stats (
  stat_date date not null,
  source text not null check (source in ('naver', 'google', 'other_search', 'external', 'direct')),
  visits integer not null default 0,
  primary key (stat_date, source)
);
create table public.post_daily_stats (
  post_id uuid not null references public.posts(id) on delete cascade,
  stat_date date not null,
  views integer not null default 0,
  primary key (post_id, stat_date)
);

-- 인덱스
create index posts_public_created_idx on public.posts (created_at desc) where not is_deleted and not is_hidden;
create index posts_public_popular_idx on public.posts (popularity desc, created_at desc) where not is_deleted and not is_hidden;
create index posts_title_trgm_idx on public.posts using gin (title extensions.gin_trgm_ops) where not is_deleted and not is_hidden;
create index posts_body_trgm_idx on public.posts using gin (body extensions.gin_trgm_ops) where not is_deleted and not is_hidden;
create index posts_reply_to_idx on public.posts (reply_to_id) where reply_to_id is not null;
create index posts_thread_idx on public.posts (thread_id, created_at) where reply_to_id is not null;
create index comments_body_trgm_idx on public.comments using gin (body extensions.gin_trgm_ops) where not is_deleted and not is_hidden;
create index comments_post_idx on public.comments (post_id, created_at);
create index comments_parent_idx on public.comments (parent_id) where parent_id is not null;
create index comments_reply_idx on public.comments (reply_to_id) where reply_to_id is not null;
create unique index reports_one_per_reporter on public.reports (target_type, target_id, reporter_key_hash) where reporter_key_hash is not null;
create index reports_status_idx on public.reports (status, created_at desc);
create index reports_target_idx on public.reports (target_type, target_id);
create index admin_audit_created_idx on public.admin_audit (created_at desc);
create index admin_sessions_expires_idx on public.admin_sessions (expires_at);
create index rate_limits_window_idx on public.rate_limits (window_start);
create index post_daily_stats_date_idx on public.post_daily_stats (stat_date, views desc);
