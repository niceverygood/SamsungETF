/**
 * KODEX ETF AI 챗봇 엔진
 * Claude Sonnet 4 + 네이버증권 + 야후파이낸스 실시간 데이터 + 스트리밍
 */

class KODEXChatbot {
    constructor() {
        this.conversationHistory = [];
    }

    async generateResponse(userMessage, onChunk) {
        this.conversationHistory.push({ role: 'user', content: userMessage });
        const recentMessages = this.conversationHistory.slice(-10);

        // 스트리밍 모드 (onChunk 콜백이 있으면)
        if (onChunk) {
            return this._streamResponse(recentMessages, onChunk);
        }

        // 일반 모드 (폴백)
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: recentMessages })
            });

            const data = await response.json();

            if (data.success && data.reply) {
                this.conversationHistory.push({ role: 'assistant', content: data.reply });
                return { reply: data.reply, modelUsed: data.modelUsed };
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

    async _streamResponse(recentMessages, onChunk) {
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: recentMessages, stream: true })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `서버 오류 ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullReply = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                const lines = text.split('\n').filter(l => l.startsWith('data: '));

                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        if (parsed.content) {
                            fullReply += parsed.content;
                            onChunk(parsed.content, fullReply);
                        }
                        if (parsed.done) {
                            this.conversationHistory.push({ role: 'assistant', content: fullReply });
                            return { reply: fullReply, modelUsed: { key: 'claude', name: 'Claude Sonnet 4', shortName: 'Claude', icon: '🧠', color: '#8B5CF6' } };
                        }
                    } catch (e) { /* skip parse errors */ }
                }
            }

            this.conversationHistory.push({ role: 'assistant', content: fullReply });
            return { reply: fullReply, modelUsed: { key: 'claude', name: 'Claude Sonnet 4', shortName: 'Claude', icon: '🧠', color: '#8B5CF6' } };
        } catch (error) {
            console.error('스트리밍 오류:', error);
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
