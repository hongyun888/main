// --- START OF FILE audioRecognition.js ---

// 导入单例 AudioContext 模块
import { getSharedAudioContext, suspendSharedAudioContext } from '../core/audioContext.js';
// 导入统一的音频处理工具
import { AudioUtils } from '../core/audioUtils.js';
// 导入统一的日志管理
import { log } from '../core/logger.js';

// 🎯 新增：音频发送后自动结束任务管理函数
const resetAutoFinishTimer = () => {
    // 清除现有的定时器
    if (autoFinishTimer) {
        clearTimeout(autoFinishTimer);
        autoFinishTimer = null;
        console.log('⏹️ 清除现有自动结束定时器');
    }
    
    // 设置新的定时器
    autoFinishTimer = setTimeout(() => {
        console.log('⏰ 1秒无音频输入，自动发送结束任务');
        if (socket && socket.readyState === WebSocket.OPEN) {
            sendFinishTask();
        }
        autoFinishTimer = null;
    }, AUTO_FINISH_DELAY);
};

const clearAutoFinishTimer = () => {
    if (autoFinishTimer) {
        clearTimeout(autoFinishTimer);
        autoFinishTimer = null;
        console.log('🧹 清理自动结束定时器');
    }
};

const onAudioSent = () => {
    // 更新最后发送时间
    lastAudioSendTime = Date.now();
    
    // 标记已经开始发送音频数据
    if (!hasStartedSendingAudio) {
        hasStartedSendingAudio = true;
        console.log('🎵 首次音频数据已发送，开始1秒自动结束监控');
    } else {
        console.log('🎵 音频数据已发送，重置1秒自动结束定时器');
    }
    
    // 重置自动结束定时器
    resetAutoFinishTimer();
};

// 安全的 WorkletNode 关闭函数，避免 Promise 重复 resolve
const safelyCloseWorkletNode = async (workletNode) => {
    return new Promise((resolve) => {
        let isResolved = false;
        
        const safeResolve = () => {
            if (!isResolved) {
                isResolved = true;
                resolve();
            }
        };
        
        // 设置超时保护，最多等待100ms
        const timeout = setTimeout(safeResolve, 100);
        
        // 检查API兼容性并尝试关闭port
        if (workletNode.port && typeof workletNode.port.close === 'function') {
            try {
                workletNode.port.close();
                clearTimeout(timeout);
                safeResolve();
            } catch (e) {
                console.warn("Error closing worklet port:", e);
                clearTimeout(timeout);
                safeResolve();
            }
        } else {
            // 如果不支持port.close，等待50ms后resolve
            setTimeout(() => {
                clearTimeout(timeout);
                safeResolve();
            }, 50);
        }
    });
};

// 统一错误处理机制
const AudioErrorHandler = {
    // 安全地执行WebSocket操作
    safeWebSocketOperation(operation, context = '') {
        try {
            return operation();
        } catch (error) {
            console.error(`audioRecognition.js [${context}]:`, error);
            return null;
        }
    },
    
    // 安全地处理AudioContext操作
    safeAudioOperation(operation, context = '', fallback = null) {
        try {
            return operation();
        } catch (error) {
            console.error(`audioRecognition.js [${context}]:`, error);
            if (typeof fallback === 'function') {
                try {
                    return fallback();
                } catch (fallbackError) {
                    console.error(`audioRecognition.js [${context}] fallback failed:`, fallbackError);
                }
            }
            return null;
        }
    },
    
    // 检查API兼容性
    checkCompatibility() {
        const issues = [];
        
        if (!navigator.mediaDevices?.getUserMedia) {
            issues.push('getUserMedia not supported');
        }
        
        if (!window.AudioContext && !window.webkitAudioContext) {
            issues.push('Web Audio API not supported');
        }
        
        if (!window.WebSocket) {
            issues.push('WebSocket not supported');
        }
        
        return {
            compatible: issues.length === 0,
            issues
        };
    }
};

let socket;
let taskId;
/** @type {MediaStream | null} */
let streamAudio = null; // Will hold the currently active audio stream
/** @type {AudioContext | null} */
let ctxAudio = null;
/** @type {MediaStreamAudioSourceNode | null} */
let sourceAudio = null;
/** 
 * @type {GainNode | null}
 * 🎛 语音识别专用增益节点（用于实现“灵敏度档位”功能）
 * 注意：仅作用于发送到识别服务的音频数据，不影响 UI 波形和系统级音量
 */
