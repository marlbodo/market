import os
import re
import difflib
import urllib.request
import urllib.parse
import json
from email.utils import parsedate_to_datetime
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

API_KEY_ID = os.environ.get("NAVER_CLIENT_ID")
API_KEY = os.environ.get("NAVER_CLIENT_SECRET")


# The Naver search API has no boolean operator syntax (no "OR"/"AND" keywords) —
# it's a plain full-text query. So instead of one query string joined with " OR ",
# we call the API once per keyword and merge/dedupe the results ourselves.
# We also use this same list to filter by TITLE only (see fetch_naver_news_for_keyword),
# so search and filtering stay consistent — no separate "content keyword" search.
# ("고용" removed — too broad, matches unrelated things like 장애인 의무고용.)
TITLE_FILTER_WORDS = ["채권", "금리", "기준금리", "연준", "CPI", "물가", "한국은행", "총재", "워시", "신현송"]

# Even when a title contains a TITLE_FILTER_WORDS match, it's often noise:
# personal/retail loan-rate promos (생계비 융자금리, 은행 이벤트 금리), Chuseok
# grocery shopping news, or unrelated compound words that merely CONTAIN a
# filter word as a substring (중금리대출 contains "금리" but means a mid-credit
# consumer loan product, not a market/policy rate). Titles containing any of
# these are dropped even if they'd otherwise pass the TITLE_FILTER_WORDS check.
TITLE_EXCLUDE_WORDS = [
    "생계비", "용자금리", "융자금리", "햇살론", "페이백", "이벤트", "특판", "우대금리",
    "성수품", "장바구니", "차례상",
    "적금", "예금",
    "중금리",
]

# Some filter words are themselves substrings of unrelated words, so a plain
# "word in title" check produces false positives. "채권" (bond) is a prefix
# of "채권자" (creditor/obligee) — a completely different concept that just
# happens to share the same two syllables. For these words we match with a
# regex that excludes the false-positive suffix instead of a plain substring
# check.
TITLE_FILTER_WORD_PATTERNS = {
    "채권": re.compile(r"채권(?!자)"),
}


def title_contains_filter_word(title, word):
    pattern = TITLE_FILTER_WORD_PATTERNS.get(word)
    if pattern:
        return bool(pattern.search(title))
    return word in title


def normalize_title(title):
    # Strip Naver's <b> highlight tags and common HTML entities, then
    # collapse whitespace, so near-identical titles compare equal.
    clean = title.replace('<b>', '').replace('</b>', '').replace('&quot;', '"').replace('&amp;', '&')
    return " ".join(clean.split()).strip()


def is_near_duplicate_title(title, existing_titles, threshold=0.6):
    # Different outlets often cover the exact same story with slightly
    # reworded headlines (e.g. "주식·채권 팔아 집 샀다...올해 1~7월에만 8조 넘어"
    # vs "...7개월간 주택시장으로 8조원 이동"). An exact-string dedupe misses
    # these, so we also compare similarity ratios and drop close matches.
    for existing in existing_titles:
        if difflib.SequenceMatcher(None, title, existing).ratio() >= threshold:
            return True
    return False


