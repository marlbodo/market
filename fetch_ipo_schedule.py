import os
import re
import json
import time
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

from bs4 import BeautifulSoup
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# Optional — if not set, overall_assessment (종합판단) is left blank instead of
# calling the model. Uses Anthropic's Messages API directly (no SDK dependency).
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

TODAY = datetime.now().date()
# 수요예측이 끝난 지 이만큼(일) 지났는데도 상장일을 못 찾으면(=o=nw에 안 잡히면)
# 이미 상장까지 끝났을 가능성이 높다고 보고 제외한다.
STALE_BUFFER_DAYS = 21


def normalize_name(name):
    if not name:
        return ""
    name = name.strip()
    name = re.sub(r"\.{2,}$", "", name)
    name = re.sub(r"…$", "", name)
    name = re.sub(r"\s+", "", name)
    return name


def _fetch_html(url, encoding_candidates=("utf-8", "euc-kr", "cp949")):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    for enc in encoding_candidates:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


# ---------------------------------------------------------------------------
# 1) 38커뮤니케이션 — 공모주 청약일정 (o=k)
# ---------------------------------------------------------------------------

def fetch_38_ipo_schedule(max_pages=3):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=k&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=k) 조회 에러(page {page}): {e}")
            break

        soup = BeautifulSoup(html, "html.parser")
        name_links = soup.find_all("a", href=re.compile(r"fund/(index\.htm)?\?o=v&no=\d+"))
        if not name_links:
            break

        for a in name_links:
            stock_name = a.get_text(strip=True)
            if not stock_name:
                continue
            tr = a.find_parent("tr")
            if not tr:
                continue
            row_text = tr.get_text(" ", strip=True)

            entry = {
                "stock_name": stock_name,
                "demand_forecast_start_date": None,
                "demand_forecast_end_date": None,
                "confirmed_price": None,
                "price_band_low": None,
                "price_band_high": None,
                "subscription_competition_rate": None,
                "source_urls": {"38": "http://www.38.co.kr" + a["href"].replace("index.htm", "")},
            }

            # 수요예측일: 2026.10.15~10.16
            m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})", row_text)
            if m:
                y, m1, d1, m2, d2 = m.groups()
                entry["demand_forecast_start_date"] = f"{y}-{m1}-{d1}"
                end_year = int(y) + 1 if int(m2) < int(m1) else int(y)
                entry["demand_forecast_end_date"] = f"{end_year}-{m2}-{d2}"
                row_text = row_text[m.end():]

            # 희망공모가 밴드: 2,000~2,000  (원 단위)
            m = re.search(r"([\d,]{3,})\s*~\s*([\d,]{3,})", row_text)
            if m:
                entry["price_band_low"] = int(m.group(1).replace(",", ""))
                entry["price_band_high"] = int(m.group(2).replace(",", ""))
                row_text = row_text[m.end():]

            # 청약경쟁률: 2.85:1
            m = re.search(r"([\d,]+(?:\.\d+)?)\s*:\s*1", row_text)
            if m:
                entry["subscription_competition_rate"] = float(m.group(1).replace(",", ""))

            key = normalize_name(stock_name)
            results[key] = entry

        time.sleep(0.3)

    print(f"38(o=k) 수요예측/청약 일정: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 2) 38커뮤니케이션 — IPO 신규상장 안내 (o=nw) : 종목별 상장(예정)일 확인용
#    "이미 어제까지 상장 끝난 종목 제외" 판단에 사용
# ---------------------------------------------------------------------------

def fetch_38_listing_dates():
    url = "http://www.38.co.kr/html/fund/index.htm?o=nw"
    results = {}  # normalized_name -> date object
    try:
        html = _fetch_html(url)
    except Exception as e:
        print(f"38(o=nw) 조회 에러: {e}")
        return results

    soup = BeautifulSoup(html, "html.parser")
    links = soup.find_all("a", href=re.compile(r"fund/(index\.htm)?\?o=v&no=\d+"))
    for a in links:
        text = a.get_text(strip=True)
        m = re.match(r"(\d{2})[./](\d{2})\s*(.+)", text)
        if not m:
            continue
        mo, d, name = m.groups()
        year = TODAY.year
        # 현재 달보다 6개월 이상 이전 달이면 해가 넘어간 것으로 간주
        if int(mo) < TODAY.month - 6:
            year += 1
        try:
            listing_date = datetime(year, int(mo), int(d)).date()
        except ValueError:
            continue
        results[normalize_name(name)] = listing_date

    print(f"38(o=nw) 상장(예정)일 정보: {len(results)}개 종목 확인")
    return results


# ---------------------------------------------------------------------------
# 3) AI 종합판단 생성 (선택사항)
# ---------------------------------------------------------------------------

def generate_overall_assessment(entry):
    if not ANTHROPIC_API_KEY:
        return None

    prompt = f"""아래는 IPO 공모주 정보입니다. 경쟁률과 공모가 밴드 대비 확정가 수준, 시장 상황을 종합 고려해서
2~3문장으로 간결한 종합판단을 작성해줘. 과장하지 말고 사실 기반으로.

종목명: {entry.get('stock_name')}
희망공모가 밴드: {entry.get('price_band_low')}~{entry.get('price_band_high')}
확정공모가: {entry.get('confirmed_price')}
청약경쟁률(일반): {entry.get('subscription_competition_rate')}
수요예측 기간: {entry.get('demand_forecast_start_date')} ~ {entry.get('demand_forecast_end_date')}"""

    body = json.dumps({
        "model": "claude-sonnet-5",
        "max_tokens": 400,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
        return "\n".join(parts).strip() or None
    except Exception as e:
        print(f"AI 종합판단 생성 에러('{entry.get('stock_name')}'): {e}")
        return None


# ---------------------------------------------------------------------------
# 상태 판단 + "이미 상장 끝난 종목" 제외 필터
# ---------------------------------------------------------------------------

def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def should_keep(entry, listing_date):
    if listing_date is not None:
        # 상장일이 오늘보다 이전(=어제까지 상장 끝남)이면 제외
        return listing_date >= TODAY

    # 상장일을 못 찾은 경우: 수요예측 종료일이 너무 오래됐으면(버퍼 기간 초과) 제외
    dfe = parse_date(entry.get("demand_forecast_end_date"))
    if dfe is not None and (TODAY - dfe).days > STALE_BUFFER_DAYS:
        return False
    return True


def infer_status(entry, listing_date):
    if listing_date and listing_date <= TODAY:
        return "상장완료"
    if listing_date and listing_date > TODAY:
        return "상장예정"

    dfs = parse_date(entry.get("demand_forecast_start_date"))
    dfe = parse_date(entry.get("demand_forecast_end_date"))
    if dfs and dfe and dfs <= TODAY <= dfe:
        return "수요예측중"
    if dfe and dfe < TODAY:
        return "청약대기"  # 수요예측은 끝났지만 상장일 미확인
    return "예정"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Supabase 환경 변수가 설정되지 않았습니다.")
        return

    schedule_data = fetch_38_ipo_schedule()
    if not schedule_data:
        print("38커뮤니케이션에서 수집된 공모주 일정이 없습니다.")
        return

    listing_dates = fetch_38_listing_dates()

    rows_to_insert = []
    for key, entry in schedule_data.items():
        listing_date = listing_dates.get(key)
        if not should_keep(entry, listing_date):
            continue

        entry["listing_date"] = listing_date.isoformat() if listing_date else None
        entry["status"] = infer_status(entry, listing_date)
        entry["overall_assessment"] = generate_overall_assessment(entry)
        entry["source_urls"] = json.dumps(entry.get("source_urls", {}), ensure_ascii=False)
        rows_to_insert.append(entry)

    print(f"필터링 후 최종 저장 대상: {len(rows_to_insert)}개 종목 "
          f"(전체 {len(schedule_data)}개 중 이미 상장 끝난/오래된 종목 제외)")

    if not rows_to_insert:
        print("저장할 공모주 일정이 없습니다.")
        return

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    try:
        supabase.table("ipo_schedule").delete().gt("id", 0).execute()
        print("기존 ipo_schedule 테이블 데이터를 모두 비웠습니다.")

        supabase.table("ipo_schedule").insert(rows_to_insert).execute()
        print(f"성공적으로 {len(rows_to_insert)}개의 공모주 일정을 Supabase에 저장했습니다.")
    except Exception as e:
        print(f"Supabase 작업 중 오류 발생: {e}")


if __name__ == "__main__":
    main()
