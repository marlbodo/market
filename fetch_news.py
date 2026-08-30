import os
import urllib.request
import json
import feedparser
from datetime import datetime

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

RSS_URL = "https://news.google.com/rss/search?q=금융+금리+환율+주식&hl=ko&gl=KR&ceid=KR:ko"

def clear_all_news():
    """테이블의 기존 데이터를 모두 삭제"""
    # id=gt.0 조건은 테이블의 모든 행을 의미합니다.
    delete_url = f"{SUPABASE_URL}/rest/v1/financial_news?id=gt.0"
    
    req = urllib.request.Request(
        delete_url,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Prefer": "return=minimal"
        },
        method="DELETE"
    )
    try:
        with urllib.request.urlopen(req):
            print("기존 뉴스 데이터 전체 초기화 완료")
    except Exception as e:
        print(f"데이터 초기화 중 에러 발생: {e}")

def fetch_and_store_news():
    # 1. 수집 전 기존 데이터 싹 비우기
    clear_all_news()
    
    # 2. 새로운 뉴스 수집 및 저장
    feed = feedparser.parse(RSS_URL)
    print(f"수집된 원본 뉴스 건수: {len(feed.entries)}")
    
    for entry in feed.entries[:15]: # 넉넉하게 15개 정도 수집
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
                "Content-Type": "application/json"
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req):
                pass
        except Exception as e:
            print(f"저장 실패 ({title[:15]}...): {e}")
            
    print("새로운 뉴스 수집 및 저장 완료")

if __name__ == "__main__":
    fetch_and_store_news()
