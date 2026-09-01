import os
import re
import json
import time
import urllib.request
from datetime import datetime

from bs4 import BeautifulSoup
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

TODAY = datetime.now().date()
# 청약/수요예측이 끝난 지 이만큼(일) 지났는데도 상장(예정)일을 못 찾으면
# 이미 상장까지 끝났을 가능성이 높다고 보고 제외한다.
STALE_BUFFER_DAYS = 21


# ---------------------------------------------------------------------------
# 공통 유틸
# ---------------------------------------------------------------------------

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


def _iter_rows(html, href_pattern=r"fund/(index\.htm)?\?o=v&no=\d+"):
    """종목 상세페이지로 연결되는 링크가 있는 <tr>을 순회하며
    (종목명, [셀 텍스트...], <a> 태그)를 반환한다.
    사이드바 위젯("MM/DD 종목명" 형식)은 이름이 날짜로 시작하므로 걸러낸다."""
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    for a in soup.find_all("a", href=re.compile(href_pattern)):
        name = a.get_text(strip=True)
        if not name or re.match(r"^\d{2}[./]\d{2}", name):
            continue
        tr = a.find_parent("tr")
        if not tr:
            continue
        cells = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if not cells:
            continue
        key = (name, tuple(cells))
        if key in seen:
            continue
        seen.add(key)
        yield name, cells, a


# --- 숫자/날짜 파서 ---------------------------------------------------------

def parse_price(s):
    """'13,000' -> 13000 / '-' -> None"""
    if not s:
        return None
    s = s.strip().replace(",", "")
    if s in ("", "-"):
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_amount_eok(s):
    """백만원 단위 문자열 -> 억원(float, 소수점 2자리)"""
    v = parse_price(s)
    return round(v / 100, 2) if v is not None else None


def parse_band(s):
    """'16,500~19,500' -> (16500, 19500). 범위가 아니면 (단일값, 단일값)."""
    if not s:
        return None, None
    m = re.search(r"([\d,]+)\s*~\s*([\d,]+)", s)
    if m:
        return parse_price(m.group(1)), parse_price(m.group(2))
    v = parse_price(s)
    return v, v


def parse_percent(s):
    if not s:
        return None
    s = s.strip()
    if s in ("", "-"):
        return None
    s = s.replace("%", "").replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def parse_ratio(s):
    """'743.49:1' 또는 '1160,70:1'(콤마를 소수점으로 쓰는 표기) -> 743.49"""
    if not s:
        return None
    s = s.strip()
    if s in ("", "-"):
        return None
    m = re.search(r"([\d.,]+)\s*:\s*1", s)
    if not m:
        return None
    raw = m.group(1)
    if "," in raw and "." not in raw:
        head, _, tail = raw.rpartition(",")
        if len(tail) == 2:  # 콤마 뒤 2자리 -> 소수점으로 쓴 것으로 판단
            raw = head.replace(",", "") + "." + tail
        else:
            raw = raw.replace(",", "")
    else:
        raw = raw.replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def parse_date_range_dot(s):
    """'2026.09.09~09.15' -> ('2026-09-09', '2026-09-15'), 연도 넘어가면 보정."""
    if not s:
        return None, None
    m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})", s)
    if not m:
        return None, None
    y, m1, d1, m2, d2 = m.groups()
    end_year = int(y) + 1 if int(m2) < int(m1) else int(y)
    return f"{y}-{m1}-{d1}", f"{end_year:04d}-{m2}-{d2}"


def parse_date_dot(s):
    if not s:
        return None
    m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})", s)
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{y}-{mo}-{d}"


def parse_date_slash(s):
    if not s:
        return None
    m = re.search(r"(\d{4})/(\d{2})/(\d{2})", s)
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{y}-{mo}-{d}"


def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 1) 38 — 수요예측 일정 (o=r)
#    셀: [종목명, 수요예측일, 희망공모가, 확정공모가, 공모금액(백만원), 주간사]
# ---------------------------------------------------------------------------

