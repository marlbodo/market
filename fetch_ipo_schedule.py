import os
import re
import json
import time
import difflib
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

from bs4 import BeautifulSoup
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

DART_API_KEY = os.environ.get("DART_API_KEY")

NAVER_API_KEY_ID = os.environ.get("NAVER_CLIENT_ID")
NAVER_API_KEY = os.environ.get("NAVER_CLIENT_SECRET")

# Optional — if not set, overall_assessment (종합판단) is left blank instead of
# calling the model. Uses Anthropic's Messages API directly (no SDK dependency).
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


# ---------------------------------------------------------------------------
# Name normalization / fuzzy matching
# ---------------------------------------------------------------------------

def normalize_name(name):
    if not name:
        return ""
    name = name.strip()
    name = re.sub(r"\.{2,}$", "", name)   # ipostock truncates long names with ".."
    name = re.sub(r"…$", "", name)
    name = re.sub(r"\s+", "", name)        # 공모주 이름은 공백 제거하고 비교
    return name


def names_match(a, b):
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    # ipostock/38 둘 다 이름을 줄여서 보여주는 경우가 있어 접두어 매칭도 허용
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(shorter) >= 2 and longer.startswith(shorter):
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() >= 0.85


def find_existing_key(name, index):
    """index: dict of normalized_name -> canonical_key(name as first seen)."""
    norm = normalize_name(name)
    if norm in index:
        return index[norm]
    for existing_norm, key in index.items():
        if names_match(norm, existing_norm):
            return key
    return None


# ---------------------------------------------------------------------------
# 1) DART — OpenDART 발행공시(지분증권 증권신고서) 목록
#    공식 API. 필드 값(공모가/경쟁률 등)은 신고서 원문 파싱이 필요해 범위 밖 —
#    여기서는 종목명 존재 확인 + 공시뷰어 링크(source_urls)만 채운다.
# ---------------------------------------------------------------------------

def fetch_dart_ipo_disclosures(lookback_days=90):
    if not DART_API_KEY:
        print("DART_API_KEY가 없어 DART 조회를 건너뜁니다.")
        return {}

    end_de = datetime.now().strftime("%Y%m%d")
    bgn_de = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y%m%d")

    results = {}
    page_no = 1
    while True:
        params = {
            "crtfc_key": DART_API_KEY,
            "bgn_de": bgn_de,
            "end_de": end_de,
            "pblntf_ty": "C",       # 발행공시 (증권신고서/투자설명서 등)
            "page_no": str(page_no),
            "page_count": "100",
        }
        url = "https://opendart.fss.or.kr/api/list.json?" + urllib.parse.urlencode(params)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"DART 조회 에러: {e}")
            break

        status = data.get("status")
        if status == "013":  # 조회된 데이터가 없음
            break
        if status != "000":
            print(f"DART API 응답 오류: {status} {data.get('message')}")
            break

        items = data.get("list", [])
        for it in items:
            report_nm = it.get("report_nm", "")
            # 지분증권 관련 증권신고서/투자설명서만 (채무증권/합병 등 제외)
            if "지분증권" not in report_nm and "증권신고서" not in report_nm:
                continue
            corp_name = it.get("corp_name", "")
            rcept_no = it.get("rcept_no", "")
            rcept_dt = it.get("rcept_dt", "")
            key = normalize_name(corp_name)
            if not key:
                continue
            entry = results.setdefault(key, {
                "stock_name": corp_name,
                "dart_url": None,
                "dart_rcept_dt": None,
            })
            dart_url = f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}"
            # 가장 최근(정정 포함) 신고서 링크로 갱신
            if not entry["dart_rcept_dt"] or rcept_dt > entry["dart_rcept_dt"]:
                entry["dart_url"] = dart_url
                entry["dart_rcept_dt"] = rcept_dt

        total_page = data.get("total_page", 1)
        if page_no >= total_page:
            break
        page_no += 1
        time.sleep(0.2)

    print(f"DART: 지분증권 관련 공시 {len(results)}개 종목 확인")
    return results


