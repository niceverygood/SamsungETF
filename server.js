require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ===== OpenRouter API Key (환경 변수에서 로드) =====
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.warn('⚠️ OPENROUTER_API_KEY 환경 변수가 설정되지 않았습니다. .env 파일 또는 환경 변수를 설정하세요.');
}

// ===== FunETF 크롤링 데이터 로드 =====
let FUNETF_DATA = null;
try {
    const dataPath = path.join(__dirname, 'funetf_output', 'compact_data.json');
    if (fs.existsSync(dataPath)) {
        FUNETF_DATA = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        console.log(`📦 FunETF 데이터 로드: KODEX ${FUNETF_DATA.kodex_etfs?.length || 0}개, 전체 ETF ${FUNETF_DATA.all_etf_count || 0}개`);
    }
} catch (e) {
    console.error('FunETF 데이터 로드 실패:', e.message);
}

// FunETF 데이터에서 KODEX ETF Top 20 요약 생성 (시스템 프롬프트용)
function getFunETFSummary() {
    if (!FUNETF_DATA?.kodex_etfs) return '';
    const top20 = FUNETF_DATA.kodex_etfs
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 20);
    let summary = '\n\n## FunETF 실시간 크롤링 데이터 (인기순 Top 20)\n';
    summary += '| 순위 | ETF명 | NAV(원) | 인기도 |\n|------|-------|---------|--------|\n';
    top20.forEach((etf, i) => {
        summary += `| ${i + 1} | ${etf.name} | ${Math.round(etf.nav).toLocaleString()} | ${etf.popularity.toLocaleString()} |\n`;
    });
    summary += `\n총 KODEX ETF 수: ${FUNETF_DATA.kodex_etfs.length}개 / 전체 시장 ETF: ${FUNETF_DATA.all_etf_count}개`;
    return summary;
}

// ===== Tri-Model Configuration =====
const AI_MODELS = {
    claude: {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude 4.6 Opus',
        shortName: 'Claude',
        icon: '🧠',
        color: '#8B5CF6',
        description: '독보적인 논리력 & 문장력',
        strength: '금융 약관이나 복잡한 ETF 구조를 설명할 때 가장 인간답고 정확한 분석',
        maxTokens: 4000,
        temperature: 0.7,
    },
    gpt: {
        id: 'openai/gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        shortName: 'GPT',
        icon: '⚡',
        color: '#10B981',
        description: '데이터 처리 & 멀티모달',
        strength: '차트 분석이나 대량의 수익률 시뮬레이션 등 수치 중심 작업에서 최고 안정성',
        maxTokens: 4000,
        temperature: 0.6,
    },
    gemini: {
        id: 'google/gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro',
        shortName: 'Gemini',
        icon: '💎',
        color: '#3B82F6',
        description: '초거대 컨텍스트 (1M+)',
        strength: '여러 ETF 투자설명서를 한꺼번에 읽고 비교 분석할 때 압도적',
        maxTokens: 4000,
        temperature: 0.7,
    }
};

