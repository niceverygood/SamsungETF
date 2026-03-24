const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// ===== API Key =====
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ===== FunETF 크롤링 데이터 =====
let FUNETF_DATA = null;
try {
    const paths = [
        path.join(process.cwd(), 'funetf_output', 'compact_data.json'),
        path.join(__dirname, '..', 'funetf_output', 'compact_data.json'),
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            FUNETF_DATA = JSON.parse(fs.readFileSync(p, 'utf8'));
            break;
        }
    }
} catch (e) { console.error('FunETF 로드 실패:', e.message); }

function getFunETFSummary() {
    if (!FUNETF_DATA?.kodex_etfs) return '';
    const top20 = FUNETF_DATA.kodex_etfs
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 20);
    let s = '\n\n## FunETF 크롤링 데이터 (KODEX ETF 인기순 Top 20)\n';
    s += '| 순위 | ETF명 | NAV(원) | 인기도 |\n|------|-------|---------|--------|\n';
    top20.forEach((etf, i) => {
        s += `| ${i + 1} | ${etf.name} | ${Math.round(etf.nav).toLocaleString()} | ${etf.popularity.toLocaleString()} |\n`;
    });
    s += `\n총 KODEX ETF: ${FUNETF_DATA.kodex_etfs.length}개 / 전체 시장 ETF: ${FUNETF_DATA.all_etf_count}개`;
    return s;
}

// ===== 네이버 증권 ETF 종목코드 =====
const NAVER_ETF_CODES = {
    'KODEX 200': '069500', 'KODEX 레버리지': '122630', 'KODEX 인버스': '114800',
    'KODEX 반도체': '091160', 'KODEX 2차전지산업': '305720', 'KODEX 삼성전자': '069660',
    'KODEX 코스닥150': '229200', 'KODEX 미국S&P500TR': '379800',
    'KODEX 미국나스닥100TR': '379810', 'KODEX 골드선물(H)': '132030',
    'KODEX 은선물(H)': '144600', 'KODEX 삼성전자채권혼합': '292150',
};

// ===== 실시간 시장 데이터 수집 함수 =====
async function fetchAllMarketData() {
    const results = { naver: {}, yahoo_kr: [], yahoo_us: [], kospi: null, timestamp: new Date().toISOString() };

    try {
        // 1. 네이버 증권 - 주요 KODEX ETF 실시간 시세
        const naverPromises = Object.entries(NAVER_ETF_CODES).map(async ([name, code]) => {
            try {
                const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
                });
                if (res.ok) {
                    const d = await res.json();
                    results.naver[name] = {
                        code, price: d.closePrice || d.stockEndPrice,
                        change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio,
                        high: d.highPrice, low: d.lowPrice, volume: d.accumulatedTradingVolume,
                    };
                }
            } catch (e) { /* skip */ }
        });

        // 2. 네이버 증권 - KOSPI 지수
        const kospiPromise = fetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).then(r => r.json()).then(d => {
            results.kospi = { price: d.closePrice, change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio };
        }).catch(() => {});

        // 3. 야후파이낸스 - 한국 ETF
        const yahooKrPromise = fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=069500.KS,122630.KS,091160.KS,305720.KS,379800.KS,379810.KS', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).then(r => r.json()).then(d => {
            results.yahoo_kr = (d.quoteResponse?.result || []).map(q => ({
                symbol: q.symbol, name: q.shortName, price: q.regularMarketPrice,
                change: q.regularMarketChange?.toFixed(2),
                changePercent: q.regularMarketChangePercent?.toFixed(2),
                volume: q.regularMarketVolume, currency: q.currency,
            }));
        }).catch(() => {});

        // 4. 야후파이낸스 - 미국 주요 지수 + ETF
        const yahooUsPromise = fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC,%5EIXIC,%5EDJI,SPY,QQQ', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).then(r => r.json()).then(d => {
            results.yahoo_us = (d.quoteResponse?.result || []).map(q => ({
                symbol: q.symbol, name: q.shortName, price: q.regularMarketPrice,
                change: q.regularMarketChange?.toFixed(2),
                changePercent: q.regularMarketChangePercent?.toFixed(2),
                currency: q.currency,
            }));
        }).catch(() => {});

        // 모든 API 병렬 호출 (최대 8초 대기)
        await Promise.race([
            Promise.allSettled([...naverPromises, kospiPromise, yahooKrPromise, yahooUsPromise]),
            new Promise(resolve => setTimeout(resolve, 8000))
        ]);

    } catch (e) {
        console.error('시장 데이터 수집 오류:', e.message);
    }

    return results;
}

