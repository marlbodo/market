import os
import urllib.request
import json
from datetime import datetime, timedelta

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

def generate_html_report():
    three_days_ago = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%dT00:00:00")
    rest_url = f"{SUPABASE_URL}/rest/v1/financial_news?select=*&published_at=gte.{three_days_ago}"
    
    req = urllib.request.Request(rest_url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    })
    
    with urllib.request.urlopen(req) as response:
        raw_data = json.loads(response.read().decode())

    def get_detailed_priority(item):
        cat = item.get('category', '')
        title = item.get('title', '')
        if cat in ['채권', '금리']:
            return 2 if any(k in title for k in ['미국', '연준', 'FOMC', '파월', '글로벌', '해외', 'UST', '국채금리']) else 1
        elif cat == '주식':
            return 4 if any(k in title for k in ['뉴욕', '미증시', '나스닥', 'S&P', '월스트리트', '해외증시']) else 3
        elif cat == '환율':
            return 5
        return 99

    news_data = sorted(
        raw_data, 
        key=lambda x: (get_detailed_priority(x), str(x.get('published_at', ''))), 
        reverse=True
    )

    today_str = datetime.now().strftime("%Y-%m-%d")
    
    html_content = f"""
    <!DOCTYPE html>
    <html lang="ko">
    <head><meta charset="UTF-8"><style>
        body {{ font-family: 'Malgun Gothic', sans-serif; color: #2c3e50; margin: 20px; background-color: #fcfbf9; font-size: 10pt; }}
        .header {{ background: linear-gradient(135deg, #1b365d, #2c3e50); color: white; padding: 16px 20px; border-radius: 6px; margin-bottom: 12px; }}
        .news-item {{ background: #ffffff; border: 1px solid #e1e8ed; border-left: 4px solid #1b365d; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }}
        .badge {{ background-color: #e2e8f0; color: #1b365d; padding: 1px 5px; font-size: 8pt; font-weight: bold; border-radius: 3px; margin-right: 5px; }}
        .badge-time {{ background-color: #fef3c7; color: #d97706; float: right; font-weight: normal; }}
        .news-title {{ font-size: 10pt; font-weight: bold; color: #1e293b; text-decoration: none; }}
        .news-summary {{ font-size: 9pt; color: #475569; margin: 3px 0 0 0; }}
    </style></head>
    <body>
    <div class="header">
        <h1>최근 3일 맞춤 정렬 금융 뉴스</h1>
        <div>기준 일자: {today_str} | 정렬: 금리(국내➔해외) ➔ 주식(국내➔해외) ➔ 환율 (최신순)</div>
    </div>
    """

    for item in news_data:
        title = item.get('title', '')
        summary = item.get('summary', '')
        category = item.get('category', '기타')
        link = item.get('original_link', '#')
        raw_time = item.get('published_at', '')
        try:
            pub_time_str = datetime.fromisoformat(raw_time.replace('Z', '+00:00')).strftime("%m-%d %H:%M")
        except:
            pub_time_str = raw_time[:16] if raw_time else "시간 미상"
        
        html_content += f"""
        <div class="news-item">
            <div>
                <span class="badge">{category}</span>
                <span class="badge badge-time">🕒 {pub_time_str}</span>
                <a href="{link}" class="news-title" target="_blank">{title}</a>
            </div>
            <p class="news-summary">{summary}</p>
        </div>
        """

    html_content += "</body></html>"
    with open("financial_market_sorted_report.html", "w", encoding="utf-8") as f:
        f.write(html_content)
    print("HTML 리포트 생성 완료")

if __name__ == "__main__":
    generate_html_report()