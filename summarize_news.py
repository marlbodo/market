import os
import urllib.request
import json
from google import genai

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

client = genai.Client(api_key=GEMINI_API_KEY)

def summarize_unread_news():
    # 요약이 안 된 항목 조회
    rest_url = f"{SUPABASE_URL}/rest/v1/financial_news?summary=eq.요약 대기 중...&select=id,title"
    req = urllib.request.Request(rest_url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    })
    
    with urllib.request.urlopen(req) as response:
        items = json.loads(response.read().decode())
    
    print(f"요약 대상 뉴스: {len(items)}건")
    
    for item in items:
        news_id = item['id']
        title = item['title']
        
        # Gemini AI 호출
        prompt = f"다음 금융 뉴스를 1~2문장으로 핵심만 요약해줘: {title}"
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt
        )
        summary_text = response.text.strip()
        
        # Supabase 업데이트
        patch_url = f"{SUPABASE_URL}/rest/v1/financial_news?id=eq.{news_id}"
        patch_data = json.dumps({
            "summary": summary_text,
            "importance_score": 4 # 예시 점수
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
                print(f"요약 완료 및 업데이트: {title[:20]}...")
        except Exception as e:
            print(f"업데이트 실패: {e}")

if __name__ == "__main__":
    summarize_unread_news()