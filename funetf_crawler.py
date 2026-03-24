#!/usr/bin/env python3
"""
FunETF 크롤러 v2 - 네트워크 인터셉트 방식
==========================================
Chrome DevTools Protocol로 XHR 요청을 가로채서 API 데이터를 직접 수집합니다.

[사용법]
  cd ~/Projects/SamsungETF
  source venv/bin/activate
  python funetf_crawler.py
"""

import json
import time
import os
import re
import logging
from datetime import datetime

import pandas as pd
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

try:
    from webdriver_manager.chrome import ChromeDriverManager
    USE_WDM = True
except ImportError:
    USE_WDM = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("FunETF")

BASE_URL = "https://www.funetf.co.kr"
OUTPUT_DIR = "funetf_output"


class FunETFCrawler:
    def __init__(self, headless=True):
        self.headless = headless
        self.driver = None
        self.captured_apis = {}   # url -> response_body
        self.all_data = {
            "etf_list": [],
            "etf_details": [],
            "fund_list": [],
            "crawled_at": datetime.now().isoformat(),
        }
        os.makedirs(OUTPUT_DIR, exist_ok=True)

    # ─── WebDriver ───

    def _init_driver(self):
        """Chrome + DevTools 로깅 활성화"""
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass

        opts = Options()
        if self.headless:
            opts.add_argument("--headless=new")

        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--window-size=1920,1080")
        opts.add_argument("--lang=ko-KR")
        opts.add_argument(
            "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
        )
        # ★ 네트워크 로그 캡처 활성화
        opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})

        if USE_WDM:
            service = Service(ChromeDriverManager().install())
        else:
            service = Service()

        self.driver = webdriver.Chrome(service=service, options=opts)
        self.driver.set_page_load_timeout(60)
        self.driver.implicitly_wait(5)
        log.info("🌐 Chrome 초기화 완료")

    def _close_driver(self):
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None

    def _check_session(self):
        """세션 유효한지 확인, 끊겼으면 재시작"""
        try:
            _ = self.driver.current_url
        except Exception:
            log.info("  ⚠️ 세션 만료 → 재초기화...")
            self._init_driver()

    # ─── 네트워크 인터셉트 (핵심) ───

    def _capture_network_responses(self) -> dict:
        """
        Chrome Performance 로그에서 API 응답을 추출합니다.
        XHR/fetch 요청 중 /api/ 경로의 JSON 응답을 모두 캡처합니다.
        """
        captured = {}

        try:
            logs = self.driver.get_log("performance")
        except Exception as e:
            log.debug(f"로그 수집 실패: {e}")
            return captured

        # requestId -> url 매핑
        request_map = {}

        for entry in logs:
            try:
                msg = json.loads(entry["message"])["message"]
                method = msg.get("method", "")
                params = msg.get("params", {})

                # 요청 기록
                if method == "Network.requestWillBeSent":
                    req_id = params.get("requestId", "")
                    url = params.get("request", {}).get("url", "")
                    if "/api/" in url:
                        request_map[req_id] = url

                # 응답 수신
                elif method == "Network.responseReceived":
                    req_id = params.get("requestId", "")
                    url = params.get("response", {}).get("url", "")
                    mime = params.get("response", {}).get("mimeType", "")
                    if "/api/" in url and "json" in mime:
                        request_map[req_id] = url

            except (json.JSONDecodeError, KeyError):
                continue

        # 응답 본문 가져오기
        for req_id, url in request_map.items():
            try:
                body = self.driver.execute_cdp_cmd(
                    "Network.getResponseBody", {"requestId": req_id}
                )
                text = body.get("body", "")
                if text:
                    data = json.loads(text)
                    captured[url] = data
                    short = url.split("funetf.co.kr")[-1] if "funetf.co.kr" in url else url
                    log.info(f"  🔗 API 캡처: {short[:80]}")
            except Exception:
                continue

        return captured

    def _enable_network_logging(self):
        """CDP 네트워크 도메인 활성화"""
        try:
            self.driver.execute_cdp_cmd("Network.enable", {})
        except Exception:
            pass

    # ─── 페이지 크롤링 ───

    def _load_page_and_capture(self, url: str, wait_seconds: int = 8, scroll: bool = True) -> dict:
        """
        페이지를 로드하고, 발생하는 모든 API 호출을 캡처합니다.
        """
        log.info(f"  📄 {url}")

        self._check_session()

        try:
            self.driver.get(url)
        except Exception as e:
            log.warning(f"  페이지 로드 실패: {e}")
            return {}

        self._enable_network_logging()

        # 초기 로딩 대기
        time.sleep(wait_seconds)

        # 팝업 닫기
        self._close_popups()
        time.sleep(1)

        # 스크롤 + 더보기 클릭으로 추가 데이터 로드
        if scroll:
            self._load_all_data()

        # 네트워크 캡처
        captured = self._capture_network_responses()
        self.captured_apis.update(captured)

        return captured

    def _close_popups(self):
        """팝업/모달 닫기"""
        close_scripts = [
            "document.querySelectorAll('[class*=close], [class*=Close], .btn-close').forEach(b => { try { b.click(); } catch(e) {} });",
            "document.querySelectorAll('button').forEach(b => { if(b.textContent.includes('닫기') || b.textContent.includes('오늘')) { try { b.click(); } catch(e) {} } });",
            "document.querySelectorAll('.popup, .modal, [class*=popup], [class*=modal]').forEach(el => { el.style.display = 'none'; });",
        ]
        for script in close_scripts:
            try:
                self.driver.execute_script(script)
                time.sleep(0.3)
            except Exception:
                pass

    def _load_all_data(self, max_attempts: int = 30):
        """스크롤 + 더보기 버튼으로 전체 데이터 로드"""
        for i in range(max_attempts):
            # 더보기 버튼 클릭
            clicked = False
            try:
                clicked = self.driver.execute_script("""
                    var btns = document.querySelectorAll('button, a');
                    for (var b of btns) {
                        if ((b.textContent.includes('더보기') || b.textContent.includes('더 보기'))
                            && b.offsetParent !== null) {
                            b.click();
                            return true;
                        }
                    }
                    return false;
                """)
            except Exception:
                pass

            if clicked:
                time.sleep(2)
                continue

            # 스크롤
            try:
                curr_height = self.driver.execute_script("return document.body.scrollHeight")
                self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                time.sleep(1.5)
                new_height = self.driver.execute_script("return document.body.scrollHeight")
                if new_height == curr_height:
                    break
            except Exception:
                break

    # ─── DOM에서 직접 데이터 추출 (폴백) ───

    def _extract_tables_from_dom(self) -> list:
        """현재 페이지의 테이블을 JavaScript로 추출 (Selenium이 아닌 JS로!)"""
        try:
            result = self.driver.execute_script("""
                var tables = document.querySelectorAll('table');
                var allData = [];

                tables.forEach(function(table) {
                    var headers = [];
                    var ths = table.querySelectorAll('thead th, thead td');
                    ths.forEach(function(th) {
                        headers.push(th.innerText.trim().replace(/\\n/g, ' '));
                    });

                    if (headers.length === 0) return;

                    var rows = table.querySelectorAll('tbody tr');
                    rows.forEach(function(tr) {
                        var tds = tr.querySelectorAll('td');
                        if (tds.length === 0) return;

                        var row = {};
                        var hasData = false;

                        tds.forEach(function(td, i) {
                            var key = i < headers.length ? headers[i] : 'col_' + i;
                            var text = td.innerText.trim().replace(/\\n/g, ' ');
                            row[key] = text;

                            var link = td.querySelector('a');
                            if (link && link.href) {
                                row[key + '_link'] = link.href;
                            }

                            if (text) hasData = true;
                        });

                        if (hasData) allData.push(row);
                    });
                });

                return allData;
            """)
            return result or []
        except Exception as e:
            log.debug(f"  DOM 테이블 추출 실패: {e}")
            return []

    # ─── ETF 상세 페이지 ───

    def _crawl_etf_detail_page(self, isin: str) -> dict:
        """ETF 개별 상세 페이지에서 모든 API 응답 캡처"""
        url = f"{BASE_URL}/product/etf/view/{isin}"
        captured = self._load_page_and_capture(url, wait_seconds=6, scroll=False)

        detail = {"isin": isin, "url": url, "api_responses": {}}

        for api_url, data in captured.items():
            short = api_url.split("funetf.co.kr")[-1] if "funetf.co.kr" in api_url else api_url
            detail["api_responses"][short] = data

        try:
            detail["name"] = self.driver.execute_script(
                "return document.querySelector('h2, [class*=name], [class*=title]')?.innerText?.trim() || '';"
            )
            detail["tables"] = self._extract_tables_from_dom()
        except Exception:
            pass

        return detail

    # ─── 메인 실행 ───

    def run(self, detail_limit: int = 10):
        log.info("=" * 60)
        log.info("🚀 FunETF 크롤러 v2 시작")
        log.info("=" * 60)

        start = time.time()

        try:
            self._init_driver()

            # ── Step 1: ETF 필터 페이지 ──
            log.info("\n📋 [1/4] ETF 목록 수집...")
            etf_captured = self._load_page_and_capture(
                f"{BASE_URL}/product/etf/filter",
                wait_seconds=10,
                scroll=True,
            )

            etf_items = self._extract_list_from_captured(etf_captured, "etf")
            if not etf_items:
                log.info("  API 캡처 실패 → DOM 추출 시도...")
                etf_items = self._extract_tables_from_dom()

            self.all_data["etf_list"] = etf_items
            log.info(f"  ✅ ETF: {len(etf_items)}건")

            # ── Step 2: 펀드 필터 페이지 ──
            log.info("\n📋 [2/4] 펀드 목록 수집...")
            self._check_session()

            fund_captured = self._load_page_and_capture(
                f"{BASE_URL}/product/fund/filter",
                wait_seconds=10,
                scroll=True,
            )

            fund_items = self._extract_list_from_captured(fund_captured, "fund")
            if not fund_items:
                fund_items = self._extract_tables_from_dom()

            self.all_data["fund_list"] = fund_items
            log.info(f"  ✅ 펀드: {len(fund_items)}건")

            # ── Step 3: ETF 상세 ──
            if detail_limit > 0:
                log.info(f"\n📊 [3/4] ETF 상세 수집 (최대 {detail_limit}건)...")
                isin_codes = self._find_isin_codes()[:detail_limit]

                for i, isin in enumerate(isin_codes):
                    log.info(f"  [{i+1}/{len(isin_codes)}] {isin}")
                    self._check_session()
                    detail = self._crawl_etf_detail_page(isin)
                    self.all_data["etf_details"].append(detail)
                    time.sleep(1.5)

            # ── Step 4: 메인 페이지 ──
            log.info("\n📰 [4/4] 메인 페이지 데이터...")
            self._check_session()
            main_captured = self._load_page_and_capture(
                BASE_URL, wait_seconds=8, scroll=False
            )
            if main_captured:
                self.all_data["main_data"] = {
                    url.split("funetf.co.kr")[-1]: data
                    for url, data in main_captured.items()
                }

        except KeyboardInterrupt:
            log.info("\n⚠️ 사용자 중단")
        except Exception as e:
            log.error(f"크롤링 오류: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self._close_driver()

        # ── 저장 ──
        self._save_all()

        elapsed = time.time() - start
        log.info("\n" + "=" * 60)
        log.info(f"✅ 완료! ({elapsed:.0f}초)")
        log.info(f"   ETF 목록: {len(self.all_data['etf_list'])}건")
        log.info(f"   펀드 목록: {len(self.all_data['fund_list'])}건")
        log.info(f"   ETF 상세: {len(self.all_data['etf_details'])}건")
        log.info(f"   캡처 API: {len(self.captured_apis)}개")
        log.info(f"   📁 {os.path.abspath(OUTPUT_DIR)}")
        log.info("=" * 60)

    # ─── 데이터 추출 헬퍼 ───

    def _extract_list_from_captured(self, captured: dict, category: str) -> list:
        """캡처된 API 응답에서 리스트 데이터 추출"""
        best = []
        for url, data in captured.items():
            items = self._dig_list(data)
            if items and len(items) > len(best):
                best = items
                short = url.split("funetf.co.kr")[-1] if "funetf.co.kr" in url else url
                log.info(f"  📦 {category} 데이터 발견: {len(items)}건 ({short[:60]})")
        return best

    def _dig_list(self, data, depth=0) -> list:
        """중첩 구조에서 가장 큰 리스트 찾기"""
        if depth > 5:
            return []
        if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
            return data
        if isinstance(data, dict):
            best = []
            for val in data.values():
                result = self._dig_list(val, depth + 1)
                if len(result) > len(best):
                    best = result
            return best
        return []

    def _find_isin_codes(self) -> list:
        """수집된 데이터에서 ISIN 코드 추출"""
        codes = set()

        for data in [self.captured_apis, self.all_data]:
            self._find_codes_recursive(data, codes)

        for item in self.all_data.get("etf_list", []):
            if isinstance(item, dict):
                for val in item.values():
                    if isinstance(val, str):
                        for m in re.finditer(r'KR7\d{6}\d{3}', val):
                            codes.add(m.group(0))

        result = sorted(codes)
        log.info(f"  🔑 ISIN 코드 {len(result)}개 발견")
        return result

    def _find_codes_recursive(self, data, codes: set, depth=0):
        if depth > 5:
            return
        if isinstance(data, str):
            for m in re.finditer(r'KR7\d{6}\d{3}', data):
                codes.add(m.group(0))
        elif isinstance(data, dict):
            for k, v in data.items():
                if k.lower() in ("isincd", "isin", "isincode", "isu_cd") and isinstance(v, str) and v.startswith("KR"):
                    codes.add(v)
                self._find_codes_recursive(v, codes, depth + 1)
        elif isinstance(data, list):
            for item in data[:200]:
                self._find_codes_recursive(item, codes, depth + 1)

    # ─── 저장 ───

    def _save_all(self):
        log.info("\n💾 저장 중...")

        # 1) 캡처된 API 원본
        api_export = {}
        for url, data in self.captured_apis.items():
            short = url.split("funetf.co.kr")[-1] if "funetf.co.kr" in url else url
            api_export[short] = data

        with open(os.path.join(OUTPUT_DIR, "captured_apis.json"), "w", encoding="utf-8") as f:
            json.dump(api_export, f, ensure_ascii=False, indent=2, default=str)
        log.info(f"  ✅ captured_apis.json ({len(api_export)}개 API)")

        # 2) 전체 데이터
        with open(os.path.join(OUTPUT_DIR, "funetf_all_data.json"), "w", encoding="utf-8") as f:
            json.dump(self.all_data, f, ensure_ascii=False, indent=2, default=str)
        log.info(f"  ✅ funetf_all_data.json")

        # 3) ETF Excel
        if self.all_data["etf_list"]:
            self._to_excel(self.all_data["etf_list"], "funetf_etf_list.xlsx")

        # 4) 펀드 Excel
        if self.all_data["fund_list"]:
            self._to_excel(self.all_data["fund_list"], "funetf_fund_list.xlsx")

        # 5) ETF 상세 Excel
        if self.all_data["etf_details"]:
            flat = []
            for d in self.all_data["etf_details"]:
                row = {"isin": d.get("isin", ""), "name": d.get("name", ""), "url": d.get("url", "")}
                for api_url, api_data in d.get("api_responses", {}).items():
                    if isinstance(api_data, dict):
                        for k, v in api_data.items():
                            if isinstance(v, (str, int, float)):
                                row[k] = v
                flat.append(row)
            self._to_excel(flat, "funetf_etf_details.xlsx")

    def _to_excel(self, data: list, filename: str):
        try:
            filepath = os.path.join(OUTPUT_DIR, filename)
            df = pd.DataFrame(data)
            df.to_excel(filepath, index=False, engine="openpyxl")
            log.info(f"  ✅ {filename} ({len(data)}행, {len(df.columns)}열)")
        except Exception as e:
            csv_name = filename.replace(".xlsx", ".csv")
            csv_path = os.path.join(OUTPUT_DIR, csv_name)
            pd.DataFrame(data).to_csv(csv_path, index=False, encoding="utf-8-sig")
            log.info(f"  ✅ {csv_name} (CSV 폴백: {e})")


# ─── CLI ───

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="FunETF 크롤러 v2")
    parser.add_argument("--no-headless", action="store_true", help="브라우저 창 표시")
    parser.add_argument("--detail-limit", type=int, default=10, help="ETF 상세 수집 개수 (0=스킵)")
    args = parser.parse_args()

    crawler = FunETFCrawler(headless=not args.no_headless)
    crawler.run(detail_limit=args.detail_limit)
