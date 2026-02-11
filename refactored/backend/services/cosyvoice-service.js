const WebSocket = require('ws');
const crypto = require('crypto');

class CosyVoiceService {
    constructor() {
        this.WS_URL = process.env.COSYVOICE_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
        this.DEFAULT_MODEL = process.env.COSYVOICE_MODEL || 'cosyvoice-v3-flash';
        this.DEFAULT_VOICE = process.env.COSYVOICE_VOICE || 'longanhuan';
        this.DEFAULT_SAMPLE_RATE = Number(process.env.COSYVOICE_SAMPLE_RATE || 24000);
        this.DEFAULT_FORMAT = process.env.COSYVOICE_FORMAT || 'pcm';
        this.DEFAULT_INSTRUCTION = process.env.COSYVOICE_INSTRUCTION || '你正在进行闲聊对话，你说话的情感是happy。';
        this.DEFAULT_RATE = Number(process.env.COSYVOICE_RATE || 1);
        this.DEFAULT_PITCH = Number(process.env.COSYVOICE_PITCH || 1);
        this.DEFAULT_VOLUME = Number(process.env.COSYVOICE_VOLUME || 50);
    }

    createTaskId() {
        if (crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return crypto.randomBytes(16).toString('hex');
    }

    createWebSocket(apiKey) {
        if (!apiKey) {
            throw new Error('CosyVoice API Key 缺失');
        }
        return new WebSocket(this.WS_URL, {
            headers: {
                Authorization: `bearer ${apiKey}`,
                'X-DashScope-DataInspection': 'enable'
            }
        });
    }

    async synthesizeText({
        text,
        apiKey,
        model = this.DEFAULT_MODEL,
        voice = this.DEFAULT_VOICE,
        sampleRate = this.DEFAULT_SAMPLE_RATE,
        format = this.DEFAULT_FORMAT,
        instruction = this.DEFAULT_INSTRUCTION,
        wordTimestampEnabled = true,
        debug = false,
        onAudioChunk = () => {},
        onWordTimestamps = () => {},
        onEvent = () => {},
        onError = () => {}
    }) {
        const ws = this.createWebSocket(apiKey);
        const taskId = this.createTaskId();
        let hasStarted = false;
        let hasFinished = false;
        let pendingFinish = false;

        const safeClose = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close(1000, 'client finished');
            }
        };

        const sendRunTask = () => {
            const normalizedInstruction = typeof instruction === 'string' ? instruction.trim() : '';
            const payload = {
                header: {
                    action: 'run-task',
                    task_id: taskId,
                    streaming: 'duplex'
                },
                payload: {
                    task_group: 'audio',
                    task: 'tts',
                    function: 'SpeechSynthesizer',
                    model,
                    parameters: {
                        text_type: 'PlainText',
                        voice,
                        format,
                        sample_rate: sampleRate,
                        rate: this.DEFAULT_RATE,
                        pitch: this.DEFAULT_PITCH,
                        volume: this.DEFAULT_VOLUME,
                        word_timestamp_enabled: !!wordTimestampEnabled
                    },
                    input: {}
                }
            };
            if (normalizedInstruction) {
                payload.payload.parameters.instruction = normalizedInstruction;
            }
            ws.send(JSON.stringify(payload));
        };

        const sendContinue = () => {
            const payload = {
                header: {
                    action: 'continue-task',
                    task_id: taskId,
                    streaming: 'duplex'
                },
                payload: {
                    input: { text }
                }
            };
            ws.send(JSON.stringify(payload));
        };

        const sendFinish = () => {
            if (pendingFinish) return;
            pendingFinish = true;
            const payload = {
                header: {
                    action: 'finish-task',
                    task_id: taskId,
                    streaming: 'duplex'
                },
                payload: { input: {} }
            };
            ws.send(JSON.stringify(payload));
        };

        let debugLogged = false;
        const sentenceBuffer = new Map();
        const emittedWordCounts = new Map();
        const handleJsonMessage = (data) => {
            let payload;
            try {
                payload = JSON.parse(data);
            } catch (err) {
                onError(err);
                return;
            }
            const event = payload?.header?.event;
            if (event) {
                onEvent(payload);
            }
            if (event === 'task-started') {
                hasStarted = true;
                sendContinue();
                sendFinish();
                return;
            }
            if (event === 'result-generated') {
                const output = payload.payload?.output;
                if (debug) {
                    if (!debugLogged) {
                        debugLogged = true;
                        console.log('🧪 CosyVoice result-generated payload sample:', JSON.stringify(output));
                    }
                    const sentence = output?.sentence || {};
                    const wordsCount = Array.isArray(sentence.words) ? sentence.words.length : 0;
                    console.log('🧪 CosyVoice result-generated:', {
                        type: output?.type,
                        words: wordsCount
                    });
                }
                if (output?.sentence && Array.isArray(output.sentence.words) && output.sentence.words.length) {
                    const sentenceIndex = Number.isFinite(output.sentence.index) ? output.sentence.index : null;
                    if (sentenceIndex !== null) {
                        const words = output.sentence.words;
                        sentenceBuffer.set(sentenceIndex, {
                            words,
                            originalText: output.original_text || ''
                        });
                        const prevCount = emittedWordCounts.get(sentenceIndex) || 0;
                        const shouldEmit = output?.type === 'sentence-end' || words.length > prevCount;
                        if (shouldEmit) {
                            emittedWordCounts.set(sentenceIndex, words.length);
                            onWordTimestamps({
                                sentenceIndex,
                                words,
                                type: output?.type || 'sentence-update',
                                originalText: output.original_text || ''
                            });
                        }
                    }
                }
                if (output?.type === 'sentence-end') {
                    const sentenceIndex = Number.isFinite(output?.sentence?.index) ? output.sentence.index : null;
                    if (sentenceIndex !== null && sentenceBuffer.has(sentenceIndex)) {
                        sentenceBuffer.delete(sentenceIndex);
                    }
                }
                return;
            }
            if (event === 'task-finished') {
                hasFinished = true;
                safeClose();
            }
            if (event === 'task-failed') {
                const error = new Error(payload?.header?.error_message || 'CosyVoice task failed');
                onError(error);
                safeClose();
            }
        };

        return new Promise((resolve, reject) => {
            ws.on('open', () => {
                sendRunTask();
            });

            ws.on('message', (data, isBinary) => {
                if (hasFinished) return;
                if (isBinary) {
                    const base64Audio = Buffer.from(data).toString('base64');
                    onAudioChunk(base64Audio);
                    return;
                }
                handleJsonMessage(data.toString());
            });

            ws.on('error', (err) => {
                onError(err);
                if (!hasFinished) {
                    reject(err);
                }
            });

            ws.on('close', () => {
                if (!hasFinished) {
                    hasFinished = true;
                }
                resolve();
            });

            ws.on('unexpected-response', (_, res) => {
                const error = new Error(`CosyVoice WS unexpected response: ${res?.statusCode}`);
                onError(error);
                reject(error);
            });
        });
    }
}

module.exports = CosyVoiceService;
