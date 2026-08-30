import os
import urllib.request
import json
import feedparser
from datetime import datetime

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# 예시: 구글 뉴스 RSS 피드 수집 (금리, 주식, 환율 키워드)
RSS_URL = "https://news.google.com/rss/search?q=금융+금리+환율+주식&hl=ko&gl=KR&ceid=KR:ko"

def fetch_and_store_news():
    feed = feedparser.parse(RSS_URL)
    print(f"수집된 원본 뉴스 건수: {len(feed.entries)}")
    
    for entry in feed.entries[:10]: # 상위 10개 예시
        title = entry.title
        link = entry.link
        published = entry.published_parsed
        published_at = datetime(*published[:6]).isoformat()
        
        # 카테고리 간단 분류 로직
        category = "기타"
        if "금리" in title or "채권" in title:
            category = "채권"
        elif "주식" in title or "증시" in title or "코스피" in title:
            category = "주식"
        elif "환율" in title or "달러" in title:
            category = "환율"

        payload = json.dumps({
            "title": title,
            "original_link": link,
            "published_at": published_at,
            "category": category,
            "importance_score": 3,
            "summary": "요약 대기 중..."
        }).encode('utf-8')

        # Supabase 업서트(중복 방지 등 필요에 따라 조정) 혹은 인서트
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/financial_news",
            data=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates"
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req) as response:
                pass
        except Exception as e:
            print(f"저장 실패 ({title}): {e}")
    print("뉴스 수집 및 저장 완료")

if __name__ == "__main__":
    fetch_and_store_news()