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


def _iter_name_rows(html, href_pattern=r"fund/(index\.htm)?\?o=v&no=\d+"):
    """공통 헬퍼: 종목명 링크 + 그 링크가 속한 <tr>의 텍스트를 순회.
    사이드바 위젯("MM/DD 종목명" 형식)은 이름이 날짜로 시작하므로 걸러낸다."""
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a", href=re.compile(href_pattern)):
        name = a.get_text(strip=True)
        if not name or re.match(r"^\d{2}[./]\d{2}", name):
            continue
        tr = a.find_parent("tr")
        if not tr:
            continue
        row_text = tr.get_text(" ", strip=True)
        after_name = row_text.split(name, 1)[-1].strip()
        yield name, after_name, a


# ---------------------------------------------------------------------------
# 1) 38 — 수요예측 일정 (o=r)
#    수요예측 시작/종료일, 희망공모가, 확정공모가(있으면), 공모금액(백만원)
# ---------------------------------------------------------------------------

_DEMAND_SCHEDULE_ROW = re.compile(
    r"(\d{4})\.(\d{2})\.(\d{2})~(\d{2})\.(\d{2})\s+"   # 수요예측일 (범위)
    r"([\d,]{3,})~([\d,]{3,})\s+"                        # 희망공모가
    r"(-|[\d,]{3,})\s+"                                   # 확정공모가
    r"([\d,]{3,})"                                         # 공모금액(백만원)
)


def fetch_38_demand_schedule(max_pages=3):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=r&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=r) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, rest, a in _iter_name_rows(html):
            m = _DEMAND_SCHEDULE_ROW.match(rest)
            if not m:
                continue
            found_any = True
            y, m1, d1, m2, d2, band_lo, band_hi, confirmed, amount_mm = m.groups()
            end_year = int(y) + 1 if int(m2) < int(m1) else int(y)
            entry = {
                "stock_name": name,
                "demand_forecast_start_date": f"{y}-{m1}-{d1}",
                "demand_forecast_end_date": f"{end_year}-{m2}-{d2}",
                "price_band_low": int(band_lo.replace(",", "")),
                "price_band_high": int(band_hi.replace(",", "")),
                "confirmed_price": None if confirmed == "-" else int(confirmed.replace(",", "")),
                "offering_amount_eok": round(int(amount_mm.replace(",", "")) / 100, 2),
                "source_urls": {"38_수요예측일정": "http://www.38.co.kr" + a["href"].replace("index.htm", "")},
            }
            results[normalize_name(name)] = entry

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=r) 수요예측 일정: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 2) 38 — 수요예측 결과 (o=r1)
#    기관경쟁률, 의무보유확약 (여기서만 얻을 수 있음) + 공모금액/확정가 보강
# ---------------------------------------------------------------------------

_DEMAND_RESULT_ROW = re.compile(
    r"(\d{4})\.(\d{2})\.(\d{2})\s+"        # 예측(결과)일
    r"([\d,]{3,})~([\d,]{3,})\s+"            # 공모희망가 밴드
    r"([\d,]{3,})\s+"                         # 공모가(확정)
    r"([\d,]{3,})\s+"                         # 공모금액(백만원)
    r"([\d,.]+):1\s+"                          # 기관경쟁률
    r"(-|[\d.]+%?)"                            # 의무보유확약
)


def fetch_38_demand_results(max_pages=3):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=r1&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=r1) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, rest, a in _iter_name_rows(html):
            m = _DEMAND_RESULT_ROW.match(rest)
            if not m:
                continue
            found_any = True
            y, mo, d, band_lo, band_hi, confirmed, amount_mm, inst_rate, lockup = m.groups()
            entry = {
                "stock_name": name,
                "demand_forecast_end_date": f"{y}-{mo}-{d}",
                "price_band_low": int(band_lo.replace(",", "")),
                "price_band_high": int(band_hi.replace(",", "")),
                "confirmed_price": int(confirmed.replace(",", "")),
                "offering_amount_eok": round(int(amount_mm.replace(",", "")) / 100, 2),
                "institutional_competition_rate": float(inst_rate.replace(",", "")),
                "lockup_commitment_ratio": None if lockup == "-" else float(lockup.replace("%", "")),
            }
            results[normalize_name(name)] = entry

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=r1) 수요예측 결과: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 3) 38 — 공모주 청약일정 (o=k)
#    청약 시작/종료일(!), 청약경쟁률, 확정공모가/밴드 보강
# ---------------------------------------------------------------------------

_SUBSCRIPTION_ROW = re.compile(
    r"(\d{4})\.(\d{2})\.(\d{2})~(\d{2})\.(\d{2})\s+"   # 공모주일정(청약기간)
    r"(-|[\d,]{3,})\s+"                                   # 확정공모가
    r"([\d,]{3,})~([\d,]{3,})"                             # 희망공모가
)


def fetch_38_subscription_schedule(max_pages=3):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=k&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=k) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, rest, a in _iter_name_rows(html):
            m = _SUBSCRIPTION_ROW.match(rest)
            if not m:
                continue
            found_any = True
            y, m1, d1, m2, d2, confirmed, band_lo, band_hi = m.groups()
            end_year = int(y) + 1 if int(m2) < int(m1) else int(y)
            after_band = rest[m.end():]
            rate_m = re.search(r"([\d,]+(?:\.\d+)?)\s*:\s*1", after_band)

            entry = {
                "stock_name": name,
                "subscription_start_date": f"{y}-{m1}-{d1}",
                "subscription_end_date": f"{end_year}-{m2}-{d2}",
                "confirmed_price": None if confirmed == "-" else int(confirmed.replace(",", "")),
                "price_band_low": int(band_lo.replace(",", "")),
                "price_band_high": int(band_hi.replace(",", "")),
                "subscription_competition_rate": float(rate_m.group(1).replace(",", "")) if rate_m else None,
                "source_urls": {"38_청약일정": "http://www.38.co.kr" + a["href"].replace("index.htm", "")},
            }
            results[normalize_name(name)] = entry

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=k) 청약 일정: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 4) 38 — 신규상장 (o=nw) : 상장(예정)일 확인용
# ---------------------------------------------------------------------------

