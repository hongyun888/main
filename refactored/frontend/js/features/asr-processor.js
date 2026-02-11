// AudioWorklet Processor for Audio Recognition
// 音频识别专用的 AudioWorklet 处理器

// 使用统一的音频工具，避免在此重复实现
import { AudioUtils } from '../core/audioUtils.js';

class ASRProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.options = options;
        if (options.processorOptions && options.processorOptions.sampleRate) {
            this.inputSampleRate = options.processorOptions.sampleRate;
        } else {
            this.inputSampleRate = 48000; // 默认采样率
        }
        this.outputSampleRate = 16000;
        this.bufferSize = this.inputSampleRate / 10; // 每100ms处理一次
        this.inputBuffer = [];
        this.frameCount = 0;
        
        // 音量平滑处理
        this.volumeSmoothingFactor = 0.3;
        
        // 音量阈值配置（可通过主线程动态调整，以支持“灵敏度档位”功能）
        this.voiceThreshold = 2; // 默认阈值 (0-100)，与现有线上行为保持一致
        this.silenceThreshold = 2; // 静音阈值
        this.lastVolume = this.silenceThreshold;

        // 状态跟踪
        this.isSpeaking = false;
        this.silenceCounter = 0;
        this.maxSilenceFrames = 50; // 最大静音帧数

        // 允许主线程通过 port 发送配置，动态调整阈值
        this.port.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === 'config' && typeof data.voiceThreshold === 'number') {
                // 做一个简单的安全夹取，避免异常值
                const next = Math.max(0, Math.min(20, data.voiceThreshold));
                this.voiceThreshold = next;
            }
        };
    }
    
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input.length > 0) {
            const inputData = input[0];
            
            // 将输入数据添加到缓冲区
            for (let i = 0; i < inputData.length; i++) {
                this.inputBuffer.push(inputData[i]);
            }

            // 当缓冲区达到指定大小时处理数据
            if (this.inputBuffer.length >= this.bufferSize) {
                const chunk = this.inputBuffer.splice(0, this.bufferSize);
                
                // 计算当前音量
                const currentVolume = AudioUtils.calculateVolume(chunk);
                
                // 平滑音量值
                this.lastVolume = this.lastVolume * (1 - this.volumeSmoothingFactor) + 
                                 currentVolume * this.volumeSmoothingFactor;

                console.log(`ASRProcessor - Current Volume: ${currentVolume}, Smoothed Volume: ${this.lastVolume}`);
                // 音量阈值过滤
                if (this.lastVolume >= this.voiceThreshold) {
                    this.isSpeaking = true;
                    this.silenceCounter = 0;
                    
                    // 重采样到目标采样率
                    const resampledData = AudioUtils.resampleLinear(
                        chunk, 
                        this.inputSampleRate, 
                        this.outputSampleRate
                    );
                    
                    // 转换为16位PCM
                    const pcm16BitData = AudioUtils.floatTo16BitPCM(resampledData);
                    
                    // 发送音频数据到主线程
                    this.port.postMessage({
                        type: 'audioData',
                        data: pcm16BitData,
                        maxVol: Math.round(this.lastVolume),
                        frameCount: this.frameCount++
                    });
                    
                } else if (this.lastVolume < this.silenceThreshold) {
                    // 检测静音
                    this.silenceCounter++;
                    
                    if (this.isSpeaking && this.silenceCounter >= this.maxSilenceFrames) {
                        // 发送静音结束信号
                        this.port.postMessage({
                            type: 'silenceDetected',
                            duration: this.silenceCounter,
                            frameCount: this.frameCount
                        });
                        
                        this.isSpeaking = false;
                        this.silenceCounter = 0;
                    }
                }
            }
        }
        
        return true; // 继续处理
    }
}

// 注册处理器
registerProcessor('asr-processor', ASRProcessor); 