let recognitionGainNode = null;
let maxVol = 0; // For UI/debug, not critical for recognition
/** @type {AudioWorkletNode | null} */
let workletNode = null;
/** @type {HTMLTextAreaElement | null} */
let textInputEle = null; // The textarea for recognition results
/** @type {string} Stores the last recognized text to detect new effective speech */
let lastRecognizedText = '';
// 🔥 新增：语音识别时间间隔管理
let lastRecognitionEndTime = 0; // 上次识别结束的时间戳
const CONTINUATION_THRESHOLD = 2500; // 2.5秒，超过则重新开始，否则继续

// 🎯 新增：音频发送后自动结束任务管理
let lastAudioSendTime = 0; // 上次发送音频的时间戳
let autoFinishTimer = null; // 自动结束任务的定时器
const AUTO_FINISH_DELAY = 1500; // 1秒无音频输入后自动结束
let hasStartedSendingAudio = false; // 是否已经开始发送音频数据

// 🎚 语音灵敏度档位配置（内部索引 0~6，共 7 档）
// 索引与语义对应关系：
//  - 0 档：-2 档 · 极近距离（环境极吵时使用）
//  - 1 档：-1 档 · 超近距离
//  - 2 档：0  档 · 近距离加强
//  - 3 档：1  档 · 近距离对话（保持与当前线上行为尽量一致）
//  - 4 档：2  档 · 约 1 米
//  - 5 档：3  档 · 小范围讲解
//  - 6 档：4  档 · 稍大空间
//
// 注意：这些索引仅用于内部配置，UI 层通过 VoiceSensitivityController 做文案映射。
const DEFAULT_SENSITIVITY_LEVEL = 3; // 默认使用“1 档 · 近距离对话”
let currentSensitivityLevel = DEFAULT_SENSITIVITY_LEVEL;

// 每档的增益设置（数值越小越“近”，主要依赖阈值控制范围）
const SENSITIVITY_GAIN_MAP = {
    0: 0.9,   // -2 档：稍微减小增益，进一步压制远处声音
    1: 0.95,  // -1 档：轻微减增益
    2: 1.0,   //  0 档：与基线接近
    3: 1.0,   //  1 档：基线，不放大
    4: 1.15,  //  2 档：略微放大
    5: 1.3,   //  3 档：日常对话，约 1 米
    6: 1.5    //  4 档：小范围讲解
};

// 🎚 不同档位下的音量阈值配置
// 说明：
// - workletThreshold: 传给 AudioWorkletProcessor(ASRProcessor) 的 voiceThreshold
// - scriptThreshold: ScriptProcessor 降级路径下使用的阈值
// - 索引越小，阈值越高（只收更近的声音）；索引越大，范围越大
const SENSITIVITY_VOLUME_FILTER = {
    // -2 档：极近距离，只收几乎贴近麦克的正常或略大声说话
    0: { workletThreshold: 3.3, scriptThreshold: 3.5 },
    // -1 档：超近距离，比 1 档更严格
    1: { workletThreshold: 3.0, scriptThreshold: 3.2 },
    //  0 档：近距离加强，略严于 1 档
    2: { workletThreshold: 2.8, scriptThreshold: 3.0 },
    //  1 档：近距离对话（贴近麦克 maxVol≈3，1m 正常说话≈2）
    3: { workletThreshold: 2.7, scriptThreshold: 2.9 },
    //  2~4 档：逐步扩大范围
    4: { workletThreshold: 2.4, scriptThreshold: 2.6 },
    5: { workletThreshold: 2.1, scriptThreshold: 2.4 },
    6: { workletThreshold: 1.8, scriptThreshold: 2.2 }
};

let currentScriptVolumeThreshold = SENSITIVITY_VOLUME_FILTER[DEFAULT_SENSITIVITY_LEVEL].scriptThreshold;

/**
 * 根据档位获取对应增益值，确保输入安全
 * @param {number} level 期望档位（内部索引 0~6）
 * @returns {number} 正常化后的增益值
 */
const getGainBySensitivityLevel = (level) => {
    const safeLevel = Math.min(6, Math.max(0, Number.isFinite(level) ? level : DEFAULT_SENSITIVITY_LEVEL));
    return SENSITIVITY_GAIN_MAP[safeLevel] ?? SENSITIVITY_GAIN_MAP[DEFAULT_SENSITIVITY_LEVEL];
};

