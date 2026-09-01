import os
import time
import hmac
import hashlib
import base64
import urllib.request
import urllib.parse
import json
from email.utils import parsedate_to_datetime
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

ACCESS_KEY = os.environ.get("NAVER_CLIENT_ID")
SECRET_KEY = os.environ.get("NAVER_CLIENT_SECRET")

def make_signature(method, uri, timestamp, access_key, secret_key):
    space = " "
    newLine = "\n"
    
    message = method + space + uri + newLine + timestamp + newLine + access_key
    message = bytes(message, 'UTF-8')
    secret_key = bytes(secret_key, 'UTF-8')
    
    sign_key = hmac.new(secret_key, message, digestmod=hashlib.sha256).digest()
    return base64.b64encode(sign_key).decode('UTF-8')

def fetch_naver_news():
    print(f"Loaded Access Key: {ACCESS_KEY[:4] if ACCESS_KEY else 'None'}... (length: {len(ACCESS_KEY) if ACCESS_KEY else 0})")
    print(f"Loaded Secret Key: {SECRET_KEY[:2] if SECRET_KEY else 'None'}... (length: {len(SECRET_KEY) if SECRET_KEY else 0})")

    query = "채권 OR 금리 OR 기준금리 OR 연준 OR CPI OR 물가 OR 고용 OR 한국은행 OR 총재 OR 워시 OR 신현송"
    encoded_query = urllib.parse.quote(query)
    
    # [주의] NCP API HUB 가이드에 명시된 정확한 경로(예: /apihub/v1/search/news.json 또는 제품별 고유 경로)를 확인해 넣어야 합니다.
    # 현재 404가 나는 이유는 아래 URI 경로가 API Gateway에 등록된 리소스 경로와 다르기 때문입니다.
    uri = f"/v1/search/news.json?query={encoded_query}&display=50&sort=date"
    url = f"https://apigateway.apigw.ntruss.com{uri}"
    
    timestamp = str(int(time.time() * 1000))
    signature = make_signature("GET", uri, timestamp, ACCESS_KEY, SECRET_KEY)
    
    request = urllib.request.Request(url)
    request.add_header("x-ncp-apigw-timestamp", timestamp)
    request.add_header("x-ncp-iam-access-key", ACCESS_KEY.strip())
    request.add_header("x-ncp-apigw-signature-v2", signature)
    
    try:
        response = urllib.request.urlopen(request)
        if response.getcode() == 200:
            data = json.loads(response.read().decode('utf-8'))
            return data.get('items', [])
    except urllib.error.HTTPError as e:
        print(f"네이버 API HTTP 에러 코드: {e.code}, 사유: {e.reason}")
        try:
            err_body = e.read().decode('utf-8')
            print(f"에러 상세 내용: {err_body}")
        except:
            pass
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

    if not ACCESS_KEY or not SECRET_KEY:
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