# ---------------------------------------------------------------------------
# 2) 38커뮤니케이션 — 공모주 청약일정 (메인 숫자 소스)
#    http://www.38.co.kr/html/fund/?o=k  (EUC-KR 인코딩, 페이지네이션 있음)
# ---------------------------------------------------------------------------

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


def fetch_38_ipo_schedule(max_pages=3):
    results = {}
    for page in range(1, max_pages + 1):
        url = f"http://www.38.co.kr/html/fund/index.htm?o=k&page={page}"
        try:
            html = _fetch_html(url)
        except Exception as e:
            print(f"38 조회 에러(page {page}): {e}")
            break

        soup = BeautifulSoup(html, "html.parser")
        # 종목명 링크는 fund/?o=v&no=NNNN 또는 fund/index.htm?o=v&no=NNNN 패턴
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
                "source_38_url": "http://www.38.co.kr" + a["href"].replace("index.htm", ""),
            }

            # 수요예측일: 2026.10.15~10.16
            m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})", row_text)
            if m:
                y, m1, d1, m2, d2 = m.groups()
                entry["demand_forecast_start_date"] = f"{y}-{m1}-{d1}"
                # 종료월이 시작월보다 작으면 해가 넘어간 것으로 간주
                end_year = int(y) + 1 if int(m2) < int(m1) else int(y)
                entry["demand_forecast_end_date"] = f"{end_year}-{m2}-{d2}"
                row_text = row_text[m.end():]

            # 희망공모가 밴드: 2,000~2,000  (원 단위, 콤마 포함 숫자만)
            m = re.search(r"([\d,]{3,})\s*~\s*([\d,]{3,})", row_text)
            if m:
                entry["price_band_low"] = int(m.group(1).replace(",", ""))
                entry["price_band_high"] = int(m.group(2).replace(",", ""))
                row_text = row_text[m.end():]

            # 확정공모가는 밴드 앞쪽에 단독 숫자로 나오는 경우가 있어 별도 탐색
            m = re.search(r"^\s*([\d,]{3,})\s", tr.get_text(" ", strip=True))
            # (위 라인은 참고용, 정확한 위치 파싱이 어려워 확정공모가는 ipostock에서 보강)

            # 청약경쟁률: 2.85:1
            m = re.search(r"([\d,]+(?:\.\d+)?)\s*:\s*1", row_text)
            if m:
                entry["subscription_competition_rate"] = float(m.group(1).replace(",", ""))

            key = normalize_name(stock_name)
            results[key] = entry

        time.sleep(0.3)

    print(f"38커뮤니케이션: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 3) IPOSTOCK — 공모청약일정 (38에 없는 값 보강: 청약일, 공모금액, 상장일 등)
#    http://www.ipostock.co.kr/sub03/ipo04.asp
# ---------------------------------------------------------------------------

def fetch_ipostock_ipo_schedule():
    url = "http://www.ipostock.co.kr/sub03/ipo04.asp"
    results = {}
    try:
        html = _fetch_html(url)
    except Exception as e:
        print(f"IPOSTOCK 조회 에러: {e}")
        return results

    soup = BeautifulSoup(html, "html.parser")
    name_links = soup.find_all("a", href=re.compile(r"view_pg/view_04\.asp\?code="))

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
            "subscription_start_date": None,
            "subscription_end_date": None,
            "price_band_low": None,
            "price_band_high": None,
            "confirmed_price": None,
            "offering_amount_eok": None,
            "listing_date": None,
            "subscription_competition_rate": None,
            "source_ipostock_url": "http://www.ipostock.co.kr" + a["href"].lstrip("."),
        }

        # 청약기간: 08.03 ~ 08.04  (연도 없음 — 현재 연도 기준으로 보정)
        m = re.search(r"(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})", row_text)
        if m:
            mo1, d1, mo2, d2 = m.groups()
            year = datetime.now().year
            entry["subscription_start_date"] = f"{year}-{mo1}-{d1}"
            entry["subscription_end_date"] = f"{year}-{mo2}-{d2}"
            row_text = row_text[m.end():]

        # 희망공모가: 5,000원~7,000원
        m = re.search(r"([\d,]+)\s*원\s*~\s*([\d,]+)\s*원", row_text)
        if m:
            entry["price_band_low"] = int(m.group(1).replace(",", ""))
            entry["price_band_high"] = int(m.group(2).replace(",", ""))
            row_text = row_text[m.end():]

        # 확정공모가: 밴드 뒤에 오는 단독 "NNN원"
        m = re.search(r"([\d,]+)\s*원", row_text)
        if m:
            entry["confirmed_price"] = int(m.group(1).replace(",", ""))
            row_text = row_text[m.end():]

        # 공모금액: 154 억원
        m = re.search(r"([\d,.]+)\s*억원", row_text)
        if m:
            entry["offering_amount_eok"] = float(m.group(1).replace(",", ""))
            row_text = row_text[m.end():]

        # 남은 두 개의 MM.DD 는 환불일, 상장일 순서
        dates = re.findall(r"(\d{2})\.(\d{2})", row_text)
        if len(dates) >= 2:
            year = datetime.now().year
            mo, d = dates[1]  # 두 번째가 상장일
            entry["listing_date"] = f"{year}-{mo}-{d}"

        # 경쟁율: 10.29 :1
        m = re.search(r"([\d,]+(?:\.\d+)?)\s*:\s*1", row_text)
        if m:
            entry["subscription_competition_rate"] = float(m.group(1).replace(",", ""))

        key = normalize_name(stock_name)
        results[key] = entry

    print(f"IPOSTOCK: {len(results)}개 종목 수집")
    return results