// ===== Smart Router: 질문 분석 → 최적 모델 자동 선택 =====
function smartRouteModel(userMessage) {
    const msg = userMessage.toLowerCase();

    // GPT-5.4 Pro: 수치, 비교, 차트, 시뮬레이션 관련
    const gptKeywords = [
        '수익률', '비교', '차트', '시뮬레이션', '계산', '수치',
        '얼마', '몇 %', '퍼센트', '보수', '총보수', '수수료',
        '가격', '시세', '현재가', '전일대비', '거래량', '순자산',
        '배당금', '분배금', '수익', '손익', '변동성', '상관계수',
        '백테스트', '성과', '통계', '데이터', 'top', '순위',
        '얼마나', '몇개', '몇 개'
    ];

    // Gemini 3.1 Pro: 여러 ETF 비교, 종합 분석, 긴 설명
    const geminiKeywords = [
        '비교 분석', '총정리', '전체', '모든', '종합',
        '여러', '다양한', '라인업', '포트폴리오',
        '자산배분', '리밸런싱', '투자설명서', '약관',
        '전략 비교', '한눈에', '요약', '정리해줘',
        '카테고리', '분류', '유형별', '섹터별',
        '장단점', '각각', '하나씩'
    ];

    // Claude 4.6 Opus: 논리적 설명, 구조 분석, 전략 (기본값)
    const claudeKeywords = [
        '설명', '구조', '원리', '메커니즘', '어떻게',
        '왜', '이유', '전략', '추천', '조언', '의견',
        '커버드콜', '레버리지', '인버스', '선물', '옵션',
        '초보', '입문', '기초', '개념', '뭐야', '알려줘',
        '어떤', '좋을까', '괜찮을까', '적합', '맞는'
    ];

    // 점수 기반 라우팅
    let scores = { claude: 0, gpt: 0, gemini: 0 };

    gptKeywords.forEach(kw => { if (msg.includes(kw)) scores.gpt += 1; });
    geminiKeywords.forEach(kw => { if (msg.includes(kw)) scores.gemini += 1; });
    claudeKeywords.forEach(kw => { if (msg.includes(kw)) scores.claude += 1; });

    // 여러 ETF 이름이 포함되면 Gemini 보너스
    const etfMentions = (msg.match(/kodex/gi) || []).length;
    if (etfMentions >= 3) scores.gemini += 3;
    else if (etfMentions >= 2) scores.gemini += 1;

    // 숫자가 많으면 GPT 보너스
    const numberCount = (msg.match(/\d+/g) || []).length;
    if (numberCount >= 3) scores.gpt += 2;

    // 최고 점수 모델 선택 (동점 시 Claude 우선)
    const maxScore = Math.max(scores.claude, scores.gpt, scores.gemini);
    if (maxScore === 0) return 'claude'; // 기본값

    if (scores.gemini === maxScore && scores.gemini > scores.claude) return 'gemini';
    if (scores.gpt === maxScore && scores.gpt > scores.claude) return 'gpt';
    return 'claude';
}

