import os
import feedparser
from datetime import datetime, timezone, timedelta
from supabase import create_client, Client
import urllib.parse

# 1. Supabase 연결 설정
SUPABASE_URL = "https://hnxvsopwxiamexnxczhj.supabase.co"
SUPABASE_KEY = "sb_publishable_1_9-bKTcV3sBQkv10ru__w_iW-51pKt"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# 2. 채권, 금리, 주가, 환율, 공모주, IPO 관련 통합 검색 쿼리
RSS_URL = "https://news.google.com/rss/search?q=채권+금리+주가+환율+공모주+IPO&hl=ko&gl=KR&ceid=KR:ko"

def clear_all_news():
    """기존 뉴스 데이터를 초기화하여 항상 최신 상태 유지"""
    try:
        supabase.table("financial_news").delete().gt("id", 0).execute()
        print("기존 뉴스 데이터 전체 초기화 완료")
    except Exception as e:
        print(f"데이터 초기화 중 에러 발생: {e}")

def fetch_financial_news():
    clear_all_news()
    
    feed = feedparser.parse(RSS_URL)
    entries = feed.entries
    print(f"수집된 원본 뉴스 총 건수: {len(entries)}")
    
    now_utc = datetime.now(timezone.utc)
    # 현재 날짜 기준 너무 오래된 기사(2025년 이전 등)는 엄격히 필터링
    valid_entries = []
    
    target_keywords = ["채권", "금리", "국채", "주가", "주식", "증시", "코스피", "코스닥", "나스닥", "환율", "달러", "공모주", "IPO", "상장", "증권", "연준"]

    for entry in entries:
        title = entry.title
        
        # 키워드 포함 여부 확인
        if not any(keyword in title for keyword in target_keywords):
            continue
            
        published = entry.get('published_parsed')
        if published:
            published_at = datetime(*published[:6], tzinfo=timezone.utc)
        else:
            published_at = now_utc
            
        # 2025년 이전 또는 터무니없는 과거 날짜 기사는 배제 (단, 최신 뉴스가 부족할 경우를 대비해 2026년 이후 또는 최근 7일 이내 우선)
        if published_at.year < 2026:
            continue
            
        valid_entries.append((entry, published_at))
        
    print(f"2026년 기준 키워드 필터링 통과 뉴스 건수: {len(valid_entries)}")
    
    # 최신순 정렬 후 상위 10개 추출
    valid_entries.sort(key=lambda x: x[1], reverse=True)
    top_entries = valid_entries[:10]
    print(f"저장할 최종 최신 뉴스 건수: {len(top_entries)}")
    
    news_list = []
    
    for entry, published_at in top_entries:
        title = entry.title
        link = entry.link
        
        updated = entry.get('updated_parsed')
        if updated:
            modified_at = datetime(*updated[:6], tzinfo=timezone.utc).isoformat()
        else:
            modified_at = published_at.isoformat()

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

        news_item = {
            "title": title,
            "summary": "요약 대기 중...",
            "original_link": link,
            "category": category,
            "region": region,
            "importance_score": 3,
            "published_at": published_at.isoformat(),
            "modified_at": modified_at
        }
        news_list.append(news_item)
        
    return news_list

# 3. 뉴스 데이터 수집 및 Supabase 저장 실행
collected_news = fetch_financial_news()

success_count = 0
for news in collected_news:
    try:
        response = supabase.table("financial_news").upsert(
            news, 
            on_conflict="original_link"
        ).execute()
        success_count += 1
    except Exception as e:
        print(f"저장 실패 ({news['title']}): {e}")

print(f"총 {success_count}건의 최신 뉴스 Supabase 저장 완료")
