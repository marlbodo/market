import os
import urllib.request
import json
import feedparser
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# 금융, 금리, 환율, 주식, 공모주, IPO 관련 검색 쿼리 명시
RSS_URL = "https://news.google.com/rss/search?q=금융+금리+환율+주식+공모주+IPO&hl=ko&gl=KR&ceid=KR:ko"

def clear_all_news():
    """파이프라인 실행 전 기존 뉴스 데이터를 모두 삭제하여 깨끗한 상태 유지"""
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
    print(f"수집된 원본 뉴스 총 건수: {len(entries)}")
    
    # 기준 시점: 현재 시간(UTC 기준) 및 정확히 3일(72시간) 전 계산
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

        # [핵심 필터링] 2025년 등 오래된 기사 및 3일 이전 기사는 엄격히 제외
        # 단, RSS 날짜 데이터 자체가 왜곡되어 너무 과거로 찍힌 경우를 방지하되, 명백히 오래된 연도(2025년 이전)는 무조건 스킵
        if published_at.year < 2026 or published_at < three_days_ago:
            continue

        published_at_str = published_at.isoformat()
        modified_at_str = modified_at.isoformat()
        
        # 카테고리 분류 (채권, 금리, 주식, 환율, 공모주/IPO)
        category = "기타"
        if any(k in title for k in ["공모주", "IPO", "상장"]):
            category = "공모주"
        elif any(k in title for k in ["금리", "채권", "국채", "기준금리"]):
            category = "채권/금리"
        elif any(k in title for k in ["환율", "달러", "원달러", "엔화", "위안화"]):
            category = "환율"
        elif any(k in title for k in ["주식", "증시", "코스피", "코스닥", "나스닥", "주가", "증권"]):
            category = "주식"

        # 국내 / 해외 분류
        region = "DOMESTIC"
        overseas_keywords = ["미국", "연준", "Fed", "중국", "일본", "유럽", "글로벌", "해외", "월가", "나스닥", "뉴욕", "파월"]
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
            print(f"저장 실패 ({title[:15]}...): {e}")
            
    print(f"최근 3일 이내 필터링된 신규 뉴스 {saved_count}건 저장 완료")

if __name__ == "__main__":
    fetch_and_store_news()
