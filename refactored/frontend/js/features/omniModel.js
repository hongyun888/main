// --- START OF FILE omniModel.js ---

// 高兼容性多模态音频处理模块
// 基于语音识别02的正确实现，适配当前应用架构

// 🚫 禁用 Omni 的语音合成功能（仅保留文本流式能力）
const OMNI_TTS_DISABLED = true;

// Web Audio API 相关变量
let omniAudioContext;
let omniNextPlayTime = 0;
let omniIsPlayingTTS = false;
let omniTtsStartTime = 0;
let omniTtsLastProgress = 0;
const OMNI_AUDIO_SAMPLE_RATE = 24000; 
const OMNI_MIN_BUFFER_AHEAD_TIME = 0.05; 

let currentOmniRequestAbortController = null; 

// 🎯 智能缓冲策略相关变量
let audioBufferQueue = []; // 音频缓冲队列
let bufferStartTime = null; // 缓冲开始时间
let isBuffering = false; // 是否正在缓冲
let networkDelayHistory = []; // 网络延迟历史记录
let dynamicBufferTime = 1500; // 动态缓冲时间(毫秒)，默认1.5秒

// 缓冲策略配置
const BUFFER_CONFIG = {
    DEFAULT_BUFFER_TIME: 1500, // 默认缓冲时间(ms)
    MIN_BUFFER_TIME: 500,      // 最小缓冲时间(ms) 
    MAX_BUFFER_TIME: 3000,     // 最大缓冲时间(ms)
    NETWORK_DELAY_SAMPLES: 3,  // 网络延迟采样数量
    SLOW_NETWORK_THRESHOLD: 500 // 慢网络阈值(ms)
}; 

// 适配当前应用的视频切换系统
function callVideoSwitch(isPlaying) {
    if (OMNI_TTS_DISABLED) return;
    console.log(`omniModel.js: Setting TTS state to ${isPlaying}`);
    if (typeof window !== 'undefined') {
        window.TTS_PLAYING = isPlaying;
        window.TTS_PENDING = false;
        if (typeof updateVideoByTTSState === 'function') {
            updateVideoByTTSState();
        }
    }
}

function initializeOmniAudioContext() {
  if (OMNI_TTS_DISABLED) return;
  if (!omniAudioContext || omniAudioContext.state === 'closed') {
    console.log("omniModel.js: Initializing new OmniAudioContext.");
    omniAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    omniNextPlayTime = 0;
    omniIsPlayingTTS = false; 
    
    // 🎯 初始化时重置缓冲状态
    resetBufferState();
  }
  if (omniAudioContext.state === 'suspended') {
    omniAudioContext.resume().catch(err => console.error("omniModel.js: Error resuming AudioContext:", err));
  }
}

// 🎯 网络延迟检测和动态缓冲时间调整
function recordNetworkDelay(delayMs) {
    networkDelayHistory.push(delayMs);
    if (networkDelayHistory.length > BUFFER_CONFIG.NETWORK_DELAY_SAMPLES) {
        networkDelayHistory.shift(); // 保持最近N次的记录
    }
    
    // 计算平均延迟并动态调整缓冲时间
    const avgDelay = networkDelayHistory.reduce((sum, delay) => sum + delay, 0) / networkDelayHistory.length;
    
    if (avgDelay > BUFFER_CONFIG.SLOW_NETWORK_THRESHOLD) {
        // 网络较慢，增加缓冲时间
        dynamicBufferTime = Math.min(BUFFER_CONFIG.MAX_BUFFER_TIME, avgDelay * 2);
        console.log(`🐌 检测到慢网络(${avgDelay.toFixed(0)}ms)，调整缓冲时间到${dynamicBufferTime}ms`);
    } else {
        // 网络正常，使用默认缓冲时间
        dynamicBufferTime = BUFFER_CONFIG.DEFAULT_BUFFER_TIME;
        console.log(`🚀 网络状况良好(${avgDelay.toFixed(0)}ms)，使用默认缓冲时间${dynamicBufferTime}ms`);
    }
}

