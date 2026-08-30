import os
import urllib.request
import urllib.parse
import json
import feedparser
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

SEARCH_QUERIES = [
    "채권 금리",
    "주식 증시",
    "원달러 환율",
    "공모주 IPO"
]

def clear_all_news():
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
            print("기존 뉴스 데이터 초기화 완료")
    except Exception as e:
        print(f"데이터 초기화 에러: {e}")

def fetch_financial_news():
    clear_all_news()
    
    all_entries = []
    for query in SEARCH_QUERIES:
        encoded_query = urllib.parse.quote(query)
        rss_url = f"https://news.google.com/rss/search?q={encoded_query}&hl=ko&gl=KR&ceid=KR:ko"
        feed = feedparser.parse(rss_url)
        all_entries.extend(feed.entries)
        
    now_utc = datetime.now(timezone.utc)
    three_days_ago = now_utc - timedelta(days=3)
    
    valid_dict = {}
    target_keywords = ["채권", "금리", "국채", "주가", "주식", "증시", "코스피", "코스닥", "나스닥", "환율", "달러", "공모주", "IPO", "상장", "증권", "연준"]

    for entry in all_entries:
        title = entry.title
        link = entry.link
        
        if link in valid_dict:
            continue
            
        if not any(keyword in title for keyword in target_keywords):
            continue
            
        published = entry.get('published_parsed')
        if published:
            published_at = datetime(*published[:6], tzinfo=timezone.utc)
        else:
            published_at = now_utc
            
        if published_at < three_days_ago:
            continue
            
        valid_dict[link] = (entry, published_at)
        
    valid_entries = list(valid_dict.values())
    
    news_list = []
    for entry, published_at in valid_entries:
        title = entry.title
        link = entry.link
        
        updated = entry.get('updated_parsed')
        if updated:
            modified_at = datetime(*updated[:6], tzinfo=timezone.utc).isoformat()
        else:
            modified_at = published_at.isoformat()

        category = "기타"
        if any(k in title for k in ["공모주", "IPO", "상장"]):
            category = "공모주"
        elif any(k in title for k in ["금리", "채권", "국채", "기준금리"]):
            category = "채권/금리"
        elif any(k in title for k in ["환율", "달러", "원달러", "엔화", "위안화"]):
            category = "환율"
        elif any(k in title for k in ["주식", "증시", "코스피", "코스닥", "나스닥", "주가", "증권"]):
            category = "주식"

        region = "DOMESTIC"
        overseas_keywords = ["미국", "연준", "Fed", "중국", "일본", "유럽", "글로벌", "해외", "월가", "나스닥", "뉴욕", "파월"]
        if any(keyword in title for keyword in overseas_keywords):
            region = "OVERSEAS"

        news_item = {
            "title": title,
            "original_link": link,
            "category": category,
            "region": region,
            "importance_score": 3,
            "published_at": published_at.isoformat(),
            "modified_at": modified_at
        }
        news_list.append(news_item)

    # 카테고리 및 지역 순서는 오름차순(낮은 번호 우선), 날짜는 최신순(내림차순) 정렬 적용
    category_order = {"채권/금리": 1, "공모주": 2, "주식": 3, "환율": 4, "기타": 5}
    region_order = {"DOMESTIC": 1, "OVERSEAS": 2}

    news_list.sort(key=lambda x: (
        category_order.get(x["category"], 5),
        region_order.get(x["region"], 2),
        datetime.fromisoformat(x["published_at"])
    ), reverse=False)

    # 같은 카테고리/지역 안에서는 최신 글이 위로 오도록 날짜 기준 내림차순 재정렬 수행
    news_list.sort(key=lambda x: datetime.fromisoformat(x["published_at"]), reverse=True)
    news_list.sort(key=lambda x: (category_order.get(x["category"], 5), region_order.get(x["region"], 2)), reverse=False)

    top_entries = news_list[:30]
    return top_entries

if __name__ == "__main__":
    collected_news = fetch_financial_news()
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
                pass
        except Exception as e:
            print(f"저장 실패: {e}")
    print("카테고리 순서 정렬 및 뉴스 30개 수집 완료")
