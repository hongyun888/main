// 统一的音频处理工具函数模块
// 供主线程、AudioWorklet 和 ScriptProcessor 降级方案共享使用

export const AudioUtils = {
    // 线性重采样函数
    resampleLinear(data, inputRate, outputRate) {
        if (inputRate === outputRate) return data;
        const ratio = inputRate / outputRate;
        const outputLength = Math.floor(data.length / ratio);
        const result = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, data.length - 1);
            const fraction = srcIndex - srcIndexFloor;
            result[i] = data[srcIndexFloor] * (1 - fraction) + data[srcIndexCeil] * fraction;
        }
        return result;
    },
    
    // Float32 转 16位 PCM
    floatTo16BitPCM(float32Array) {
        const pcm16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16Array;
    },
    
    // 计算音量级别
    calculateVolume(data) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i] * data[i];
        }
        return Math.round(Math.sqrt(sum / data.length) * 100);
    },
    
    // 兼容旧版压缩函数（用于ScriptProcessor降级）
    compress(data, inputSampleRate, outputSampleRate) {
        if (inputSampleRate === outputSampleRate) {
            return data;
        }
        const compressionRatio = inputSampleRate / outputSampleRate;
        const outputLength = Math.floor(data.length / compressionRatio);
        const result = new Float32Array(outputLength);
        let outputIndex = 0;
        let inputBufferIndex = 0;
        while (outputIndex < outputLength) {
            result[outputIndex++] = data[Math.floor(inputBufferIndex)];
            inputBufferIndex += compressionRatio;
        }
        return result;
    }
};

// 为了支持 Worklet 中的 importScripts，也提供全局函数版本
if (typeof globalThis !== 'undefined') {
    globalThis.AudioUtils = AudioUtils;
    
    // 也提供独立函数，方便在 Worklet 中直接使用
    globalThis.resampleLinear = AudioUtils.resampleLinear;
    globalThis.floatTo16BitPCM = AudioUtils.floatTo16BitPCM;
    globalThis.calculateVolume = AudioUtils.calculateVolume;
    globalThis.compress = AudioUtils.compress;
}

// 如果在浏览器环境中，也挂载到 window
if (typeof window !== 'undefined') {
    window.AudioUtils = AudioUtils;
} 