def fetch_38_listing_dates(max_pages=3):
    results = {}  # normalized_name -> date object
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=nw&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=nw) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, rest, a in _iter_name_rows(html):
            m = re.match(r"(\d{4})\.(\d{2})\.(\d{2})", rest)
            if not m:
                continue
            found_any = True
            y, mo, d = m.groups()
            try:
                results[normalize_name(name)] = datetime(int(y), int(mo), int(d)).date()
            except ValueError:
                continue

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=nw) 상장(예정)일 정보: {len(results)}개 종목 확인")
    return results


# ---------------------------------------------------------------------------
# AI 종합판단 생성 (선택사항)
# ---------------------------------------------------------------------------

def generate_overall_assessment(entry):
    if not ANTHROPIC_API_KEY:
        return None

    prompt = f"""아래는 IPO 공모주 정보입니다. 경쟁률과 공모가 밴드 대비 확정가 수준, 의무보유확약 비율,
시장 상황을 종합 고려해서 2~3문장으로 간결한 종합판단을 작성해줘. 과장하지 말고 사실 기반으로.

종목명: {entry.get('stock_name')}
희망공모가 밴드: {entry.get('price_band_low')}~{entry.get('price_band_high')}
확정공모가: {entry.get('confirmed_price')}
공모금액(억원): {entry.get('offering_amount_eok')}
기관경쟁률: {entry.get('institutional_competition_rate')}
의무보유확약(%): {entry.get('lockup_commitment_ratio')}
청약경쟁률(일반): {entry.get('subscription_competition_rate')}
수요예측 기간: {entry.get('demand_forecast_start_date')} ~ {entry.get('demand_forecast_end_date')}
청약 기간: {entry.get('subscription_start_date')} ~ {entry.get('subscription_end_date')}"""

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
# 병합 / 상태 판단 / 필터
# ---------------------------------------------------------------------------

FILL_FIELDS = (
    "demand_forecast_start_date", "demand_forecast_end_date",
    "subscription_start_date", "subscription_end_date",
    "price_band_low", "price_band_high", "confirmed_price",
    "offering_amount_eok", "institutional_competition_rate",
    "lockup_commitment_ratio", "subscription_competition_rate",
)


def merge_into(master, source_data):
    for key, src in source_data.items():
        row = master.get(key)
        if row is None:
            row = {"stock_name": src["stock_name"], "source_urls": {}}
            master[key] = row
        for field in FILL_FIELDS:
            if row.get(field) is None and src.get(field) is not None:
                row[field] = src[field]
        if src.get("source_urls"):
            row["source_urls"].update(src["source_urls"])


def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def should_keep(entry, listing_date):
    if listing_date is not None:
        return listing_date >= TODAY  # 어제까지 상장 끝난 종목 제외

    dfe = parse_date(entry.get("demand_forecast_end_date"))
    if dfe is not None and (TODAY - dfe).days > STALE_BUFFER_DAYS:
        return False
    return True


def infer_status(entry, listing_date):
    if listing_date:
        return "상장예정" if listing_date > TODAY else "상장완료"

    sub_s = parse_date(entry.get("subscription_start_date"))
    sub_e = parse_date(entry.get("subscription_end_date"))
    if sub_s and sub_e:
        if sub_s <= TODAY <= sub_e:
            return "청약중"
        if sub_e < TODAY:
            return "상장대기"  # 청약은 끝났지만 상장일 미확인

    dfs = parse_date(entry.get("demand_forecast_start_date"))
    dfe = parse_date(entry.get("demand_forecast_end_date"))
    if dfs and dfe:
        if dfs <= TODAY <= dfe:
            return "수요예측중"
        if dfe < TODAY:
            return "청약대기"  # 수요예측은 끝났지만 청약일정 미확인
    return "예정"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Supabase 환경 변수가 설정되지 않았습니다.")
        return

    demand_schedule = fetch_38_demand_schedule()
    demand_results = fetch_38_demand_results()
    subscription_schedule = fetch_38_subscription_schedule()
    listing_dates = fetch_38_listing_dates()

    if not (demand_schedule or subscription_schedule):
        print("38커뮤니케이션에서 수집된 공모주 일정이 없습니다.")
        return

    master = {}
    # 우선순위: 청약일정(o=k) -> 수요예측일정(o=r) -> 수요예측결과(o=r1)
    merge_into(master, subscription_schedule)
    merge_into(master, demand_schedule)
    merge_into(master, demand_results)

    rows_to_insert = []
    for key, entry in master.items():
        listing_date = listing_dates.get(key)
        if not should_keep(entry, listing_date):
            continue

        entry["listing_date"] = listing_date.isoformat() if listing_date else None
        entry["status"] = infer_status(entry, listing_date)
        entry["overall_assessment"] = generate_overall_assessment(entry)
        entry["source_urls"] = json.dumps(entry.get("source_urls", {}), ensure_ascii=False)
        rows_to_insert.append(entry)

    print(f"필터링 후 최종 저장 대상: {len(rows_to_insert)}개 종목 "
          f"(전체 {len(master)}개 중 이미 상장 끝난/오래된 종목 제외)")

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
