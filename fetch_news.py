import os
import urllib.request
import json
import feedparser
from datetime import datetime, timezone

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
    print(f"수집된 원본 뉴스 총 건수: {len(entries)}")
    
    valid_entries = []
    
    # 1단계: 채권, 금리, 주식, 환율, 공모주, IPO 관련 키워드가 포함된 뉴스만 먼저 선별
    target_keywords = ["금리", "채권", "국채", "주식", "증시", "코스피", "코스닥", "나스닥", "환율", "달러", "공모주", "IPO", "상장", "증권", "연준"]
    
    for entry in entries:
        title = entry.title
        if any(keyword in title for keyword in target_keywords):
            valid_entries.append(entry)
            
    print(f"키워드 필터링 통과 뉴스 건수: {len(valid_entries)}")
    
    # 2단계: 선별된 뉴스 중 가장 최신 상위 10개만 확정
    target_entries = valid_entries[:10]
    print(f"저장할 최종 최신 뉴스 건수: {len(target_entries)}")
    
    saved_count = 0
    now_utc = datetime.now(timezone.utc)
    
    for entry in target_entries:
        title = entry.title
        link = entry.link
        
        published = entry.get('published_parsed')
        if published:
            published_at = datetime(*published[:6], tzinfo=timezone.utc)
        else:
            published_at = now_utc
            
        updated = entry.get('updated_parsed')
        if updated:
            modified_at = datetime(*updated[:6], tzinfo=timezone.utc)
        else:
            modified_at = published_at

        # 연도가 너무 터무니없이 과거(2024년 이전 등)인 경우 현재 시간으로 보정하여 리포트 누락 방지
        if published_at.year < 2025:
            published_at = now_utc
            modified_at = now_utc

        published_at_str = published_at.isoformat()
        modified_at_str = modified_at.isoformat()
        
        # 카테고리 분류
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
            
    print(f"최종 신규 뉴스 {saved_count}건 저장 완료")

if __name__ == "__main__":
    fetch_and_store_news()
