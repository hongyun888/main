/**
 * 百炼智能体知识库检索服务
 * 从原始前端代码中提取，保持完全一致的功能
 */

const fetch = require('node-fetch');

class BaiLianService {
    constructor() {
        // 从环境变量或配置中获取
        this.AGENT_APP_URL = 'https://hongchuanai.com/agent/chat/2af93eb45a0b4db9be4833da94650392';
        this.sessions = new Map(); // 管理多个会话
    }

    /**
     * 调用百炼智能体进行知识库检索
     * @param {string} text - 用户输入文本
     * @param {string} sessionId - 会话ID
     * @param {Array} fileIds - 文件ID列表
     * @param {string} appCode - 应用代码
     * @param {string} token - 认证token
     * @returns {Promise<string>} 检索结果文本
     */
    async requestBaiLianAgent(text, sessionId, fileIds = [], appCode, token) {
        console.log("🔍 后端：开始调用百炼智能体进行知识库检索:", {
            textLength: text.length,
            textPreview: text.substring(0, 100) + '...',
            fileIds: fileIds,
            sessionId: sessionId
        });
        
        return new Promise((resolve, reject) => {
            if (!appCode || !token) {
                reject(new Error('百炼智能体认证信息缺失'));
                return;
            }

            const params = {
                input: {
                    prompt: text,
                    session_id: sessionId,
                },
                parameters: {
                    incremental_output: true,
                    rag_options: {
                        session_file_ids: fileIds
                    }
                },
                stream: true
            };

            const url = `${this.AGENT_APP_URL}?AppCode=${appCode}`;
            let accumulatedText = '';
            let currentSessionId = sessionId;

            fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-DashScope-SSE': 'enable'
                },
                body: JSON.stringify(params)
            }).then(async resp => {
                if (!resp.ok) {
                    throw new Error(`百炼智能体请求失败: ${resp.status} ${resp.statusText}`);
                }
                
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const processDataStr = (dataStr) => {
                    if (!dataStr || dataStr === '[DONE]') {
                        return false;
                    }
                    const chunk = JSON.parse(dataStr);
                    const data = chunk.output || {};

                    if (data.session_id) {
                        currentSessionId = data.session_id;
                    }

                    if (typeof data.text === 'string' && data.text) {
                        accumulatedText += data.text;
                    }

                    if (data.finish_reason === 'stop') {
                        console.log("✅ 后端：百炼智能体知识库检索完成:", {
                            textLength: accumulatedText.length,
                            sessionId: currentSessionId
                        });
                        // 更新会话管理
                        this.sessions.set(sessionId, currentSessionId);
                        resolve(accumulatedText);
                        return true;
                    }

                    return false;
                };

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim().startsWith('data:')) continue;
                        
                        try {
                            const dataStr = line.slice(5).trim();
                            if (processDataStr(dataStr)) {
                                return;
                            }
                        } catch (e) {
                            console.warn("后端：解析百炼智能体响应数据失败:", e, line);
                        }
                    }
                }

                const tail = buffer.trim();
                if (tail.startsWith('data:')) {
                    try {
                        if (processDataStr(tail.slice(5).trim())) {
                            return;
                        }
                    } catch (e) {
                        console.warn("后端：解析百炼智能体响应尾部数据失败:", e, tail);
                    }
                }
            }).catch(error => {
                console.error("❌ 后端：百炼智能体知识库检索失败:", error);
                reject(error);
            });
        });
    }

    /**
     * 获取会话ID
     * @param {string} sessionId - 原始会话ID
     * @returns {string} 当前会话ID
     */
    getSessionId(sessionId) {
        return this.sessions.get(sessionId) || sessionId;
    }

    /**
     * 清理过期会话
     */
    cleanupSessions() {
        // 可以根据需要实现会话清理逻辑
        console.log('🧹 清理过期会话');
    }
}

module.exports = BaiLianService; 
