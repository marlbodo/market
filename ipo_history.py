import os
import re
import time
import urllib.request
from datetime import datetime

from bs4 import BeautifulSoup
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
BASE = "http://www.38.co.kr"

# 평소(매일/매시간 실행)에는 최근 1~2페이지만 훑어도 충분하지만,
# 최초 구축 시에는 전체 이력을 다 긁어와야 하므로 페이지 수를 환경변수로 조절할 수 있게 함.
# 예) 최초 1회 전체 백필:
#   DEMAND_SCHEDULE_MAX_PAGES=93 DEMAND_RESULTS_MAX_PAGES=92 \
#   SUBSCRIPTION_MAX_PAGES=62 LISTING_MAX_PAGES=87 python fetch_ipo_history.py
DEFAULT_MAX_PAGES = {
    "DEMAND_SCHEDULE_MAX_PAGES": 1,
    "DEMAND_RESULTS_MAX_PAGES": 1,
    "SUBSCRIPTION_MAX_PAGES": 1,
    "LISTING_MAX_PAGES": 1,
}


def _max_pages(env_var):
    val = os.environ.get(env_var)
    if val:
        try:
            return int(val)
        except ValueError:
            print(f"{env_var} 값이 올바르지 않아 기본값을 사용합니다: {val}")
    return DEFAULT_MAX_PAGES[env_var]


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


_HEADER_NAMES = {"종목명", "기업명", "기업 명"}


def _iter_rows(html, min_cells=3):
    """<tr><td>...가 min_cells개 이상 있고 첫 칸이 종목명처럼 생긴 행을 순회하며
    (종목명, [셀 텍스트...], 첫 칸 안의 <a> 태그 또는 None)을 반환한다."""
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    for tr in soup.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < min_cells:
            continue
        name = tds[0].get_text(strip=True)
        if not name or name in _HEADER_NAMES:
            continue
        if re.match(r"^\d{2}[./]\d{2}", name):
            continue
        if name.startswith("[") or "공모뉴스" in name or "뉴스" in name:
            continue
        if len(name) > 20:
            continue
        cells = [td.get_text(" ", strip=True) for td in tds]
        key = (name, tuple(cells))
        if key in seen:
            continue
        seen.add(key)
        yield name, cells, tds[0].find("a")


# --- 숫자/날짜 파서 ---------------------------------------------------------

def parse_price(s):
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
        if len(tail) == 2:
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


def _detail_url(a):
    if a is None or not a.get("href"):
        return None
    href = a["href"]
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        return BASE + href
    return f"{BASE}/html/fund/{href}"


# ---------------------------------------------------------------------------
# 1) 수요예측 일정 (o=r)
#    셀: [종목명, 수요예측일, 희망공모가, 확정공모가, 공모금액(백만원), 주간사]
# ---------------------------------------------------------------------------

def fetch_demand_schedule(max_pages=5):
    rows = []
    for page in range(1, max_pages + 1):
        url = f"{BASE}/html/fund/index.htm?o=r&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"수요예측일정 조회 에러(page {page}): {e}")
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
            rows.append({
                "stock_name": normalize_name(name),
                "demand_forecast_start_date": start,
                "demand_forecast_end_date": end,
                "price_band_low": band_lo,
                "price_band_high": band_hi,
                "confirmed_price": parse_price(cells[3]) if len(cells) > 3 else None,
                "offering_amount_eok": parse_amount_eok(cells[4]) if len(cells) > 4 else None,
                "lead_underwriter": cells[5] if len(cells) > 5 else None,
                "source_url": _detail_url(a),
                "last_stage": "forecast_schedule",
            })

        if not found_any:
            break
        time.sleep(0.3)

    print(f"[수요예측일정] {len(rows)}개 행 수집")
    return rows


# ---------------------------------------------------------------------------
# 2) 수요예측 결과 (o=r1)
#    셀: [기업명, 예측일, 공모희망가, 공모가, 공모금액, 기관경쟁률, 의무보유확약, 주간사]
# ---------------------------------------------------------------------------

def fetch_demand_results(max_pages=5):
    rows = []
    for page in range(1, max_pages + 1):
        url = f"{BASE}/html/fund/index.htm?o=r1&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"수요예측결과 조회 에러(page {page}): {e}")
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
            rows.append({
                "stock_name": normalize_name(name),
                "price_band_low": band_lo,
                "price_band_high": band_hi,
                "confirmed_price": parse_price(cells[3]),
                "offering_amount_eok": parse_amount_eok(cells[4]),
                "institutional_competition_rate": parse_ratio(cells[5]) if len(cells) > 5 else None,
                "lockup_commitment_ratio": parse_percent(cells[6]) if len(cells) > 6 else None,
                "lead_underwriter": cells[7] if len(cells) > 7 else None,
                "source_url": _detail_url(a),
                "last_stage": "forecast_result",
            })

        if not found_any:
            break
        time.sleep(0.3)

    print(f"[수요예측결과] {len(rows)}개 행 수집")
    return rows