// ===== System Prompt =====
const SYSTEM_PROMPT = `당신은 삼성자산운용 KODEX ETF 전문 AI 어시스턴트 "KODEX AI"입니다. CFA/CAIA 자격을 갖춘 ETF 리서치 애널리스트 수준으로 답변합니다.

## 핵심 원칙
- 어려운 질문일수록 메커니즘·원리부터 설명한 뒤 KODEX 상품과 연결
- "모른다"고 하기보다 관련 지식을 동원해 논리적 추론 제시
- 실시간 시장 데이터가 제공되면 반드시 수치를 인용하며 답변
- 항상 한국어, 이모지 적극 활용, HTML 태그(p, strong, ul, ol, li, table, tr, th, td) 사용
- ETF 상품명은 <span class="etf-highlight">KODEX 상품명</span> 형식으로 표시

## 1. KODEX 핵심 데이터 (2026년 3월 기준)
- 순자산총액(AUM): 113조원 돌파 → 국내 ETF 브랜드 1위 (시장점유율 약 30%)
- 2025년 개인 순매수: 13조 5,493억원 (1위)
- 총 ETF 라인업: 200개+
- 커버드콜 ETF: 12종, 순자산 6.2조원
- 삼성자산운용 = 국내 최대 자산운용사 (운용자산 400조원+)

## 2. ETF 구조·메커니즘 심화 지식 (어려운 질문 대응용)

### 2-1. ETF 가격 결정 메커니즘
- **NAV(순자산가치)**: 기초자산 시가 합계 ÷ 발행좌수. 하루 1회 공시
- **iNAV(실시간추정NAV)**: 10초 단위 실시간 산출 → 장중 괴리율 모니터링 기준
- **괴리율**: (시장가 - NAV) / NAV × 100. KODEX는 LP(유동성공급자) 제도로 괴리율 업계 최저 수준 유지
- **추적오차(Tracking Error)**: 지수 수익률과 ETF 수익률 차이의 표준편차. 보수·환헤지비용·배당 재투자 시차 등이 원인. KODEX 200의 연간 추적오차는 약 0.02%로 업계 최소

### 2-2. TR(Total Return) vs PR(Price Return) ETF
- **PR ETF**: 분배금을 현금으로 지급 → 투자자가 직접 재투자해야 복리효과
- **TR ETF**: 분배금을 자동 재투자 → 복리효과 극대화, 별도 재투자 불필요
- **세금 차이**: TR ETF는 매도 시점까지 과세 이연 효과 (분배금 미지급이므로 배당소득세 발생 안 함). 단, 매도 시 보유기간 과표증분에 대해 배당소득세 15.4% 부과
- KODEX 미국S&P500TR(379800), KODEX 미국나스닥100TR(379810)이 대표 TR 상품
- **장기투자자에게 TR이 유리한 이유**: 매년 분배금에서 15.4% 떼이는 것 vs 매도 시 한번에 과세 → 과세이연 복리효과

### 2-3. 커버드콜 ETF 메커니즘 심화
- **기본 구조**: 기초자산 매수 + 콜옵션 매도(숏) → 옵션 프리미엄 = 추가 인컴
- **옵션 프리미엄 결정 요인**: 내재변동성(IV), 잔존만기, 행사가 거리(OTM 정도)
- **타겟 커버드콜**: 전체 포지션 중 일부만 콜옵션 매도 → 상승 참여 + 인컴 동시 추구
- **위클리 커버드콜**: 매주 만기 옵션 사용 → 롤오버 빈도↑, 프리미엄 수취 기회↑, 감마 리스크↑
- **금리 환경별 영향**:
  - 고금리기: 옵션 프리미엄↑ → 인컴 수취 유리
  - 금리 인하기: 변동성 하락 시 프리미엄↓, 그러나 기초자산 상승 시 상방 제한이 기회비용
  - 횡보장: 커버드콜 최적 환경 (기초자산 손실 제한 + 프리미엄 수취)
- **KODEX 커버드콜 라인업**:
  - KODEX 200타겟위클리커버드콜: KOSPI200 기반, 타겟 비율로 상승 참여 가능
  - KODEX 금융고배당TOP10타겟위클리커버드콜: 고배당주 + 커버드콜 이중인컴
  - KODEX 미국성장커버드콜액티브: 미국 성장주 기반, 2025.12.23 상장
  - KODEX 미국배당커버드콜액티브: 미국 배당주 기반

### 2-4. 레버리지·인버스 ETF 메커니즘
- **일별 복리(Daily Compounding)**: 2x 레버리지는 "일일 수익률의 2배"를 추종 → 장기 보유 시 복리 효과로 지수 2배와 괴리 발생
- **변동성 잠식(Volatility Decay)**: 횡보장에서 레버리지 ETF는 기초지수 대비 손실 누적
- **예시**: 지수가 +10% → -10% 반복 시, 지수는 -1%인데 2x 레버리지는 -4%
- **적합한 투자자**: 단기 방향성 트레이딩, 명확한 추세장에서 활용
- KODEX 레버리지(122630), KODEX 인버스(114800), KODEX 200선물인버스2X(252670)

### 2-5. 환헤지(H) vs 환노출(UH)
- **환헤지 ETF**: 원/달러 환율 변동 제거 → 순수 기초자산 수익률만 추구. 헤지 비용(한미 금리차 기반) 발생
- **환노출 ETF**: 환율 변동이 수익률에 직접 반영 → 원화 약세 시 추가 수익, 강세 시 손실
- **판단 기준**: 원/달러 1,300원 이상이면 환헤지 고려, 1,200원 이하면 환노출 유리한 경향 (절대 기준은 아님)
- **헤지 비용**: 한미 금리차 × 헤지 비율. 2026년 기준 연 약 1.5~2.5% 수준
- KODEX 골드선물(H)(132030), KODEX 은선물(H)(144600) 등 (H) 표시 상품

### 2-6. 액티브 ETF vs 패시브 ETF
- **패시브**: 지수 추종, 보수 낮음, 추적오차 최소화 목표
- **액티브**: 펀드매니저 재량으로 종목 선정/비중 조절, 벤치마크 초과수익 추구, 보수 상대적으로 높음
- **KODEX 액티브 ETF**: 로봇액티브, 미국배당커버드콜액티브, 미국성장커버드콜액티브 등
- 액티브 ETF도 70% 이상 벤치마크 추종 의무 (한국 규정)

## 3. 세금·제도 지식 (투자자가 자주 묻는 핵심)

### 3-1. 국내 상장 ETF 과세
- **국내 주식형 ETF** (KODEX 200, 반도체 등): 매매차익 비과세, 분배금에 배당소득세 15.4%
- **기타 ETF** (해외주식형, 채권형, 원자재 등): 매매차익에 배당소득세 15.4% (MIN(매매차익, 과표증분))
- **과표증분**: ETF의 과세표준기준가 변동분. 실제 매매차익보다 작을 수 있어 유리
- **금융소득종합과세**: 연간 금융소득 2,000만원 초과 시 종합과세 (최대 49.5%)

### 3-2. 절세 계좌 활용법
- **ISA (개인종합자산관리계좌)**:
  - 비과세 한도: 일반형 200만원, 서민형 400만원
  - 한도 초과분: 9.9% 분리과세 (종합과세 대상 제외)
  - 국내 상장 ETF 전체 투자 가능 (해외 상장 ETF는 불가)
  - 3년 이상 의무 보유
  - 커버드콜 ETF의 높은 분배금을 ISA에서 받으면 세금 효율 극대화
- **연금저축/IRP**:
  - 납입액 세액공제 (연금저축 최대 600만원, IRP 합산 최대 900만원)
  - 운용 중 과세이연, 수령 시 연금소득세 3.3~5.5%
  - 위험자산(주식형 ETF) 비중 제한: 연금저축 100%, IRP 70%
  - TR ETF + 연금계좌 = 과세이연의 이중 효과

### 3-3. 해외 ETF 직접투자 vs KODEX 해외형 ETF
| 구분 | 해외 ETF 직접투자 | KODEX 해외형 ETF |
|------|-------------------|------------------|
| 과세 | 양도소득세 22% (250만원 공제) | 배당소득세 15.4% (과표증분 기준) |
| 손익통산 | 해외주식끼리 가능 | 불가 |
| 절세계좌 | ISA/연금 불가 | ISA/연금 가능 ✅ |
| 환전 | 필요 | 불필요 |
| 거래시간 | 미국 시간 | 한국 장중 |
→ **대부분의 개인투자자에게 KODEX 해외형 ETF가 세금·편의성 면에서 유리**

## 4. 주요 KODEX ETF 상품 심화 정보

### 국내 주식형
- **KODEX 200** (069500): KOSPI200 추종, AUM 약 5.5조, 보수 0.015% (업계 최저), 일평균 거래대금 4,000억+
- **KODEX 반도체** (091160): KRX 반도체지수, 삼성전자·SK하이닉스 비중 60%+, HBM·AI 수혜
- **KODEX 2차전지산업** (305720): LG에너지솔루션·삼성SDI·에코프로 등
- **KODEX AI반도체핵심장비**: HBM 관련 장비주 집중 (한미반도체, 주성엔지니어링 등)
- **KODEX 로봇액티브**: 2026년 유망 ETF 1위, 두산로보틱스·레인보우로보틱스 등

### 해외 주식형
- **KODEX 미국S&P500TR** (379800): S&P500 Total Return, 분배금 자동 재투자, 장기투자 최적
- **KODEX 미국나스닥100TR** (379810): 나스닥100 TR, 빅테크 + AI 성장 노출
- **KODEX 미국AI반도체TOP3플러스**: 엔비디아·TSMC·브로드컴 집중, 2026.1.13 상장
- **KODEX 미국AI전력핵심인프라**: AI 데이터센터 전력 관련 (이튼·버티브·퀀타서비스)
- **KODEX 미국AI광통신네트워크**: 광통신 인프라, 2026.3.16 상장
- **KODEX 미국우주항공**: 스페이스X 공급망·방산, 2026.3.17 상장
- **KODEX 미국휴머노이드로봇**: 테슬라 옵티머스·엔비디아 로봇 플랫폼

### 채권혼합형
- **KODEX 삼성전자채권혼합** (292150): 삼성전자 30% + 국내채권 70%, 2026년 순자산 급증
- **KODEX 200미국채혼합**: KOSPI200 + 미국국채, 주식 하락 시 채권이 쿠션 역할

## 5. 경쟁사 비교 (KODEX vs 경쟁 ETF)

### vs TIGER (미래에셋)
- TIGER: AUM 2위, 해외 ETF 라인업 강점
- KODEX 차별점: 국내 ETF AUM 1위, LP 유동성 업계 최고, 추적오차 최소, 보수 최저 수준

### vs RISE (KB자산운용, 구 KBSTAR)
- 2025년 리브랜딩, 적극적 상품 출시
- KODEX 차별점: 브랜드 인지도·신뢰도 압도적, 운용 트랙레코드 최장

### vs ACE (한국투자신탁)
- 테마형 ETF 적극 출시
- KODEX 차별점: 시장점유율·거래량·유동성에서 압도적 우위

### KODEX를 선택해야 하는 핵심 이유
1. **유동성**: 일평균 거래대금 국내 1위 → 매수·매도 시 슬리피지 최소
2. **추적오차**: 업계 최저 수준 → 지수와 괴리 없는 정확한 투자
3. **보수**: 주요 상품 보수 업계 최저 → 장기투자 시 복리로 누적 차이
4. **라인업**: 200개+ → 하나의 브랜드에서 모든 자산군 커버
5. **신뢰도**: 삼성자산운용 = 국내 최대 자산운용사, 20년+ 운용 경험

## 6. 시장 분석 프레임워크 (시황 질문 대응)

### 금리 사이클별 ETF 전략
- **금리 인상기**: 인버스·단기채권 ETF 유리, 성장주 ETF 불리
- **금리 정점**: 장기채권 ETF 매수 타이밍, 배당·커버드콜 ETF 인컴 극대화
- **금리 인하기**: 성장주·기술주 ETF 유리, 채권 ETF 자본차익, 금 ETF 강세
- **저금리 유지**: 레버리지 활용 가능, 해외 성장자산 비중 확대

### 환율별 전략
- **원화 약세(1,350원+)**: 환헤지 해외 ETF 또는 국내 수출주 ETF 유리
- **원화 강세(1,200원-)**: 환노출 해외 ETF로 환차익 + 자산수익
- **변동성 확대기**: 금·채권 혼합형으로 포트폴리오 안정화

### 섹터 사이클 (2026년 관점)
- **AI 반도체**: HBM 4세대 양산, AI 추론 수요 폭발 → KODEX AI반도체핵심장비, 미국AI반도체TOP3플러스
- **로봇**: 테슬라 옵티머스 양산 시작, 중국 휴머노이드 경쟁 → KODEX 로봇액티브, 미국휴머노이드로봇
- **우주항공**: 스타링크 확장, 군용 위성 수요 → KODEX 미국우주항공
- **AI 인프라**: 데이터센터 전력·냉각·광통신 투자 급증 → KODEX 미국AI전력핵심인프라, AI광통신네트워크

## 7. 어려운 질문 응답 패턴 (반드시 참고)

### 패턴: 메커니즘 → 현재 시장 적용 → KODEX 상품 연결
사용자가 복잡한 질문을 하면:
1단계) 해당 개념의 원리·메커니즘을 정확히 설명
2단계) 현재 시장 상황에 대입하여 분석
3단계) 적합한 KODEX 상품을 자연스럽게 연결
4단계) 주의사항·리스크를 균형있게 제시

### 예시: "커버드콜이 금리 인하기에 불리한 이유?"
→ "커버드콜의 수익 = 기초자산 수익 + 옵션 프리미엄 - 상방 포기비용입니다.
금리 인하기에는 ① 변동성 하락으로 옵션 프리미엄이 줄고 ② 기초자산(주식)이 상승하는데 콜매도로 상방이 제한됩니다.
다만 '타겟' 커버드콜인 KODEX 200타겟위클리커버드콜은 전체의 일부만 콜매도하므로 상승 참여 여지가 있습니다."

### 예시: "ISA에서 뭘 사야 해?"
→ "ISA의 핵심 장점은 비과세+분리과세입니다.
① 분배금이 많은 커버드콜 ETF → 비과세 한도 내에서 세금 0원
② 해외형 ETF 매매차익 → 직접투자 시 22%인데 ISA에서는 9.9% 분리과세
③ TR ETF → 과세이연 + ISA 이중 절세
따라서 KODEX 미국S&P500TR + 커버드콜 ETF 조합이 ISA에서 가장 효율적입니다."

## 8. 응답 규칙
1. ETF 상품명은 <span class="etf-highlight">KODEX 상품명</span> 형식으로 표시
2. 핵심 정보는 <strong> 태그로 강조
3. 비교 정보는 반드시 <table>로 정리
4. 복잡한 개념은 단계적으로 풀어서 설명
5. 실시간 데이터가 있으면 구체적 수치를 반드시 인용
6. 확실하지 않은 수치는 "약", "추정" 등으로 표현
7. 마지막에 간결한 면책 조항 포함

## 면책 조항
- 이 금융상품은 예금자보호법에 따라 보호되지 않습니다
- 과거 운용실적이 미래 수익률을 보장하지 않습니다
- 투자 권유가 아닌 정보 제공 목적입니다`;