# ---------------------------------------------------------------------------
# 4) 네이버 뉴스 — 공모주/IPO 제목 매칭 (fetch_ipo_news.py 로직 재사용, 요약용)
# ---------------------------------------------------------------------------

def fetch_naver_ipo_context(stock_names, display=100):
    """종목명별 최신 뉴스 제목/요약을 모아 AI 종합판단용 컨텍스트로 반환."""
    if not NAVER_API_KEY_ID or not NAVER_API_KEY:
        print("네이버 API 키가 없어 뉴스 조회를 건너뜁니다.")
        return {}

    context = {name: [] for name in stock_names}
    for keyword in ["공모주", "IPO"]:
        encoded_query = urllib.parse.quote(keyword)
        url = (
            "https://naverapihub.apigw.ntruss.com/search/v1/news"
            f"?query={encoded_query}&display={display}&start=1&sort=date&format=json"
        )
        request = urllib.request.Request(url)
        request.add_header("X-NCP-APIGW-API-KEY-ID", NAVER_API_KEY_ID.strip())
        request.add_header("X-NCP-APIGW-API-KEY", NAVER_API_KEY.strip())
        try:
            response = urllib.request.urlopen(request, timeout=15)
            if response.getcode() != 200:
                continue
            data = json.loads(response.read().decode("utf-8"))
        except Exception as e:
            print(f"네이버 뉴스 조회 에러('{keyword}'): {e}")
            continue

        for item in data.get("items", []):
            title = item.get("title", "").replace("<b>", "").replace("</b>", "")
            desc = item.get("description", "").replace("<b>", "").replace("</b>", "")
            for name in stock_names:
                if normalize_name(name) and normalize_name(name) in normalize_name(title + desc):
                    context[name].append(f"{title} - {desc}")

    return context


# ---------------------------------------------------------------------------
# 5) AI 종합판단 생성 (Anthropic Messages API, 선택사항)
# ---------------------------------------------------------------------------

def generate_overall_assessment(entry, news_snippets):
    if not ANTHROPIC_API_KEY:
        return None

    news_text = "\n".join(f"- {s}" for s in news_snippets[:5]) if news_snippets else "(관련 뉴스 없음)"
    prompt = f"""아래는 IPO 공모주 정보입니다. 최근 분위기, 경쟁률, 유통가능물량, 시장상황을 종합 고려해서
2~3문장으로 간결한 종합판단을 작성해줘. 과장하지 말고 사실 기반으로.

종목명: {entry.get('stock_name')}
희망공모가 밴드: {entry.get('price_band_low')}~{entry.get('price_band_high')}
확정공모가: {entry.get('confirmed_price')}
공모금액(억원): {entry.get('offering_amount_eok')}
기관경쟁률: {entry.get('institutional_competition_rate')}
청약경쟁률(일반): {entry.get('subscription_competition_rate')}
유통가능구주물량: {entry.get('tradable_existing_shares')}
유통가능신주물량: {entry.get('tradable_new_shares')}

관련 뉴스:
{news_text}"""

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
# 병합: dart -> naver -> 38 -> ipostock 순서, 이미 채워진 필드는 덮어쓰지 않음
# ---------------------------------------------------------------------------

