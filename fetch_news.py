import os
import urllib.request
import json
import feedparser
from datetime import datetime, timezone

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# 다양한 금융 관련 검색어로 나누어 수집해야 풍부하게 가져올 수 있습니다.
SEARCH_QUERIES = [
    "채권 금리",
    "주식 증시",
    "원달러 환율",
    "공모주 IPO"
]

def clear_all_news():
    """기존 뉴스 데이터 초기화"""
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

def fetch_financial_news():
    clear_all_news()
    
    all_entries = []
    
    # 각 검색어별로 RSS 수집
    for query in SEARCH_QUERIES:
        encoded_query = urllib.parse.quote(query)
        rss_url = f"https://news.google.com/rss/search?q={encoded_query}&hl=ko&gl=KR&ceid=KR:ko"
        feed = feedparser.parse(rss_url)
        all_entries.extend(feed.entries)
        
    print(f"수집된 원본 뉴스 총 건수 (중복 포함): {len(all_entries)}")
    
    now_utc = datetime.now(timezone.utc)
    valid_dict = {} # 중복 링크 제거용
    
    target_keywords = ["채권", "금리", "국채", "주가", "주식", "증시", "코스피", "코스닥", "나스닥", "환율", "달러", "공모주", "IPO", "상장", "증권", "연준"]

    for entry in all_entries:
        title = entry.title
        link = entry.link
        
        # 중복 링크면 스킵
        if link in valid_dict:
            continue
            
        # 키워드 포함 여부 확인
        if not any(keyword in title for keyword in target_keywords):
            continue
            
        published = entry.get('published_parsed')
        if published:
            published_at = datetime(*published[:6], tzinfo=timezone.utc)
        else:
            published_at = now_utc
            
        # 2026년 기준 기사만 엄선 (너무 오래된 과거 기사 배제)
        if published_at.year < 2026:
            continue
            
        valid_dict[link] = (entry, published_at)
        
    valid_entries = list(valid_dict.values())
    print(f"2026년 기준 유효한 고유 뉴스 건수: {len(valid_entries)}")
    
    # 최신순 정렬 후 상위 15개 추출
    valid_entries.sort(key=lambda x: x[1], reverse=True)
    top_entries = valid_entries[:15]
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

if __name__ == "__main__":
    collected_news = fetch_financial_news()

    success_count = 0
    for news in collected_news:
        payload = json.dumps(news).encode('utf-8')
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/financial_news",
            data=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal"
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req):
                success_count += 1
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            print(f"저장 실패 ({news['title'][:15]}...): HTTP {e.code} - {error_body}")
        except Exception as e:
            print(f"저장 실패 ({news['title'][:15]}...): {e}")

    print(f"총 {success_count}건의 최신 뉴스 Supabase 저장 완료")
