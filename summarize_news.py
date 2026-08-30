import os
import time
import urllib.request
import urllib.parse
import json
from google import genai

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

client = genai.Client(api_key=GEMINI_API_KEY)

def summarize_unread_news():
    query_params = urllib.parse.urlencode({
        "summary": "eq.요약 대기 중...",
        "select": "id,title"
    })
    rest_url = f"{SUPABASE_URL}/rest/v1/financial_news?{query_params}"
    
    req = urllib.request.Request(rest_url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    })
    
    try:
        with urllib.request.urlopen(req) as response:
            items = json.loads(response.read().decode())
    except Exception as e:
        print(f"요약 대상 조회 실패: {e}")
        return
    
    print(f"요약 대상 뉴스: {len(items)}건")
    
    for index, item in enumerate(items):
        news_id = item['id']
        title = item['title']
        
        summary_text = title # API 호출 실패 시 원본 제목으로 대체
        
        try:
            prompt = f"다음 금융 뉴스를 핵심 위주로 1~2문장으로 간결하게 요약해줘: {title}"
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt
            )
            if response and response.text:
                summary_text = response.text.strip()
        except Exception as e:
            print(f"Gemini 요약 한도 초과 또는 에러 ({title[:15]}...): {e}")
            print("쿼타 제한 회복을 위해 15초 대기 후 다음으로 진행합니다...")
            time.sleep(15)
        
        patch_url = f"{SUPABASE_URL}/rest/v1/financial_news?id=eq.{news_id}"
        patch_data = json.dumps({
            "summary": summary_text,
            "importance_score": 4
        }).encode('utf-8')
        
        update_req = urllib.request.Request(
            patch_url,
            data=patch_data,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            method="PATCH"
        )
        try:
            with urllib.request.urlopen(update_req):
                print(f"요약 완료 및 업데이트 ({index+1}/{len(items)}): {title[:20]}...")
        except Exception as e:
            print(f"데이터베이스 업데이트 실패: {e}")
            
        # [중요] 무료 티어 쿼타 제한(RPM)을 피하기 위해 각 요청마다 8초 이상 대기
        time.sleep(8)

if __name__ == "__main__":
    summarize_unread_news()