def merge_sources(dart_data, s38_data, ipostock_data):
    # 마스터 종목 목록은 38 + ipostock 합집합 (실제 일정 숫자를 갖고 있는 소스들)
    master = {}
    name_index = {}  # normalized_name -> canonical key

    def get_or_create(key, display_name):
        canonical = find_existing_key(display_name, name_index)
        if canonical is None:
            canonical = key
            name_index[key] = canonical
            master[canonical] = {"stock_name": display_name, "source_urls": {}}
        return canonical

    # 38 먼저 (메인 숫자 소스)
    for key, e in s38_data.items():
        ck = get_or_create(key, e["stock_name"])
        row = master[ck]
        for field in ("demand_forecast_start_date", "demand_forecast_end_date",
                      "confirmed_price", "price_band_low", "price_band_high",
                      "subscription_competition_rate"):
            if row.get(field) is None and e.get(field) is not None:
                row[field] = e[field]
        if e.get("source_38_url"):
            row["source_urls"]["38"] = e["source_38_url"]

    # ipostock으로 빈 필드 보강
    for key, e in ipostock_data.items():
        ck = get_or_create(key, e["stock_name"])
        row = master[ck]
        for field in ("subscription_start_date", "subscription_end_date",
                      "price_band_low", "price_band_high", "confirmed_price",
                      "offering_amount_eok", "listing_date",
                      "subscription_competition_rate"):
            if row.get(field) is None and e.get(field) is not None:
                row[field] = e[field]
        if e.get("source_ipostock_url"):
            row["source_urls"]["ipostock"] = e["source_ipostock_url"]

    # dart는 공식 링크만 (숫자 필드 없음)
    for key, e in dart_data.items():
        ck = find_existing_key(e["stock_name"], name_index)
        if ck is None:
            # 38/ipostock에 아직 안 잡힌 종목(수요예측 전 단계)도 존재 자체는 기록
            ck = get_or_create(key, e["stock_name"])
        if e.get("dart_url"):
            master[ck]["source_urls"]["dart"] = e["dart_url"]

    return master


def infer_status(row):
    today = datetime.now().date()

    def parse_d(s):
        try:
            return datetime.strptime(s, "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return None

    listing = parse_d(row.get("listing_date"))
    sub_start = parse_d(row.get("subscription_start_date"))
    sub_end = parse_d(row.get("subscription_end_date"))
    dfs = parse_d(row.get("demand_forecast_start_date"))
    dfe = parse_d(row.get("demand_forecast_end_date"))

    if listing and listing <= today:
        return "상장완료"
    if sub_start and sub_end and sub_start <= today <= sub_end:
        return "청약중"
    if dfs and dfe and dfs <= today <= dfe:
        return "수요예측중"
    return "예정"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Supabase 환경 변수가 설정되지 않았습니다.")
        return

    dart_data = fetch_dart_ipo_disclosures()
    s38_data = fetch_38_ipo_schedule()
    ipostock_data = fetch_ipostock_ipo_schedule()

    merged = merge_sources(dart_data, s38_data, ipostock_data)
    if not merged:
        print("수집된 공모주 일정이 없습니다.")
        return

    stock_names = [row["stock_name"] for row in merged.values()]
    news_context = fetch_naver_ipo_context(stock_names)

    rows_to_insert = []
    for row in merged.values():
        row["status"] = infer_status(row)
        snippets = news_context.get(row["stock_name"], [])
        row["overall_assessment"] = generate_overall_assessment(row, snippets)
        row["source_urls"] = json.dumps(row.get("source_urls", {}), ensure_ascii=False)
        rows_to_insert.append(row)

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