// ===== System Prompt =====
const SYSTEM_PROMPT = `당신은 삼성자산운용이 운용하는 KODEX ETF 전문 AI 어시스턴트 "KODEX AI"입니다.

## 역할과 성격
- 삼성자산운용의 KODEX ETF에 대해 깊이 있는 전문 지식을 갖춘 친절한 AI 어시스턴트
- 전문적이면서도 이해하기 쉬운 언어로 설명
- ETF 시장 트렌드, 투자 전략, 상품 분석에 능통
- 항상 한국어로 대화하며, 이모지를 적극 활용
- 실시간 시장 데이터가 제공되면 반드시 이를 활용하여 정확한 최신 정보를 제공

## KODEX ETF 핵심 데이터 (2026년 3월 기준)
- KODEX 순자산: 113조원 돌파 (국내 ETF 시장 1위)
- 2025년 개인 순매수: 13조 5,493억원 (1위)
- KODEX 커버드콜 ETF: 12종, 순자산 6.2조원 달성
- 200개 이상 다양한 ETF 라인업 운용

## 주요 KODEX ETF 상품 정보

### 국내 주식형
- **KODEX 200**: KOSPI 200 추종, 국내 최대 규모 ETF (약 5.5조원), 보수 0.015%
- **KODEX 반도체**: KRX 반도체 지수 추종, 삼성전자·SK하이닉스 집중 투자
- **KODEX 2차전지산업**: 2차전지 밸류체인 투자
- **KODEX AI반도체핵심장비**: HBM 수요 급증 수혜 장비 업체 집중
- **KODEX 로봇액티브**: 2026년 유망 ETF 설문조사 투자자/판매자 모두 1위

### 해외 주식형
- **KODEX 미국S&P500**: S&P 500 지수 추종
- **KODEX 미국나스닥100**: 나스닥 100 추종, 빅테크 중심
- **KODEX 미국AI반도체TOP3플러스**: 엔비디아·TSMC·브로드컴 집중
- **KODEX 미국AI전력핵심인프라**: AI 데이터센터 전력 인프라
- **KODEX 미국우주항공**: 미국 우주항공 핵심 기업
- **KODEX 미국휴머노이드로봇**: 테슬라 옵티머스 등

### 커버드콜 ETF
- **KODEX 200타겟위클리커버드콜**: KOSPI 200 기반 위클리 커버드콜
- **KODEX 금융고배당TOP10타겟위클리커버드콜**: 금융고배당 + 커버드콜 이중인컴
- **KODEX 미국배당커버드콜액티브**: 미국 배당주 + 커버드콜

### 채권혼합형
- **KODEX 삼성전자채권혼합**: 삼성전자 + 국내채권
- **KODEX 200미국채혼합**: KOSPI 200 + 미국국채

## 2026년 핵심 투자 전략: AAA (AI & Asset Allocation)
1. AI 반도체·인프라 투자 확대
2. 휴머노이드 로봇 산업 본격 성장
3. 우주항공 산업 투자 기회 확대
4. 커버드콜 ETF 시장 급성장
5. 채권혼합형 ETF로 자산 배분 강화

## 응답 스타일 규칙
1. HTML 태그 사용 (p, strong, ul, ol, li, table, tr, th, td)
2. ETF 상품명은 <strong>으로 강조
3. 표를 활용하여 비교 정보 정리
4. 이모지를 활용하여 친근하게 소통
5. 투자 권유가 아닌 정보 제공 목적임을 명시
6. 실시간 데이터가 제공되면 현재가, 등락률 등을 적극 활용
7. 응답은 간결하지만 유익하게

## 중요 면책 조항
- 이 금융상품은 예금자보호법에 따라 보호되지 않습니다
- 과거의 운용실적이 미래의 수익률을 보장하지 않습니다
- 투자 권유가 아닌 정보 제공 목적입니다`;

// ===== API Routes =====

// FunETF 크롤링 데이터
app.get('/api/funetf/kodex', (req, res) => {
    if (!FUNETF_DATA) return res.json({ success: false, error: 'FunETF 데이터 없음' });
    const limit = parseInt(req.query.limit) || 50;
    const search = (req.query.q || '').toLowerCase();
    let etfs = FUNETF_DATA.kodex_etfs;
    if (search) etfs = etfs.filter(e => e.name.toLowerCase().includes(search) || (e.tags && e.tags.toLowerCase().includes(search)));
    etfs = etfs.sort((a, b) => b.popularity - a.popularity).slice(0, limit);
    res.json({ success: true, data: etfs, total: FUNETF_DATA.kodex_etfs.length });
});