def fetch_38_demand_schedule(max_pages=5):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=r&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=r) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, cells, a in _iter_rows(html):
            if len(cells) < 3:
                continue
            start, end = parse_date_range_dot(cells[1])
            if not start:
                continue
            found_any = True
            band_lo, band_hi = parse_band(cells[2])
            entry = {
                "stock_name": name,
                "demand_forecast_start_date": start,
                "demand_forecast_end_date": end,
                "price_band_low": band_lo,
                "price_band_high": band_hi,
                "confirmed_price": parse_price(cells[3]) if len(cells) > 3 else None,
                "offering_amount_eok": parse_amount_eok(cells[4]) if len(cells) > 4 else None,
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
#    셀: [기업명, 예측일, 공모희망가, 공모가, 공모금액, 기관경쟁률, 의무보유확약, 주간사]
# ---------------------------------------------------------------------------

def fetch_38_demand_results(max_pages=5):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=r1&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=r1) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, cells, a in _iter_rows(html):
            if len(cells) < 5:
                continue
            pred_date = parse_date_dot(cells[1])
            if not pred_date:
                continue
            found_any = True
            band_lo, band_hi = parse_band(cells[2])
            entry = {
                "stock_name": name,
                "demand_forecast_end_date": pred_date,
                "price_band_low": band_lo,
                "price_band_high": band_hi,
                "confirmed_price": parse_price(cells[3]),
                "offering_amount_eok": parse_amount_eok(cells[4]),
                "institutional_competition_rate": parse_ratio(cells[5]) if len(cells) > 5 else None,
                "lockup_commitment_ratio": parse_percent(cells[6]) if len(cells) > 6 else None,
            }
            results[normalize_name(name)] = entry

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=r1) 수요예측 결과: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 3) 38 — 공모주 청약일정 (o=k)
#    셀: [종목명, 공모주일정, 확정공모가, 희망공모가, 청약경쟁률, 주간사, 분석]
# ---------------------------------------------------------------------------

def fetch_38_subscription_schedule(max_pages=5):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=k&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=k) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, cells, a in _iter_rows(html):
            if len(cells) < 2:
                continue
            start, end = parse_date_range_dot(cells[1])
            if not start:
                continue
            found_any = True
            band_lo, band_hi = parse_band(cells[3]) if len(cells) > 3 else (None, None)
            entry = {
                "stock_name": name,
                "subscription_start_date": start,
                "subscription_end_date": end,
                "confirmed_price": parse_price(cells[2]) if len(cells) > 2 else None,
                "price_band_low": band_lo,
                "price_band_high": band_hi,
                "subscription_competition_rate": parse_ratio(cells[4]) if len(cells) > 4 else None,
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
#    셀: [기업명, 신규상장일(YYYY/MM/DD), 현재가, ...]
# ---------------------------------------------------------------------------

def fetch_38_listing_dates(max_pages=5):
    results = {}  # normalized_name -> date object
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=nw&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38(o=nw) 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, cells, a in _iter_rows(html):
            if len(cells) < 2:
                continue
            iso = parse_date_slash(cells[1]) or parse_date_dot(cells[1])
            if not iso:
                continue
            found_any = True
            d = parse_date(iso)
            if d:
                results[normalize_name(name)] = d

        if not found_any:
            break
        time.sleep(0.3)

    print(f"38(o=nw) 상장(예정)일 정보: {len(results)}개 종목 확인")
    return results


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


def should_keep(entry, listing_date):
    # 상장(예정)일을 알면 그걸로 판단: 오늘 이전에 이미 상장된 종목은 제외.
    if listing_date is not None:
        return listing_date >= TODAY

    # 상장일을 모르면, 청약종료일(없으면 수요예측종료일)이 너무 오래됐는지로 판단.
    ref_date = parse_date(entry.get("subscription_end_date")) or parse_date(entry.get("demand_forecast_end_date"))
    if ref_date is not None and (TODAY - ref_date).days > STALE_BUFFER_DAYS:
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

    if not (demand_schedule or subscription_schedule or demand_results):
        print("38커뮤니케이션에서 수집된 공모주 일정이 없습니다.")
        return

    master = {}
    # 병합 우선순위 (겹치는 필드는 먼저 병합된 소스 값이 유지됨):
    # 청약일정(o=k, 가장 최종/확정) > 수요예측결과(o=r1, 확정) > 수요예측일정(o=r, 초기 희망밴드)
    merge_into(master, subscription_schedule)
    merge_into(master, demand_results)
    merge_into(master, demand_schedule)

    rows_to_insert = []
    null_counts = {f: 0 for f in FILL_FIELDS}
    for key, entry in master.items():
        listing_date = listing_dates.get(key)
        if not should_keep(entry, listing_date):
            continue

        entry.setdefault("source_urls", {})
        entry["listing_date"] = listing_date.isoformat() if listing_date else None
        entry["status"] = infer_status(entry, listing_date)

        for f in FILL_FIELDS:
            if entry.get(f) is None:
                null_counts[f] += 1

        entry["source_urls"] = json.dumps(entry.get("source_urls", {}), ensure_ascii=False)
        rows_to_insert.append(entry)

    print(f"필터링 후 최종 저장 대상: {len(rows_to_insert)}개 종목 "
          f"(전체 {len(master)}개 중 이미 상장 끝난/오래된 종목 제외)")
    if rows_to_insert:
        remaining_nulls = {k: v for k, v in null_counts.items() if v}
        if remaining_nulls:
            print("필드별 남은 NULL 개수:", remaining_nulls)

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
