# 😈 헛소리 대마왕

가입 없이 글·댓글을 쓰는 익명 커뮤니티. GitHub Pages(화면) + Supabase(DB·이미지·서버)로 돌아갑니다.

- 주소: https://marlbodo.github.io/nonsense/
- 관리자: `/admin/` (비밀번호만, 통계는 `/admin/stats.html`)

## 구조

```
index.html / post.html / write.html   화면 (정적 파일, 빌드 없이 그대로 동작)
admin/                                관리자 화면 (noindex)
assets/js, assets/css                 스크립트·스타일 (CSP: 인라인 스타일/스크립트 없음)
supabase/migrations/001~003.sql       DB 구조 · 서버 함수 · 보안/저장소 (이 순서로 실행)
supabase/functions/api/index.ts       Edge Function 'api' (모든 DB 접근은 여기로만)
tools/build-seo.mjs                   글별 정적 페이지·sitemap.xml·robots.txt 생성
tools/make-admin-hash.mjs             관리자 비밀번호 해시 생성기
.github/workflows/pages.yml           배포 (push · 15분마다 · 수동)
tests/                                화면 자동 테스트 + DB 함수 테스트
```

핵심 원칙: 브라우저는 DB에 직접 붙지 않습니다. 모든 테이블은 RLS 를 켜고 공개 권한이 없으며, Edge Function 이 service_role 로만 읽고 씁니다. 글·댓글 비밀번호는 bcrypt 해시로만 저장하고, 방문 통계는 개인 식별값 없이 집계 숫자만 저장합니다.

## 처음부터 설치하기

### 1. Supabase