const getVolumeFilterConfigForLevel = (level) => {
    const safeLevel = Math.min(6, Math.max(0, Number.isFinite(level) ? level : DEFAULT_SENSITIVITY_LEVEL));
    return SENSITIVITY_VOLUME_FILTER[safeLevel] ?? SENSITIVITY_VOLUME_FILTER[DEFAULT_SENSITIVITY_LEVEL];
};

/**
 * 将当前档位应用到识别专用增益节点
 * 注意：如果增益节点暂未创建，只更新内存状态，稍后初始化时会自动使用
 */
const applySensitivityToGainNode = () => {
    if (!recognitionGainNode) {
        console.log('[VoiceSensitivity] recognitionGainNode 尚未初始化，稍后在 initRecordMicro 中应用增益');
        return;
    }
    const gainValue = getGainBySensitivityLevel(currentSensitivityLevel);
    recognitionGainNode.gain.value = gainValue;
    console.log('[VoiceSensitivity] 已应用语音灵敏度到增益节点', {
        level: currentSensitivityLevel,
        gain: gainValue
    });
};

/**
 * 将当前档位对应的音量阈值应用到处理器
 * - 对 AudioWorkletProcessor 通过 port 发送配置
 * - 对 ScriptProcessor 使用当前的全局阈值变量
 */
const applySensitivityToProcessors = () => {
    const config = getVolumeFilterConfigForLevel(currentSensitivityLevel);
    currentScriptVolumeThreshold = config.scriptThreshold;

    if (workletNode && workletNode.port) {
        try {
            workletNode.port.postMessage({
                type: 'config',
                voiceThreshold: config.workletThreshold
            });
            console.log('[VoiceSensitivity] 已将语音阈值配置发送到 AudioWorkletProcessor', config);
        } catch (err) {
            console.warn('[VoiceSensitivity] 向 AudioWorkletProcessor 发送阈值配置失败:', err);
        }
    }
};

/**
 * 对外暴露的语音灵敏度设置函数
 * - 被前端“灵敏度调节器组件”调用
 * - 默认范围限制在 0~6 档（内部索引），避免异常输入
 * @param {number} level 档位索引（0~6）
 */
const setVoiceSensitivity = (level) => {
    const previousLevel = currentSensitivityLevel;
    const safeLevel = Math.min(6, Math.max(0, Number(level) || DEFAULT_SENSITIVITY_LEVEL));
    currentSensitivityLevel = safeLevel;
    const gainValue = getGainBySensitivityLevel(currentSensitivityLevel);

    console.log('[VoiceSensitivity] 更新语音灵敏度档位', {
        previousLevel,
        newLevel: currentSensitivityLevel,
        gain: gainValue
    });

    // 即时更新已有增益节点
    if (recognitionGainNode) {
        recognitionGainNode.gain.value = gainValue;
    }

    // 将新的档位设置同步到各处理器
    applySensitivityToProcessors();
};

/** @type {number | null} Timer for silence detection (if needed for fallback) */
let silenceTimer = null;

/**
 * Initializes and starts the audio recognition process.
 * @param {string} regUrl - The WebSocket URL for the recognition server.
 * @param {string} tid - The task ID for this recognition session.
 * @param {HTMLTextAreaElement} ele - The textarea element to update.
 */