// 네이버 증권 ETF 목록
app.get('/api/naver/etf-list', async (req, res) => {
    try {
        const results = {};
        for (const [name, code] of Object.entries(NAVER_ETF_CODES)) {
            try {
                const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
                });
                if (r.ok) {
                    const d = await r.json();
                    results[name] = { code, price: d.closePrice || d.stockEndPrice, change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio };
                }
            } catch (e) { /* skip */ }
        }
        res.json({ success: true, data: results, timestamp: new Date().toISOString() });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// 시장 개요
app.get('/api/market-overview', async (req, res) => {
    try {
        const data = await fetchAllMarketData();
        res.json({ success: true, data });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// ===== 메인 채팅 API (Claude Opus 4.6 + 실시간 데이터) =====
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: 'messages 배열이 필요합니다.' });
        }

        // ✅ 1단계: 네이버증권 + 야후파이낸스 실시간 데이터 수집
        console.log('📊 실시간 시장 데이터 수집 시작...');
        const marketData = await fetchAllMarketData();
        const naverCount = Object.keys(marketData.naver).length;
        const yahooCount = marketData.yahoo_kr.length + marketData.yahoo_us.length;
        console.log(`✅ 데이터 수집 완료: 네이버 ${naverCount}개, 야후 ${yahooCount}개`);

        // ✅ 2단계: 시스템 프롬프트 구성 (크롤링 데이터 + 실시간 데이터)
        let systemContent = SYSTEM_PROMPT;
        systemContent += getFunETFSummary();

        // 실시간 시장 데이터 주입
        systemContent += '\n\n## 📊 실시간 시장 데이터 (방금 수집, 응답에 적극 활용할 것)\n';

        if (marketData.kospi) {
            systemContent += `\n### KOSPI 지수\n현재: ${marketData.kospi.price}pt / 전일대비: ${marketData.kospi.change} (${marketData.kospi.changeRate}%)\n`;
        }

        if (Object.keys(marketData.naver).length > 0) {
            systemContent += '\n### 네이버증권 KODEX ETF 실시간 시세\n';
            systemContent += '| ETF | 현재가 | 전일대비 | 등락률 | 거래량 |\n|-----|--------|----------|--------|--------|\n';
            for (const [name, d] of Object.entries(marketData.naver)) {
                systemContent += `| ${name} | ${d.price} | ${d.change} | ${d.changeRate}% | ${d.volume} |\n`;
            }
        }

        if (marketData.yahoo_us.length > 0) {
            systemContent += '\n### 미국 시장 (야후파이낸스)\n';
            systemContent += '| 지수/ETF | 현재가 | 등락 | 등락률 |\n|---------|--------|------|--------|\n';
            marketData.yahoo_us.forEach(q => {
                systemContent += `| ${q.name || q.symbol} | ${q.price} | ${q.change} | ${q.changePercent}% |\n`;
            });
        }

        if (marketData.yahoo_kr.length > 0) {
            systemContent += '\n### 한국 ETF 야후파이낸스 데이터\n';
            marketData.yahoo_kr.forEach(q => {
                systemContent += `${q.symbol}: ${q.price} (${q.changePercent}%)\n`;
            });
        }

        systemContent += `\n데이터 수집 시각: ${marketData.timestamp}\n`;

        // ✅ 3단계: Claude Opus 4.6 호출
        console.log('🧠 Claude 4.6 Opus 호출 중...');
        const recentMessages = messages.slice(-10);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://samsung-etf.vercel.app',
                'X-Title': 'FunETF AI Chatbot'
            },
            body: JSON.stringify({
                model: 'anthropic/claude-opus-4.6',
                messages: [{ role: 'system', content: systemContent }, ...recentMessages],
                max_tokens: 4000,
                temperature: 0.7,
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content;

        if (!reply || reply.trim().length === 0) {
            throw new Error('Claude가 빈 응답을 반환했습니다.');
        }

        console.log(`🧠 응답 완료 (${data.usage?.completion_tokens || '?'} tokens)`);

        res.json({
            success: true,
            reply,
            modelUsed: {
                key: 'claude', name: 'Claude 4.6 Opus', shortName: 'Claude',
                icon: '🧠', color: '#8B5CF6', description: '독보적인 논리력 & 문장력',
                wasAutoRouted: false,
            },
            usage: data.usage,
            marketDataUsed: {
                naverETFs: naverCount,
                yahooQuotes: yahooCount,
                hasFunETF: !!FUNETF_DATA,
            }
        });
    } catch (error) {
        console.error('Chat Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

module.exports = app;
