-- 헛소리 대마왕 — 2/3 서버 함수 (모두 Edge Function(service_role)만 호출합니다)

create or replace function public.kst_today() returns date language sql stable set search_path to ''
as $$ select (now() at time zone 'Asia/Seoul')::date $$;

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path to ''
as $$ begin new.updated_at := now(); return new; end $$;

create or replace function public.refresh_post_comment_count() returns trigger language plpgsql set search_path to ''
as $$
declare v_post uuid := coalesce(new.post_id, old.post_id);
begin
  update public.posts p
     set comment_count = (select count(*) from public.comments c
                           where c.post_id = v_post and not c.is_deleted and not c.is_hidden)
   where p.id = v_post;
  return null;
end $$;

create or replace function public.refresh_post_has_image() returns trigger language plpgsql set search_path to ''
as $$
declare v_post uuid := coalesce(new.post_id, old.post_id);
begin
  update public.posts p
     set has_image = exists (select 1 from public.post_attachments a where a.post_id = v_post and not a.is_hidden)
   where p.id = v_post;
  return null;
end $$;

create or replace function public.bump_daily_new() returns trigger language plpgsql set search_path to ''
as $$
begin
  if tg_table_name = 'posts' then
    insert into public.site_daily_stats (stat_date, new_posts) values (public.kst_today(), 1)
    on conflict (stat_date) do update set new_posts = public.site_daily_stats.new_posts + 1;
  else
    insert into public.site_daily_stats (stat_date, new_comments) values (public.kst_today(), 1)
    on conflict (stat_date) do update set new_comments = public.site_daily_stats.new_comments + 1;
  end if;
  return null;
end $$;

create or replace function public.apply_vote_counts() returns trigger language plpgsql set search_path to ''
as $$
declare
  v_type text; v_id uuid; d_up int := 0; d_down int := 0;
begin
  if tg_op in ('UPDATE','DELETE') then
    v_type := old.target_type; v_id := old.target_id;
    if old.value = 1 then d_up := d_up - 1; else d_down := d_down - 1; end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    v_type := new.target_type; v_id := new.target_id;
    if new.value = 1 then d_up := d_up + 1; else d_down := d_down + 1; end if;
    insert into public.site_daily_stats (stat_date, up_votes, down_votes)
    values (public.kst_today(), (new.value = 1)::int, (new.value = -1)::int)
    on conflict (stat_date) do update
      set up_votes = public.site_daily_stats.up_votes + (new.value = 1)::int,
          down_votes = public.site_daily_stats.down_votes + (new.value = -1)::int;
  end if;
  if v_type = 'post' then
    update public.posts set up_count = greatest(up_count + d_up, 0), down_count = greatest(down_count + d_down, 0) where id = v_id;
  else
    update public.comments set up_count = greatest(up_count + d_up, 0), down_count = greatest(down_count + d_down, 0) where id = v_id;
  end if;
  return null;
end $$;

create or replace function public.api_rate_limit(p_key_hash text, p_action text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql set search_path to ''
as $$
declare v_start timestamptz; v_count int;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits (key_hash, action, window_start, hit_count)
  values (p_key_hash, p_action, v_start, 1)
  on conflict (key_hash, action, window_start)
  do update set hit_count = public.rate_limits.hit_count + 1
  returning hit_count into v_count;
  return v_count <= p_max;
end $$;

create or replace function public.api_check_password(p_kind text, p_id uuid, p_password text)
returns boolean language plpgsql set search_path to ''
as $$
declare v_hash text;
begin
  if p_kind = 'post' then
    select password_hash into v_hash from public.post_secrets where post_id = p_id;
  elsif p_kind = 'comment' then
    select password_hash into v_hash from public.comment_secrets where comment_id = p_id;
  else
    return false;
  end if;
  if v_hash is null then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10)); -- 타이밍 균등화
    return false;
  end if;
  return v_hash = extensions.crypt(coalesce(p_password, ''), v_hash);
end $$;