const audioRecognition = async (regUrl, tid, ele) => {
    // 检查API兼容性
    const compatibility = AudioErrorHandler.checkCompatibility();
    if (!compatibility.compatible) {
        console.error("Audio recognition not supported:", compatibility.issues);
        return;
    }
    
    // 🔥 新增：检查时间间隔，决定是否清空内容
    const now = Date.now();
    const timeSinceLastRecognition = now - lastRecognitionEndTime;
    const shouldClearContent = timeSinceLastRecognition > CONTINUATION_THRESHOLD;
    
    console.log(`🕒 语音识别间隔检查: ${timeSinceLastRecognition}ms, 阈值: ${CONTINUATION_THRESHOLD}ms, ${shouldClearContent ? '清空重新开始' : '保留内容继续'}`);

    // Clean up any existing connection or resources first
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        log.warn("Audio recognition called while a previous WebSocket was still active. Closing old one.");
        AudioErrorHandler.safeWebSocketOperation(() => socket.close(), 'closing previous socket');
    }
    await stopRecordInternal(false, shouldClearContent); // 🔥 修改：传递是否清空内容的参数

    taskId = tid;
    textInputEle = ele;

    // 安全地创建WebSocket连接
    socket = AudioErrorHandler.safeWebSocketOperation(() => {
        return new WebSocket(regUrl);
    }, 'creating WebSocket');
    
    if (!socket) {
        console.error("Failed to create WebSocket connection");
        return;
    }

    let taskStarted = false;

    socket.onopen = () => {
        log.websocket('Connected to recognition server');
        taskStarted = false;
        sendRunTask();
        // 🎯 移除：连接建立后不应该立即启动自动结束定时器
        // 只有在开始发送音频数据后才应该启动定时器
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.header.event) {
                case 'task-started':
                    console.log('Recognition task started by server.');
                    taskStarted = true;
                    // 🎯 新增：任务开始时清空lastRecognizedText
                    lastRecognizedText = '';
                    console.log('🔄 新任务开始，已清空lastRecognizedText');
                    sendAudioStream();
                    // 🎯 移除：任务开始时不应该立即启动自动结束定时器
                    // 只有在实际发送音频数据后才应该启动定时器
                    break;
                case 'result-generated': {
                    const newText = message.payload.output.sentence.text.trim();
                    if (newText && newText !== lastRecognizedText) {
                        // 🔥 新增：智能文本处理逻辑
                        console.log(`lastRecognizedText: ${lastRecognizedText} newText : ${newText}`)
                        let finalText;
                        // if (lastRecognizedText && !newText.startsWith(lastRecognizedText)) {
                        //     // 继续模式：追加新内容
                        //     finalText = lastRecognizedText + ' ' + newText;
                        //     console.log('➕ 追加模式:', lastRecognizedText, '→', finalText);
                        // } else {
                        //     // 全新内容或包含关系
                        //     finalText = newText;
                        //     console.log('🔄 替换模式:', finalText);
                        // }
                        if (message.payload.output.sentence.end_time === null) {
                            finalText = lastRecognizedText + newText;
                        } else {
                            lastRecognizedText += newText;
                            finalText = lastRecognizedText;
                            // 🎯 新增：句子结束时清空lastRecognizedText，为下次识别做准备
                            console.log('📝 句子结束，清空lastRecognizedText，最终文本:', finalText);
                            lastRecognizedText = '';
                        }
                        
                        if (textInputEle && typeof textInputEle.value === 'string') {
                            textInputEle.value = finalText;
                        }

                        // 🔥 新增：更新识别活动时间戳
                        lastRecognitionEndTime = Date.now();

                        // 🎯 新增：收到识别结果时重置自动结束定时器
                        resetAutoFinishTimer();

                        // 调用script.js中的VoiceInputHandler.resetAutoSendTimer
                        if (typeof VoiceInputHandler !== 'undefined' && VoiceInputHandler.resetAutoSendTimer) {
                            VoiceInputHandler.resetAutoSendTimer();
                        }
                    }
                    break;
                }
                case 'task-finished':
                    console.log('Recognition task finished by server.');
                    // 🔥 新增：更新识别结束时间戳
                    lastRecognitionEndTime = Date.now();
                    // 🎯 新增：任务结束时清理自动结束定时器
                    clearAutoFinishTimer();
                    // 🎯 新增：重置音频发送状态
                    hasStartedSendingAudio = false;
                    // 🎯 新增：任务结束时清空lastRecognizedText
                    lastRecognizedText = '';
                    console.log('🔄 任务结束，已清空lastRecognizedText');
                    
                    // 🎯 新增：任务结束后自动重新开始新的识别任务
                    console.log('🔄 任务已结束，准备重新开始新的识别任务');
                    setTimeout(() => {
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            sendRunTask();
                        }
                    }, 100); // 短暂延迟确保状态正确重置
                    break;
                case 'task-failed':
                    console.error('Recognition task failed:', message.header.error_message);
                    break;
                default:
                    console.log('Unknown event from recognition server:', message.header.event, message);
            }
        } catch (e) {
            console.error("Error processing message from recognition server:", e, "Raw data:", event.data);
        }
    };

    socket.onclose = (event) => {
        console.log('WebSocket connection closed.', `Code: ${event.code}, Reason: ${event.reason}, WasClean: ${event.wasClean}`);
        if (!taskStarted && event.code !== 1000) {
             console.error('Task did not start properly or connection closed unexpectedly before task start.');
        }
        // 🎯 新增：WebSocket关闭时清理自动结束定时器
        clearAutoFinishTimer();
        // 🎯 新增：重置音频发送状态
        hasStartedSendingAudio = false;
        stopRecordInternal(false, true); // WebSocket关闭时清空内容
    };
};

