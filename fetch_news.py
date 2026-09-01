import os
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
KEYWORDS = ["채권", "금리"]


def fetch_naver_news_for_keyword(keyword, display=30):
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
            print(f"  '{keyword}': {len(items)}건")
            return items
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


def fetch_naver_news(max_total=50):
    print(f"Loaded API Key ID: {API_KEY_ID[:4] if API_KEY_ID else 'None'}... (length: {len(API_KEY_ID) if API_KEY_ID else 0})")
    print(f"Loaded API Key: {API_KEY[:2] if API_KEY else 'None'}... (length: {len(API_KEY) if API_KEY else 0})")

    # link -> item, to dedupe articles that match multiple keywords
    merged = {}
    for keyword in KEYWORDS:
        for item in fetch_naver_news_for_keyword(keyword):
            link_key = item.get('originallink') or item.get('link')
            if link_key and link_key not in merged:
                merged[link_key] = item

    def sort_key(item):
        dt = parse_rfc822_date(item.get('pubDate'))
        return dt or ""

    items = sorted(merged.values(), key=sort_key, reverse=True)[:max_total]
    print(f"가져온 뉴스 개수(중복 제거 후): {len(items)}")
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
            link = item.get('originallink') if item.get('originallink') else item.get('link')
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