// 🎯 播放音频缓冲队列中的音频
function playBufferedAudio(signal) {
    if (audioBufferQueue.length === 0 || signal?.aborted) return;
    
    console.log(`🎵 开始播放缓冲音频，队列中有${audioBufferQueue.length}个音频块`);
    let firstScheduledTime = null;
    for (let i = 0; i < audioBufferQueue.length; i++) {
        if (signal?.aborted) break;
        
        const audioBuffer = audioBufferQueue[i];
        const sourceNode = omniAudioContext.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(omniAudioContext.destination);

        const currentTime = omniAudioContext.currentTime;
        const scheduledTime = Math.max(currentTime + OMNI_MIN_BUFFER_AHEAD_TIME, omniNextPlayTime);
        if (firstScheduledTime === null) {
            firstScheduledTime = scheduledTime;
        }
        sourceNode.start(scheduledTime);
        omniNextPlayTime = scheduledTime + audioBuffer.duration;
    }
    
    // 开始播放后设置状态
    if (!omniIsPlayingTTS && !signal?.aborted) {
        omniIsPlayingTTS = true;
        callVideoSwitch(true);
        omniTtsStartTime = Number.isFinite(firstScheduledTime) ? firstScheduledTime : (omniAudioContext ? omniAudioContext.currentTime : 0);
        omniTtsLastProgress = 0;
        
        if (typeof window !== 'undefined' && typeof window.VoiceStateManager !== 'undefined') {
            window.VoiceStateManager.startTTS({
                progressProvider: () => {
                    if (!omniAudioContext || omniAudioContext.state === 'closed') return omniTtsLastProgress;
                    const minTotal = (typeof window !== 'undefined' && window.__SUBTITLE_EST_DURATION_MS)
                        ? window.__SUBTITLE_EST_DURATION_MS / 1000
                        : 0;
                    const total = Math.max(0.001, omniNextPlayTime - omniTtsStartTime, minTotal || 0);
                    if (omniAudioContext.currentTime < omniTtsStartTime) return 0;
                    const current = Math.max(0, omniAudioContext.currentTime - omniTtsStartTime);
                    const raw = current / total;
                    if (Number.isFinite(raw)) {
                        omniTtsLastProgress = Math.max(omniTtsLastProgress, Math.min(1, Math.max(0, raw)));
                    }
                    return omniTtsLastProgress;
                }
            });
            console.log('🔊 omni TTS播放开始，已通知VoiceStateManager');
        }
    }
    
    // 清空已播放的缓冲队列
    audioBufferQueue = [];
    isBuffering = false;
    bufferStartTime = null;
}

// 🎯 重置缓冲状态
function resetBufferState() {
    audioBufferQueue = [];
    isBuffering = false;
    bufferStartTime = null;
    dynamicBufferTime = BUFFER_CONFIG.DEFAULT_BUFFER_TIME;
    console.log('🔄 重置音频缓冲状态');
}

function stopOmniTTSPlayback() {
    console.log("omniModel.js: Stopping Omni TTS playback.");
    const wasPlaying = omniIsPlayingTTS;
    
    // 🎯 清理缓冲状态
    resetBufferState();

    if (OMNI_TTS_DISABLED) {
        omniNextPlayTime = 0;
        omniIsPlayingTTS = false;
        omniTtsStartTime = 0;
        omniTtsLastProgress = 0;
        return;
    }
    
    if (omniAudioContext) {
        if (omniAudioContext.state !== 'closed') {
            omniAudioContext.close()
                .then(() => { console.log("omniModel.js: OmniAudioContext closed."); })
                .catch(e => { console.warn("omniModel.js: Error closing omniAudioContext:", e); })
                .finally(() => { omniAudioContext = null; });
        } else {
            omniAudioContext = null;
        }
    }
    omniNextPlayTime = 0;
    omniIsPlayingTTS = false;
    omniTtsStartTime = 0;
    omniTtsLastProgress = 0;
    
    // 适配当前应用：如果之前在播放，切换到静音状态
    if (wasPlaying) {
        callVideoSwitch(false);
        
        // 🔥 新增：omni TTS播放结束，通知VoiceStateManager
        if (typeof window !== 'undefined' && typeof window.VoiceStateManager !== 'undefined') {
            window.VoiceStateManager.stopTTS();
            console.log('✅ omni TTS播放结束，已通知VoiceStateManager');
        }
    }
}

