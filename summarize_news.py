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
    rest_url = f"{SUPABASE_URL}/rest/v1/financial_news?select=id,title,summary"
    
    req = urllib.request.Request(rest_url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    })
    
    try:
        with urllib.request.urlopen(req) as response:
            all_items = json.loads(response.read().decode())
    except Exception as e:
        print(f"대상 조회 실패: {e}")
        return
    
    # 요약이 안 되어 있거나 타이틀과 정확히 똑같은 항목들 대상 선정
    items = [item for item in all_items if item.get('summary') == '요약 대기 중...' or item.get('summary') == item.get('title')]
    print(f"AI 요약 대상 뉴스: {len(items)}건")
    
    for index, item in enumerate(items):
        news_id = item['id']
        title = item['title']
        snippet = item.get('summary', '') # fetch 단계에서 넘어온 스니펫 활용
        
        # 스니펫이 너무 짧거나 대기 중 문구면 타이틀 기반 심층 요약 유도
        content_to_use = snippet if snippet and snippet != '요약 대기 중...' else title
        
        print(f"[{index+1}/{len(items)}] 요약 중: {title[:20]}...")
        
        summary_text = title
        try:
            prompt = (
                f"다음 금융 뉴스 정보를 바탕으로, 시장에 미치는 영향과 핵심 내용을 2~3문장의 자연스럽고 풍부한 요약문으로 작성해줘. "
                f"절대 제목을 그대로 복사하지 말고, 내용을 분석하여 요약할 것.\n\n"
                f"기사 제목: {title}\n"
                f"기사 내용/요약: {content_to_use}"
            )
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt
            )
            if response and response.text:
                generated = response.text.strip()
                if generated:
                    summary_text = generated
        except Exception as e:
            print(f"Gemini 요약 에러: {e}")
            time.sleep(10)
        
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
                print(f"-> 요약 완료 DB 반영")
        except Exception as e:
            print(f"DB 업데이트 실패: {e}")
            
        time.sleep(5)

if __name__ == "__main__":
    summarize_unread_news()