# ---------------------------------------------------------------------------
# 3) 공모청약일정 (o=k)
#    셀: [종목명, 공모주일정, 확정공모가, 희망공모가, 청약경쟁률, 주간사, 분석]
# ---------------------------------------------------------------------------

def fetch_subscription_schedule(max_pages=5):
    rows = []
    for page in range(1, max_pages + 1):
        url = f"{BASE}/html/fund/index.htm?o=k&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"청약일정 조회 에러(page {page}): {e}")
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
            rows.append({
                "stock_name": normalize_name(name),
                "subscription_start_date": start,
                "subscription_end_date": end,
                "confirmed_price": parse_price(cells[2]) if len(cells) > 2 else None,
                "price_band_low": band_lo,
                "price_band_high": band_hi,
                "subscription_competition_rate": parse_ratio(cells[4]) if len(cells) > 4 else None,
                "lead_underwriter": cells[5] if len(cells) > 5 else None,
                "source_url": _detail_url(a),
                "last_stage": "subscription",
            })

        if not found_any:
            break
        time.sleep(0.3)

    print(f"[청약일정] {len(rows)}개 행 수집")
    return rows


# ---------------------------------------------------------------------------
# 4) 신규상장 (o=nw)
#    셀: [기업명, 신규상장일, 현재가, 전일비, 공모가, 공모가대비등락률, 시초가, 시초/공모(%), 첫날종가, ...]
# ---------------------------------------------------------------------------

def fetch_listing_results(max_pages=5):
    rows = []
    for page in range(1, max_pages + 1):
        url = f"{BASE}/html/fund/index.htm?o=nw&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"신규상장 조회 에러(page {page}): {e}")
            break

        found_any = False
        for name, cells, a in _iter_rows(html):
            if len(cells) < 2:
                continue
            iso = parse_date_slash(cells[1]) or parse_date_dot(cells[1])
            if not iso:
                continue
            found_any = True
            rows.append({
                "stock_name": normalize_name(name),
                "listing_date": iso,
                "listing_offering_price": parse_price(cells[4]) if len(cells) > 4 else None,
                "listing_open_price": parse_price(cells[6]) if len(cells) > 6 else None,
                "listing_first_close_price": parse_price(cells[8]) if len(cells) > 8 else None,
                "source_url": _detail_url(a),
                "last_stage": "listing",
            })

        if not found_any:
            break
        time.sleep(0.3)

    print(f"[신규상장] {len(rows)}개 행 수집")
    return rows


# ---------------------------------------------------------------------------
# upsert
# ---------------------------------------------------------------------------

def upsert_stage(supabase: Client, stage_name, rows, chunk_size=50):
    if not rows:
        return
    # 같은 배치 안에 같은 종목명이 중복되면 upsert가 에러를 내므로 정리
    dedup = {}
    for r in rows:
        if r["stock_name"]:
            dedup[r["stock_name"]] = r
    rows = list(dedup.values())

    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        try:
            supabase.table("ipo_history").upsert(chunk, on_conflict="stock_name").execute()
        except Exception as e:
            print(f"[{stage_name}] upsert 실패(chunk {i // chunk_size}): {e}")

    print(f"[{stage_name}] {len(rows)}개 종목 upsert 완료")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Supabase 환경 변수가 설정되지 않았습니다.")
        return

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    demand_schedule_pages = _max_pages("DEMAND_SCHEDULE_MAX_PAGES")
    demand_results_pages = _max_pages("DEMAND_RESULTS_MAX_PAGES")
    subscription_pages = _max_pages("SUBSCRIPTION_MAX_PAGES")
    listing_pages = _max_pages("LISTING_MAX_PAGES")
    print(
        "이번 실행 페이지 수 — "
        f"수요예측일정:{demand_schedule_pages} 수요예측결과:{demand_results_pages} "
        f"청약일정:{subscription_pages} 신규상장:{listing_pages}"
    )

    # 단계 순서대로 진행: 뒤 단계일수록 더 확정적인 값이라 그대로 덮어써도 된다.
    upsert_stage(supabase, "수요예측일정", fetch_demand_schedule(max_pages=demand_schedule_pages))
    upsert_stage(supabase, "수요예측결과", fetch_demand_results(max_pages=demand_results_pages))
    upsert_stage(supabase, "청약일정", fetch_subscription_schedule(max_pages=subscription_pages))
    upsert_stage(supabase, "신규상장", fetch_listing_results(max_pages=listing_pages))

    print("ipo_history 갱신 완료")


if __name__ == "__main__":
    main()
