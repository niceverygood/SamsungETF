/**
 * KODEX ETF AI 챗봇 엔진
 * Claude 4.6 Opus + 네이버증권 + 야후파이낸스 실시간 데이터
 */

class KODEXChatbot {
    constructor() {
        this.conversationHistory = [];
    }

    // AI 응답 생성 (서버에서 실시간 데이터 수집 후 Claude 호출)
    async generateResponse(userMessage) {
        this.conversationHistory.push({ role: 'user', content: userMessage });

        // 최근 10개 메시지만 전송
        const recentMessages = this.conversationHistory.slice(-10);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: recentMessages })
            });

            const data = await response.json();

            if (data.success && data.reply) {
                this.conversationHistory.push({ role: 'assistant', content: data.reply });

                if (data.marketDataUsed) {
                    console.log(`📊 실시간 데이터: 네이버 ${data.marketDataUsed.naverETFs}개, 야후 ${data.marketDataUsed.yahooQuotes}개`);
                }

                return {
                    reply: data.reply,
                    modelUsed: data.modelUsed
                };
            } else {
                throw new Error(data.error || '응답 생성 실패');
            }
        } catch (error) {
            console.error('AI 응답 오류:', error);
            return {
                reply: `<p>⚠️ 죄송합니다. AI 연결에 일시적인 문제가 발생했습니다.</p>
<p><small>오류: ${error.message}</small></p>
<p>잠시 후 다시 시도해주세요.</p>`,
                modelUsed: null
            };
        }
    }

    // 마퀴 데이터 업데이트
    async updateMarqueeData() {
        try {
            const res = await fetch('/api/naver/etf-list');
            const data = await res.json();
            if (!data.success || !data.data) return;

            const marqueeTrack = document.getElementById('marqueeTrack');
            if (!marqueeTrack) return;

            const etfTags = Object.entries(data.data).map(([name, info]) => {
                const changeRate = parseFloat(info.changeRate) || 0;
                const changeClass = changeRate >= 0 ? 'positive' : 'negative';
                const sign = changeRate >= 0 ? '+' : '';
                return `<div class="etf-tag">${name} <span class="etf-tag-change ${changeClass}">${sign}${changeRate.toFixed(2)}%</span></div>`;
            }).join('');

            if (etfTags) {
                marqueeTrack.innerHTML = etfTags + etfTags;
            }
        } catch (e) { /* skip */ }
    }
}

const chatbot = new KODEXChatbot();