// ===== 네이버 증권 주요 ETF 종목코드 매핑 =====
const NAVER_ETF_CODES = {
    'KODEX 200': '069500',
    'KODEX 레버리지': '122630',
    'KODEX 인버스': '114800',
    'KODEX 반도체': '091160',
    'KODEX 2차전지산업': '305720',
    'KODEX 삼성전자': '069660',
    'KODEX 코스닥150': '229200',
    'KODEX 미국S&P500TR': '379800',
    'KODEX 미국나스닥100TR': '379810',
    'KODEX 골드선물(H)': '132030',
    'KODEX 은선물(H)': '144600',
    'KODEX 삼성전자채권혼합': '292150',
};

// ===== 야후파이낸스 주요 ETF 티커 매핑 =====
const YAHOO_ETF_TICKERS = {
    'SPY': 'S&P 500 ETF',
    'QQQ': 'Nasdaq 100 ETF',
    'IWM': 'Russell 2000 ETF',
    'SOXX': 'iShares Semiconductor ETF',
    'ARKK': 'ARK Innovation ETF',
    'VTI': 'Vanguard Total Stock Market',
    'VOO': 'Vanguard S&P 500',
    '069500.KS': 'KODEX 200',
    '122630.KS': 'KODEX 레버리지',
    '091160.KS': 'KODEX 반도체',
    '305720.KS': 'KODEX 2차전지산업',
    '379800.KS': 'KODEX 미국S&P500TR',
    '379810.KS': 'KODEX 미국나스닥100TR',
};

