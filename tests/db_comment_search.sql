-- 댓글 10만자 + 댓글/대댓글 검색 테스트 (db_smoke.sql 과 같은 빈 DB에서 실행)
create temp table ids(k text primary key, v uuid);
insert into ids select 'a', public.api_create_post('갑','일반글','본문엔 없음','pass1234');
insert into ids select 'b', public.api_create_post('을','다른글','본문 둘','pass1234');
insert into ids select 'c1', public.api_create_comment((select v from ids where k='a'), null, null, '댓', '여기에 고구마 있음', 'pass1234');
insert into ids select 'c2', public.api_create_comment((select v from ids where k='b'), null, null, '댓', '그냥 댓글', 'pass1234');
insert into ids select 'c3', public.api_create_comment((select v from ids where k='b'), (select v from ids where k='c2'), (select v from ids where k='c2'), '대', '대댓글에 감자 숨김', 'pass1234');
select '댓글 검색 고구마(기대 1건 일반글, 💬 미리보기): ' || count(*) || ' / ' || min(title) || ' / ' || min(preview) from public.api_list_posts('latest','고구마',20,0);
select '대댓글 검색 감자(기대 1건 다른글): ' || count(*) || ' / ' || min(title) || ' / ' || min(preview) from public.api_list_posts('latest','감자',20,0);
select '본문 검색은 💬 없음(기대 본문 둘): ' || min(preview) from public.api_list_posts('latest','본문 둘',20,0);
select '없는 단어(기대 0): ' || count(*) from public.api_list_posts('latest','없는단어zzz',20,0);
-- 삭제된 댓글은 검색 제외
select public.api_delete_comment((select v from ids where k='c1'),'pass1234');
select '삭제된 댓글 검색(기대 0): ' || count(*) from public.api_list_posts('latest','고구마',20,0);
-- 숨김 댓글 제외
update public.comments set is_hidden = true where id = (select v from ids where k='c3');
select '숨김 댓글 검색(기대 0): ' || count(*) from public.api_list_posts('latest','감자',20,0);
-- LIKE 특수문자 이스케이프
select '와일드카드 % 검색(기대 0): ' || count(*) from public.api_list_posts('latest','%',20,0);
-- 10만자 댓글
insert into ids select 'big', public.api_create_comment((select v from ids where k='a'), null, null, '긴', repeat('가', 100000), 'pass1234');
select '10만자 댓글 저장(기대 100000): ' || char_length(body) from public.comments where id=(select v from ids where k='big');
do $$ begin
  perform public.api_create_comment((select v from ids where k='a'), null, null, '긴', repeat('가', 100001), 'pass1234');
  raise notice '10만1자 허용됨(오류!)';
exception when check_violation then raise notice '10만1자 거부됨(정상)'; end $$;
select '긴 댓글 내용 검색(기대 1건): ' || count(*) from public.api_list_posts('latest',repeat('가',50),20,0);
select '댓글 조회 limit(기대 2): ' || count(*) from public.api_get_comments((select v from ids where k='a'));
