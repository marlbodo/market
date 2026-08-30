import os
import time
import urllib.request
import urllib.parse
import json
from html.parser import HTMLParser
from google import genai

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

client = genai.Client(api_key=GEMINI_API_KEY)

class HTMLTextExtractor(HTMLParser):
    """HTML 태그를 제거하고 텍스트만 추출하는 파서"""
    def __init__(self):
        super().__init__()
        self.text_list = []
        self.ignore = False

    def handle_starttag(self, tag, attrs):
        if tag in ['script', 'style', 'nav', 'footer', 'header']:
            self.ignore = True

    def handle_endtag(self, tag):
        if tag in ['script', 'style', 'nav', 'footer', 'header']:
            self.ignore = False

    def handle_data(self, data):
        if not self.ignore:
            text = data.strip()
            if text:
                self.text_list.append(text)

    def get_text(self):
        return ' '.join(self.text_list)

def fetch_article_body(url):
    """뉴스 링크에 직접 접속하여 본문 텍스트 추출 (차단 방지 헤더 추가)"""
    try:
        req = urllib.request.Request(
            url, 
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
            parser = HTMLTextExtractor()
            parser.feed(html_content)
            return parser.get_text()[:1500] # 너무 길면 잘라냄
    except Exception as e:
        print(f"본문 스크래핑 실패 ({url}): {e}")
        return ""

def summarize_unread_news():
    rest_url = f"{SUPABASE_URL}/rest/v1/financial_news?select=id,title,summary,original_link"
    
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
    
    # 요약이 안 되어 있거나 제목과 요약이 똑같은 항목 대상 선정
    items = [item for item in all_items if item.get('summary') == '요약 대기 중...' or item.get('summary') == item.get('title')]
    print(f"실제 본문 요약 대상 뉴스: {len(items)}건")
    
    for index, item in enumerate(items):
        news_id = item['id']
        title = item['title']
        link = item.get('original_link')
        
        # 1. 링크에서 본문 가져오기 시도
        body_text = ""
        if link:
            print(f"[{index+1}/{len(items)}] 본문 가져오는 중: {title[:20]}...")
            body_text = fetch_article_body(link)
            
        # 2. 본문이 없거나 너무 짧으면 제목 기반으로 fallback, 있으면 본문 기반으로 요약
        target_content = body_text if len(body_text) > 100 else title
        
        summary_text = f"핵심: {title}"
        try:
            prompt = f"다음 금융 뉴스의 내용을 바탕으로 핵심 포인트를 2~3문장으로 명확하게 요약해줘:\n\n제목: {title}\n본문 내용: {target_content}"
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt
            )
            if response and response.text:
                summary_text = response.text.strip()
        except Exception as e:
            print(f"Gemini 요약 에러: {e}")
            time.sleep(10)
        
        # 3. Supabase 업데이트
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
                print(f"본문 요약 완료 및 업데이트 반영됨")
        except Exception as e:
            print(f"DB 업데이트 실패: {e}")
            
        time.sleep(5)

if __name__ == "__main__":
    summarize_unread_news()
