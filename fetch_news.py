import os
import urllib.request
import json
import feedparser
from datetime import datetime

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

RSS_URL = "https://news.google.com/rss/search?q=금융+금리+환율+주식&hl=ko&gl=KR&ceid=KR:ko"

def fetch_and_store_news():
    feed = feedparser.parse(RSS_URL)
    print(f"수집된 원본 뉴스 건수: {len(feed.entries)}")
    
    for entry in feed.entries[:10]:
        title = entry.title
        link = entry.link
        published = entry.published_parsed
        if published:
            published_at = datetime(*published[:6]).isoformat()
        else:
            published_at = datetime.now().isoformat()
        
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

        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/financial_news",
            data=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req) as response:
                pass
        except urllib.error.HTTPError as e:
            print(f"저장 실패 ({title[:15]}...): HTTP {e.code} - {e.reason}")
        except Exception as e:
            print(f"저장 실패 ({title[:15]}...): {e}")
            
    print("뉴스 수집 및 저장 완료")

if __name__ == "__main__":
    fetch_and_store_news()