create or replace function public.api_create_post(p_nickname text, p_title text, p_body text, p_password text, p_reply_to uuid default null)
returns uuid language plpgsql set search_path to ''
as $$
declare v_id uuid := gen_random_uuid(); v_thread uuid; v_depth int := 0; t record;
begin
  if p_password is null or char_length(p_password) < 4 or char_length(p_password) > 64 then
    raise exception 'invalid_password';
  end if;
  if p_reply_to is not null then
    select thread_id, reply_depth, is_deleted, is_hidden into t from public.posts where id = p_reply_to;
    if not found or t.is_deleted or t.is_hidden then raise exception 'post_not_available'; end if;
    if t.reply_depth >= 50 then raise exception 'reply_too_deep'; end if;
    v_thread := t.thread_id; v_depth := t.reply_depth + 1;
  else
    v_thread := v_id;
  end if;
  insert into public.posts (id, nickname, title, body, reply_to_id, thread_id, reply_depth)
  values (v_id, btrim(p_nickname), btrim(p_title), btrim(p_body), p_reply_to, v_thread, v_depth);
  insert into public.post_secrets (post_id, password_hash)
  values (v_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  return v_id;
end $$;

create or replace function public.api_edit_post(p_id uuid, p_password text, p_title text, p_body text)
returns boolean language plpgsql set search_path to ''
as $$
begin
  if not public.api_check_password('post', p_id, p_password) then return false; end if;
  update public.posts set title = btrim(p_title), body = btrim(p_body)
   where id = p_id and not is_deleted;
  return found;
end $$;

create or replace function public.api_delete_post(p_id uuid, p_password text)
returns boolean language plpgsql set search_path to ''
as $$
begin
  if not public.api_check_password('post', p_id, p_password) then return false; end if;
  update public.posts set is_deleted = true, deleted_at = now(), deleted_by = 'author'
   where id = p_id and not is_deleted;
  return found;
end $$;

create or replace function public.api_create_comment(p_post_id uuid, p_parent_id uuid, p_reply_to_id uuid, p_nickname text, p_body text, p_password text)
returns uuid language plpgsql set search_path to ''
as $$
declare v_id uuid;
begin
  if p_password is null or char_length(p_password) < 4 or char_length(p_password) > 64 then
    raise exception 'invalid_password';
  end if;
  if not exists (select 1 from public.posts where id = p_post_id and not is_deleted and not is_hidden) then
    raise exception 'post_not_available';
  end if;
  if p_parent_id is not null and not exists (select 1 from public.comments where id = p_parent_id and post_id = p_post_id) then
    raise exception 'invalid_parent';
  end if;
  if p_reply_to_id is not null and not exists (select 1 from public.comments where id = p_reply_to_id and post_id = p_post_id) then
    raise exception 'invalid_reply_target';
  end if;
  insert into public.comments (post_id, parent_id, reply_to_id, nickname, body)
  values (p_post_id, p_parent_id, p_reply_to_id, btrim(p_nickname), btrim(p_body)) returning id into v_id;
  insert into public.comment_secrets (comment_id, password_hash)
  values (v_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  return v_id;
end $$;

create or replace function public.api_edit_comment(p_id uuid, p_password text, p_body text)
returns boolean language plpgsql set search_path to ''
as $$
begin
  if not public.api_check_password('comment', p_id, p_password) then return false; end if;
  update public.comments set body = btrim(p_body) where id = p_id and not is_deleted;
  return found;
end $$;

create or replace function public.api_delete_comment(p_id uuid, p_password text)
returns boolean language plpgsql set search_path to ''
as $$
begin
  if not public.api_check_password('comment', p_id, p_password) then return false; end if;
  update public.comments set is_deleted = true, deleted_at = now(), deleted_by = 'author'
   where id = p_id and not is_deleted;
  return found;
end $$;

create or replace function public.api_vote(p_target_type text, p_target_id uuid, p_voter_hash text, p_value smallint)
returns table(up_count integer, down_count integer, my_value smallint)
language plpgsql set search_path to ''
as $$
#variable_conflict use_column
declare v_existing smallint; v_my smallint := p_value;
begin
  if p_value not in (1, -1) or p_voter_hash is null or char_length(p_voter_hash) < 16 then
    raise exception 'invalid_vote';
  end if;
  if p_target_type = 'post' then
    if not exists (select 1 from public.posts where id = p_target_id and not is_deleted and not is_hidden) then
      raise exception 'target_not_available';
    end if;
  elsif p_target_type = 'comment' then
    if not exists (select 1 from public.comments where id = p_target_id and not is_deleted and not is_hidden) then
      raise exception 'target_not_available';
    end if;
  else
    raise exception 'invalid_target_type';
  end if;

  select v.value into v_existing from public.votes v
   where v.target_type = p_target_type and v.target_id = p_target_id and v.voter_key_hash = p_voter_hash;

  if v_existing is null then
    insert into public.votes (target_type, target_id, voter_key_hash, value)
    values (p_target_type, p_target_id, p_voter_hash, p_value);
  elsif v_existing = p_value then
    delete from public.votes v
     where v.target_type = p_target_type and v.target_id = p_target_id and v.voter_key_hash = p_voter_hash;
    v_my := 0;
  else
    update public.votes v set value = p_value
     where v.target_type = p_target_type and v.target_id = p_target_id and v.voter_key_hash = p_voter_hash;
  end if;

  if p_target_type = 'post' then
    return query select p.up_count, p.down_count, v_my from public.posts p where p.id = p_target_id;
  else
    return query select c.up_count, c.down_count, v_my from public.comments c where c.id = p_target_id;
  end if;
end $$;

create or replace function public.api_report(p_target_type text, p_target_id uuid, p_reason text, p_detail text, p_reporter_hash text)
returns boolean language plpgsql set search_path to ''
as $$
declare v_ok boolean;
begin
  if p_target_type = 'post' then
    v_ok := exists (select 1 from public.posts where id = p_target_id);
  elsif p_target_type = 'comment' then
    v_ok := exists (select 1 from public.comments where id = p_target_id);
  elsif p_target_type = 'image' then
    v_ok := exists (select 1 from public.post_attachments where post_id = p_target_id);
  else
    v_ok := false;
  end if;
  if not v_ok then raise exception 'target_not_found'; end if;
  insert into public.reports (target_type, target_id, reason, detail, reporter_key_hash)
  values (p_target_type, p_target_id, p_reason, left(p_detail, 1000), p_reporter_hash)
  on conflict do nothing;
  return found;
end $$;

create or replace function public.api_track(p_new_session boolean, p_post_id uuid, p_source text)
returns void language plpgsql set search_path to ''
as $$
declare
  v_date date := public.kst_today();
  v_hour smallint := extract(hour from (now() at time zone 'Asia/Seoul'))::smallint;
  v_visit int := case when p_new_session then 1 else 0 end;
  v_src text := case when p_source in ('naver','google','other_search','external','direct') then p_source else 'direct' end;
begin
  insert into public.site_daily_stats (stat_date, visits, pageviews) values (v_date, v_visit, 1)
  on conflict (stat_date) do update
    set visits = public.site_daily_stats.visits + v_visit,
        pageviews = public.site_daily_stats.pageviews + 1;
  insert into public.site_hourly_stats (stat_date, hour, visits, pageviews) values (v_date, v_hour, v_visit, 1)
  on conflict (stat_date, hour) do update
    set visits = public.site_hourly_stats.visits + v_visit,
        pageviews = public.site_hourly_stats.pageviews + 1;
  if p_new_session then
    insert into public.referrer_daily_stats (stat_date, source, visits) values (v_date, v_src, 1)
    on conflict (stat_date, source) do update set visits = public.referrer_daily_stats.visits + 1;
  end if;
  if p_post_id is not null and exists (select 1 from public.posts where id = p_post_id and not is_deleted and not is_hidden) then
    insert into public.post_daily_stats (post_id, stat_date, views) values (p_post_id, v_date, 1)
    on conflict (post_id, stat_date) do update set views = public.post_daily_stats.views + 1;
  end if;
end $$;

-- 정적 페이지·사이트맵 생성용 공개 글 목록
create or replace function public.api_feed(p_limit integer, p_offset integer)
returns table(id uuid, nickname text, title text, body text, created_at timestamptz, updated_at timestamptz, comment_count integer, has_image boolean)
language sql stable set search_path to ''
as $$
  select s.id, s.nickname, s.title, s.body, s.created_at, s.updated_at, s.comment_count, s.has_image
    from public.posts s
   where not s.is_deleted and not s.is_hidden
   order by s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.api_get_post(p_id uuid)
returns table(id uuid, status text, nickname text, title text, body text, created_at timestamptz, updated_at timestamptz, up_count integer, down_count integer, comment_count integer, has_image boolean, reply_depth integer, reply_to_id uuid, reply_to_status text, reply_to_nickname text, reply_to_title text)
language sql stable set search_path to ''
as $$
  select p.id,
         case when p.is_deleted then 'deleted' when p.is_hidden then 'hidden' else 'visible' end,
         case when p.is_deleted or p.is_hidden then null else p.nickname end,
         case when p.is_deleted or p.is_hidden then null else p.title end,
         case when p.is_deleted or p.is_hidden then null else p.body end,
         p.created_at, p.updated_at, p.up_count, p.down_count, p.comment_count,
         (p.has_image and not p.is_deleted and not p.is_hidden),
         p.reply_depth, p.reply_to_id,
         case when r.id is null then null when r.is_deleted then 'deleted' when r.is_hidden then 'hidden' else 'visible' end,
         case when r.id is null or r.is_deleted or r.is_hidden then null else r.nickname end,
         case when r.id is null or r.is_deleted or r.is_hidden then null else r.title end
    from public.posts p left join public.posts r on r.id = p.reply_to_id
   where p.id = p_id;
$$;

create or replace function public.api_get_comments(p_post_id uuid)
returns table(id uuid, parent_id uuid, reply_to_id uuid, reply_to_nickname text, status text, nickname text, body text, created_at timestamptz, updated_at timestamptz, up_count integer, down_count integer)
language sql stable set search_path to ''
as $$
  select c.id, c.parent_id, c.reply_to_id,
         case when r.id is not null and not r.is_deleted and not r.is_hidden then r.nickname end,
         case when c.is_deleted then 'deleted' when c.is_hidden then 'hidden' else 'visible' end,
         case when c.is_deleted or c.is_hidden then null else c.nickname end,
         case when c.is_deleted or c.is_hidden then null else c.body end,
         c.created_at, c.updated_at, c.up_count, c.down_count
    from public.comments c
    left join public.comments r on r.id = c.reply_to_id
   where c.post_id = p_post_id
   order by c.created_at, c.id
   limit 500;
$$;

-- 이 글에 달린 모든 답글(재귀, 최대 100개)
create or replace function public.api_get_replies(p_post_id uuid)
returns table(id uuid, nickname text, title text, preview text, created_at timestamptz, up_count integer, down_count integer, comment_count integer, has_image boolean, reply_depth integer, reply_to_id uuid, reply_to_nickname text)
language sql stable set search_path to ''
as $$
  with recursive d as (
    select c.id from public.posts c where c.reply_to_id = p_post_id
    union all
    select c.id from public.posts c join d on c.reply_to_id = d.id
  )
  select c.id, c.nickname, c.title, left(c.body, 200), c.created_at, c.up_count, c.down_count, c.comment_count, c.has_image,
         c.reply_depth, c.reply_to_id, rp.nickname
    from public.posts c join d on d.id = c.id
    left join public.posts rp on rp.id = c.reply_to_id and not rp.is_deleted and not rp.is_hidden
   where not c.is_deleted and not c.is_hidden
   order by c.created_at, c.id
   limit 100;
$$;

-- 목록·검색. 원글 번호(display_no)는 작성 순서로 고정(최신/인기 정렬과 무관).
create or replace function public.api_list_posts(p_sort text, p_query text, p_limit integer, p_offset integer)
returns table(id uuid, display_no integer, nickname text, title text, preview text, created_at timestamptz, up_count integer, down_count integer, comment_count integer, has_image boolean, total_count bigint, reply_depth integer, reply_to_id uuid, reply_to_nickname text, placeholder text, reply_count integer)
language plpgsql stable set search_path to ''
as $$
#variable_conflict use_column
declare v_total bigint; v_pat text; v_limit int; v_offset int;
begin
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  if p_query is not null and btrim(p_query) <> '' then
    v_pat := '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if v_pat is not null then
    -- 검색: 원글·답글 모두 공개 글만 평평하게
    select count(*) into v_total from public.posts s
     where not s.is_deleted and not s.is_hidden and (s.title ilike v_pat or s.body ilike v_pat
            or exists (select 1 from public.comments mc where mc.post_id = s.id and not mc.is_deleted and not mc.is_hidden and mc.body ilike v_pat));
    return query
    with numbered as (
      select r.id as nid, (row_number() over (order by r.created_at, r.id))::int as seq
        from public.posts r
       where r.reply_to_id is null
         and ((not r.is_deleted and not r.is_hidden)
              or exists (select 1 from public.posts c where c.thread_id = r.id and c.reply_to_id is not null and not c.is_deleted and not c.is_hidden))
    )
    select x.id, n.seq,
           x.nickname, x.title,
           case when x.title ilike v_pat or x.body ilike v_pat then left(x.body, 200)
                else '💬 ' || coalesce((select left(mc.body, 200) from public.comments mc where mc.post_id = x.id and not mc.is_deleted and not mc.is_hidden and mc.body ilike v_pat order by mc.created_at limit 1), left(x.body, 200)) end,
           x.created_at, x.up_count, x.down_count, x.comment_count, x.has_image, v_total,
           x.reply_depth, x.reply_to_id, rp.nickname, null::text, 0
      from (select s.* from public.posts s
             where not s.is_deleted and not s.is_hidden and (s.title ilike v_pat or s.body ilike v_pat
                    or exists (select 1 from public.comments mc where mc.post_id = s.id and not mc.is_deleted and not mc.is_hidden and mc.body ilike v_pat))
             order by (case when p_sort = 'popular' then s.popularity end) desc nulls last, s.created_at desc, s.id desc
             limit v_limit offset v_offset) x
      left join numbered n on n.nid = x.id
      left join public.posts rp on rp.id = x.reply_to_id and not rp.is_deleted and not rp.is_hidden
     order by (case when p_sort = 'popular' then x.popularity end) desc nulls last, x.created_at desc, x.id desc;
    return;
  end if;

  -- 목록: 원글 단위로 쪽을 나누고, 각 원글 바로 아래에 답글(최대 30개)을 시간순으로 붙인다.
  select count(*) into v_total from public.posts r
   where r.reply_to_id is null
     and ((not r.is_deleted and not r.is_hidden)
          or exists (select 1 from public.posts c where c.thread_id = r.id and c.reply_to_id is not null and not c.is_deleted and not c.is_hidden));

  return query
  with numbered as (
    select r.id as nid, (row_number() over (order by r.created_at, r.id))::int as seq
      from public.posts r
     where r.reply_to_id is null
       and ((not r.is_deleted and not r.is_hidden)
            or exists (select 1 from public.posts c where c.thread_id = r.id and c.reply_to_id is not null and not c.is_deleted and not c.is_hidden))
  ), roots as (
    select x.*, row_number() over (order by (case when p_sort = 'popular' then x.popularity end) desc nulls last, x.created_at desc, x.id desc) as rn
      from (select r.* from public.posts r
             where r.reply_to_id is null
               and ((not r.is_deleted and not r.is_hidden)
                    or exists (select 1 from public.posts c where c.thread_id = r.id and c.reply_to_id is not null and not c.is_deleted and not c.is_hidden))
             order by (case when p_sort = 'popular' then r.popularity end) desc nulls last, r.created_at desc, r.id desc
             limit v_limit offset v_offset) x
  ), reps as (
    select c.*, rt.rn as root_rn, row_number() over (partition by c.thread_id order by c.created_at, c.id) as cn
      from public.posts c join roots rt on rt.id = c.thread_id
     where c.reply_to_id is not null and not c.is_deleted and not c.is_hidden
  ), u as (
    select r.id, (select n.seq from numbered n where n.nid = r.id) as display_no,
           case when r.is_deleted or r.is_hidden then null else r.nickname end as nickname,
           case when r.is_deleted or r.is_hidden then null else r.title end as title,
           case when r.is_deleted or r.is_hidden then null else left(r.body, 200) end as preview,
           r.created_at, r.up_count, r.down_count, r.comment_count,
           (r.has_image and not r.is_deleted and not r.is_hidden) as has_image,
           0 as reply_depth, null::uuid as reply_to_id, null::text as reply_to_nickname,
           case when r.is_deleted then 'deleted' when r.is_hidden then 'hidden' end as placeholder,
           (select count(*)::int from reps q where q.thread_id = r.id) as reply_count,
           r.rn as k1, 0::bigint as k2
      from roots r
    union all
    select c.id, null::int, c.nickname, c.title, left(c.body, 200), c.created_at, c.up_count, c.down_count, c.comment_count, c.has_image,
           c.reply_depth, c.reply_to_id, rp.nickname, null::text, 0, c.root_rn, c.cn
      from reps c
      left join public.posts rp on rp.id = c.reply_to_id and not rp.is_deleted and not rp.is_hidden
     where c.cn <= 30
  )
  select u.id, u.display_no, u.nickname, u.title, u.preview, u.created_at, u.up_count, u.down_count, u.comment_count, u.has_image,
         v_total, u.reply_depth, u.reply_to_id, u.reply_to_nickname, u.placeholder, u.reply_count
    from u order by u.k1, u.k2;
end $$;

-- 관리자 방문 통계
create or replace function public.api_admin_stats(p_days integer default 30)
returns jsonb language plpgsql stable set search_path to ''
as $$
declare
  t date := public.kst_today();
  v_from date;
  v_start date;
  v_min date;
  res jsonb;
begin
  select min(stat_date) into v_min from public.site_daily_stats;
  v_from := case when p_days is null then date '2000-01-01' else t - (p_days - 1) end;
  v_start := greatest(v_from, coalesce(v_min, t), t - 365);

  res := jsonb_build_object(
    'measure_note', '방문 = 브라우저 탭 세션당 1회(순방문자 아님) · 페이지뷰 = 화면 조회 수 · 기준 시간대 Asia/Seoul · 개인 식별값 미사용',
    'range_days', p_days,
    'today', t,

    'cards', (select jsonb_build_object(
        'visits_today',      coalesce(sum(visits) filter (where stat_date = t), 0),
        'visits_yesterday',  coalesce(sum(visits) filter (where stat_date = t - 1), 0),
        'visits_7d',         coalesce(sum(visits) filter (where stat_date > t - 7), 0),
        'visits_30d',        coalesce(sum(visits) filter (where stat_date > t - 30), 0),
        'visits_total',      coalesce(sum(visits), 0),
        'pageviews_today',   coalesce(sum(pageviews) filter (where stat_date = t), 0),
        'pageviews_total',   coalesce(sum(pageviews), 0))
      from public.site_daily_stats),

    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
          'date', g.d, 'visits', coalesce(s.visits, 0), 'pageviews', coalesce(s.pageviews, 0),
          'new_posts', coalesce(s.new_posts, 0), 'new_comments', coalesce(s.new_comments, 0),
          'up_votes', coalesce(s.up_votes, 0), 'down_votes', coalesce(s.down_votes, 0)) order by g.d), '[]'::jsonb)
        from generate_series(v_start, t, interval '1 day') as g(d)
        left join public.site_daily_stats s on s.stat_date = g.d::date),

    'weekly', (select coalesce(jsonb_agg(w order by w->>'week_start'), '[]'::jsonb) from (
        select jsonb_build_object('week_start', date_trunc('week', stat_date)::date,
               'visits', sum(visits), 'pageviews', sum(pageviews),
               'new_posts', sum(new_posts), 'new_comments', sum(new_comments)) as w
          from public.site_daily_stats where stat_date >= v_from
         group by date_trunc('week', stat_date)) q),

    'monthly', (select coalesce(jsonb_agg(m order by m->>'month_start'), '[]'::jsonb) from (
        select jsonb_build_object('month_start', date_trunc('month', stat_date)::date,
               'visits', sum(visits), 'pageviews', sum(pageviews),
               'new_posts', sum(new_posts), 'new_comments', sum(new_comments)) as m
          from public.site_daily_stats where stat_date >= v_from
         group by date_trunc('month', stat_date)) q),

    'hourly', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'visits', coalesce(x.v, 0), 'pageviews', coalesce(x.p, 0)) order by h), '[]'::jsonb)
        from generate_series(0, 23) h
        left join (select hour, sum(visits) v, sum(pageviews) p from public.site_hourly_stats
                    where stat_date >= v_from group by hour) x on x.hour = h),

    'weekday', (select coalesce(jsonb_agg(jsonb_build_object('dow', dw, 'visits', coalesce(x.v, 0), 'pageviews', coalesce(x.p, 0)) order by dw), '[]'::jsonb)
        from generate_series(0, 6) dw
        left join (select extract(dow from stat_date)::int dow, sum(visits) v, sum(pageviews) p
                     from public.site_daily_stats where stat_date >= v_from group by 1) x on x.dow = dw),

    'growth', (select jsonb_build_object(
        'visits_7d',  jsonb_build_object('current', coalesce(sum(visits) filter (where stat_date > t - 7), 0),
                                         'previous', coalesce(sum(visits) filter (where stat_date <= t - 7 and stat_date > t - 14), 0)),
        'visits_28d', jsonb_build_object('current', coalesce(sum(visits) filter (where stat_date > t - 28), 0),
                                         'previous', coalesce(sum(visits) filter (where stat_date <= t - 28 and stat_date > t - 56), 0)),
        'visits_30d', jsonb_build_object('current', coalesce(sum(visits) filter (where stat_date > t - 30), 0),
                                         'previous', coalesce(sum(visits) filter (where stat_date <= t - 30 and stat_date > t - 60), 0)),
        'new_posts_28d', jsonb_build_object('current', coalesce(sum(new_posts) filter (where stat_date > t - 28), 0),
                                            'previous', coalesce(sum(new_posts) filter (where stat_date <= t - 28 and stat_date > t - 56), 0)),
        'new_comments_28d', jsonb_build_object('current', coalesce(sum(new_comments) filter (where stat_date > t - 28), 0),
                                               'previous', coalesce(sum(new_comments) filter (where stat_date <= t - 28 and stat_date > t - 56), 0)))
      from public.site_daily_stats),

    'search_visits_28d', (select jsonb_build_object(
        'current', coalesce(sum(visits) filter (where stat_date > t - 28), 0),
        'previous', coalesce(sum(visits) filter (where stat_date <= t - 28 and stat_date > t - 56), 0))
      from public.referrer_daily_stats where source in ('naver','google','other_search')),

    'referrers', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'visits', v) order by v desc), '[]'::jsonb)
        from (select source, sum(visits) v from public.referrer_daily_stats where stat_date >= v_from group by source) q),

    'top_posts', (select coalesce(jsonb_agg(jsonb_build_object('post_id', q.post_id, 'title', q.title, 'views', q.v) order by q.v desc), '[]'::jsonb)
        from (select s.post_id, p.title, sum(s.views) v
                from public.post_daily_stats s join public.posts p on p.id = s.post_id
               where s.stat_date >= v_from group by s.post_id, p.title
               order by sum(s.views) desc limit 20) q),

    'content', (select jsonb_build_object(
        'posts_total', (select count(*) from public.posts where not is_deleted),
        'comments_total', (select count(*) from public.comments where not is_deleted),
        'avg_comments_per_post', coalesce(round((select count(*) from public.comments where not is_deleted)::numeric
                                  / nullif((select count(*) from public.posts where not is_deleted), 0), 2), 0)))
  );
  return res;
end $$;