def fetch_naver_news_for_keyword(keyword, display=50):
    encoded_query = urllib.parse.quote(keyword)

    # NAVER API HUB: no ".json" in the path. Response format is chosen
    # via the "format" query param (defaults to json anyway, but explicit is safer).
    url = (
        "https://naverapihub.apigw.ntruss.com/search/v1/news"
        f"?query={encoded_query}&display={display}&start=1&sort=date&format=json"
    )

    request = urllib.request.Request(url)
    request.add_header("X-NCP-APIGW-API-KEY-ID", API_KEY_ID.strip() if API_KEY_ID else "")
    request.add_header("X-NCP-APIGW-API-KEY", API_KEY.strip() if API_KEY else "")

    try:
        response = urllib.request.urlopen(request)
        if response.getcode() == 200:
            data = json.loads(response.read().decode('utf-8'))
            items = data.get('items', [])
            # Naver's full-text search also matches the keyword when it only
            # appears inside the body/summary. To keep the feed focused on
            # articles that are actually about the topic, only keep items
            # whose title contains at least one word from TITLE_FILTER_WORDS,
            # and drop items whose title contains a TITLE_EXCLUDE_WORDS noise word.
            on_topic = []
            for it in items:
                title = normalize_title(it.get('title', ''))
                if not any(title_contains_filter_word(title, w) for w in TITLE_FILTER_WORDS):
                    continue
                if any(w in title for w in TITLE_EXCLUDE_WORDS):
                    continue
                on_topic.append(it)
            print(f"  '{keyword}': {len(items)}건 조회, 제목 매칭 {len(on_topic)}건")
            return on_topic
    except urllib.error.HTTPError as e:
        print(f"  '{keyword}' 에러 코드: {e.code}, 사유: {e.reason}")
        try:
            err_body = e.read().decode('utf-8')
            err_json = json.loads(err_body)
            err_obj = err_json.get("error", err_json)
            print(f"  파싱된 에러 코드: {err_obj.get('errorCode')}, 메시지: {err_obj.get('message') or err_obj.get('errorMessage')}")
        except Exception:
            pass
    except Exception as e:
        print(f"  '{keyword}' 호출 에러: {e}")
    return []


def fetch_naver_news(max_total=30):
    print(f"Loaded API Key ID: {API_KEY_ID[:4] if API_KEY_ID else 'None'}... (length: {len(API_KEY_ID) if API_KEY_ID else 0})")
    print(f"Loaded API Key: {API_KEY[:2] if API_KEY else 'None'}... (length: {len(API_KEY) if API_KEY else 0})")

    # Dedupe by link AND by title similarity — the same story is often
    # republished under different URLs (different outlets/syndication) with
    # a reworded but very similar headline, which an exact-string compare misses.
    merged = {}
    seen_titles = []
    for keyword in TITLE_FILTER_WORDS:
        for item in fetch_naver_news_for_keyword(keyword):
            # Prefer Naver's own internal link (news.naver.com) when available;
            # fall back to the original publisher's URL otherwise.
            link_key = item.get('link') or item.get('originallink')
            title_key = normalize_title(item.get('title', ''))
            if not link_key or link_key in merged:
                continue
            if title_key and is_near_duplicate_title(title_key, seen_titles):
                continue
            merged[link_key] = item
            if title_key:
                seen_titles.append(title_key)

    def sort_key(item):
        dt = parse_rfc822_date(item.get('pubDate'))
        return dt or ""

    items = sorted(merged.values(), key=sort_key, reverse=True)[:max_total]
    print(f"가져온 뉴스 개수(중복 제거 후, 최대 {max_total}건): {len(items)}")
    return items


def parse_rfc822_date(date_str):
    if not date_str:
        return None
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.isoformat()
    except Exception:
        return None


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Supabase 환경 변수가 설정되지 않았습니다.")
        return
    if not API_KEY_ID or not API_KEY:
        print("NCP API 인증 정보가 설정되지 않았습니다.")
        return

    news_items = fetch_naver_news()
    if not news_items:
        print("가져온 뉴스가 없습니다.")
        return

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    try:
        supabase.table("financial_news").delete().gt("id", 0).execute()
        print("기존 financial_news 테이블 데이터를 모두 비웠습니다.")

        rows_to_insert = []
        for item in news_items:
            title = item.get('title', '').replace('<b>', '').replace('</b>', '').replace('&quot;', '"').replace('&amp;', '&')
            summary = item.get('description', '').replace('<b>', '').replace('</b>', '').replace('&quot;', '"').replace('&amp;', '&')
            # Prefer Naver's own internal link (news.naver.com) when available;
            # fall back to the original publisher's URL otherwise.
            link = item.get('link') if item.get('link') else item.get('originallink')
            pub_date = parse_rfc822_date(item.get('pubDate'))

            rows_to_insert.append({
                "title": title,
                "summary": summary,
                "link": link,
                "article_published_at": pub_date,
                "article_modified_at": pub_date
            })

        supabase.table("financial_news").insert(rows_to_insert).execute()
        print(f"성공적으로 {len(rows_to_insert)}개의 최신 뉴스를 Supabase에 저장했습니다.")
    except Exception as e:
        print(f"Supabase 작업 중 오류 발생: {e}")


if __name__ == "__main__":
    main()