const sendMsg = (msg) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
    } else {
        console.warn("WebSocket is not open. Message not sent.");
    }
};

const sendRunTask = () => {
    console.log('🚀 发送运行任务命令，当前状态:', {
        hasStartedSendingAudio,
        taskId: !!taskId,
        socketState: socket ? socket.readyState : 'null'
    });
    
    const runTaskMessage = {
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
            task_group: 'audio', task: 'asr', function: 'recognition',
            model: 'paraformer-realtime-v2',
            parameters: { sample_rate: 16000, format: 'pcm' },
            input: {}
        }
    };
    sendMsg(JSON.stringify(runTaskMessage));
};

const sendAudioStream = () => {
    if (typeof navigator.mediaDevices === 'undefined' || typeof navigator.mediaDevices.getUserMedia === 'undefined') {
        console.error('getUserMedia is not supported in this browser.');
        return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(newStream => {
            if (streamAudio && streamAudio.id !== newStream.id) {
                streamAudio.getTracks().forEach(track => track.stop());
                log.audio('stream-stop', "Old audio stream stopped");
            }
            streamAudio = newStream;
            log.audio('stream-start', "New audio stream acquired successfully");
            initRecordMicro(streamAudio);
        })
        .catch(err => {
            console.error('Failed to get microphone access for audio stream:', err);
        });
};

const initRecordMicro = async (activeStream) => {
    // 安全地清理旧的资源
    AudioErrorHandler.safeAudioOperation(() => {
        if (sourceAudio) sourceAudio.disconnect();
    }, 'disconnecting sourceAudio');

    // 清理旧的识别专用增益节点，避免重复连接
    AudioErrorHandler.safeAudioOperation(() => {
        if (recognitionGainNode) {
            try {
                recognitionGainNode.disconnect();
            } catch (e) {
                console.warn('[VoiceSensitivity] 断开旧的 recognitionGainNode 时出错:', e);
            }
            recognitionGainNode = null;
        }
    }, 'disconnecting recognitionGainNode');
    
    AudioErrorHandler.safeAudioOperation(() => {
        if (workletNode) workletNode.disconnect();
    }, 'disconnecting workletNode');

    return AudioErrorHandler.safeAudioOperation(async () => {
        // 使用单例 AudioContext
        ctxAudio = getSharedAudioContext();
        
        if (!ctxAudio) {
            throw new Error('Failed to get shared AudioContext');
        }

        // 优先使用 AudioWorklet
        let useWorklet = false;
        if (ctxAudio.audioWorklet && typeof ctxAudio.audioWorklet.addModule === 'function') {
            try {
                // 使用绝对路径或相对于当前页面的路径，避免打包后路径问题
                const processorPath = new URL('./js/features/asr-processor.js', window.location.href).href;
                await ctxAudio.audioWorklet.addModule(processorPath);
                
                // 创建 AudioWorkletNode
                workletNode = new AudioWorkletNode(ctxAudio, 'asr-processor', {
                    processorOptions: {
                        sampleRate: ctxAudio.sampleRate
                    }
                });
                workletNode.port.onmessage = (event) => {
                    if (event.data.type === 'audioData') {
                        const voiceStatusBtn = document.getElementById('voiceStatusBtn')
                        if (voiceStatusBtn.dataset.state !== 'voice_on') {
                            return;
                        }
                        maxVol = event.data.maxVol;
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(event.data.data.buffer);
                            onAudioSent();
                        }
                    } else if (event.data.type === 'silenceDetected') {
                        console.log('🔇 检测到静音，持续时间:', event.data.duration, '帧');
                    }
                };
                
                // 处理 AudioWorklet 错误
                workletNode.onprocessorerror = (error) => {
                    console.error('❌ AudioWorklet 处理器错误:', error);
                    // 自动降级到 ScriptProcessor
                    useWorklet = false;
                    initScriptProcessor();
                };
                
                // 通过增益节点串联音频链路：Source -> Gain -> Worklet
                sourceAudio = ctxAudio.createMediaStreamSource(activeStream);
                recognitionGainNode = ctxAudio.createGain();
                recognitionGainNode.gain.value = getGainBySensitivityLevel(currentSensitivityLevel);
                sourceAudio.connect(recognitionGainNode);
                recognitionGainNode.connect(workletNode);
                
                useWorklet = true;
                log.info("✅ 麦克风录音已使用 AudioWorklet (外部处理器) 初始化，并接入语音灵敏度增益节点", {
                    sensitivityLevel: currentSensitivityLevel,
                    gain: recognitionGainNode.gain.value
                });

                // 初始化时同步一次阈值到处理器
                applySensitivityToProcessors();
                
            } catch (workletError) {
                console.warn("⚠️ 外部 AudioWorklet 失败，尝试内联处理器:", workletError);
                
                // 降级：尝试内联 AudioWorkletProcessor
                try {
                    const processorCode = `
                        import { AudioUtils } from '../core/audioUtils.js';

                        class AudioRecognitionProcessor extends AudioWorkletProcessor {
                            constructor() {
                                super();
                                this.inputSampleRate = 48000;
                                this.outputSampleRate = 16000;
                                this.bufferSize = 4096;
                                this.inputBuffer = [];
                            }
                            
                            process(inputs) {
                                const input = inputs[0];
                                if (input.length > 0) {
                                    const inputData = input[0];
                                    
                                    for (let i = 0; i < inputData.length; i++) {
                                        this.inputBuffer.push(inputData[i]);
                                    }
                                    
                                    if (this.inputBuffer.length >= this.bufferSize) {
                                        const chunk = this.inputBuffer.splice(0, this.bufferSize);
                                        
                                        // 使用统一的音频处理工具
                                        const resampledData = AudioUtils.resampleLinear(chunk, this.inputSampleRate, this.outputSampleRate);
                                        const pcm16BitData = AudioUtils.floatTo16BitPCM(resampledData);
                                        const maxVol = AudioUtils.calculateVolume(chunk);
                                        
                                        // 🎯 新增：音量阈值过滤 - 只有音量达到阈值才发送数据
                                        const VOICE_THRESHOLD = 6; // 音量阈值 (0-100)，与配置保持一致
                                        if (maxVol >= VOICE_THRESHOLD) {
                                            this.port.postMessage({
                                                type: 'audioData',
                                                data: pcm16BitData,
                                                maxVol: maxVol
                                            });
                                        }
                                    }
                                }
                                return true;
                            }
                        }
                        
                        registerProcessor('audio-recognition-processor-inline', AudioRecognitionProcessor);
                    `;
                    
                    const blob = new Blob([processorCode], { type: 'application/javascript' });
                    const processorUrl = URL.createObjectURL(blob);
                    
                    await ctxAudio.audioWorklet.addModule(processorUrl);
                    URL.revokeObjectURL(processorUrl);
                    
                    workletNode = new AudioWorkletNode(ctxAudio, 'audio-recognition-processor-inline');
                    workletNode.port.onmessage = (event) => {
                        if (event.data.type === 'audioData') {
                            maxVol = event.data.maxVol;
                            if (socket && socket.readyState === WebSocket.OPEN) {
                                socket.send(event.data.data.buffer);
                                // 🎯 新增：音频发送后重置自动结束定时器
                                onAudioSent();
                            } else {
                                console.log( "音频buffer长度： " + event.data.data.buffer.length)
                                console.log( "hasStartedSendingAudio： " + hasStartedSendingAudio)
                                console.log( "socket： " + socket)
                            }
                        }
                    };
                    
                    // 通过增益节点串联音频链路：Source -> Gain -> Worklet（内联版）
                    sourceAudio = ctxAudio.createMediaStreamSource(activeStream);
                    recognitionGainNode = ctxAudio.createGain();
                    recognitionGainNode.gain.value = getGainBySensitivityLevel(currentSensitivityLevel);
                    sourceAudio.connect(recognitionGainNode);
                    recognitionGainNode.connect(workletNode);
                    
                    useWorklet = true;
                    console.log("✅ 麦克风录音已使用内联 AudioWorklet 初始化，并接入语音灵敏度增益节点", {
                        sensitivityLevel: currentSensitivityLevel,
                        gain: recognitionGainNode.gain.value
                    });
                    
                } catch (inlineError) {
                    console.warn("⚠️ 内联 AudioWorklet 失败，降级到 ScriptProcessor:", inlineError);
                }
            }
        }
        
        // 降级到ScriptProcessor（已弃用但兼容旧浏览器）
        if (!useWorklet) {
            console.warn("⚠️ 使用已弃用的 ScriptProcessor 进行音频处理");
            initScriptProcessor();
        }
        
        // ScriptProcessor 初始化函数
        function initScriptProcessor() {
            try {
                sourceAudio = ctxAudio.createMediaStreamSource(activeStream);
                scriptProcessor = ctxAudio.createScriptProcessor(4096, 1, 1);
                
                scriptProcessor.onaudioprocess = (event) => {
                    const inputBuffer = event.inputBuffer;
                    const inputData = inputBuffer.getChannelData(0);
                    
                    // 计算音量
                    let sum = 0;
                    for (let i = 0; i < inputData.length; i++) {
                        sum += inputData[i] * inputData[i];
                    }
                    maxVol = Math.round(Math.sqrt(sum / inputData.length) * 100);
                    
                    // 音量阈值过滤（根据当前灵敏度档位动态调整）
                    if (maxVol >= currentScriptVolumeThreshold) {
                        // 重采样到16kHz
                        const resampledData = AudioUtils.resampleLinear(inputData, 48000, 16000);
                        const pcm16BitData = AudioUtils.floatTo16BitPCM(resampledData);
                        
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(pcm16BitData.buffer);
                            // 🎯 新增：音频发送后重置自动结束定时器
                            onAudioSent();
                        }
                    }
                };
                
                // 通过增益节点串联音频链路：Source -> Gain -> ScriptProcessor
                recognitionGainNode = ctxAudio.createGain();
                recognitionGainNode.gain.value = getGainBySensitivityLevel(currentSensitivityLevel);
                sourceAudio.connect(recognitionGainNode);
                recognitionGainNode.connect(scriptProcessor);
                // 创建一个静音的 GainNode 避免麦克风回放到扬声器（防止啸叫）
                const silentGain = ctxAudio.createGain();
                silentGain.gain.value = 0; // 完全静音
                scriptProcessor.connect(silentGain);
                silentGain.connect(ctxAudio.destination);
                
                console.log("✅ 麦克风录音已使用 ScriptProcessor 初始化，并接入语音灵敏度增益节点", {
                    sensitivityLevel: currentSensitivityLevel,
                    gain: recognitionGainNode.gain.value
                });

                // 初始化时同步一次脚本处理器阈值
                const cfg = getVolumeFilterConfigForLevel(currentSensitivityLevel);
                currentScriptVolumeThreshold = cfg.scriptThreshold;
                
            } catch (scriptError) {
                console.error("❌ ScriptProcessor 初始化失败:", scriptError);
                throw new Error("所有音频处理方法都失败了");
            }
        }
        
        return true; // 成功初始化
    }, 'initRecordMicro', () => {
        console.error("Failed to initialize audio recording");
        return false;
    });
};

