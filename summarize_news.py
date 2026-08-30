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
    """HTML 태그를 제거하고 기사 본문 텍스트만 깔끔하게 추출하는 파서"""
    def __init__(self):
        super().__init__()
        self.text_list = []
        self.ignore = False

    def handle_starttag(self, tag, attrs):
        if tag in ['script', 'style', 'nav', 'footer', 'header', 'aside']:
            self.ignore = True

    def handle_endtag(self, tag):
        if tag in ['script', 'style', 'nav', 'footer', 'header', 'aside']:
            self.ignore = False

    def handle_data(self, data):
        if not self.ignore:
            text = data.strip()
            if text:
                self.text_list.append(text)

    def get_text(self):
        return ' '.join(self.text_list)

def fetch_article_body(url):
    """구글 뉴스 리디렉션을 거쳐 실제 언론사 페이지의 본문을 스크래핑"""
    try:
        req = urllib.request.Request(
            url, 
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        # 구글 뉴스 링크 리디렉션 따라가기
        with urllib.request.urlopen(req, timeout=7) as response:
            final_url = response.url
            html_content = response.read().decode('utf-8', errors='ignore')
            
            parser = HTMLTextExtractor()
            parser.feed(html_content)
            body_text = parser.get_text()
            return body_text[:2000] # LLM에 전달할 적정 길이로 자르기
    except Exception as e:
        print(f"본문 스크래핑 실패: {e}")
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
        
        # 1. 실제 링크에서 본문 추출
        print(f"[{index+1}/{len(items)}] 본문 수집 및 요약 중: {title[:25]}...")
        body_text = ""
        if link:
            body_text = fetch_article_body(link)
            
        # 2. 본문이 스크래핑되었으면 본문 내용 활용, 실패했으면 제목 활용
        target_content = body_text if len(body_text) > 150 else title
        
        summary_text = title # 최후의 fallback
        try:
            prompt = (
                f"다음 금융 기사의 본문 내용을 읽고, 핵심 내용을 객관적이고 자연스러운 2~3문장으로 요약해줘. "
                f"절대 제목을 그대로 반복하거나 '핵심:' 같은 불필요한 머리말을 붙이지 말고 바로 요약문만 작성해줘.\n\n"
                f"기사 제목: {title}\n"
                f"기사 본문: {target_content}"
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
        
        # 3. Supabase에 요약문 반영
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
                print(f"-> 요약 DB 반영 완료")
        except Exception as e:
            print(f"DB 업데이트 실패: {e}")
            
        # 쿼타 방지 및 안정적인 처리를 위한 대기
        time.sleep(5)

if __name__ == "__main__":
    summarize_unread_news()