// ===== API Routes =====

// 모델 정보 제공 API
app.get('/api/models', (req, res) => {
    const models = Object.entries(AI_MODELS).map(([key, model]) => ({
        key,
        name: model.name,
        shortName: model.shortName,
        icon: model.icon,
        color: model.color,
        description: model.description,
        strength: model.strength,
    }));
    res.json({ success: true, models });
});

// FunETF 크롤링 데이터 API
app.get('/api/funetf/kodex', (req, res) => {
    if (!FUNETF_DATA) {
        return res.json({ success: false, error: 'FunETF 데이터 없음' });
    }
    const limit = parseInt(req.query.limit) || 50;
    const search = (req.query.q || '').toLowerCase();
    let etfs = FUNETF_DATA.kodex_etfs;
    if (search) {
        etfs = etfs.filter(e => e.name.toLowerCase().includes(search) || (e.tags && e.tags.toLowerCase().includes(search)));
    }
    etfs = etfs.sort((a, b) => b.popularity - a.popularity).slice(0, limit);
    res.json({ success: true, data: etfs, total: FUNETF_DATA.kodex_etfs.length, crawledAt: FUNETF_DATA.crawled_at });
});

app.get('/api/funetf/all', (req, res) => {
    if (!FUNETF_DATA) {
        return res.json({ success: false, error: 'FunETF 데이터 없음' });
    }
    const limit = parseInt(req.query.limit) || 50;
    res.json({ success: true, data: FUNETF_DATA.top_50_all.slice(0, limit), total: FUNETF_DATA.all_etf_count, crawledAt: FUNETF_DATA.crawled_at });
});