const sendFinishTask = () => {
    if (!taskId) {
        console.warn("No task ID available to send finish-task.");
        return;
    }
    const finishTaskMessage = {
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} }
    };
    sendMsg(JSON.stringify(finishTaskMessage));
    console.log("Sent finish-task to server.");
    
    // 🎯 新增：发送结束任务后，等待服务器响应后会自动重新开始
    // 这里不需要手动重新开始，因为会在 task-finished 事件中处理
};

const stopRecordInternal = async (shouldSendFinishTask = true, shouldClearContent = true) => {
    // 清理音频流
    if (streamAudio) {
        streamAudio.getTracks().forEach(track => {
            track.stop();
            console.log(`Audio track ${track.id} stopped.`);
        });
        streamAudio = null;
        console.log("Audio stream tracks stopped.");
    }
    
    // 断开音频节点连接 - 使用正确的顺序避免竞态条件
    if (sourceAudio) {
        try {
            sourceAudio.disconnect();
        } catch (e) {
            console.warn("Error disconnecting sourceAudio:", e);
        }
        sourceAudio = null;
    }
    
    if (workletNode) {
        try {
            // 先清理消息处理器，防止后续消息处理
            workletNode.port.onmessage = null;
            
            // 安全的异步等待机制，避免Promise重复resolve
            await safelyCloseWorkletNode(workletNode);
            
            workletNode.disconnect();
        } catch (e) {
            console.warn("Error disconnecting workletNode:", e);
        }
        workletNode = null;
    }

    // 断开并清理识别专用增益节点
    if (recognitionGainNode) {
        try {
            recognitionGainNode.disconnect();
        } catch (e) {
            console.warn("[VoiceSensitivity] Error disconnecting recognitionGainNode:", e);
        }
        recognitionGainNode = null;
    }
    
    // 等待 AudioWorklet 处理完成后再暂停 AudioContext
    if (ctxAudio) {
        try {
            // 短暂延迟确保所有音频处理完成
            await new Promise(resolve => setTimeout(resolve, 10));
            await suspendSharedAudioContext();
            console.log("Shared AudioContext suspended successfully.");
        } catch (e) {
            console.warn("Error suspending shared AudioContext:", e);
        } finally {
            ctxAudio = null;
        }
    }
    
    // 清理计时器
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
    
    // 🎯 新增：清理自动结束定时器
    clearAutoFinishTimer();
    
    // 🎯 新增：重置音频发送状态
    hasStartedSendingAudio = false;
    
    // 🔥 修改：根据参数决定是否清空已识别文本
    if (shouldClearContent) {
        lastRecognizedText = '';
        console.log('🗑️ 已清空识别内容（超过2.5秒间隔）');
    } else {
        console.log('📝 保留识别内容（小于2.5秒间隔）');
    }
    maxVol = 0;
    
    // 发送结束任务信号
    if (shouldSendFinishTask && socket && socket.readyState === WebSocket.OPEN) {
        sendFinishTask();
    }
    
    console.log("Audio recording resources released.");
};

