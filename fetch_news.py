import os
import urllib.request
import urllib.parse
import json
from datetime import datetime
from email.utils import parsedate_to_datetime
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

NAVER_CLIENT_ID = os.environ.get("NAVER_CLIENT_ID")
NAVER_CLIENT_SECRET = os.environ.get("NAVER_CLIENT_SECRET")

def fetch_naver_news():
    # 디버깅을 위해 전달된 ID/Secret의 길이와 앞 두 글자 확인 (보안을 위해 전체 노출은 안 함)
    print(f"Loaded NAVER_CLIENT_ID: {NAVER_CLIENT_ID[:4] if NAVER_CLIENT_ID else 'None'}... (length: {len(NAVER_CLIENT_ID) if NAVER_CLIENT_ID else 0})")
    print(f"Loaded NAVER_CLIENT_SECRET: {NAVER_CLIENT_SECRET[:2] if NAVER_CLIENT_SECRET else 'None'}... (length: {len(NAVER_CLIENT_SECRET) if NAVER_CLIENT_SECRET else 0})")

    query = "채권 금리"
    encoded_query = urllib.parse.quote(query)
    url = f"https://openapi.naver.com/v1/search/news.json?query={encoded_query}&display=30&sort=date"
    
    request = urllib.request.Request(url)
    request.add_header("X-Naver-Client-Id", NAVER_CLIENT_ID.strip() if NAVER_CLIENT_ID else "")
    request.add_header("X-Naver-Client-Secret", NAVER_CLIENT_SECRET.strip() if NAVER_CLIENT_SECRET else "")
    
    try:
        response = urllib.request.urlopen(request)
        if response.getcode() == 200:
            data = json.loads(response.read().decode('utf-8'))
            return data.get('items', [])
    except urllib.error.HTTPError as e:
        print(f"네이버 API HTTP 에러 코드: {e.code}, 사유: {e.reason}")
    except Exception as e:
        print(f"네이버 API 호출 에러: {e}")
    return []

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

    if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
        print("네이버 API 인증 정보가 설정되지 않았습니다.")
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
