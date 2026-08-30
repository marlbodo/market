import os
import urllib.request
import json
from datetime import datetime

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

def generate_html_report():
    rest_url = f"{SUPABASE_URL}/rest/v1/financial_news?select=*"
    
    req = urllib.request.Request(rest_url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    })
    
    with urllib.request.urlopen(req) as response:
        raw_data = json.loads(response.read().decode())

    # 우선순위 정렬 함수 (공모주 ➔ 채권/금리 ➔ 주식 ➔ 환율 순)
    def get_detailed_priority(item):
        cat = item.get('category', '')
        title = item.get('title', '')
        if cat == '공모주':
            return 1
        elif cat == '채권/금리':
            return 3 if any(k in title for k in ['미국', '연준', 'FOMC', '파월', '글로벌', '해외', '국채']) else 2
        elif cat == '주식':
            return 5 if any(k in title for k in ['뉴욕', '미증시', '나스닥', 'S&P', '해외증시']) else 4
        elif cat == '환율':
            return 6
        return 99

    news_data = sorted(
        raw_data, 
        key=lambda x: (get_detailed_priority(x), str(x.get('published_at', ''))), 
        reverse=False
    )
    news_data.reverse()

    today_str = datetime.now().strftime("%Y-%m-%d")
    
    html_content = f"""
    <!DOCTYPE html>
    <html lang="ko">
    <head><meta charset="UTF-8"><style>
        body {{ font-family: 'Malgun Gothic', sans-serif; color: #2c3e50; margin: 20px; background-color: #f8fafc; font-size: 10pt; }}
        .header {{ background: linear-gradient(135deg, #0f172a, #1e293b); color: white; padding: 20px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
        .header h1 {{ margin: 0 0 8px 0; font-size: 18pt; }}
        .header p {{ margin: 0; color: #94a3b8; font-size: 9pt; }}
        .news-item {{ background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 12px 15px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }}
        .badge {{ background-color: #eff6ff; color: #1d4ed8; padding: 2px 8px; font-size: 8pt; font-weight: bold; border-radius: 4px; margin-right: 6px; border: 1px solid #bfdbfe; }}
        .badge-time {{ background-color: #fef3c7; color: #b45309; float: right; font-weight: normal; border: 1px solid #fde68a; padding: 2px 6px; border-radius: 4px; font-size: 8pt; }}
        .news-title {{ font-size: 10.5pt; font-weight: bold; color: #0f172a; text-decoration: none; display: inline-block; margin-top: 2px; }}
        .news-title:hover {{ text-decoration: underline; color: #2563eb; }}
        .news-summary {{ font-size: 9.5pt; color: #475569; margin: 6px 0 0 0; line-height: 1.4; }}
    </style></head>
    <body>
    <div class="header">
        <h1>최근 3일 맞춤 정렬 금융 뉴스</h1>
        <p>기준 일자: {today_str} | 정렬 순서: 공모주 ➔ 채권/금리 ➔ 주식 ➔ 환율 (최신순)</p>
    </div>
    """

    if not news_data:
        html_content += """
        <div style="text-align: center; padding: 40px; color: #64748b; background: white; border-radius: 6px; border: 1px solid #e2e8f0;">
            수집된 최근 3일 이내의 금융 뉴스가 없습니다.
        </div>
        """
    else:
        for item in news_data:
            title = item.get('title', '')
            summary = item.get('summary', '')
            category = item.get('category', '기타')
            link = item.get('original_link', '#')
            
            raw_time = item.get('published_at', '')
            raw_modified = item.get('modified_at', '')
            
            try:
                pub_time_str = datetime.fromisoformat(raw_time.replace('Z', '+00:00')).strftime("%m-%d %H:%M")
            except:
                pub_time_str = raw_time[:16] if raw_time else "시간 미상"

            try:
                mod_time_str = datetime.fromisoformat(raw_modified.replace('Z', '+00:00')).strftime("%m-%d %H:%M")
            except:
                mod_time_str = raw_modified[:16] if raw_modified else ""
            
            time_display = f"🕒 {pub_time_str}"
            if mod_time_str and mod_time_str != pub_time_str:
                time_display += f" (수정: {mod_time_str})"

            html_content += f"""
            <div class="news-item">
                <div>
                    <span class="badge">{category}</span>
                    <span class="badge-time">{time_display}</span>
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