const stopRecord = async () => {
    console.log("stopRecord called publicly.");
    
    // 安全地停止录音
    await AudioErrorHandler.safeAudioOperation(async () => {
        await stopRecordInternal(true, true); // 手动停止时清空内容
    }, 'stopRecordInternal');
    
    // 安全地关闭WebSocket连接
    if (socket) {
        AudioErrorHandler.safeWebSocketOperation(() => {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close(1000, "Client initiated stop");
                console.log("WebSocket connection closed by client's stopRecord.");
            }
        }, 'closing WebSocket in stopRecord');
        socket = null;
    }
};

// 🎯 新增：调试函数
const debugRecognitionState = () => {
    console.log('🔍 识别状态调试信息:', {
        hasStartedSendingAudio,
        lastAudioSendTime,
        autoFinishTimer: !!autoFinishTimer,
        socketState: socket ? socket.readyState : 'null',
        taskId: !!taskId,
        maxVol,
        lastRecognitionEndTime,
        timeSinceLastRecognition: Date.now() - lastRecognitionEndTime
    });
};

// 暴露调试函数到全局
if (typeof window !== 'undefined') {
    window.debugRecognitionState = debugRecognitionState;
}

/**
 * 将核心音频识别函数暴露到全局，确保script.js可以正常调用
 * 这解决了ES6模块与普通脚本之间的隔离问题
 */
