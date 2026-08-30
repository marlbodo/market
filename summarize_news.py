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

class ArticleHTMLParser(HTMLParser):
    """기사 페이지에서 본문 문단(p 태그)을 정밀하게 추출하는 파서"""
    def __init__(self):
        super().__init__()
        self.in_body_tag = False
        self.text_chunks = []
        self.ignore = False

    def handle_starttag(self, tag, attrs):
        if tag in ['script', 'style', 'nav', 'footer', 'header', 'aside', 'advertisement']:
            self.ignore = True
        if tag == 'p':
            self.in_body_tag = True

    def handle_endtag(self, tag):
        if tag in ['script', 'style', 'nav', 'footer', 'header', 'aside', 'advertisement']:
            self.ignore = False
        if tag == 'p':
            self.in_body_tag = False

    def handle_data(self, data):
        if not self.ignore and self.in_body_tag:
            text = data.strip()
            if len(text) > 20: # 너무 짧은 문장 제외
                self.text_chunks.append(text)

    def get_body_text(self):
        return '\n'.join(self.text_chunks)

def fetch_real_article_text(google_news_url):
    """구글 뉴스 리디렉션을 풀어 실제 언론사 기사 본문을 긁어옴"""
    try:
        req = urllib.request.Request(
            google_news_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        # 리디렉션을 따라 최종 언론사 페이지로 이동
        with urllib.request.urlopen(req, timeout=8) as response:
            html_bytes = response.read()
            html_content = html_bytes.decode('utf-8', errors='ignore')
            
            parser = ArticleHTMLParser()
            parser.feed(html_content)
            body = parser.get_body_text()
            return body[:3000] # LLM 분석용으로 넉넉하게 추출
    except Exception as e:
        print(f"본문 크롤링 에러 ({google_news_url[:30]}...): {e}")
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
    
    # 요약이 안 되었거나 제목과 요약이 똑같은 항목 대상 선정
    items = [item for item in all_items if item.get('summary') == '요약 대기 중...' or item.get('summary') == item.get('title')]
    print(f"본문 정밀 요약 대상 뉴스: {len(items)}건")
    
    for index, item in enumerate(items):
        news_id = item['id']
        title = item['title']
        link = item.get('original_link')
        
        print(f"[{index+1}/{len(items)}] 본문 분석 중: {title[:20]}...")
        
        # 1. 실제 기사 본문 수집 시도
        article_body = ""
        if link:
            article_body = fetch_real_article_text(link)
            
        # 2. 본문을 성공적으로 가져왔으면 본문 기반 요약, 실패했으면 타이틀+안내 문구
        if len(article_body) > 100:
            prompt = (
                f"다음은 실제 금융 뉴스 기사의 본문 내용이다. 이 내용을 바탕으로 핵심 내용과 주요 수치, 시장 영향 등을 "
                f"줄바꿈을 포함하여 3~4문장의 풍부하고 상세한 요약문으로 작성해줘. "
                f"절대 제목을 그대로 복사하거나 반복하지 말고, 본문 내용을 분석해서 요약할 것.\n\n"
                f"[기사 제목]\n{title}\n\n"
                f"[기사 본문 내용]\n{article_body}"
            )
        else:
            prompt = (
                f"다음 금융 뉴스 제목을 바탕으로, 이 기사가 다루고 있는 배경과 의미를 금융 전문가의 시각에서 "
                f"3~4문장으로 상세히 풀어서 설명해줘.\n\n기사 제목: {title}"
            )
            
        summary_text = title
        try:
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
                print(f"-> 상세 요약 반영 완료")
        except Exception as e:
            print(f"DB 업데이트 실패: {e}")
            
        time.sleep(5)

if __name__ == "__main__":
    summarize_unread_news()
