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
            # 사이드바 위젯("09/15 종목명" 형식)이 같은 href 패턴을 써서 같이 잡히는
            # 문제 방지 — 메인 테이블 종목명은 날짜 접두어가 없다.
            if re.match(r"^\d{2}[./]\d{2}", stock_name):
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

            # 확정공모가 + 희망공모가 밴드가 붙어서 나온다:
            #   "- 10,700~12,300"        (미확정: 대시)
            #   "10,000 13,000~16,000"   (확정: 숫자)
            m = re.match(r"\s*(-|[\d,]{3,})\s+([\d,]{3,})\s*~\s*([\d,]{3,})", row_text)
            if m:
                confirmed_raw = m.group(1)
                if confirmed_raw != "-":
                    entry["confirmed_price"] = int(confirmed_raw.replace(",", ""))
                entry["price_band_low"] = int(m.group(2).replace(",", ""))
                entry["price_band_high"] = int(m.group(3).replace(",", ""))
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
# 2) 38커뮤니케이션 — 수요예측 결과 (o=r1)
#    공모금액(백만원), 기관경쟁률, 의무보유확약을 여기서만 얻을 수 있다.
# ---------------------------------------------------------------------------

_DEMAND_RESULT_ROW = re.compile(
    r"(\d{4})\.(\d{2})\.(\d{2})\s+"      # 예측일
    r"([\d,]{3,})~([\d,]{3,})\s+"          # 공모희망가 밴드
    r"([\d,]{3,})\s+"                       # 공모가(확정)
    r"([\d,]{3,})\s+"                       # 공모금액(백만원)
    r"([\d,.]+):1\s+"                        # 기관경쟁률
    r"(-|[\d.]+%?)"                          # 의무보유확약
)


def fetch_38_demand_forecast_results(max_pages=3):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=r1&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=r1) 조회 에러(page {page}): {e}")
            break

        soup = BeautifulSoup(html, "html.parser")
        name_links = soup.find_all("a", href=re.compile(r"fund/(index\.htm)?\?o=v&no=\d+"))
        if not name_links:
            break

        found_any = False
        for a in name_links:
            stock_name = a.get_text(strip=True)
            if not stock_name or re.match(r"^\d{2}[./]\d{2}", stock_name):
                continue
            tr = a.find_parent("tr")
            if not tr:
                continue
            row_text = tr.get_text(" ", strip=True)
            # 종목명 뒤에 이어지는 나머지 텍스트만 매칭 대상으로 삼는다
            after_name = row_text.split(stock_name, 1)[-1].strip()
            m = _DEMAND_RESULT_ROW.match(after_name)
            if not m:
                continue
            found_any = True
            y, mo, d, band_lo, band_hi, confirmed, amount_mm, inst_rate, lockup = m.groups()

            entry = {
                "demand_forecast_end_date": f"{y}-{mo}-{d}",
                "price_band_low": int(band_lo.replace(",", "")),
                "price_band_high": int(band_hi.replace(",", "")),
                "confirmed_price": int(confirmed.replace(",", "")),
                # 원본은 백만원 단위 -> 억원 단위로 변환 (1억원 = 100백만원)
                "offering_amount_eok": round(int(amount_mm.replace(",", "")) / 100, 2),
                "institutional_competition_rate": float(inst_rate.replace(",", "")),
                "lockup_commitment_ratio": None if lockup == "-" else float(lockup.replace("%", "")),
            }
            results[normalize_name(stock_name)] = entry

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=r1) 수요예측 결과: {len(results)}개 종목 수집")
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

    demand_results = fetch_38_demand_forecast_results()
    listing_dates = fetch_38_listing_dates()

    # 수요예측 결과 데이터로 빈 필드 보강 (이미 값이 있으면 덮어쓰지 않음)
    for key, result in demand_results.items():
        entry = schedule_data.get(key)
        if entry is None:
            # o=k 테이블에 아직 안 잡힌 종목(과거 페이지 등)도 결과가 있으면 추가
            entry = {"stock_name": result.get("stock_name", key), "source_urls": {}}
            schedule_data[key] = entry
        for field in ("price_band_low", "price_band_high", "confirmed_price",
                      "demand_forecast_end_date", "offering_amount_eok",
                      "institutional_competition_rate", "lockup_commitment_ratio"):
            if entry.get(field) is None and result.get(field) is not None:
                entry[field] = result[field]

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