if (typeof window !== 'undefined') {
    // 暴露主要音频识别函数
    window.audioRecognition = audioRecognition;
    window.stopRecord = stopRecord;
    
    // 🎯 新增：暴露音频发送管理函数
    window.resetAutoFinishTimer = resetAutoFinishTimer;
    window.clearAutoFinishTimer = clearAutoFinishTimer;
    window.onAudioSent = onAudioSent;
    window.debugRecognitionState = debugRecognitionState; // 暴露调试函数
    // 🎚 暴露语音灵敏度调节接口，供前端组件调用
    window.setVoiceSensitivity = setVoiceSensitivity;
    
    // 可选：暴露错误处理器供外部使用
    window.AudioErrorHandler = AudioErrorHandler;
    
    console.log('✅ 音频识别函数已暴露到全局scope:', {
        audioRecognition: typeof window.audioRecognition,
        stopRecord: typeof window.stopRecord,
        resetAutoFinishTimer: typeof window.resetAutoFinishTimer,
        clearAutoFinishTimer: typeof window.clearAutoFinishTimer,
        onAudioSent: typeof window.onAudioSent,
        AudioErrorHandler: typeof window.AudioErrorHandler
    });
} else {
    console.warn('⚠️ window对象不可用，无法暴露全局函数');
}


// ES6 模块导出
export { 
    audioRecognition, 
    stopRecord, 
    AudioErrorHandler,
    resetAutoFinishTimer,
    clearAutoFinishTimer,
    onAudioSent,
    debugRecognitionState,
};
