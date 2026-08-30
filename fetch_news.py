import os
import urllib.request
import json
import feedparser
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

RSS_URL = "https://news.google.com/rss/search?q=금융+금리+환율+주식+공모주+IPO&hl=ko&gl=KR&ceid=KR:ko"

def clear_all_news():
    """파이프라인 실행 전 기존 뉴스 데이터를 모두 삭제"""
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
    clear_all_news()
    
    feed = feedparser.parse(RSS_URL)
    entries = feed.entries
    print(f"수집된 원본 뉴스 건수: {len(entries)}")
    
    # 현재 시간 기준 정확히 3일(72시간) 전 계산
    now_utc = datetime.now(timezone.utc)
    three_days_ago = now_utc - timedelta(days=3)
    
    saved_count = 0
    
    for entry in entries:
        title = entry.title
        link = entry.link
        
        # 발행일시 파싱
        published = entry.get('published_parsed')
        if published:
            published_at = datetime(*published[:6], tzinfo=timezone.utc)
        else:
            published_at = now_utc
            
        # 수정일시 파싱
        updated = entry.get('updated_parsed')
        if updated:
            modified_at = datetime(*updated[:6], tzinfo=timezone.utc)
        else:
            modified_at = published_at

        # [핵심] 정확히 최근 3일(72시간) 이내 기사만 필터링
        if published_at < three_days_ago:
            continue

        published_at_str = published_at.isoformat()
        modified_at_str = modified_at.isoformat()
        
        # 카테고리 분류
        category = "기타"
        if "공모주" in title or "IPO" in title or "상장" in title:
            category = "공모주"
        elif "금리" in title or "채권" in title:
            category = "채권"
        elif "주식" in title or "증시" in title or "코스피" in title:
            category = "주식"
        elif "환율" in title or "달러" in title:
            category = "환율"

        # 국내 / 해외 분류
        region = "DOMESTIC"
        overseas_keywords = ["미국", "연준", "Fed", "중국", "일본", "유럽", "글로벌", "해외", "월가", "나스닥", "뉴욕"]
        if any(keyword in title for keyword in overseas_keywords):
            region = "OVERSEAS"

        payload = json.dumps({
            "title": title,
            "original_link": link,
            "published_at": published_at_str,
            "modified_at": modified_at_str,
            "category": category,
            "region": region,
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
            with urllib.request.urlopen(req):
                saved_count += 1
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            print(f"저장 실패 ({title[:15]}...): HTTP {e.code} - {error_body}")
        except Exception as e:
            print(f"저장실패 ({title[:15]}...): {e}")
            
    print(f"최근 3일 이내 신규 뉴스 {saved_count}건 저장 완료")

if __name__ == "__main__":
    fetch_and_store_news()
