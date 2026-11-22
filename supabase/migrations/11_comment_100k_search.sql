alter table public.comments drop constraint if exists comments_body_check;
alter table public.comments add constraint comments_body_check check (char_length(btrim(body)) between 1 and 100000);
create index if not exists comments_body_trgm_idx on public.comments using gin (body extensions.gin_trgm_ops) where not is_deleted and not is_hidden;

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