// Base64解码函数
function base64ToArrayBufferLocal(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// 取消当前请求的函数
window.cancelCurrentOmniModelRequest = function () {
  console.log("omniModel.js: cancelCurrentOmniModelRequest called.");
  const wasPlayingTTSBeforeCancel = omniIsPlayingTTS;

  if (currentOmniRequestAbortController) {
    console.log("omniModel.js: Aborting current OmniModel fetch request.");
    currentOmniRequestAbortController.abort();
  } else {
    console.log("omniModel.js: No active fetch to abort.");
  }

  stopOmniTTSPlayback();
  if (wasPlayingTTSBeforeCancel && !omniIsPlayingTTS) {
    console.log("omniModel.js: TTS was active during cancellation and now stopped, ensuring idle video.");
    callVideoSwitch(false);
  }
};

const requestOmniModel = (url, param, msgHistory, handleRes, onPlaybackFinishedCallback, options = {}) => {
  const localAbortController = new AbortController();
  currentOmniRequestAbortController = localAbortController;
  const signal = localAbortController.signal;

  if (!OMNI_TTS_DISABLED) {
    initializeOmniAudioContext();
    // 🎯 重置缓冲状态，开始新的请求
    resetBufferState();
  } else {
    omniIsPlayingTTS = false;
  }
  const requestStartTime = Date.now(); // 记录请求开始时间用于网络延迟检测
  
  const requestParameter = processParam(param, msgHistory, options);
  
  // 确保视频状态正确：请求开始前如果没有TTS播放，确保视频为静音状态
  if (!omniIsPlayingTTS) {
      console.log("omniModel.js: No TTS currently playing before new request, ensuring idle video.");
      callVideoSwitch(false);
  }

     // 获取认证信息
   if (typeof getAppCode !== 'function' || typeof getToken !== 'function') {
     console.error("omniModel.js: getAppCode or getToken function not available");
     if (typeof onPlaybackFinishedCallback === 'function') onPlaybackFinishedCallback(true);
     return;
   }
   
   const appCode = getAppCode();
   const token = getToken();
   
   if (!appCode || !token) {
     console.error("omniModel.js: AppCode or Token not available", { appCode: !!appCode, token: !!token });
     if (typeof onPlaybackFinishedCallback === 'function') onPlaybackFinishedCallback(true);
     return;
   }
   
   console.log("omniModel.js: Starting request with authentication");
   const fullUrl = url + `?AppCode=${appCode}`;
   console.log("omniModel.js: Request details:", {
     url: fullUrl,
     method: 'POST',
     hasToken: !!token,
     hasAppCode: !!appCode,
     requestBody: requestParameter
   });
   
   fetch(fullUrl, {
     method: 'POST',
     headers: { 
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${token}`
     },
     body: JSON.stringify(requestParameter),
     signal: signal
   })
         .then(async response => {
       // 🎯 记录网络延迟
       const networkDelay = Date.now() - requestStartTime;
       recordNetworkDelay(networkDelay);
       
       console.log("omniModel.js: Received response:", {
         status: response.status,
         statusText: response.statusText,
         networkDelay: `${networkDelay}ms`,
         dynamicBufferTime: `${dynamicBufferTime}ms`,
         headers: Object.fromEntries(response.headers.entries())
       });
       
       if (signal.aborted) {
         console.log("omniModel.js: Fetch aborted before response processing.");
         return;
       }
       if (!response.ok) {
         console.error("omniModel.js: HTTP error response:", {
           status: response.status,
           statusText: response.statusText
         });
         if (omniIsPlayingTTS) callVideoSwitch(false);
         stopOmniTTSPlayback();
         if (typeof onPlaybackFinishedCallback === 'function') onPlaybackFinishedCallback(true); 
         throw new Error(`omniModel.js: HTTP error! status: ${response.status}`);
       }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const streamProcessingLoop = async () => {
        while (true) {
          if (signal.aborted) {
            console.log("omniModel.js: Stream reading aborted during loop.");
            if(omniIsPlayingTTS) callVideoSwitch(false);
            stopOmniTTSPlayback();
            reader.cancel("User aborted stream").catch(e => console.warn("omniModel.js: Error cancelling reader:", e));
            return; 
          }
          const { done, value } = await reader.read();
          if (done) {
            console.log("omniModel.js: Stream finished normally.");
            
            // 🎯 流结束时，如果还有缓冲的音频，立即播放
            if (audioBufferQueue.length > 0 && !omniIsPlayingTTS && !signal.aborted) {
              console.log(`🎵 流结束，播放剩余的${audioBufferQueue.length}个缓冲音频块`);
              playBufferedAudio(signal);
            }
            
            const finalizeResponse = () => {
              if (signal.aborted) {
                console.log("omniModel.js: FinalizeResponse skipped due to abort signal.");
                callVideoSwitch(false);
                stopOmniTTSPlayback();
                return;
              }
              
              console.log("omniModel.js: Finalizing response normally.");
              if (!omniIsPlayingTTS) {
                callVideoSwitch(false);
              } else if (omniIsPlayingTTS && omniAudioContext && omniAudioContext.currentTime >= omniNextPlayTime - OMNI_MIN_BUFFER_AHEAD_TIME / 2) {
                stopOmniTTSPlayback();
              }

              if (typeof onPlaybackFinishedCallback === 'function') {
                onPlaybackFinishedCallback(false);
              }
              if (currentOmniRequestAbortController === localAbortController) {
                currentOmniRequestAbortController = null;
              }
            };

            // 等待音频播放完成或直接完成
            if (omniIsPlayingTTS && omniAudioContext && omniAudioContext.currentTime < omniNextPlayTime - OMNI_MIN_BUFFER_AHEAD_TIME / 2) {
              console.log("omniModel.js: Waiting for buffered audio to play out.");
              const checkInterval = setInterval(() => {
                if (signal.aborted || !omniAudioContext || omniAudioContext.state === 'closed' || omniAudioContext.currentTime >= omniNextPlayTime - OMNI_MIN_BUFFER_AHEAD_TIME / 2 || !omniIsPlayingTTS) {
                  clearInterval(checkInterval);
                  console.log("omniModel.js: Audio playout wait finished or aborted.");
                  if (signal.aborted) {
                      if(omniIsPlayingTTS) callVideoSwitch(false);
                      stopOmniTTSPlayback();
                  } else {
                      finalizeResponse(); 
                  }
                }
              }, 50);
            } else {
               if (!signal.aborted) finalizeResponse();
               else {
                  if(omniIsPlayingTTS) callVideoSwitch(false);
                  stopOmniTTSPlayback();
               }
            }
            return; 
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (signal.aborted) {
              console.log("omniModel.js: Line processing skipped (aborted).");
              break;
            }
          
            if (!line.trim().startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;

            try {
              const chunk = JSON.parse(dataStr);
              if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
                const delta = chunk.choices[0].delta;

                if (delta && typeof delta.content === 'string' && !signal.aborted) {
                  handleRes({ type: 'text', content: delta.content });
                }

                if (!OMNI_TTS_DISABLED && delta && delta.audio && !signal.aborted) {
                  if (delta.audio.transcript) {
                    handleRes({ type: 'text', content: delta.audio.transcript });
                  }
                  if (delta.audio.data) {
                    if (!omniAudioContext || omniAudioContext.state === 'closed') {
                        if (!signal.aborted) { 
                            console.warn("omniModel.js: AudioContext closed mid-stream. Re-initializing.");
                            initializeOmniAudioContext();
                        } else {
                            console.log("omniModel.js: Audio processing skipped, context closed (aborted).");
                            continue; 
                        }
                    }
                    if (omniAudioContext.state === 'suspended') {
                      omniAudioContext.resume().catch(err => console.error("omniModel.js: Error resuming AudioContext:", err));
                    }
                    if (signal.aborted) { 
                        continue;
                    }

                    const base64AudioChunk = delta.audio.data;
                    try {
                      const audioChunkArrayBuffer = base64ToArrayBufferLocal(base64AudioChunk);
                      const pcmData = new Int16Array(audioChunkArrayBuffer);
                      const frameCount = pcmData.length;

                      if (frameCount === 0) continue;

                      // 创建音频buffer
                      const audioBuffer = omniAudioContext.createBuffer(1, frameCount, OMNI_AUDIO_SAMPLE_RATE);
                      const channelData = audioBuffer.getChannelData(0);
                      for (let i = 0; i < frameCount; i++) {
                        channelData[i] = pcmData[i] / 32768.0;
                      }

                      // 🎯 智能缓冲策略：将音频加入缓冲队列而不是立即播放
                      audioBufferQueue.push(audioBuffer);
                      
                      // 第一次收到音频数据时开始缓冲计时
                      if (!isBuffering && !bufferStartTime) {
                        isBuffering = true;
                        bufferStartTime = Date.now();
                        console.log(`🎯 开始缓冲音频，缓冲时间: ${dynamicBufferTime}ms`);
                      }
                      
                      // 检查是否达到缓冲条件：时间足够 或 队列中有足够的音频数据
                      const bufferElapsed = Date.now() - (bufferStartTime || Date.now());
                      const hasEnoughData = audioBufferQueue.length >= 3; // 至少3个音频块
                      const bufferTimeReached = bufferElapsed >= dynamicBufferTime;
                      
                      if (!omniIsPlayingTTS && isBuffering && (bufferTimeReached || hasEnoughData)) {
                        console.log(`🎵 缓冲条件满足：时间=${bufferElapsed}ms, 数据块=${audioBufferQueue.length}个`);
                        playBufferedAudio(signal);
                      } else if (omniIsPlayingTTS) {
                        // 已经在播放，直接添加到播放队列
                      const sourceNode = omniAudioContext.createBufferSource();
                      sourceNode.buffer = audioBuffer;
                      sourceNode.connect(omniAudioContext.destination);

                      const currentTime = omniAudioContext.currentTime;
                      const scheduledTime = Math.max(currentTime + OMNI_MIN_BUFFER_AHEAD_TIME, omniNextPlayTime);
                      sourceNode.start(scheduledTime);
                      omniNextPlayTime = scheduledTime + audioBuffer.duration;

                        // 从队列中移除已播放的音频
                        audioBufferQueue.pop();
                      }
                    } catch (e) {
                      console.error("omniModel.js: Error processing audio chunk:", e);
                    }
                  }
                }
              }
            } catch (parseErr) {
                console.error("omniModel.js: Error parsing JSON chunk:", parseErr, "Data:", dataStr);
            }
          } 
          if (signal.aborted) break; 
        } 
      };

      await streamProcessingLoop();
      
    })
         .catch(fetchError => {
       console.error("omniModel.js: Request failed:", {
         error: fetchError.message,
         stack: fetchError.stack,
         name: fetchError.name
       });
       callVideoSwitch(false);
       stopOmniTTSPlayback();
       if (typeof onPlaybackFinishedCallback === 'function') onPlaybackFinishedCallback(true);
       if (currentOmniRequestAbortController === localAbortController) {
         currentOmniRequestAbortController = null;
       }
       throw fetchError;
     });
};

// 处理历史消息
const processContent = (msgHistory, msgs) => {
  if (!msgHistory || !Array.isArray(msgHistory)) return;
  
  for (const msg of msgHistory) {
    if (msg.type === 'owner') {
      msgs.push({
        "role": "user",
        "content": [{ type: 'text', text: msg.text }]
      });
    } else if (msg.type === 'other') {
      msgs.push({
        "role": "assistant", 
        "content": [{ type: 'text', text: msg.text }]
      });
    }
  }
};

const processParam = (param, msgHistory, options = {}) => {
  console.log("omniModel.js: processParam input:", {
    paramType: typeof param,
    isArray: Array.isArray(param),
    paramValue: param
  });

  let payloadContent;
  if (Array.isArray(param)) {
    payloadContent = param.map(element => processFileType(element));
    console.log("omniModel.js: Processed multimodal array:", payloadContent);
  } else if (typeof param === 'string') {
    payloadContent = [{ type: 'text', text: param }];
    console.log("omniModel.js: Processed text-only:", payloadContent);
  } else if (typeof param === 'object' && param !== null && param.type) {
    payloadContent = [processFileType(param)];
    console.log("omniModel.js: Processed single object:", payloadContent);
  } else {
    console.warn("omniModel.js: processParam received unexpected param structure:", param);
    payloadContent = [{ type: 'text', text: "Error: Invalid input structure." }]; 
  }

  const msgs = [];
  processContent(msgHistory, msgs);

  msgs.push({
    "role": "user",
    "content": payloadContent
  });

  const audioEnabled = !OMNI_TTS_DISABLED && options.audioEnabled !== false;
  const payload = {
    "model": "qwen-omni-turbo",
    "messages": msgs,
    "stream": true,
    "stream_options": {
      "include_usage": true
    },
    "modalities": audioEnabled ? ["audio", "text"] : ["text"]
  };
  if (audioEnabled) {
    payload.audio = {
      "voice": "Cherry",
      "format": "wav"
    };
  }
  return payload;
};

const processFileType = (element) => {
  if (element.type === 'image' || element.type === 'image_url') {
    return {
      "type": "image_url",
      "image_url": { "url": element.url }
    };
  }
  if (element.type === 'audio' || element.type === 'input_audio') {
    return {
      "type": "input_audio",
      "input_audio": { "data": element.url, "format": element.format }
    };
  }
  if (element.type === 'video' || element.type === 'video_url') {
    return {
      "type": "video_url",
      "video_url": { "url": element.url }
    };
  }
  if (element.type === 'text') {
    return {
      "type": "text",
      "text": element.text
    };
  }
  console.warn("omniModel.js: Unknown file type for processFileType:", element);
  return element; 
};

// 全局暴露函数，确保与现有系统兼容
if (typeof window !== 'undefined') {
    window.requestOmniModel = requestOmniModel;
    
    // 暴露状态变量
    Object.defineProperty(window, 'omniIsPlayingTTS', {
        get: () => omniIsPlayingTTS,
        set: (value) => { omniIsPlayingTTS = value; },
        enumerable: true,
        configurable: true
    });
    
    console.log('✅ Omni模型函数已暴露到全局scope:', {
        requestOmniModel: typeof window.requestOmniModel,
        omniIsPlayingTTS: typeof window.omniIsPlayingTTS,
        cancelCurrentOmniModelRequest: typeof window.cancelCurrentOmniModelRequest
    });
} else {
    console.warn('⚠️ window对象不可用，无法暴露全局函数');
}

// --- END OF FILE omniModel.js ---