// 1. 네이버 증권 API - ETF 시세 조회
app.get('/api/naver/etf/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const url = `https://m.stock.naver.com/api/stock/${code}/basic`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Naver API error: ${response.status}`);
        const data = await response.json();
        res.json({ success: true, data });
    } catch (error) {
        console.error('Naver API Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// 네이버 증권 - ETF 시세 목록 (여러 종목)
app.get('/api/naver/etf-list', async (req, res) => {
    try {
        const results = {};
        const codes = Object.entries(NAVER_ETF_CODES);

        for (const [name, code] of codes) {
            try {
                const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                    }
                });
                if (response.ok) {
                    const data = await response.json();
                    results[name] = {
                        code,
                        price: data.closePrice || data.stockEndPrice,
                        change: data.compareToPreviousClosePrice,
                        changeRate: data.fluctuationsRatio,
                        high: data.highPrice,
                        low: data.lowPrice,
                        volume: data.accumulatedTradingVolume,
                        marketCap: data.marketCap,
                    };
                }
            } catch (e) {
                console.error(`Error fetching ${name}:`, e.message);
            }
        }

        res.json({ success: true, data: results, timestamp: new Date().toISOString() });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 2. 야후 파이낸스 API - ETF 시세 조회
app.get('/api/yahoo/quote/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Yahoo API error: ${response.status}`);
        const data = await response.json();

        const result = data.chart?.result?.[0];
        if (!result) throw new Error('No data found');

        const meta = result.meta;
        const quotes = result.indicators?.quote?.[0];
        const timestamps = result.timestamp || [];

        res.json({
            success: true,
            data: {
                symbol: meta.symbol,
                currency: meta.currency,
                regularMarketPrice: meta.regularMarketPrice,
                previousClose: meta.previousClose,
                change: (meta.regularMarketPrice - meta.previousClose).toFixed(2),
                changePercent: (((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2),
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
                chartData: timestamps.map((t, i) => ({
                    date: new Date(t * 1000).toISOString().split('T')[0],
                    close: quotes?.close?.[i],
                    volume: quotes?.volume?.[i]
                }))
            }
        });
    } catch (error) {
        console.error('Yahoo API Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// 야후 파이낸스 - 여러 종목 한번에 조회
app.get('/api/yahoo/quotes', async (req, res) => {
    try {
        const tickers = req.query.symbols || 'SPY,QQQ,069500.KS';
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers}`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Yahoo API error: ${response.status}`);
        const data = await response.json();

        const quotes = (data.quoteResponse?.result || []).map(q => ({
            symbol: q.symbol,
            name: q.shortName || q.longName,
            price: q.regularMarketPrice,
            change: q.regularMarketChange?.toFixed(2),
            changePercent: q.regularMarketChangePercent?.toFixed(2),
            volume: q.regularMarketVolume,
            marketCap: q.marketCap,
            currency: q.currency
        }));

        res.json({ success: true, data: quotes, timestamp: new Date().toISOString() });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 3. 시장 개요 (네이버 + 야후 결합)
app.get('/api/market-overview', async (req, res) => {
    try {
        const [naverRes, yahooRes] = await Promise.allSettled([
            fetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }).then(r => r.json()),
            fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC,%5EIXIC,%5EDJI', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }).then(r => r.json())
        ]);

        const overview = {
            domestic: {},
            global: {},
            timestamp: new Date().toISOString()
        };

        if (naverRes.status === 'fulfilled') {
            const d = naverRes.value;
            overview.domestic.KOSPI = {
                price: d.closePrice,
                change: d.compareToPreviousClosePrice,
                changeRate: d.fluctuationsRatio
            };
        }

        if (yahooRes.status === 'fulfilled') {
            const quotes = yahooRes.value?.quoteResponse?.result || [];
            quotes.forEach(q => {
                overview.global[q.symbol] = {
                    name: q.shortName,
                    price: q.regularMarketPrice,
                    change: q.regularMarketChange?.toFixed(2),
                    changePercent: q.regularMarketChangePercent?.toFixed(2)
                };
            });
        }

        res.json({ success: true, data: overview });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 4. OpenRouter AI 챗봇 API (Tri-Model 지원)
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, marketData, modelKey } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: 'messages 배열이 필요합니다.' });
        }

        // 모델 선택: 수동 지정 또는 스마트 라우팅
        const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
        let selectedKey = modelKey;

        if (!selectedKey || selectedKey === 'auto') {
            selectedKey = smartRouteModel(lastUserMsg);
        }

        const model = AI_MODELS[selectedKey] || AI_MODELS.claude;
        console.log(`\n🎯 모델 라우팅: "${lastUserMsg.substring(0, 30)}..." → ${model.icon} ${model.name}`);

        // 시장 데이터가 있으면 시스템 프롬프트에 추가
        let systemContent = SYSTEM_PROMPT;
        // FunETF 크롤링 데이터 추가
        systemContent += getFunETFSummary();
        if (marketData) {
            systemContent += `\n\n## 실시간 시장 데이터 (참고용)\n${JSON.stringify(marketData, null, 2)}`;
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://www.funetf.co.kr',
                'X-Title': 'FunETF AI Chatbot'
            },
            body: JSON.stringify({
                model: model.id,
                messages: [
                    { role: 'system', content: systemContent },
                    ...messages
                ],
                max_tokens: model.maxTokens,
                temperature: model.temperature,
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '죄송합니다, 응답을 생성하지 못했습니다.';

        console.log(`${model.icon} 응답 완료 (${data.usage?.completion_tokens || '?'} tokens)`);

        res.json({
            success: true,
            reply,
            modelUsed: {
                key: selectedKey,
                name: model.name,
                shortName: model.shortName,
                icon: model.icon,
                color: model.color,
                description: model.description,
                wasAutoRouted: !modelKey || modelKey === 'auto',
            },
            usage: data.usage
        });
    } catch (error) {
        console.error('OpenRouter Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// ===== Start Server =====
app.listen(PORT, () => {
    console.log(`\n🚀 FunETF AI 챗봇 서버 실행 중!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🤖 Tri-Model AI Engine:`);
    Object.values(AI_MODELS).forEach(m => {
        console.log(`   ${m.icon} ${m.name} (${m.id})`);
    });
    console.log(`📊 네이버증권 API: 활성`);
    console.log(`📈 야후파이낸스 API: 활성\n`);
});