1. [supabase.com](https://supabase.com) 에서 새 프로젝트를 만듭니다. (Project ref 를 메모: 주소의 `https://<ref>.supabase.co`)
2. **SQL Editor** 에서 `supabase/migrations/001_tables.sql` → `002_functions.sql` → `003_triggers_security.sql` 를 **순서대로** 실행합니다.
   - 테이블, 인덱스, 함수, 트리거, RLS, 정리 작업(cron), 이미지 저장소(비공개 버킷 `post-images`, 5MB, JPG/PNG/GIF/WebP)가 한 번에 만들어집니다.
   - `pg_cron` 이 없다는 오류가 나면 Database > Extensions 에서 `pg_cron` 을 켠 뒤 다시 실행합니다.
3. **Edge Functions > Deploy a new function**: 이름 `api`, `supabase/functions/api/index.ts` 내용을 통째로 붙여넣습니다. **Verify JWT 는 끕니다**(함수가 직접 인증합니다).
   - 코드를 고칠 때마다 파일 전체를 다시 붙여넣어 재배포해야 합니다.
4. **Edge Functions > Secrets** 에 두 값을 직접 입력합니다. (채팅·메신저에 붙여넣지 마세요)
   - `ALLOWED_ORIGINS` = `https://<계정>.github.io` (끝에 `/` 나 경로 없이. 틀리면 사이트가 서버 호출을 거부당해 목록이 안 뜹니다)
   - `ADMIN_PASSWORD_HASH` = 아래 2번에서 만든 한 줄

### 2. 관리자 비밀번호

본인 컴퓨터(Node 18+)에서:

```
node tools/make-admin-hash.mjs
```

비밀번호(12자 이상 권장)를 입력하면 `pbkdf2$sha256$...` 한 줄이 출력됩니다. 이 줄을 `ADMIN_PASSWORD_HASH` 시크릿에 저장합니다. 비밀번호 자체는 어디에도 저장되지 않습니다. 바꾸려면 새 해시로 시크릿만 교체하면 됩니다.

### 3. 화면 설정

`assets/js/config.js` 의 `API` 를 본인 프로젝트로 바꿉니다.

```js
API: "https://<ref>.supabase.co/functions/v1/api",
```

여기에는 공개되어도 되는 값만 둡니다. 비밀 키를 넣지 마세요.

### 4. GitHub Pages

1. 저장소를 만들고 이 폴더의 파일을 모두 올립니다. (웹 업로드는 `.github` 같은 점(.)으로 시작하는 폴더를 건너뜁니다. 저장소에서 **Add file > Create new file** 로 `.github/workflows/pages.yml` 을 만들어 내용을 붙여넣으세요)
2. **Settings > Pages > Build and deployment > Source** 를 **GitHub Actions** 로 선택합니다.
3. push 하면 자동 배포됩니다. 새 글을 정적 페이지·sitemap 에 반영하기 위해 15분마다도 자동으로 돕니다. **Actions** 탭에서 초록 체크를 확인하세요.
4. 사이트 주소가 `https://<계정>.github.io/<저장소>/` 가 아니면 저장소 변수 `SITE_URL` 에 실제 주소를 넣습니다. (Settings > Secrets and variables > Actions > Variables)

## 사용·운영

### 글쓰기 규칙

- 글 1~10만자, 제목 100자, 별명 20자, 댓글 1~10만자. 비밀번호 4자 이상(수정·삭제용, 분실 시 복구 불가).
- 이미지는 글당 1장, 5MB 이하, JPG/PNG/GIF/WebP. 글에서 "이미지 보기"를 눌러야 불러오며, 비공개 저장소의 60초짜리 주소로만 제공됩니다.
- 답글: 글 하나를 골라 "답글 쓰기"로 완전히 새 글을 씁니다. 목록에서 원글 바로 아래에 붙고, 한 단계만 들여씁니다. 더 깊은 답글은 같은 위치에 "↳ @대상"으로 표시합니다.
- 댓글/대댓글: 첫 답글 단계만 들여쓰고 이후는 같은 위치에 "↳ @대상"으로 표시합니다.
- 글 번호는 작성 순서로 고정입니다. 인기순은 같은 번호를 인기 순서로 다시 늘어놓은 것입니다.
- 삭제는 소프트 삭제입니다(내용만 가려지고 구조 유지). 답글이 달린 글은 영구 삭제할 수 없습니다.
- 도배 방지: IP 해시 기준 속도 제한(글 5분에 3개, 댓글 5분에 10개, 업로드 1시간에 5개 등).

### 관리자 (`/admin/`)

- 비밀번호로 로그인(12시간 세션). 글 목록은 전체/숨김/삭제/신고 필터.
- 글·댓글 수정, 숨김/숨김 해제, 삭제/복구, 영구 삭제(확인 필요), 첨부 이미지 숨김/영구 삭제.
- 신고 목록에서 처리 완료/기각. 관리자 작업은 `admin_audit` 에 기록됩니다.
- 로그인은 5회 실패 시 15분 제한이 걸립니다.

### 방문 통계 (`/admin/stats.html`)

방문(브라우저 탭 세션당 1회, 순방문자 아님)·페이지뷰·신규 글/댓글·시간대/요일·유입 경로(검색/외부/직접)·인기 글. 기준 시간대는 Asia/Seoul 이며 개인 식별값은 저장하지 않습니다.

### 검색엔진 등록 (최초 1회)

프로젝트 사이트(`계정.github.io/저장소/`)는 도메인 루트의 `robots.txt` 를 쓸 수 없어서 sitemap 을 직접 제출해야 합니다.

1. [Google Search Console](https://search.google.com/search-console) 에 URL 접두어 `https://<계정>.github.io/<저장소>/` 로 등록 후, Sitemaps 에 `sitemap.xml` 제출.
2. [네이버 서치어드바이저](https://searchadvisor.naver.com) 에 같은 주소로 사이트 등록 후, 요청 > 사이트맵 제출.

관리자·글쓰기·글 상세(동적) 페이지는 noindex 이고, 글마다 `/p/<id>/` 정적 페이지가 색인 대상입니다.

## 개발·테스트

```
pip install playwright        # 이미 설치되어 있으면 생략. 크롬 경로는 CHROME 환경변수로 지정 가능
python3 tests/ui_test.py      # 목록·상세·글쓰기·댓글·뒤로가기·들여쓰기 (38)
python3 tests/admin_test.py   # 관리자 로그인·수정·숨김·삭제·통계 (34)
python3 tests/reply_test.py   # 답글 글 (17)
python3 tests/seo_test.py     # 정적 페이지·sitemap·robots (11)
python3 tests/emoji_test.py   # PC 이모지 버튼 (10)
```

화면 테스트는 서버 응답을 가짜로 만들어 쓰므로 인터넷·DB 없이 돕니다. `tests/db_smoke.sql` 은 빈 Postgres 에서 DB 함수(번호·답글·추천·신고·제약)를 확인하는 스크립트이며, 파일 맨 위에 준비 방법이 있습니다. **운영 DB 에서는 실행하지 마세요.**

로컬 확인: 이 폴더에서 `python3 -m http.server 8000` 후 http://localhost:8000 (서버 주소는 config.js 의 API 를 사용합니다).

## 문제 해결

| 증상 | 확인 |
|---|---|
| 목록이 계속 "불러오는 중…" | 처음 접속은 서버가 깨어나느라 몇 초 걸릴 수 있습니다. 계속이면 `ALLOWED_ORIGINS` 값이 사이트 주소와 정확히 같은지(끝 `/` 없음), `config.js` 의 API 주소가 맞는지 확인 |
| 새 화면이 안 보임 | Actions 탭의 초록 체크 확인 후 Ctrl+F5 (폰은 새로고침 또는 캐시 삭제) |
| Actions 실패 "No artifacts named github-pages" | `pages.yml` 이 build/deploy 두 단계(job)로 되어 있는지 확인 |
| 이미지가 안 올라감 | 5MB 이하 JPG/PNG/GIF/WebP 인지, 글 등록 후 업로드 단계에서 실패한 경우 글 수정에서 다시 첨부 |
| 관리자 로그인이 안 됨 | `ADMIN_PASSWORD_HASH` 시크릿 확인. 5회 실패 시 15분 대기 |
| 글 비밀번호를 잊음 | 복구 불가. 관리자 화면에서 수정/삭제 |
| 서버 오류가 계속 남 | Supabase 대시보드 > Edge Functions > api > Logs. 로그에는 비밀번호·본문이 남지 않습니다 |

## 보안 요약

- RLS 전 테이블 활성, anon/authenticated 권한 없음, 함수는 service_role 만 실행.
- 비밀번호: bcrypt(글·댓글), PBKDF2-SHA256 600,000회(관리자). 세션 토큰은 해시로만 저장.
- 입력 검증(길이·제어문자 제거), 이미지는 파일 머리(매직 바이트)로 형식 판별 후 content-type 고정, 비공개 버킷 + 60초 서명 주소.
- CORS 는 `ALLOWED_ORIGINS` 로 제한, CSP 로 외부 스크립트·인라인 코드 차단, 화면은 `textContent` 로만 렌더링(XSS 방지).
- 속도 제한 키·투표 토큰은 서버 전용 HMAC 키로 해시(원본 IP·토큰 비저장).
