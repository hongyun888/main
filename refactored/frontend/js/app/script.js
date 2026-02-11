// --- START OF FILE script.js ---
"use strict";

/* ===== 环境开关（防护总闸） ===== */
const __PROD__ = true;   // 调试时改 false
const DEBUG_SUBTITLE_LOG = true; // 字幕调试日志开关

/*================== Global Constants & Configuration ==================*/
const AGENT_APP_URL = 'https://hongchuanai.com/agent/chat/2af93eb45a0b4db9be4833da94650392';
const AUDIO_RECOGNITION_URL = "wss://www.hongchuanai.com/agent/speech/recognition";
const BAIREN_STREAMING_URL = "https://hongchuanai.com/agent/omni/dialogue"; // 多模态模型URL (Multimodal model URL for main chat)
const GET_INDEX_URL = "https://hongchuanai.com/agent/getIndexByAppId?appId=2af93eb45a0b4db9be4833da94650392" //获取当前应用对应的知识库Id
const CONTEXT_LIMIT_COUNT = 8;
const VOICE_IDLE_TIMEOUT_DURATION = 3 * 60 * 1000; // 🔥 修改：从8分钟缩短到3分钟
const KNOWLEDGE_BASE_PASSWORD = "135246"; // 知识库默认密码 (Default password for knowledge base)
const USE_COSYVOICE_TIMESTAMP_SUBTITLES = true; // 使用CosyVoice时间戳进行字幕同步
const SUBTITLE_SYNC_VERSION = 2; // 1 = 旧逻辑, 2 = 优化对齐逻辑
const SUBTITLE_LEAD_SEC = 0.12; // 字幕轻微提前量，抵消渲染/调度延迟
const SUBTITLE_TAIL_MAX_SEC = 4; // 尾段最小可读时长上限
const SUBTITLE_TAIL_MIN_BASE = 0.4; // 尾段最小时长基准
const SUBTITLE_TAIL_PER_CHAR = 0.035; // 尾段按字数补偿系数
const COSYVOICE_SOCKET_PATH = window.COSYVOICE_SOCKET_PATH || '/api-fl/socket.io';
const COSYVOICE_SOCKET_URL = window.COSYVOICE_SOCKET_URL || '';

window.INDEX_ID = null;

/* ===== 强制使用HTML渲染系统，彻底移除Canvas冲突 ===== */
let sessionId;
let manualVideoActive = false;
let manualVideoElement = null;
let manualVideoEndHandler = null;
let manualVideoPrevLoop = null;

/* ---------- 统一TTS状态管理 ---------- */
window.TTS_PLAYING = false;   // true = 正在播
window.TTS_PENDING = false;   // true = 正在请求/合成

/* ---------- CosyVoice TTS Client (Backend via Socket.IO) ---------- */
const CosyVoiceTTSClient = (() => {
    let socket = null;
    let audioCtx = null;
    let nextPlayTime = 0;
    let isPlaying = false;
    let bufferQueue = [];
    let bufferStartTime = null;
    let startPlayTime = 0;
    let totalDurationSec = 0;
    let lastProgress = 0;
    let lastRequestId = 0;
    let finishTimer = null;
    let playbackGapSec = 0;
    let hasTimedSegments = false;
    let audioChunkCount = 0;
    let timingScale = 1;
    let lastTimedRawEnd = 0;
    let lastCalibrationScale = 1;
    let lastSubtitleSyncAt = 0;
    let rawTimedSegments = [];
    const MIN_BUFFER_AHEAD = 0.05;
    const BUFFER_TIME_MS = 500;

    const ensureAudioContext = () => {
        if (!audioCtx || audioCtx.state === 'closed') {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        return audioCtx;
    };

    const resetPlayback = () => {
        bufferQueue = [];
        bufferStartTime = null;
        nextPlayTime = 0;
        startPlayTime = 0;
        totalDurationSec = 0;
        lastProgress = 0;
        timedSegments = [];
        sentenceWordCounts = new Map();
        sentenceSegmentsRaw = new Map();
        fallbackSentenceIndex = 0;
        timingScale = 1;
        lastTimedRawEnd = 0;
        lastCalibrationScale = 1;
        lastSubtitleSyncAt = 0;
        audioChunkCount = 0;
        rawTimedSegments = [];
        timestampScale = null;
        isPlaying = false;
        playbackGapSec = 0;
        hasTimedSegments = false;
        if (finishTimer) {
            clearTimeout(finishTimer);
            finishTimer = null;
        }
    };

    const getPlaybackTimeSec = () => {
        if (!audioCtx || !startPlayTime) return null;
        const raw = audioCtx.currentTime - startPlayTime - playbackGapSec;
        return Math.max(0, raw);
    };

    const scheduleAudioBuffer = (audioBuffer) => {
        const ctx = ensureAudioContext();
        const sourceNode = ctx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(ctx.destination);
        const now = ctx.currentTime;
        const scheduledTime = Math.max(now + MIN_BUFFER_AHEAD, nextPlayTime || now + MIN_BUFFER_AHEAD);
        if (nextPlayTime && scheduledTime > nextPlayTime + 0.005) {
            playbackGapSec += (scheduledTime - nextPlayTime);
        }
        if (!startPlayTime) {
            startPlayTime = scheduledTime;
        }
        sourceNode.start(scheduledTime);
        nextPlayTime = scheduledTime + audioBuffer.duration;
    };

    const startPlaybackIfReady = () => {
        if (isPlaying || bufferQueue.length === 0) return;
        const elapsed = bufferStartTime ? Date.now() - bufferStartTime : 0;
        if (elapsed < BUFFER_TIME_MS && bufferQueue.length < 2) return;
        bufferQueue.forEach(scheduleAudioBuffer);
        bufferQueue = [];
        isPlaying = true;
        window.TTS_PENDING = false;
        window.TTS_PLAYING = true;
        updateVideoByTTSState();
        if (typeof VoiceStateManager !== 'undefined') {
            VoiceStateManager.startTTS({
                durationSec: totalDurationSec || null,
                progressProvider: () => {
                    if (!audioCtx || !startPlayTime || !totalDurationSec) return null;
                    const current = getPlaybackTimeSec();
                    if (!Number.isFinite(current)) return null;
                    const raw = current / totalDurationSec;
                    if (Number.isFinite(raw)) {
                        lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, raw)));
                    }
                    return lastProgress;
                }
            });
            if (USE_COSYVOICE_TIMESTAMP_SUBTITLES && typeof SubtitleManager !== 'undefined' && timedSegments.length) {
                SubtitleManager.setTimedSegments(timedSegments, getPlaybackTimeSec);
            }
        }
    };

    const handleAudioChunk = (base64Audio, sampleRate) => {
        const ctx = ensureAudioContext();
        const pcmData = new Int16Array(Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0)).buffer);
        const frameCount = pcmData.length;
        if (!frameCount) return;
        const audioBuffer = ctx.createBuffer(1, frameCount, sampleRate || 24000);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = pcmData[i] / 32768.0;
        }
        totalDurationSec += audioBuffer.duration;
        bufferQueue.push(audioBuffer);
        audioChunkCount += 1;
        if (audioChunkCount % 12 === 0) {
            applyTimingCalibration('chunk');
        }
        if (!bufferStartTime) {
            bufferStartTime = Date.now();
        }
        if (isPlaying) {
            scheduleAudioBuffer(audioBuffer);
            bufferQueue.pop();
        } else {
            startPlaybackIfReady();
        }
    };

    const finalizePlayback = (onComplete, wasAborted) => {
        window.TTS_PLAYING = false;
        window.TTS_PENDING = false;
        updateVideoByTTSState();
        if (typeof VoiceStateManager !== 'undefined') {
            VoiceStateManager.stopTTS();
        }
        resetPlayback();
        if (typeof onComplete === 'function') {
            onComplete(wasAborted);
        }
    };

    const handleAudioComplete = (onComplete) => {
        applyTimingCalibration('complete');
        compressSubtitleTailToAudio();
        ensureTailReadable();
        if (!isPlaying && bufferQueue.length) {
            startPlaybackIfReady();
        }
        if (!audioCtx || !nextPlayTime) {
            finalizePlayback(onComplete, false);
            return;
        }
        const remainingMs = Math.max(0, (nextPlayTime - audioCtx.currentTime) * 1000);
        finishTimer = setTimeout(() => {
            finalizePlayback(onComplete, false);
        }, remainingMs + 80);
    };

    let timedSegments = [];
    let sentenceWordCounts = new Map();
    let sentenceSegmentsRaw = new Map();
    let fallbackSentenceIndex = 0;
    let timestampScale = null;
    let timestampScaleConfidence = 0;
    const updateTimestampScale = (guess) => {
        if (!guess || !Number.isFinite(guess)) return;
        if (!timestampScale) {
            timestampScale = guess;
            timestampScaleConfidence = 1;
            return;
        }
        if (timestampScale === guess) {
            timestampScaleConfidence = Math.min(3, timestampScaleConfidence + 1);
            return;
        }
        timestampScaleConfidence -= 1;
        if (timestampScaleConfidence <= 0) {
            timestampScale = guess;
            timestampScaleConfidence = 1;
        }
    };
    const extractWordText = (word) => {
        if (!word || typeof word !== 'object') return '';
        return String(
            word.text ??
            word.word ??
            word.value ??
            word.token ??
            word.w ??
            ''
        );
    };

    const inferTimeScale = (words) => {
        if (timestampScale) return timestampScale;
        const times = [];
        const durations = [];
        for (const word of words) {
            if (!word || typeof word !== 'object') continue;
            const startRaw = Number(
                word.start_time ??
                word.startTime ??
                word.begin_time ??
                word.beginTime ??
                word.start ??
                word.begin ??
                word.s
            );
            const endRaw = Number(
                word.end_time ??
                word.endTime ??
                word.finish_time ??
                word.finishTime ??
                word.end ??
                word.finish ??
                word.e
            );
            if (Number.isFinite(startRaw)) times.push(startRaw);
            if (Number.isFinite(endRaw)) times.push(endRaw);
            if (Number.isFinite(startRaw) && Number.isFinite(endRaw) && endRaw > startRaw) {
                durations.push(endRaw - startRaw);
            }
        }
        if (!times.length) {
            timestampScale = 1;
            return timestampScale;
        }
        const avgDuration = durations.length
            ? durations.reduce((sum, value) => sum + value, 0) / durations.length
            : null;
        if (Number.isFinite(avgDuration)) {
            if (avgDuration >= 20) {
                updateTimestampScale(0.001);
                return timestampScale;
            }
            if (avgDuration >= 2) {
                updateTimestampScale(0.01);
                return timestampScale;
            }
        }
        const max = Math.max(...times);
        let guess = 1;
        if (max > 5000) {
            guess = 0.001;
        } else if (max > 1000) {
            guess = 0.001;
        } else if (max > 100) {
            guess = 0.01;
        } else if (max > 10) {
            guess = 0.1;
        }
        updateTimestampScale(guess);
        return timestampScale;
    };

    const extractWordTiming = (word, scale) => {
        if (!word || typeof word !== 'object') return { startSec: null, endSec: null };
        const startRaw = Number(
            word.start_time ??
            word.startTime ??
            word.begin_time ??
            word.beginTime ??
            word.start ??
            word.begin ??
            word.s
        );
        const endRaw = Number(
            word.end_time ??
            word.endTime ??
            word.finish_time ??
            word.finishTime ??
            word.end ??
            word.finish ??
            word.e
        );
        const startSec = Number.isFinite(startRaw) ? startRaw * scale : null;
        const endSec = Number.isFinite(endRaw) ? endRaw * scale : null;
        return { startSec, endSec };
    };

    const needsSpace = (prevText, nextText) => {
        if (!prevText || !nextText) return false;
        const prevChar = prevText.slice(-1);
        const nextChar = nextText[0];
        if (/\s/.test(prevChar) || /\s/.test(nextChar)) return false;
        const isPrevDigit = /[0-9]/.test(prevChar);
        const isNextDigit = /[0-9]/.test(nextChar);
        const isPrevAsciiLetter = /[A-Za-z]/.test(prevChar);
        const isNextAsciiLetter = /[A-Za-z]/.test(nextChar);
        const isPrevCnNum = /[零〇一二三四五六七八九两十百千万亿]/.test(prevChar);
        const isNextCnNum = /[零〇一二三四五六七八九两十百千万亿]/.test(nextChar);
        if ((isPrevDigit || isPrevCnNum) && (isNextDigit || isNextCnNum)) return false;
        if (isPrevAsciiLetter && isNextAsciiLetter) return true;
        if (/[.,;:!?]/.test(prevChar)) return true;
        return false;
    };

    const buildTimedSegments = (words) => {
        const segments = [];
        const MAX_SEG_CHARS = 140;
        const MIN_SEG_CHARS = 55;
        const MAX_NUM_OVERFLOW = 22;
        let bufferText = '';
        let bufferStartSec = null;
        let bufferEndSec = null;
        const scale = inferTimeScale(words);
        const isNumericToken = (value) => /^[0-9]+$/.test(value) || /^[零〇一二三四五六七八九两十百千万亿]+$/.test(value);
        const isNumericSeparator = (value) => /^[-—–·•]$/.test(value);
        const isPhoneToken = (value) => isNumericToken(value) || isNumericSeparator(value);

        const pushSegment = () => {
            const trimmed = bufferText.trim();
            if (!trimmed) {
                bufferText = '';
                bufferStartSec = null;
                bufferEndSec = null;
                return;
            }
            const startSec = Number.isFinite(bufferStartSec)
                ? bufferStartSec
                : (Number.isFinite(bufferEndSec) ? bufferEndSec : 0);
            const endSec = Number.isFinite(bufferEndSec)
                ? bufferEndSec
                : (Number.isFinite(bufferStartSec) ? bufferStartSec : startSec);
            segments.push({
                text: trimmed,
                startSec,
                endSec: endSec >= startSec ? endSec : startSec
            });
            bufferText = '';
            bufferStartSec = null;
            bufferEndSec = null;
        };

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const wordText = extractWordText(word).trim();
            if (!wordText) continue;
            const { startSec, endSec } = extractWordTiming(word, scale);
            if (bufferStartSec === null && Number.isFinite(startSec)) {
                bufferStartSec = startSec;
            }
            if (Number.isFinite(endSec)) {
                bufferEndSec = endSec;
            }
            if (bufferText && needsSpace(bufferText, wordText)) {
                bufferText += ' ';
            }
            bufferText += wordText;

            const nextWordText = i + 1 < words.length ? extractWordText(words[i + 1]).trim() : '';
            const hasPunct = /[。！？!?；;，,.]/.test(wordText);
            if ((hasPunct && bufferText.length >= MIN_SEG_CHARS) || bufferText.length >= MAX_SEG_CHARS) {
                const lastChar = bufferText.slice(-1);
                const lastIsNum = /[0-9零〇一二三四五六七八九两十百千万亿]/.test(lastChar);
                const deferSplit = lastIsNum && (isPhoneToken(wordText) || isPhoneToken(nextWordText));
                if (deferSplit && bufferText.length < MAX_SEG_CHARS + MAX_NUM_OVERFLOW) {
                    continue;
                }
                pushSegment();
            }
        }
        pushSegment();
        return segments;
    };

    const rebuildTimedSegments = () => {
        const indices = Array.from(sentenceSegmentsRaw.keys()).sort((a, b) => a - b);
        const rebuilt = [];
        let lastEndSec = 0;
        for (const idx of indices) {
            const segs = sentenceSegmentsRaw.get(idx) || [];
            if (!segs.length) continue;
            const firstStart = segs[0]?.startSec;
            let offsetSec = 0;
            if (SUBTITLE_SYNC_VERSION >= 2 && Number.isFinite(firstStart)) {
                const gap = lastEndSec - firstStart;
                const isRelative = firstStart < 1.5 || gap > 2.0;
                if (isRelative && Number.isFinite(lastEndSec) && lastEndSec > 0) {
                    offsetSec = lastEndSec - firstStart;
                } else if (gap > 0 && gap < 0.2) {
                    offsetSec = gap;
                }
            } else if (Number.isFinite(firstStart) && firstStart < lastEndSec - 0.05) {
                offsetSec = lastEndSec;
            }
            for (const seg of segs) {
                let startSec = (Number.isFinite(seg.startSec) ? seg.startSec : lastEndSec) + offsetSec;
                let endSec = (Number.isFinite(seg.endSec) ? seg.endSec : startSec) + offsetSec;
                if (startSec < lastEndSec && startSec > lastEndSec - 0.2) {
                    startSec = lastEndSec;
                }
                if (endSec < lastEndSec + 0.01) {
                    endSec = lastEndSec + 0.01;
                }
                if (endSec < startSec) {
                    endSec = startSec + 0.01;
                }
                rebuilt.push({ text: seg.text, startSec, endSec });
                lastEndSec = endSec;
            }
        }
        const cleaned = fixSegmentPunctuation(rebuilt);
        lastTimedRawEnd = cleaned.length ? cleaned[cleaned.length - 1].endSec : lastEndSec;
        rawTimedSegments = cleaned;
        if (timingScale !== 1) {
            timedSegments = cleaned.map(seg => ({
                text: seg.text,
                startSec: Number.isFinite(seg.startSec) ? seg.startSec * timingScale : seg.startSec,
                endSec: seg.endSec * timingScale
            }));
        } else {
            timedSegments = cleaned;
        }
    };

    function fixSegmentPunctuation(segments) {
        if (!segments || segments.length < 2) return segments;
        const leadingPunctRe = /^[，。！？；：、,.!?;:~～]+/;
        for (let i = 1; i < segments.length; i++) {
            const current = segments[i];
            const prev = segments[i - 1];
            if (!current || !prev) continue;
            const lead = current.text.match(leadingPunctRe);
            if (lead && lead[0]) {
                prev.text = (prev.text + lead[0]).trim();
                current.text = current.text.slice(lead[0].length).trimStart();
            }
            if (!current.text) {
                segments.splice(i, 1);
                i -= 1;
                continue;
            }
            current.text = normalizeSubtitleText(current.text);
            prev.text = normalizeSubtitleText(prev.text);
        }
        return segments;
    }

    const applyTimingCalibration = (reason) => {
        if (!hasTimedSegments || !timedSegments.length) return;
        if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) return;
        if (!Number.isFinite(lastTimedRawEnd) || lastTimedRawEnd <= 0) return;
        const scaleByTotal = totalDurationSec / lastTimedRawEnd;
        let scaleByPlayback = null;
        const nowSec = getPlaybackTimeSec();
        if (Number.isFinite(nowSec) && nowSec > 3 && rawTimedSegments.length) {
            const idx = rawTimedSegments.findIndex(seg => nowSec <= (seg.endSec * timingScale));
            if (idx >= 0) {
                const rawEnd = rawTimedSegments[idx]?.endSec;
                if (Number.isFinite(rawEnd) && rawEnd > 0) {
                    scaleByPlayback = nowSec / rawEnd;
                }
            }
        }
        let targetScale = timingScale;
        let weight = 0.15;
        if (reason === 'chunk') {
            if (!Number.isFinite(scaleByPlayback)) return;
            if (nowSec < 6) return;
            const progress = Number.isFinite(totalDurationSec) && totalDurationSec > 0
                ? (nowSec / totalDurationSec)
                : 0;
            const lowerBound = progress > 0.6 ? 0.6 : 0.7;
            if (scaleByPlayback < lowerBound || scaleByPlayback > 1.25) return;
            targetScale = scaleByPlayback;
            if (progress > 0.6) {
                weight = 0.3;
            }
        } else {
            targetScale = scaleByTotal;
        }
        if (targetScale <= 0.5 || targetScale >= 1.8) return;
        const newScale = reason === 'complete'
            ? targetScale
            : (timingScale * (1 - weight)) + (targetScale * weight);
        if (Math.abs(newScale - lastCalibrationScale) < 0.01) return;
        timingScale = newScale;
        lastCalibrationScale = newScale;
        rebuildTimedSegments();
        if (typeof SubtitleManager !== 'undefined') {
            SubtitleManager.setTimedSegments(timedSegments, getPlaybackTimeSec);
        }
        const now = Date.now();
        if (now - lastSubtitleSyncAt > 1500) {
            console.log('🧭 TTS字幕校准(前端):', {
                reason,
                totalDurationSec: Number(totalDurationSec.toFixed(3)),
                lastEndSec: Number(lastTimedRawEnd.toFixed(3)),
                scaleByTotal: Number(scaleByTotal.toFixed(3)),
                scaleByPlayback: Number((scaleByPlayback ?? NaN).toFixed(3)),
                scale: Number(newScale.toFixed(3)),
                segments: timedSegments.length
            });
            lastSubtitleSyncAt = now;
        }
    };

    const compressSubtitleTailToAudio = () => {
        if (!hasTimedSegments || !timedSegments.length) return;
        if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) return;
        const lastEnd = timedSegments[timedSegments.length - 1]?.endSec;
        if (!Number.isFinite(lastEnd)) return;
        if (lastEnd <= totalDurationSec + 0.05) return;
        let firstTailIndex = timedSegments.findIndex(seg => seg.endSec > totalDurationSec);
        if (firstTailIndex === -1) return;
        if (firstTailIndex === 0) {
            firstTailIndex = 1;
        }
        const prevEnd = timedSegments[firstTailIndex - 1]?.endSec ?? 0;
        const denom = lastEnd - prevEnd;
        if (!Number.isFinite(denom) || denom <= 0) {
            return;
        }
        const scale = (totalDurationSec - prevEnd) / denom;
        if (!Number.isFinite(scale) || scale <= 0) {
            return;
        }
        for (let i = firstTailIndex; i < timedSegments.length; i++) {
            const rawEnd = timedSegments[i].endSec;
            const adjusted = prevEnd + (rawEnd - prevEnd) * scale;
            const minEnd = i === 0 ? 0 : (timedSegments[i - 1].endSec + 0.01);
            timedSegments[i].endSec = Math.max(adjusted, minEnd);
            if (Number.isFinite(timedSegments[i].startSec)) {
                const rawStart = timedSegments[i].startSec;
                const adjustedStart = prevEnd + (rawStart - prevEnd) * scale;
                timedSegments[i].startSec = Math.min(timedSegments[i].endSec - 0.01, Math.max(adjustedStart, prevEnd));
            }
        }
        timedSegments[timedSegments.length - 1].endSec = Math.max(
            totalDurationSec,
            timedSegments[timedSegments.length - 2]?.endSec ? timedSegments[timedSegments.length - 2].endSec + 0.01 : 0
        );
        if (Number.isFinite(timedSegments[timedSegments.length - 1].startSec)) {
            timedSegments[timedSegments.length - 1].startSec = Math.min(
                timedSegments[timedSegments.length - 1].endSec - 0.01,
                timedSegments[timedSegments.length - 1].startSec
            );
        }
        if (typeof SubtitleManager !== 'undefined') {
            SubtitleManager.setTimedSegments(timedSegments, getPlaybackTimeSec);
        }
        console.log('🧭 TTS字幕尾段压缩(前端):', {
            totalDurationSec: Number(totalDurationSec.toFixed(3)),
            lastEndSec: Number(lastEnd.toFixed(3)),
            fromIndex: firstTailIndex,
            scale: Number(scale.toFixed(3)),
            segments: timedSegments.length
        });
    };

    const ensureTailReadable = () => {
        if (!hasTimedSegments || timedSegments.length < 2) return;
        if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) return;
        const lastIdx = timedSegments.length - 1;
        const lastText = timedSegments[lastIdx]?.text || '';
        const minDur = Math.min(
            SUBTITLE_TAIL_MAX_SEC,
            Math.max(0.9, lastText.length * SUBTITLE_TAIL_PER_CHAR + SUBTITLE_TAIL_MIN_BASE)
        );
        const prevEnd = timedSegments[lastIdx - 1]?.endSec ?? 0;
        const lastDur = totalDurationSec - prevEnd;
        if (lastDur >= minDur) return;
        if (minDur - lastDur < 0.25) return;
        let targetPrevEnd = totalDurationSec - minDur;
        const prevPrevEnd = timedSegments[lastIdx - 2]?.endSec ?? 0;
        if (targetPrevEnd <= prevPrevEnd + 0.01) {
            targetPrevEnd = prevPrevEnd + 0.01;
        }
        timedSegments[lastIdx - 1].endSec = targetPrevEnd;
        timedSegments[lastIdx].endSec = Math.max(totalDurationSec, targetPrevEnd + 0.01);
        if (typeof SubtitleManager !== 'undefined') {
            SubtitleManager.setTimedSegments(timedSegments, getPlaybackTimeSec);
        }
        console.log('🧭 TTS字幕尾段补偿(前端):', {
            totalDurationSec: Number(totalDurationSec.toFixed(3)),
            minLastDur: Number(minDur.toFixed(3)),
            lastDur: Number(lastDur.toFixed(3)),
            segments: timedSegments.length
        });
    };

    const handleTimestamps = (payload) => {
        if (!USE_COSYVOICE_TIMESTAMP_SUBTITLES) return;
        const words = Array.isArray(payload?.words) ? payload.words : [];
        if (!words.length) return;
        hasTimedSegments = true;

        const sentenceIndexRaw = payload?.sentenceIndex ?? payload?.sentence_index;
        const sentenceIndex = Number.isFinite(sentenceIndexRaw) ? sentenceIndexRaw : (fallbackSentenceIndex++);
        const prevCount = sentenceWordCounts.get(sentenceIndex) || 0;
        if (words.length <= prevCount) return;
        sentenceWordCounts.set(sentenceIndex, words.length);

        const newSegments = buildTimedSegments(words);
        if (!newSegments.length) return;
        sentenceSegmentsRaw.set(sentenceIndex, fixSegmentPunctuation(newSegments));
        rebuildTimedSegments();

        if (typeof SubtitleManager !== 'undefined') {
            SubtitleManager.setTimedSegments(timedSegments, getPlaybackTimeSec);
        }
    };

    const ensureSocket = () => {
        if (socket) return socket;
        if (typeof window.io !== 'function') {
            console.warn('Socket.IO client not available for CosyVoice TTS');
            return null;
        }
        const socketOptions = {
            path: COSYVOICE_SOCKET_PATH,
            transports: ['websocket'],
            reconnection: true
        };
        socket = COSYVOICE_SOCKET_URL
            ? window.io(COSYVOICE_SOCKET_URL, socketOptions)
            : window.io(socketOptions);
        console.log('✅ CosyVoice Socket.IO 已连接配置:', {
            url: COSYVOICE_SOCKET_URL || window.location.origin,
            path: COSYVOICE_SOCKET_PATH
        });
        socket.on('tts_config', (payload) => {
            if (payload && payload.requestId !== lastRequestId) return;
            const voice = payload?.voice || 'unknown';
            const rate = Number.isFinite(payload?.rate) ? payload.rate : null;
            console.log('🎙️ 当前TTS音色配置:', { voice, rate });
        });
        socket.on('audio_chunk', (payload) => {
            if (!payload || payload.requestId !== lastRequestId) return;
            handleAudioChunk(payload.audioData, payload.sampleRate);
        });
        socket.on('subtitle_timestamps', (payload) => {
            if (!payload || payload.requestId !== lastRequestId) return;
            handleTimestamps(payload);
        });
        socket.on('tts_error', (payload) => {
            if (payload && payload.requestId !== lastRequestId) return;
            console.warn('CosyVoice TTS error:', payload?.message || payload);
            finalizePlayback(null, true);
        });
        return socket;
    };

    const speak = (text, onComplete) => {
        const ws = ensureSocket();
        if (!ws) {
            if (typeof onComplete === 'function') onComplete(true);
            return;
        }
        lastRequestId += 1;
        resetPlayback();
        window.TTS_PENDING = true;
        window.TTS_PLAYING = false;
        updateVideoByTTSState();
        ws.emit('tts_request', {
            requestId: lastRequestId,
            text
        });
        const onCompleteHandler = (payload) => {
            if (!payload || payload.requestId !== lastRequestId) return;
            ws.off('audio_complete', onCompleteHandler);
            handleAudioComplete(onComplete);
        };
        const onErrorHandler = (payload) => {
            if (payload && payload.requestId !== lastRequestId) return;
            ws.off('tts_error', onErrorHandler);
            finalizePlayback(onComplete, true);
        };
        ws.on('audio_complete', onCompleteHandler);
        ws.on('tts_error', onErrorHandler);
    };

    const abort = () => {
        if (socket) {
            socket.emit('tts_abort');
        }
        finalizePlayback(null, true);
    };

    return { speak, abort, handleTimestamps };
})();

// 废弃旧API，强制报错
window.switchVideo = undefined;
window.callSwitchVideo = undefined;

/* ---------- 唯一 VideoStateManager ---------- */
const VIDEO_IDLE = 'assets/videos/video3.mp4';
const VIDEO_TALK = 'assets/videos/video2.mp4';
const FADE_MS = 15; // 超快15ms切换，确保无缝体验

const normalizeSpeechText = (input) => {
    let text = String(input || '');
    if (!text) return '';
    text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
    text = text.replace(/```([\s\S]*?)```/g, '$1');
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    text = text.replace(/^\s{0,3}>\s?/gm, '');
    text = text.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '');
    text = text.replace(/^\s{0,3}([-*_]){3,}\s*$/gm, '');
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/\*([^*]+)\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/_([^_]+)_/g, '$1');
    text = text.replace(/~~([^~]+)~~/g, '$1');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/:[a-zA-Z0-9_+-]+:/g, '');
    text = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, '');
    text = text.replace(/[ \t]{2,}/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
};

const CN_NUM_MAP = {
    '零': '0', '〇': '0',
    '一': '1', '幺': '1', '二': '2', '两': '2', '三': '3', '四': '4',
    '五': '5', '六': '6', '七': '7', '八': '8', '九': '9'
};
const CN_UNIT_MAP = { '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000 };

const convertChineseNumberToArabic = (segment) => {
    if (!segment) return segment;
    let total = 0;
    let section = 0;
    let number = 0;
    for (const ch of segment) {
        if (CN_NUM_MAP[ch] !== undefined) {
            number = Number(CN_NUM_MAP[ch]);
            continue;
        }
        const unit = CN_UNIT_MAP[ch];
        if (!unit) continue;
        if (unit === 10000 || unit === 100000000) {
            section = (section + number) * unit;
            total += section;
            section = 0;
            number = 0;
            continue;
        }
        section += (number || 1) * unit;
        number = 0;
    }
    return String(total + section + number);
};

const normalizePhoneSequence = (raw, mode) => {
    if (!raw) return raw;
    const cleaned = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const stripped = cleaned.replace(/[\\s、，·•-]/g, '');
    if (!/^[0-9零〇一二三四五六七八九两幺十百千万亿]+$/.test(stripped)) {
        return raw;
    }
    let digits;
    if (/[十百千万亿]/.test(stripped)) {
        digits = convertChineseNumberToArabic(stripped);
    } else {
        digits = stripped.split('').map(ch => CN_NUM_MAP[ch] ?? ch).join('');
    }
    if (!/^[0-9]{5,}$/.test(digits)) {
        return raw;
    }
    if (mode === 'tts') {
        return digits.split('').join(' ');
    }
    if (digits.length === 11 && digits[0] === '1') {
        return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
    }
    if (digits.startsWith('0') && digits.length >= 10) {
        const areaLen = digits.length === 10 ? 3 : 4;
        return `${digits.slice(0, areaLen)}-${digits.slice(areaLen)}`;
    }
    return digits;
};

const PHONE_CONTEXT_RE = /(电话|热线|服务热线|热线电话|维权|拨打|联系|咨询|号码|手机号|手机|座机|传真|tel|TEL|公众号|微信)/i;
const PHONE_SEQ_RE = /([0-9零〇一二三四五六七八九两幺十百千万亿][0-9零〇一二三四五六七八九两幺十百千万亿\\s、，·•-]{3,}[0-9零〇一二三四五六七八九两幺十百千万亿])/g;

const normalizePhoneSequences = (text, mode) => {
    if (!text) return text;
    return text.replace(PHONE_SEQ_RE, (match, _p1, offset, full) => {
        const start = Math.max(0, offset - 24);
        const end = Math.min(full.length, offset + match.length + 24);
        const window = full.slice(start, end);
        if (!PHONE_CONTEXT_RE.test(window)) return match;
        return normalizePhoneSequence(match, mode);
    });
};

const normalizeSubtitleText = (input) => {
    let text = normalizeSpeechText(input);
    if (!text) return '';
    text = text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    text = text.replace(/[－—–]/g, '-');
    text = text.replace(/[~～]{2,}/g, '～');
    text = text.replace(/^[~～]+/, '');
    text = text.replace(/[·•]{2,}/g, '·');
    text = text.replace(/-{2,}/g, '-');
    text = text.replace(/\s*([，。！？；：、,.!?;:])\s*/g, '$1');
    text = text.replace(/[，。！？；：、,.!?;:]{2,}/g, (match) => {
        if (/[？?]/.test(match)) return '？';
        if (/[！!]/.test(match)) return '！';
        if (/[。\.]/.test(match)) return '。';
        if (/[；;]/.test(match)) return '；';
        if (/[：:]/.test(match)) return '：';
        if (/[、]/.test(match)) return '、';
        return '，';
    });
    text = text.replace(/([，；：、])([。！？])/g, '$2');
    text = text.replace(/[，,]{2,}/g, '，');
    text = text.replace(/[。\.]{2,}/g, '。');
    text = text.replace(/[！!]{2,}/g, '！');
    text = text.replace(/[？?]{2,}/g, '？');
    text = text.replace(/[；;]{2,}/g, '；');
    text = text.replace(/[：:]{2,}/g, '：');
    text = text.replace(/[、]{2,}/g, '、');
    text = text.replace(/\s{2,}/g, ' ');
    const toArabic = (segment) => {
        if (!segment) return segment;
        const hasUnit = /[十百千万亿]/.test(segment);
        if (!hasUnit) {
            return segment.split('').map(ch => CN_NUM_MAP[ch] ?? ch).join('');
        }
        return convertChineseNumberToArabic(segment);
    };
    text = text.replace(/([零〇一二三四五六七八九两幺十百千万亿])[\s·•]+(?=[零〇一二三四五六七八九两幺十百千万亿])/g, '$1');
    text = text.replace(/[零〇一二三四五六七八九两幺十百千万亿]+/g, (match) => toArabic(match));
    text = text.replace(/([零〇一二三四五六七八九两幺])(\d)/g, (_, a, b) => (CN_NUM_MAP[a] ?? a) + b);
    text = text.replace(/(\d)([零〇一二三四五六七八九两幺])/g, (_, a, b) => a + (CN_NUM_MAP[b] ?? b));
    text = text.replace(/(\d)[\s·•]+(?=\d)/g, '$1');
    text = text.replace(/(\d)\s*-\s*(\d)/g, '$1-$2');
    text = normalizePhoneSequences(text, 'display');
    return text.trim();
};

const normalizeTtsText = (input) => {
    let text = normalizeSpeechText(input);
    if (!text) return '';
    text = normalizePhoneSequences(text, 'tts');
    return text.trim();
};



function clearManualVideoOverride() {
    if (manualVideoElement && manualVideoEndHandler) {
        manualVideoElement.removeEventListener('ended', manualVideoEndHandler);
    }
    if (manualVideoElement && typeof manualVideoPrevLoop === 'boolean') {
        manualVideoElement.loop = manualVideoPrevLoop;
    }
    if (manualVideoElement) {
        manualVideoElement.muted = true;
    }
    manualVideoActive = false;
    manualVideoElement = null;
    manualVideoEndHandler = null;
    manualVideoPrevLoop = null;
}

// 统一状态更新函数
function updateVideoByTTSState() {
    if (manualVideoActive && !window.TTS_PLAYING && !window.TTS_PENDING) {
        return;
    }
    if (manualVideoActive && (window.TTS_PLAYING || window.TTS_PENDING)) {
        clearManualVideoOverride();
    }
    const target = window.TTS_PLAYING ? VIDEO_TALK : VIDEO_IDLE;
    VideoStateManager.crossfade(target);
}

const playManualVideo = async (index) => {
    if (window.TTS_PLAYING || window.TTS_PENDING) {
        console.log('交互视频播放中，忽略手动视频切换');
        return;
    }
    const manualSrc = `assets/resource/${index}.mp4`;
    clearManualVideoOverride();
    const targetVideo = await VideoStateManager.crossfade(manualSrc);
    if (!targetVideo) {
        console.warn('手动视频切换失败，保持当前视频');
        return;
    }
    manualVideoActive = true;
    manualVideoElement = targetVideo;
    manualVideoPrevLoop = targetVideo.loop;
    targetVideo.loop = false;
    targetVideo.currentTime = 0;
    targetVideo.muted = false;
    targetVideo.volume = 1;
    targetVideo.play().catch(() => { });
    manualVideoEndHandler = () => {
        clearManualVideoOverride();
        updateVideoByTTSState();
    };
    targetVideo.addEventListener('ended', manualVideoEndHandler, { once: true });
};

const getIndexByAppId = () => { return fetch(`${GET_INDEX_URL}&AppCode=${appCode}`, 
    {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        }
    }).then(async resp => {
        if (!resp.ok) {
            throw new Error(`查询知识库Id失败: ${resp.status} ${resp.statusText}`);
        }
        return resp.json();
    })
}

getIndexByAppId()
    .then((res) => {
        window.INDEX_ID = res?.data || null;
    })
    .catch((error) => {
        window.INDEX_ID = null;
        console.warn('获取知识库Id失败，继续使用默认检索链路:', error?.message || error);
    });

const VideoStateManager = (() => {
    // 视频缓存池管理
    const videoPool = [
        document.getElementById('bgVideoA'),
        document.getElementById('bgVideoB'),
        document.getElementById('bgVideoC'),
        document.getElementById('bgVideoD')
    ];

    let currentSrc = VIDEO_IDLE;
    let activeVideoIndex = 0;
    let preloadedVideos = new Map(); // src -> videoElement
    let performanceMetrics = {
        frameDrops: 0,
        lastFrameTime: 0,
        avgFPS: 60
    };

    // 黑帧检测参数
    const BLACK_FRAME_THRESHOLD = 25; // RGB平均值阈值
    const LOOP_PREPARE_TIME = 0.2; // 提前0.2秒准备循环
    const BLACK_FRAME_SKIP = 0.033; // 跳过一帧的时间

    // Canvas复用机制，避免重复创建
    const sharedCanvas = document.createElement('canvas');
    sharedCanvas.width = 32;
    sharedCanvas.height = 32;
    const sharedCanvasCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });

    // 性能监控
    let performanceMonitor = null;

    // 深度预加载系统
    const deepPreload = async (videoElement, src) => {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                videoElement.removeEventListener('canplaythrough', onReady);
                videoElement.removeEventListener('error', onError);
            };

            const onReady = () => {
                cleanup();
                // 预渲染首帧到内存
                prerenderFrame(videoElement);
                resolve(videoElement);
            };

            const onError = (e) => {
                cleanup();
                reject(e);
            };

            videoElement.addEventListener('canplaythrough', onReady, { once: true });
            videoElement.addEventListener('error', onError, { once: true });

            const sourceEl = videoElement.querySelector('source');
            if (sourceEl) {
                sourceEl.src = src;
                videoElement.load();
            }
        });
    };

    // 预渲染帧到内存
    const prerenderFrame = (videoElement) => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 36;
            const ctx = canvas.getContext('2d');
            if (ctx && videoElement.videoWidth > 0) {
                ctx.drawImage(videoElement, 0, 0, 64, 36);
                videoElement._prerenderData = canvas.toDataURL();
            }
        } catch (e) {
            console.warn('预渲染失败:', e);
        }
    };

    // 高性能黑帧检测（降采样 + 智能算法优化）
    const detectBlackFrame = (videoElement) => {
        try {
            // 检查视频是否可能存在跨域问题
            if (!videoElement.crossOrigin && videoElement.src && !videoElement.src.startsWith(window.location.origin)) {
                console.warn('⚠️ 视频源可能存在跨域问题，跳过黑帧检测:', videoElement.src);
                return false;
            }

            // 使用复用的Canvas，避免重复创建
            if (!sharedCanvasCtx || videoElement.videoWidth === 0) return false;

            // 优化：使用更小的Canvas尺寸，大幅提升性能
            const SAMPLE_WIDTH = 16;   // 从32x32降到16x16，计算量减少75%
            const SAMPLE_HEIGHT = 16;

            // 调整Canvas尺寸（如果需要）
            if (sharedCanvas.width !== SAMPLE_WIDTH || sharedCanvas.height !== SAMPLE_HEIGHT) {
                sharedCanvas.width = SAMPLE_WIDTH;
                sharedCanvas.height = SAMPLE_HEIGHT;
            }

            // 清空Canvas内容（重要：避免残留）
            sharedCanvasCtx.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

            // 禁用图像平滑，提升绘制性能
            sharedCanvasCtx.imageSmoothingEnabled = false;
            sharedCanvasCtx.drawImage(videoElement, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

            // 检测 Canvas 是否被污染（跨域问题）
            try {
                const imageData = sharedCanvasCtx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
                const data = imageData.data;

                let totalBrightness = 0;
                let brightPixels = 0;
                let sampleCount = 0;

                // 稀疏采样：只检测每隔一行的像素，进一步减少50%计算量
                const SKIP_STEP = 2;
                for (let y = 0; y < SAMPLE_HEIGHT; y += SKIP_STEP) {
                    for (let x = 0; x < SAMPLE_WIDTH; x += SKIP_STEP) {
                        const i = (y * SAMPLE_WIDTH + x) * 4;
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];

                        // 使用快速亮度计算（Luminance公式的简化版）
                        // 避免除法，使用位运算提升性能
                        const brightness = (r + g + b) >> 2; // 等价于 / 4，但更快

                        totalBrightness += brightness;
                        if (brightness > BLACK_FRAME_THRESHOLD) {
                            brightPixels++;
                        }
                        sampleCount++;
                    }
                }

                const avgBrightness = totalBrightness / sampleCount;
                const brightRatio = brightPixels / sampleCount;

                // 如果平均亮度太低且亮像素比例太少，认为是黑帧
                return avgBrightness < BLACK_FRAME_THRESHOLD && brightRatio < 0.1;

            } catch (securityError) {
                if (securityError.name === 'SecurityError') {
                    console.warn('⚠️ Canvas 被污染（跨域安全限制），跳过黑帧检测');
                    return false;
                }
                throw securityError; // 重新抛出非安全相关的错误
            }
        } catch (e) {
            console.warn('⚠️ 黑帧检测失败:', e);
            return false;
        }
    };

    // 智能跳过黑帧
    const skipBlackFrames = (videoElement) => {
        if (detectBlackFrame(videoElement)) {
            const newTime = Math.min(videoElement.duration - 0.1, videoElement.currentTime + BLACK_FRAME_SKIP);
            videoElement.currentTime = newTime;
            console.log(`跳过黑帧: ${videoElement.currentTime.toFixed(3)}s`);
            return true;
        }
        return false;
    };

    // 确保视频播放（带黑帧检测和自动恢复）
    const ensurePlaying = async (videoElement) => {
        if (!videoElement) return;

        try {
            if (videoElement.readyState >= 3) {
                // 检测并跳过黑帧
                if (skipBlackFrames(videoElement)) {
                    // 跳过后再次检查
                    await new Promise(resolve => setTimeout(resolve, 16)); // 等一帧
                    skipBlackFrames(videoElement);
                }

                // 强制播放，忽略浏览器限制
                if (videoElement.paused) {
                    await videoElement.play();
                }
            } else {
                const onCanPlay = async () => {
                    skipBlackFrames(videoElement);
                    if (videoElement.paused) {
                        await videoElement.play();
                    }
                };
                videoElement.addEventListener('canplay', onCanPlay, { once: true });
            }
        } catch (e) {
            console.warn('视频播放失败:', e);
            // 添加重试机制
            setTimeout(() => {
                if (videoElement.paused && videoElement.classList.contains('active')) {
                    console.log('🔄 尝试恢复暂停的视频');
                    videoElement.play().catch(() => { });
                }
            }, 1000);
        }
    };

    // 设置循环监控
    const setupLoopMonitoring = (videoElement) => {
        const onTimeUpdate = () => {
            if (videoElement.duration && videoElement.currentTime > videoElement.duration - LOOP_PREPARE_TIME) {
                // 提前准备循环重置
                prepareLoop(videoElement);
            }
        };

        videoElement.addEventListener('timeupdate', onTimeUpdate);
        return () => videoElement.removeEventListener('timeupdate', onTimeUpdate);
    };

    // 准备无缝循环
    const prepareLoop = (videoElement) => {
        // 找一个备用video开始预加载同样的内容
        const backupVideo = videoPool.find(v => v !== videoElement && !v.classList.contains('active'));
        if (backupVideo) {
            const currentSrc = videoElement.querySelector('source')?.src;
            if (currentSrc) {
                deepPreload(backupVideo, currentSrc).then(() => {
                    backupVideo.currentTime = 0.05; // 跳过可能的黑帧
                    backupVideo.classList.add('preparing');
                });
            }
        }
    };

    // 性能监控
    const startPerformanceMonitoring = () => {
        let frameCount = 0;
        let lastTime = performance.now();
        let reportInterval = 0;

        const monitor = () => {
            const now = performance.now();
            frameCount++;

            if (now - lastTime >= 1000) {
                const fps = (frameCount * 1000) / (now - lastTime);
                performanceMetrics.avgFPS = fps;

                if (fps < 50) {
                    performanceMetrics.frameDrops++;
                    console.warn(`⚠️ 性能警告: FPS降至${fps.toFixed(1)}`);
                }

                // 每10秒输出一次性能报告
                reportInterval++;
                if (reportInterval >= 10) {
                    console.log(`📊 视频系统性能报告:
           - 平均FPS: ${fps.toFixed(1)}
           - 掉帧次数: ${performanceMetrics.frameDrops}
           - 当前活跃视频: ${currentSrc}
           - 缓存池状态: ${videoPool.filter(v => v.readyState >= 3).length}/4 ready`);
                    reportInterval = 0;
                }

                frameCount = 0;
                lastTime = now;
            }

            performanceMonitor = requestAnimationFrame(monitor);
        };

        monitor();
    };

    // 获取最佳可用视频元素
    const getBestAvailableVideo = (targetSrc) => {
        // 优先返回已经预加载了目标源的视频
        for (let video of videoPool) {
            const currentSrc = video.querySelector('source')?.src || '';
            if (currentSrc.includes(targetSrc) && video.readyState >= 3) {
                return video;
            }
        }

        // 其次返回非激活状态的视频
        return videoPool.find(v => !v.classList.contains('active')) || videoPool[1];
    };

    // 超高速crossfade实现
    const crossfade = async (toSrc) => {
        if (toSrc === currentSrc) {
            // 即使是相同源，也要确保当前视频在播放
            const activeVideo = videoPool[activeVideoIndex];
            ensurePlaying(activeVideo);
            return activeVideo;
        }

        const activeVideo = videoPool[activeVideoIndex];
        const targetVideo = getBestAvailableVideo(toSrc);
        const isManualVideo = toSrc.includes('assets/resource/');
        // 交互视频保持静音，手动观影视频开启声音
        targetVideo.muted = !isManualVideo;
        if (isManualVideo) {
            targetVideo.volume = 1;
        }

        // 深度预加载目标视频
        try {
            await deepPreload(targetVideo, toSrc);

            // 跳过黑帧
            targetVideo.currentTime = toSrc.includes('video2') ? 0.08 : 0.05;

            // 确保两个视频都在播放
            await ensurePlaying(targetVideo);
            await ensurePlaying(activeVideo);

            // 设置循环监控
            const cleanupLoop = setupLoopMonitoring(targetVideo);

            // 超快速crossfade动画
            const startTime = performance.now();
            const FADE_DURATION = 15; // 15ms超快切换

            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(1, elapsed / FADE_DURATION);

                // 使用优化的缓动函数
                const easeProgress = progress * progress * (3 - 2 * progress);

                targetVideo.style.opacity = easeProgress;
                activeVideo.style.opacity = 1 - easeProgress;

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    // 切换完成
                    targetVideo.classList.add('active');
                    activeVideo.classList.remove('active');
                    activeVideo.classList.add('fadeOut');

                    setTimeout(() => {
                        activeVideo.pause();
                        activeVideo.classList.remove('fadeOut');
                        activeVideo.style.opacity = '0';
                    }, 50);

                    // 更新索引
                    activeVideoIndex = videoPool.indexOf(targetVideo);
                    currentSrc = toSrc;

                    console.log(`视频切换完成: ${toSrc} (${FADE_DURATION}ms)`);
                }
            };

            requestAnimationFrame(animate);

            return targetVideo;
        } catch (error) {
            console.error('视频切换失败:', error);
            // 降级处理
            ensurePlaying(activeVideo);
            return activeVideo;
        }
    };

    // 自动恢复暂停视频的监控器
    const startAutoPauseRecovery = () => {
        const checkInterval = setInterval(() => {
            const activeVideo = videoPool[activeVideoIndex];

            if (activeVideo && activeVideo.classList.contains('active')) {
                // 检查活跃视频是否意外暂停
                if (activeVideo.paused && activeVideo.readyState >= 3) {
                    console.warn('🚨 检测到活跃视频被暂停，正在自动恢复...');
                    ensurePlaying(activeVideo);
                }

                // 检查视频是否卡住（currentTime不变）
                const currentTime = activeVideo.currentTime;
                if (activeVideo._lastCheckTime === currentTime && !activeVideo.paused && currentTime > 0) {
                    console.warn('🚨 检测到视频卡住，正在重启播放...');
                    activeVideo.currentTime = Math.min(activeVideo.duration - 0.1, currentTime + 0.1);
                    ensurePlaying(activeVideo);
                }
                activeVideo._lastCheckTime = currentTime;
            }
        }, 2000); // 每2秒检查一次

        return () => clearInterval(checkInterval);
    };

    // 初始化系统
    const initialize = () => {
        // 启动性能监控
        if (!__PROD__)  {
            startPerformanceMonitoring();
        }
        // 启动自动恢复监控
        const stopRecovery = startAutoPauseRecovery();
        cleanupFunctions.push(stopRecovery);

        // 预加载常用视频
        deepPreload(videoPool[0], VIDEO_IDLE);
        deepPreload(videoPool[2], VIDEO_TALK);

        // 设置初始状态
        videoPool[0].classList.add('active');
        ensurePlaying(videoPool[0]);

        // 为所有视频添加意外暂停事件监听和错误处理
        videoPool.forEach(video => {
            // 意外暂停恢复
            video.addEventListener('pause', (e) => {
                if (video.classList.contains('active') && !video._intentionalPause) {
                    console.warn('⚠️ 活跃视频意外暂停，1秒后自动恢复');
                    setTimeout(() => {
                        if (video.classList.contains('active') && video.paused) {
                            ensurePlaying(video);
                        }
                    }, 1000);
                }
            });

            // 视频错误处理
            video.addEventListener('error', (e) => {
                console.error('❌ 视频播放错误:', e);
                if (video.classList.contains('active')) {
                    console.log('🔄 尝试重新加载错误的视频');
                    setTimeout(() => {
                        video.load();
                        setTimeout(() => ensurePlaying(video), 500);
                    }, 1000);
                }
            });

            // 视频停滞检测
            video.addEventListener('stalled', (e) => {
                console.warn('⚠️ 视频加载停滞');
                if (video.classList.contains('active')) {
                    setTimeout(() => {
                        if (video.readyState < 3) {
                            video.load();
                        }
                    }, 2000);
                }
            });

            // 视频等待数据
            video.addEventListener('waiting', (e) => {
                if (video.classList.contains('active')) {
                    console.log('⏳ 视频等待数据，尝试恢复播放');
                    setTimeout(() => {
                        if (video.paused && video.readyState >= 2) {
                            ensurePlaying(video);
                        }
                    }, 500);
                }
            });

            // 标记有意的暂停操作
            const originalPause = video.pause;
            video.pause = function () {
                this._intentionalPause = true;
                originalPause.call(this);
                setTimeout(() => { this._intentionalPause = false; }, 100);
            };
        });

        console.log('高级视频管理系统已初始化（含自动恢复功能）');
    };

    // 存储清理函数
    let cleanupFunctions = [];

    // 清理资源
    const cleanup = () => {
        if (performanceMonitor) {
            cancelAnimationFrame(performanceMonitor);
            performanceMonitor = null;
        }

        // 清理Canvas资源
        if (sharedCanvasCtx) {
            try {
                sharedCanvasCtx.clearRect(0, 0, sharedCanvas.width, sharedCanvas.height);
            } catch (e) {
                console.warn('清理Canvas失败:', e);
            }
        }

        // 执行所有清理函数
        cleanupFunctions.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.warn('清理函数执行失败:', e);
            }
        });
        cleanupFunctions = [];

        // 清理视频池中的资源
        videoPool.forEach(video => {
            try {
                if (video.src && video.src.startsWith('blob:')) {
                    URL.revokeObjectURL(video.src);
                }
                video.removeAttribute('src');
                video.load();
            } catch (e) {
                console.warn('清理视频资源失败:', e);
            }
        });
    };

    return {
        crossfade,
        initialize,
        cleanup,
        getPerformanceMetrics: () => performanceMetrics
    };
})();

if (typeof window !== 'undefined') {
    window.VideoStateManager = VideoStateManager;
}

const voiceWaveConfig = { /* ... (保持不变) ... */
    baseAmplitude: 15,              // 🔥 调整：降低基础振幅，提高敏感度
    silenceThreshold: 0.02,         // 🔥 调整：降低静音阈值，提高低音响应
    amplitudeMultiplier: 120,       // 🔥 调整：提高倍数，增强音量响应
    lineWidth: 3,
    lineCap: "round",
    gradientColor1: "#4a90e2",
    gradientColor2: "#50c0e9",
    shadowColor: "rgba(0, 0, 0, 0.3)",
    shadowBlur: 8,
    fftSize: 1024,                  // 🔥 调整：降低FFT大小，提高实时性
    smoothingTimeConstant: 0.3,     // 🔥 新增：音频数据平滑常数
    minDecibels: -90,               // 🔥 新增：最小分贝值
    maxDecibels: -10,               // 🔥 新增：最大分贝值
    frequencyWeights: {             // 🔥 新增：频率加权配置
        lowFreq: { start: 0, end: 0.2, weight: 1.5 },      // 低频加权
        midFreq: { start: 0.2, end: 0.6, weight: 1.0 },    // 中频加权  
        highFreq: { start: 0.6, end: 1.0, weight: 0.7 }    // 高频降权
    }
};
const knowledgeBaseConfig = { /* ... (保持不变) ... */
    fileItemThumbSize: 24,
    acceptedFileTypes: [
        '.jpe', '.jpeg', '.jpg', '.jfif', '.png', '.apng', '.webp', '.bmp', '.dib', '.gif', '.svg', '.ico',
        '.wav', '.mp3', '.aac', '.ogg', '.oga', '.flac', '.m4a', '.opus',
        '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv',
        '.pdf',
        '.doc', '.docx',
        '.ppt', '.pptx',
        '.xls', '.xlsx',
        '.txt', '.rtf', '.csv',
        '.md',
        '.zip', '.rar', '.7z', '.tar', '.gz',
    ].join(',')
};

/*================== Application State Manager ==================*/
const generateConversationId = () => `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const AppStateManager = (() => { /* ... (保持不变) ... */
    const state = {
        messages: [], isVoiceMode: false,
        uiMicStream: null, uiVoiceAnalyser: null,
        knowledgeFiles: [],
        autoSendTimer: null, voiceActiveAndIdleTimer: null,
        conversationId: generateConversationId(),
    };
    const getMessages = () => state.messages;
    const shouldDropWelcomeMessage = (message) => {
        if (!message || typeof message.text !== 'string') return false;
        if (state.messages.some(m => m && m.type === 'owner')) return false;
        const text = message.text;
        return /欢迎使用|您的问题|多模态数智人/.test(text);
    };
    const addMessage = (message) => {
        if (shouldDropWelcomeMessage(message)) {
            console.log('🧹 已忽略顶部欢迎提示消息');
            return;
        }
        state.messages.push(message);
    };
    const clearMessagesForNewConversation = () => {
        state.conversationId = generateConversationId();
        state.messages = [];
    };
    const getState = () => state;
    const getConversationId = () => state.conversationId;
    return {
        getState, getMessages, addMessage, clearMessagesForNewConversation,
        getConversationId,
    };
})();
window.AppStateManager = AppStateManager;

/*================== High-Performance DOM Cache System ==================*/
const DOMCache = (() => {
    const cache = new Map();
    const queryStats = new Map(); // 性能监控：统计查询次数
    const perfMetrics = {
        cacheHits: 0,
        cacheMisses: 0,
        totalQueries: 0,
        avgQueryTime: 0
    };

    const get = (id) => {
        const startTime = performance.now();
        perfMetrics.totalQueries++;

        // 从缓存获取
        if (cache.has(id)) {
            perfMetrics.cacheHits++;
            queryStats.set(id, (queryStats.get(id) || 0) + 1);
            const element = cache.get(id);

            // 验证元素仍在DOM中（防止动态移除的元素）
            if (element && document.contains(element)) {
                const queryTime = performance.now() - startTime;
                perfMetrics.avgQueryTime = (perfMetrics.avgQueryTime + queryTime) / 2;
                return element;
            } else {
                // 元素已不在DOM中，从缓存移除
                cache.delete(id);
            }
        }

        // 首次查询或元素已过期，重新查询并缓存
        perfMetrics.cacheMisses++;
        const element = document.getElementById(id);
        if (element) {
            cache.set(id, element);
            queryStats.set(id, (queryStats.get(id) || 0) + 1);
        }

        const queryTime = performance.now() - startTime;
        perfMetrics.avgQueryTime = (perfMetrics.avgQueryTime + queryTime) / 2;
        return element;
    };

    const clear = () => {
        cache.clear();
        queryStats.clear();
        // 重置性能指标
        Object.keys(perfMetrics).forEach(key => perfMetrics[key] = 0);
    };

    const getStats = () => ({
        queryCount: Object.fromEntries(queryStats),
        performance: { ...perfMetrics },
        cacheSize: cache.size,
        hitRate: perfMetrics.totalQueries > 0 ?
            (perfMetrics.cacheHits / perfMetrics.totalQueries * 100).toFixed(2) + '%' : '0%'
    });

    // 批量预缓存关键元素
    const preCache = (elementIds) => {
        elementIds.forEach(id => get(id));
    };

    return { get, clear, getStats, preCache };
})();

const DOMElements = {
    // 使用getter实现懒加载和智能缓存
    get mainContainer() { return DOMCache.get('mainContainer'); },
    get bgVideoA() { return DOMCache.get('bgVideoA'); },
    get bgVideoB() { return DOMCache.get('bgVideoB'); },
    get chatContainer() { return DOMCache.get('chatContainer'); },
    get inputPanel() { return DOMCache.get('inputPanel'); },
    get toggleBtn() { return DOMCache.get('toggleBtn'); },
    get toggleIcon() { return DOMCache.get('toggleIcon'); },
    get textInput() { return DOMCache.get('textInput'); },
    get sendBtn() { return DOMCache.get('sendBtn'); },
    get soundWaveOverlay() { return DOMCache.get('soundWaveOverlay'); },
    get knowledgeBaseBtn() { return DOMCache.get('knowledgeBaseBtn'); },
    get knowledgeBasePage() { return DOMCache.get('knowledgeBasePage'); },
    get closeKnowledgeBaseBtn() { return DOMCache.get('closeKnowledgeBaseBtn'); },
    get addFileBtn() { return DOMCache.get('addFileBtn'); },
    get dropZone() { return DOMCache.get('dropZone'); },
    get knowledgeBaseRight() { return DOMCache.get('knowledgeBaseRight'); },
    get subtitleBar() { return DOMCache.get('subtitleBar'); },
    get subtitleText() { return DOMCache.get('subtitleText'); },

    // 别名属性，兼容原有代码中的直接引用
    get backgroundVideo() { return DOMCache.get('bgVideoA') || DOMCache.get('bgVideoB'); },
    get transitionVideo() { return DOMCache.get('bgVideoB') || DOMCache.get('bgVideoA'); },

    // 性能监控和管理方法
    getQueryStats: () => DOMCache.getStats(),
    clearCache: () => DOMCache.clear(),
    preCache: (elementIds) => DOMCache.preCache(elementIds)
};

/*================== Subtitle Manager ==================*/
const SubtitleManager = (() => {
    const getBar = () => DOMElements.subtitleBar || document.getElementById('subtitleBar');
    const getTextEl = () => DOMElements.subtitleText || document.getElementById('subtitleText');
    const maxChars = 140;
    const minChars = 55;
    let pendingText = '';
    let chunks = [];
    let lastChunkIndex = -1;
    let timedSegments = null;
    let timeProvider = null;
    let lastTimedIndex = -1;
    let progressTimer = null;
    let progressProvider = null;
    let fallbackStartTime = 0;
    let fallbackDurationMs = 0;
    let firstChunkHoldUntil = 0;
    let lastChunkChangeAt = 0;
    const minChunkHoldMs = 240;
    let isPlaying = false;
    let lastLoggedText = '';
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const normalizeText = (text) => {
        const raw = normalizeSubtitleText(text);
        if (!raw) return '';
        return raw;
    };
    const splitToChunks = (text) => {
        const raw = normalizeText(text);
        if (!raw) return [];
        if (raw.length <= maxChars) return [raw];
        const result = [];
        let buffer = '';
        let lastPunctIndex = -1;
        const pushBuffer = () => {
            const trimmed = buffer.trim();
            if (trimmed) result.push(trimmed);
            buffer = '';
            lastPunctIndex = -1;
        };
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            buffer += ch;
            if ('。！？!?；;，,'.includes(ch)) {
                lastPunctIndex = buffer.length - 1;
            }
            if (buffer.length >= maxChars) {
                if (lastPunctIndex >= minChars) {
                    const cut = buffer.slice(0, lastPunctIndex + 1).trim();
                    if (cut) result.push(cut);
                    buffer = buffer.slice(lastPunctIndex + 1);
                    lastPunctIndex = -1;
                } else {
                    pushBuffer();
                }
            } else if (lastPunctIndex >= minChars) {
                const cut = buffer.slice(0, lastPunctIndex + 1).trim();
                if (cut) result.push(cut);
                buffer = buffer.slice(lastPunctIndex + 1);
                lastPunctIndex = -1;
            }
        }
        if (buffer.trim()) result.push(buffer.trim());
        return result;
    };
    const estimateDurationMs = (durationSec, text) => {
        if (Number.isFinite(durationSec) && durationSec > 0) {
            return durationSec * 1000;
        }
        const length = (text || '').length;
        return Math.max(3000, length * 90);
    };
    const applyText = (text) => {
        const bar = getBar();
        const textEl = getTextEl();
        if (!bar || !textEl) return;
        const normalized = normalizeText(text);
        textEl.textContent = normalized;
        if (DEBUG_SUBTITLE_LOG && normalized && normalized !== lastLoggedText) {
            console.log('📝 字幕文本:', normalized);
            lastLoggedText = normalized;
        }
        if (normalized) {
            bar.classList.add('is-visible');
        } else {
            bar.classList.remove('is-visible');
        }
    };
    const getProgress = () => {
        if (typeof progressProvider === 'function') {
            try {
                const value = progressProvider();
                if (Number.isFinite(value)) {
                    return clamp(value, 0, 1);
                }
            } catch (err) {
                console.warn('Subtitle progress provider error:', err);
            }
        }
        if (fallbackDurationMs > 0) {
            return clamp((performance.now() - fallbackStartTime) / fallbackDurationMs, 0, 1);
        }
        return 0;
    };
    const syncToTimedSegments = () => {
        if (!isPlaying || !timedSegments || !timeProvider) return;
        const currentSec = timeProvider();
        if (!Number.isFinite(currentSec)) return;
        const leadSec = SUBTITLE_LEAD_SEC;
        let targetIndex = -1;
        for (let i = 0; i < timedSegments.length; i++) {
            const seg = timedSegments[i];
            if (!seg) continue;
            const startSec = Number.isFinite(seg.startSec)
                ? seg.startSec
                : (i === 0 ? 0 : (timedSegments[i - 1]?.endSec ?? 0));
            const nextStart = Number.isFinite(timedSegments[i + 1]?.startSec)
                ? timedSegments[i + 1].startSec
                : (Number.isFinite(seg.endSec) ? seg.endSec + 0.001 : Number.POSITIVE_INFINITY);
            if (currentSec + leadSec < startSec) {
                targetIndex = Math.max(0, i - 1);
                break;
            }
            if (currentSec + leadSec >= startSec && currentSec < nextStart) {
                targetIndex = i;
                break;
            }
        }
        if (targetIndex === -1) {
            targetIndex = timedSegments.length - 1;
        }
        if (targetIndex !== lastTimedIndex) {
            lastTimedIndex = targetIndex;
            applyText(timedSegments[targetIndex]?.text || '');
        }
    };

    const syncToProgress = () => {
        if (!isPlaying) return;
        if (timedSegments && timeProvider) {
            syncToTimedSegments();
            return;
        }
        if (!chunks.length) {
            applyText('');
            return;
        }
        const progress = getProgress();
        const now = performance.now();
        let targetIndex = Math.min(chunks.length - 1, Math.max(0, Math.floor(progress * chunks.length)));
        if (now < firstChunkHoldUntil) {
            targetIndex = 0;
        }
        if (targetIndex > lastChunkIndex && lastChunkIndex >= 0 && now - lastChunkChangeAt < minChunkHoldMs) {
            targetIndex = lastChunkIndex;
        }
        if (targetIndex !== lastChunkIndex) {
            lastChunkIndex = targetIndex;
            lastChunkChangeAt = now;
            applyText(chunks[targetIndex] || '');
        }
    };
    const stopProgressSync = () => {
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
        progressProvider = null;
        timedSegments = null;
        timeProvider = null;
        lastTimedIndex = -1;
        fallbackStartTime = 0;
        fallbackDurationMs = 0;
        lastChunkIndex = -1;
        firstChunkHoldUntil = 0;
        lastChunkChangeAt = 0;
    };
    const startProgressSync = (durationSec, provider) => {
        stopProgressSync();
        if (!chunks.length) {
            applyText('');
            return;
        }
        progressProvider = typeof provider === 'function' ? provider : null;
        fallbackStartTime = performance.now();
        fallbackDurationMs = estimateDurationMs(durationSec, pendingText);
        firstChunkHoldUntil = performance.now() + 350;
        lastChunkChangeAt = 0;
        syncToProgress();
        progressTimer = setInterval(syncToProgress, 120);
    };
    const setTimedSegments = (segments, provider) => {
        timedSegments = Array.isArray(segments) ? segments : null;
        timeProvider = typeof provider === 'function' ? provider : null;
        lastTimedIndex = -1;
        if (isPlaying) {
            syncToTimedSegments();
        }
    };
    const setPending = (text) => {
        pendingText = normalizeText(text);
        chunks = splitToChunks(pendingText);
        if (typeof window !== 'undefined') {
            window.__SUBTITLE_EST_DURATION_MS = estimateDurationMs(null, pendingText);
        }
        if (isPlaying) {
            syncToProgress();
        }
    };
    const onTTSStart = (options) => {
        isPlaying = true;
        let durationSec = null;
        let provider = null;
        if (typeof options === 'number') {
            durationSec = options;
        } else if (options && typeof options === 'object') {
            durationSec = options.durationSec;
            provider = options.progressProvider;
        }
        startProgressSync(durationSec, provider);
    };
    const onTTSEnd = () => {
        isPlaying = false;
        pendingText = '';
        chunks = [];
        stopProgressSync();
        applyText('');
    };
    const clear = () => {
        pendingText = '';
        chunks = [];
        isPlaying = false;
        stopProgressSync();
        applyText('');
    };
    return { setPending, setTimedSegments, onTTSStart, onTTSEnd, clear };
})();
if (typeof window !== 'undefined') {
    window.SubtitleManager = SubtitleManager;
}

/*================== Global Utility Functions ==================*/
const Utils = (() => { /* ... (保持不变) ... */
    const getPlaceholderTarget = () => DOMElements.textInput;
    const setInputPlaceholder = (text) => { const target = getPlaceholderTarget(); if (!target) return; if (target.tagName === 'TEXTAREA') { target.placeholder = text; } };
    return { setInputPlaceholder, getPlaceholderTarget };
})();

/*================== Adaptive Resolution ==================*/
const adaptResolution = () => { /* ... (保持不变) ... */
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (winW < 768) {  // 移动端适配
        if (DOMElements.mainContainer) {
            // 移动端：使用原生尺寸，不缩放
            DOMElements.mainContainer.style.transform = 'none';
            DOMElements.mainContainer.style.width = '100%';
            DOMElements.mainContainer.style.height = '100%';
            DOMElements.mainContainer.style.left = '0px';
            DOMElements.mainContainer.style.top = '0px';
        }
        return;  // 跳过桌面端缩放逻辑
    }

    // 桌面端适配
    let targetWidth = 1920, targetHeight = 1080;
    if (winW >= 3840 && winH >= 2160) {
        targetWidth = 3840;
        targetHeight = 2160;
    } else if (winW >= 2560 && winH >= 1440) {
        targetWidth = 2560;
        targetHeight = 1440;
    }

    if (DOMElements.mainContainer) {
        DOMElements.mainContainer.style.width = targetWidth + "px";
        DOMElements.mainContainer.style.height = targetHeight + "px";

        const scale = Math.min(winW / targetWidth, winH / targetHeight);
        // 使用更精确的缩放，考虑设备像素比
        const adjustedScale = scale * Math.min(devicePixelRatio, 1.5);

        DOMElements.mainContainer.style.transform = `scale(${scale})`;
        DOMElements.mainContainer.style.left = ((winW - targetWidth * scale) / 2) + "px";
        DOMElements.mainContainer.style.top = ((winH - targetHeight * scale) / 2) + "px";

    } else {
        console.error("mainContainer not found for adaptResolution.");
    }
};

const getIconForFileType = (fileType) => {
    if (!fileType) return "insert_drive_file";
    if (fileType.startsWith("image/")) return "image";
    if (fileType.startsWith("video/")) return "movie";
    if (fileType.startsWith("audio/")) return "audiotrack";
    if (fileType === "application/pdf") return "picture_as_pdf";
    if (fileType.includes("word")) return "description";
    if (fileType.includes("presentation") || fileType.includes("powerpoint")) return "slideshow";
    if (fileType.includes("excel") || fileType.includes("spreadsheet")) return "grid_on";
    if (fileType.startsWith("text/")) return "article";
    if (fileType.includes("zip") || fileType.includes("archive")) return "archive";
    return "insert_drive_file";
};

/*================== 百炼智能体知识库检索函数 ==================*/
let currentBaiLianAbortController = null;

const cancelCurrentBaiLianRequest = () => {
    if (currentBaiLianAbortController) {
        currentBaiLianAbortController.abort();
        currentBaiLianAbortController = null;
    }
};

if (typeof window !== 'undefined') {
    window.cancelCurrentBaiLianRequest = cancelCurrentBaiLianRequest;
}

// 专门用于知识库检索的百炼智能体调用函数，返回纯文本内容
const requestBaiLianAgent = async (text, fileIds = []) => {
    console.log("🔍 开始调用百炼智能体进行知识库检索:", {
        textLength: text.length,
        textPreview: text.substring(0, 100) + '...',
        fileIds: fileIds
    });

    const MAX_RETRIES = 3;
    const baseDelayMs = 800;

    return new Promise((resolve, reject) => {
        const appCode = getAppCode();
        const token = getToken();

        if (!appCode || !token) {
            reject(new Error('百炼智能体认证信息缺失'));
            return;
        }

        cancelCurrentBaiLianRequest();
        const abortController = new AbortController();
        currentBaiLianAbortController = abortController;
        const { signal } = abortController;

        const url = `${AGENT_APP_URL}?AppCode=${appCode}`;

        const createAbortError = () => {
            try {
                return new DOMException('Aborted', 'AbortError');
            } catch (_) {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                return error;
            }
        };

        const finalize = (handler) => {
            if (currentBaiLianAbortController === abortController) {
                currentBaiLianAbortController = null;
            }
            if (typeof handler === 'function') {
                handler();
            }
        };

        const doRequest = async (attempt) => {
            if (signal.aborted) {
                finalize(() => reject(createAbortError()));
                return;
            }
            let accumulatedText = '';
            let currentSessionId = sessionId;

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
            // 保持原有结构，避免影响其它逻辑
            if (INDEX_ID) {
                try {
                    // 将 pipeline_ids 合并进原有 rag_options（不改变原字段层级）
                    params.parameters.rag_options.pipeline_ids = [INDEX_ID];
                } catch (_) {
                    // 忽略合并异常，避免影响主流程
                }
            }

            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    signal,
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'X-DashScope-SSE': 'enable'
                    },
                    body: JSON.stringify(params)
                });

                if (!resp.ok) {
                    // HTTP层面错误直接抛出，交由下方重试逻辑处理
                    throw new Error(`百炼智能体请求失败: ${resp.status} ${resp.statusText}`);
                }

                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let throttled = false;

                const processDataStr = (dataStr) => {
                    if (!dataStr || dataStr === '[DONE]') {
                        return { done: false, throttled: false };
                    }
                    const chunk = JSON.parse(dataStr);
                    // 处理限流与错误信息
                    if (chunk && (chunk.code || chunk.message)) {
                        const msg = (chunk.message || '').toString();
                        if ((chunk.code && String(chunk.code).includes('Throttling')) || msg.includes('Requests rate limit exceeded')) {
                            return { done: false, throttled: true };
                        }
                    }

                    const data = chunk.output || {};
                    if (data.session_id) currentSessionId = data.session_id;

                    if (typeof data.text === 'string' && data.text) {
                        accumulatedText += data.text;
                    }

                    if (data.finish_reason === 'stop') {
                        console.log("✅ 百炼智能体知识库检索完成:", {
                            textLength: accumulatedText.length,
                            sessionId: currentSessionId
                        });
                        sessionId = currentSessionId; // 更新全局session
                        finalize(() => resolve(accumulatedText));
                        return { done: true, throttled: false };
                    }

                    return { done: false, throttled: false };
                };

                while (true) {
                    if (signal.aborted) {
                        finalize(() => reject(createAbortError()));
                        return;
                    }
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim().startsWith('data:')) continue;
                        const dataStr = line.slice(5).trim();

                        try {
                            const result = processDataStr(dataStr);
                            if (result.throttled) {
                                console.warn(`⏳ 触发限流，第${attempt}次，准备重试...`);
                                throttled = true;
                                try { reader.cancel && reader.cancel(); } catch (_) {}
                                break;
                            }
                            if (result.done) {
                                return;
                            }
                        } catch (e) {
                            // 非标准数据行，记录并继续
                            console.warn("解析百炼智能体响应数据失败:", e, line);
                        }
                    }

                    if (throttled) break;
                }

                if (throttled) {
                    if (attempt < MAX_RETRIES) {
                        const delay = baseDelayMs * Math.pow(2, attempt - 1);
                        setTimeout(() => {
                            if (currentBaiLianAbortController !== abortController) {
                                return;
                            }
                            if (signal.aborted) {
                                finalize(() => reject(createAbortError()));
                                return;
                            }
                            doRequest(attempt + 1);
                        }, delay);
                        return;
                    } else {
                        finalize(() => reject(new Error('请求频率超限，请稍后重试')));
                        return;
                    }
                }

                const tail = buffer.trim();
                if (tail.startsWith('data:')) {
                    try {
                        const result = processDataStr(tail.slice(5).trim());
                        if (result.done) {
                            return;
                        }
                    } catch (e) {
                        console.warn("解析百炼智能体响应尾部数据失败:", e, tail);
                    }
                }

                // 流正常结束但未收到stop信号：返回已累积文本或报错
                if (accumulatedText) {
                    finalize(() => resolve(accumulatedText));
                } else {
                    finalize(() => reject(new Error('未获取到有效响应')));
                }
            } catch (err) {
                console.error('❌ 百炼智能体知识库检索失败:', err);
                if (signal.aborted || err.name === 'AbortError') {
                    finalize(() => reject(createAbortError()));
                    return;
                }
                if (attempt < MAX_RETRIES) {
                    const delay = baseDelayMs * Math.pow(2, attempt - 1);
                    setTimeout(() => {
                        if (currentBaiLianAbortController !== abortController) {
                            return;
                        }
                        if (signal.aborted) {
                            finalize(() => reject(createAbortError()));
                            return;
                        }
                        doRequest(attempt + 1);
                    }, delay);
                } else {
                    finalize(() => reject(err));
                }
            }
        };

        // 启动首次请求
        doRequest(1);
    });
};

/*================== AI Model Manager ==================*/
const AIModelManager = (() => {
    // 🔥 新增：TTS中断功能 - 增强版
    const interruptTTS = () => {
        console.log('🛑 手动中断所有TTS播放');

        // 1. 中断omni模型请求（文本兜底）
        if (typeof window.cancelCurrentOmniModelRequest === 'function') {
            window.cancelCurrentOmniModelRequest();
            console.log('✅ omni模型TTS已被手动中断');
        }

        // 2. 中断CosyVoice TTS
        if (typeof CosyVoiceTTSClient !== 'undefined' && CosyVoiceTTSClient.abort) {
            CosyVoiceTTSClient.abort();
            console.log('✅ CosyVoice TTS已被手动中断');
        }
        
        // 3. 重置所有TTS状态
        window.TTS_PENDING = false;
        window.TTS_PLAYING = false;
        updateVideoByTTSState();
        
        console.log('✅ 所有TTS播放已被完全中断');
    };

    return { interruptTTS };
})();

/*================== Conversation Flow & API Manager ==================*/
const ConversationManager = (() => { /* ... (保持不变) ... */
    const initConversation = () => {
        if (typeof window.cancelCurrentBaiLianRequest === 'function') {
            window.cancelCurrentBaiLianRequest();
        }
        sessionId = undefined;
        AppStateManager.clearMessagesForNewConversation();
        // 重置TTS状态，确保视频回到静音状态
        window.TTS_PLAYING = false;
        window.TTS_PENDING = false;
        updateVideoByTTSState();
    };

    const handleUIMessageDisplayAndContext = (question) => {
        const currentMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const conversationId = typeof AppStateManager.getConversationId === 'function'
            ? AppStateManager.getConversationId()
            : null;
        if (question) {
            const userMessageData = { type: 'owner', text: question, id: currentMessageId + "_usr_text" };
            if (window.ENABLE_MARKDOWN_LITE && typeof window.sanitizeAndFormatLLMText === 'function') {
                userMessageData.blocks = window.sanitizeAndFormatLLMText(question);
            }
            AppStateManager.addMessage(userMessageData);
        }
        const msgHistoryForAI = AppStateManager.getMessages().slice(-CONTEXT_LIMIT_COUNT);
        return { msgHistoryForAI, currentMessageId, conversationId };
    };

    const processAndSendToAI = async (question) => {
        // 🔥 新增：用户发送消息时清除自动回到初始化状态的计时器
        if (typeof VoiceStateManager !== 'undefined' && VoiceStateManager.clearAutoReturnToInitTimer) {
            VoiceStateManager.clearAutoReturnToInitTimer();
        }
        
        const { msgHistoryForAI: _initialMsgHistoryForAI, currentMessageId, conversationId } = handleUIMessageDisplayAndContext(question);

        const questionForAI = question || '';

        // ✅ 清理输入框，准备下一次输入
        // 🔥 增强：停掉旧TTS，设置等待新合成
        console.log('🔄 新消息发送，中断当前TTS播放并准备新的合成');
        
        // 🔥 新增：完整中断所有类型的TTS播放
        if (typeof AIModelManager !== 'undefined' && AIModelManager.interruptTTS) {
            AIModelManager.interruptTTS(); // 这会处理所有类型的TTS
        }
        
        window.TTS_PENDING = true;
        window.TTS_PLAYING = false;     // 不再 refresh，这样首条消息在 TTS 第一帧真正到来前仍播放 video3
        
        // 🔥 新增：通知VoiceStateManager准备新的TTS
        if (typeof VoiceStateManager !== 'undefined') {
            // 设置TTS准备状态
            VoiceStateManager.startTTSPreparation();
            console.log('🔄 已通知VoiceStateManager进入TTS准备状态');
        }

        if (DOMElements.textInput.tagName === 'TEXTAREA')
            DOMElements.textInput.value = "";
        let payloadPartsForOmniModel = [];
        if (question) {
            payloadPartsForOmniModel.push({ type: 'text', text: questionForAI });
        }
        let finalPayloadForOmniModel;
        if (payloadPartsForOmniModel.length === 0) { 
            console.warn("No content to send."); 
            ConversationManager.updateUIAfterAIResponse(null); 
        } 
        else if (payloadPartsForOmniModel.length === 1 && payloadPartsForOmniModel[0].type === 'text') { 
            // ✅ 纯文本：传字符串格式，omni模型更好处理
            finalPayloadForOmniModel = payloadPartsForOmniModel[0].text; 
        } 
        else { 
            // ✅ 多模态：传数组格式
            finalPayloadForOmniModel = payloadPartsForOmniModel; 
        }

        if (finalPayloadForOmniModel && !(Array.isArray(finalPayloadForOmniModel) && finalPayloadForOmniModel.length === 0)) {
            let accumulatedResponseText = "";
            let aiMessageUIIndex = null;
            const appState = AppStateManager.getState();
            const handlePlaybackFinished = (wasAbortedOrError) => {
                if (conversationId && typeof AppStateManager.getConversationId === 'function' && conversationId !== AppStateManager.getConversationId()) {
                    console.log('🔄 会话已切换，跳过旧播放完成回调');
                    return;
                }
                console.log(`ConversationManager: handlePlaybackFinished. Aborted/Error: ${wasAbortedOrError}`);
                // 🚀 传递AI回复的messageId以支持富文本增强
                const aiMessageId = currentMessageId + "_r";
                ConversationManager.updateUIAfterAIResponse(accumulatedResponseText, aiMessageId);
            };
            // 🔄 双模型串行处理：先百炼智能体（知识库检索），再Omni模型（语音合成）
            const msgHistoryForAI = AppStateManager.getMessages().slice(-CONTEXT_LIMIT_COUNT);

            console.log("🎯 开始双模型串行处理:", {
                step1: "百炼智能体知识库检索",
                step2: "Omni模型语音合成",
                payload: finalPayloadForOmniModel,
                historyLength: msgHistoryForAI.length,
                payloadType: Array.isArray(finalPayloadForOmniModel) ? 'multimodal' : 'text-only'
            });

            // 🔍 第一步：调用百炼智能体进行知识库检索
            try {
                // 如果有附件，需要特殊处理 - 暂时只处理纯文本情况
                const textForKnowledgeBase = typeof finalPayloadForOmniModel === 'string' 
                    ? finalPayloadForOmniModel 
                    : (Array.isArray(finalPayloadForOmniModel) 
                        ? finalPayloadForOmniModel.find(item => item.type === 'text')?.text || '' 
                        : '');

                if (!textForKnowledgeBase) {
                    throw new Error('无法从输入中提取文本用于知识库检索');
                }

                console.log("🔍 开始第一步：百炼智能体知识库检索");
                
                const knowledgeBaseResponse = await requestBaiLianAgent(textForKnowledgeBase, []);

                if (conversationId && typeof AppStateManager.getConversationId === 'function' && conversationId !== AppStateManager.getConversationId()) {
                    console.log('🔄 会话已切换，跳过旧的知识库回复');
                    return;
                }
                
                console.log("✅ 百炼智能体检索完成，开始第二步：Omni模型语音合成");
                
                // 🎤 第二步：将百炼智能体的回复作为prompt传给Omni模型进行语音合成
                const speakText = normalizeTtsText(knowledgeBaseResponse);
                
                console.log("🎤 开始第二步：CosyVoice语音合成:", {
                    originalTextLength: knowledgeBaseResponse.length,
                    textPreview: speakText.substring(0, 100) + '...'
                });

                // 直接显示百炼智能体的回复文本给用户
                accumulatedResponseText = knowledgeBaseResponse;
                const messageData = {
                    type: 'other',
                    text: accumulatedResponseText,
                    id: currentMessageId + "_r"
                };

                if (window.ENABLE_MARKDOWN_LITE && typeof window.sanitizeAndFormatLLMText === 'function') {
                    messageData.blocks = window.sanitizeAndFormatLLMText(accumulatedResponseText);
                }

                AppStateManager.addMessage(messageData);
                if (typeof SubtitleManager !== 'undefined') {
                    SubtitleManager.setPending(knowledgeBaseResponse);
                }
                aiMessageUIIndex = AppStateManager.getMessages().length - 1;

                // 使用CosyVoice进行语音合成（后端WebSocket代理）
                CosyVoiceTTSClient.speak(speakText, handlePlaybackFinished);

            } catch (error) {
                console.error("❌ 双模型处理失败:", error);

                if (conversationId && typeof AppStateManager.getConversationId === 'function' && conversationId !== AppStateManager.getConversationId()) {
                    console.log('⚠️ 会话已切换，忽略旧对话的降级流程');
                    return;
                }

                if (error && error.name === 'AbortError') {
                    console.log('⚠️ 百炼知识库请求被中断，已停止旧流程');
                    return;
                }
                
                // 🔧 降级方案：如果百炼智能体失败，直接使用Omni模型
                console.log("🔧 启用降级方案：直接调用Omni模型");
                
            requestOmniModel(BAIREN_STREAMING_URL, finalPayloadForOmniModel, msgHistoryForAI,
                (delta) => {
                        // 恢复原始的处理逻辑
                    if (conversationId && typeof AppStateManager.getConversationId === 'function' && conversationId !== AppStateManager.getConversationId()) {
                        return;
                    }
                    if (!delta || !delta.content) return;
                    if (delta.type !== 'text') return;

                    accumulatedResponseText += delta.content;
                        if (typeof SubtitleManager !== 'undefined') {
                            SubtitleManager.setPending(accumulatedResponseText);
                        }

                    const messageData = {
                        type: 'other',
                        text: accumulatedResponseText,
                        id: currentMessageId + "_r"
                    };

                    if (window.ENABLE_MARKDOWN_LITE && typeof window.sanitizeAndFormatLLMText === 'function') {
                        messageData.blocks = window.sanitizeAndFormatLLMText(accumulatedResponseText);
                    }

                    if (aiMessageUIIndex === null) {
                        AppStateManager.addMessage(messageData);
                        aiMessageUIIndex = AppStateManager.getMessages().length - 1;
                    } else {
                        const messages = AppStateManager.getMessages();
                        if (messages[aiMessageUIIndex]) {
                            messages[aiMessageUIIndex].text = accumulatedResponseText;
                            if (window.ENABLE_MARKDOWN_LITE && typeof window.sanitizeAndFormatLLMText === 'function') {
                                messages[aiMessageUIIndex].blocks = window.sanitizeAndFormatLLMText(accumulatedResponseText);
                            }
                        } else {
                            const fallbackData = {
                                type: 'other',
                                text: accumulatedResponseText,
                                id: currentMessageId + "_r_fbk"
                            };
                            if (window.ENABLE_MARKDOWN_LITE && typeof window.sanitizeAndFormatLLMText === 'function') {
                                fallbackData.blocks = window.sanitizeAndFormatLLMText(accumulatedResponseText);
                            }
                            AppStateManager.addMessage(fallbackData);
                            aiMessageUIIndex = AppStateManager.getMessages().length - 1;
                        }
                    }
                    }, 
                    (wasAbortedOrError) => {
                        if (wasAbortedOrError) {
                            handlePlaybackFinished(true);
                            return;
                        }
                        const speakText = normalizeTtsText(accumulatedResponseText);
                        if (typeof SubtitleManager !== 'undefined') {
                            SubtitleManager.setPending(accumulatedResponseText);
                        }
                        CosyVoiceTTSClient.speak(speakText, handlePlaybackFinished);
                    },
                    { audioEnabled: false }
            );
            }
        } else {
            console.warn("Final payload for AI is empty. Not sending."); ConversationManager.updateUIAfterAIResponse(null);

        }
    };

    // 🔓 暴露发送函数到全局，供引导问题直接调用（不影响既有流程）
    if (typeof window !== 'undefined' && !window.processAndSendToAI) {
        window.processAndSendToAI = processAndSendToAI;
    }

    const updateUIAfterAIResponse = (lastAiMessageText, messageId) => {
        console.log("ConversationManager: updateUIAfterAIResponse. AI text: ", lastAiMessageText ? lastAiMessageText.substring(0, 50) + "..." : "null");
        return;
    };

    if (DOMElements.sendBtn) {
        DOMElements.sendBtn.addEventListener('click', async () => {
            let question = "";
            if (DOMElements.textInput.tagName === 'TEXTAREA') { question = DOMElements.textInput.value.trim(); }

            if (!question) {
                DOMElements.textInput.focus()
                return
            }
            if (typeof SubtitleManager !== 'undefined') {
                SubtitleManager.clear();
            }
            
            console.log("Send button clicked. Initiating interruption.");
            if (typeof window.cancelCurrentOmniModelRequest === 'function') {
                window.cancelCurrentOmniModelRequest();
            }
            if (typeof window.cancelCurrentBaiLianRequest === 'function') {
                window.cancelCurrentBaiLianRequest();
            }
            if (!window.TTS_PLAYING && !window.TTS_PENDING) {
                // 确保视频回到静音状态
                window.TTS_PLAYING = false;
                window.TTS_PENDING = false;
                updateVideoByTTSState();
            }


            if (!question) {
                updateUIAfterAIResponse(null);
                return;
            }
            await processAndSendToAI(question);
        });
    }
    return { initConversation, updateUIAfterAIResponse };
})();

/*================== Voice Input Handler ==================*/
const VoiceInputHandler = (() => { /* ... (保持不变) ... */
    const appState = AppStateManager.getState();
    let recognitionPausedByTTS = false;

    const resetVoiceActiveAndIdleTimer = () => {
        if (appState.voiceActiveAndIdleTimer) clearTimeout(appState.voiceActiveAndIdleTimer);
        if (appState.isVoiceMode) { appState.voiceActiveAndIdleTimer = setTimeout(() => { console.log(`${VOICE_IDLE_TIMEOUT_DURATION / 60000}m voice inactivity. Switching to text mode.`); if (appState.isVoiceMode) { toggleInputMode(); } }, VOICE_IDLE_TIMEOUT_DURATION); }
    };
    /**
     * 重置自动发送计时器
     * @param {boolean} shouldForceSend - 是否强制发送（来自预设问题点击或其他强制触发）
     */
    const resetAutoSendTimer = (shouldForceSend = false) => {
        if (appState.autoSendTimer) clearTimeout(appState.autoSendTimer);
        appState.autoSendTimer = setTimeout(() => {
            if (window.TTS_PENDING || window.TTS_PLAYING) {
                console.log('⏸️ TTS进行中，跳过自动发送');
                return;
            }
            let currentText = "";
            if (DOMElements.textInput.tagName === 'TEXTAREA') currentText = DOMElements.textInput.value.trim();
            if (currentText !== "" && DOMElements.sendBtn) {
                if (shouldForceSend || appState.isVoiceMode) {
                    console.log(`Auto-sending text after timeout. ForceSend: ${shouldForceSend}, VoiceMode: ${appState.isVoiceMode}`);
                    DOMElements.sendBtn.click();
                }
            }
        }, 3500);
    };
    const resetAutoSendTimerForPresetQuestion = () => { resetAutoSendTimer(true); };

    if (DOMElements.textInput) {
        const setupInputListeners = () => { if (!DOMElements.textInput) return; if (DOMElements.textInput.tagName === 'TEXTAREA') { DOMElements.textInput.addEventListener('input', () => { if (appState.isVoiceMode) { resetAutoSendTimer(false); if (DOMElements.textInput.value.trim() !== "") resetVoiceActiveAndIdleTimer(); } }); } };
        setupInputListeners();
    }

    const drawAdvancedVoiceWave = () => {
        if (!appState.uiVoiceAnalyser || !DOMElements.soundWaveOverlay || !appState.isVoiceMode || !appState.uiMicStream?.active) { 
            if (DOMElements.soundWaveOverlay) { 
                const canvasWave = DOMElements.soundWaveOverlay; 
                if (canvasWave?.getContext) { 
                    const ctxWave = canvasWave.getContext("2d"); 
                    if (ctxWave) ctxWave.clearRect(0, 0, canvasWave.width, canvasWave.height); 
                } 
            } 
            return; 
        }
        
        const canvasWave = DOMElements.soundWaveOverlay; 
        const ctxWave = canvasWave.getContext("2d"); 
        if (!ctxWave) { 
            console.warn("Could not get 2D context for soundWaveOverlay in drawAdvancedVoiceWave."); 
            return; 
        } 
        
        const bufferLength = appState.uiVoiceAnalyser.frequencyBinCount; 
        const frequencyData = new Uint8Array(bufferLength);
        const timeData = new Uint8Array(bufferLength);
        
        const drawLoop = () => { 
            if (!appState.isVoiceMode || !appState.uiVoiceAnalyser || !appState.uiMicStream?.active) { 
                if (ctxWave) ctxWave.clearRect(0, 0, canvasWave.width, canvasWave.height); 
                return; 
            } 
            
            requestAnimationFrame(drawLoop); 
            
            // 🔥 改进：同时获取频域和时域数据
            appState.uiVoiceAnalyser.getByteFrequencyData(frequencyData);
            appState.uiVoiceAnalyser.getByteTimeDomainData(timeData);
            
            ctxWave.clearRect(0, 0, canvasWave.width, canvasWave.height); 
            
            // 🔥 改进：计算加权音量，平衡高低音响应
            let weightedVolume = 0;
            let totalWeight = 0;
            const config = voiceWaveConfig.frequencyWeights;
            
            // 低频段加权
            const lowStart = Math.floor(config.lowFreq.start * bufferLength);
            const lowEnd = Math.floor(config.lowFreq.end * bufferLength);
            for (let i = lowStart; i < lowEnd; i++) {
                weightedVolume += (frequencyData[i] / 255.0) * config.lowFreq.weight;
                totalWeight += config.lowFreq.weight;
            }
            
            // 中频段加权
            const midStart = Math.floor(config.midFreq.start * bufferLength);
            const midEnd = Math.floor(config.midFreq.end * bufferLength);
            for (let i = midStart; i < midEnd; i++) {
                weightedVolume += (frequencyData[i] / 255.0) * config.midFreq.weight;
                totalWeight += config.midFreq.weight;
            }
            
            // 高频段加权（降权处理）
            const highStart = Math.floor(config.highFreq.start * bufferLength);
            const highEnd = Math.floor(config.highFreq.end * bufferLength);
            for (let i = highStart; i < highEnd; i++) {
                weightedVolume += (frequencyData[i] / 255.0) * config.highFreq.weight;
                totalWeight += config.highFreq.weight;
            }
            
            const avgVolume = weightedVolume / totalWeight;
            
            // 静音检测
            if (avgVolume < voiceWaveConfig.silenceThreshold) return;
            
            // 🔥 改进：使用对数缩放模拟人耳感知
            const logVolume = Math.log10(avgVolume * 9 + 1); // 对数缩放到0-1
            const amplitude = voiceWaveConfig.baseAmplitude + logVolume * voiceWaveConfig.amplitudeMultiplier;
            
            const baseline = canvasWave.height / 2; 
            let gradient = ctxWave.createLinearGradient(0, 0, canvasWave.width, 0); 
            gradient.addColorStop(0, voiceWaveConfig.gradientColor1); 
            gradient.addColorStop(1, voiceWaveConfig.gradientColor2); 
            ctxWave.lineWidth = voiceWaveConfig.lineWidth; 
            ctxWave.lineCap = voiceWaveConfig.lineCap; 
            ctxWave.strokeStyle = gradient; 
            ctxWave.shadowColor = voiceWaveConfig.shadowColor; 
            ctxWave.shadowBlur = voiceWaveConfig.shadowBlur; 
            ctxWave.beginPath(); 
            
            const sliceWidth = canvasWave.width * 1.0 / bufferLength; 
            let x = 0; 
            
            // 🔥 改进：结合时域数据绘制更自然的波形
            for (let i = 0; i < bufferLength; i++) { 
                const v = timeData[i] / 128.0; 
                const diff = v - 1.0; 
                
                // 🔥 改进：使用频域数据调制振幅
                const freqModulation = 1 + (frequencyData[i] / 255.0) * 0.5;
                const adjustedDiff = Math.sign(diff) * Math.pow(Math.abs(diff), 0.6) * freqModulation;
                const y = baseline + adjustedDiff * amplitude; 
                
                if (i === 0) ctxWave.moveTo(x, y); 
                else ctxWave.lineTo(x, y); 
                x += sliceWidth; 
            } 
            ctxWave.stroke(); 
        }; 
        drawLoop();
    };

    // 🔥 新增：麦克风音量控制方法
    const muteMicrophoneForTTS = () => {
        console.log('🔇 TTS开始，关闭麦克风避免回音');
        try {
            // 方法1：静音所有音频轨道
            if (appState.uiMicStream) {
                appState.uiMicStream.getAudioTracks().forEach(track => {
                    track.enabled = false;
                    console.log(`麦克风轨道 ${track.id} 已静音`);
                });
            }
            
            // 方法2：如果有音频上下文，设置音量为0
            if (appState.micGainNode) {
                appState.micGainNode.gain.value = 0;
                console.log('麦克风增益节点已设置为0');
            }
        } catch (error) {
            console.warn('麦克风静音失败:', error);
        }
    };

    const restoreMicrophoneAfterTTS = () => {
        console.log('🔊 TTS结束，恢复麦克风');
        try {
            // 恢复音频轨道
            if (appState.uiMicStream) {
                appState.uiMicStream.getAudioTracks().forEach(track => {
                    track.enabled = true;
                    console.log(`麦克风轨道 ${track.id} 已恢复`);
                });
            }
            
            // 恢复音量
            if (appState.micGainNode) {
                appState.micGainNode.gain.value = 1;
                console.log('麦克风增益节点已恢复为1');
            }
        } catch (error) {
            console.warn('麦克风恢复失败:', error);
        }
    };

    const initMicAndVoiceWave = async () => {
        if (appState.uiMicStream?.active) { if (appState.uiVoiceAnalyser && DOMElements.soundWaveOverlay?.style.display === 'block' && appState.isVoiceMode) { drawAdvancedVoiceWave(); } return; }
        if (appState.uiMicStream) 
            appState.uiMicStream.getTracks().forEach(track => track.stop()); 
        appState.uiMicStream = null; 
        if (appState.uiVoiceAnalyser?.context?.state !== 'closed') { 
            try { appState.uiVoiceAnalyser.disconnect(); 

            } catch (e) { /* ignore */ 

            } 
        }
        appState.uiVoiceAnalyser = null;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); 
            appState.uiMicStream = stream; 
            const audioContext = new (window.AudioContext || window.webkitAudioContext)(); 
            const source = audioContext.createMediaStreamSource(stream); 
            appState.uiVoiceAnalyser = audioContext.createAnalyser(); 
            appState.uiVoiceAnalyser.fftSize = voiceWaveConfig.fftSize;
            // 🔥 新增：应用音频分析器优化参数
            appState.uiVoiceAnalyser.smoothingTimeConstant = voiceWaveConfig.smoothingTimeConstant;
            appState.uiVoiceAnalyser.minDecibels = voiceWaveConfig.minDecibels;
            appState.uiVoiceAnalyser.maxDecibels = voiceWaveConfig.maxDecibels; 
            
            // 🔥 新增：创建音量控制节点
            appState.micGainNode = audioContext.createGain();
            appState.micGainNode.gain.value = 1; // 默认音量为1（正常）
            
            // 🔥 修改音频连接路径：source -> gainNode -> analyser
            source.connect(appState.micGainNode);
            appState.micGainNode.connect(appState.uiVoiceAnalyser); 
            if (appState.isVoiceMode && DOMElements.soundWaveOverlay) { 
                DOMElements.soundWaveOverlay.style.display = 'block'; 
                drawAdvancedVoiceWave(); 
            } 
            console.log("UI Mic stream acquired for voice wave.");
        } catch (err) { 
            console.error("Failed to initialize mic for voice wave:", err); 
            if (DOMElements.toggleIcon) {
                 DOMElements.toggleIcon.textContent = "mic_off"; DOMElements.toggleIcon.style.color = "red";
                  DOMElements.toggleIcon.classList.remove("breathing"); } Utils.setInputPlaceholder("麦克风不可用"); 
                  if (DOMElements.soundWaveOverlay)
                    DOMElements.soundWaveOverlay.style.display = "none"; 
                if (appState.voiceActiveAndIdleTimer)
                    clearTimeout(appState.voiceActiveAndIdleTimer); throw err; }
    };
    const startRecognition = () => {
        if (!appState.uiMicStream?.active) {
            initMicAndVoiceWave().then(() => { if (appState.uiMicStream?.active && typeof audioRecognition === 'function') { const taskId = crypto.randomUUID(); const inputElementForASR = DOMElements.textInput; audioRecognition(AUDIO_RECOGNITION_URL, taskId, inputElementForASR).catch(e => console.error("Audio recognition error:", e)); resetVoiceActiveAndIdleTimer(); } else { console.error("Failed to initialize UI mic stream before starting ASR."); } }).catch(err => { console.error("Error in initMicAndVoiceWave called from startRecognition:", err); }); return;
        }
        if (typeof audioRecognition === 'function') { const taskId = crypto.randomUUID(); const inputElementForASR = DOMElements.textInput; audioRecognition(AUDIO_RECOGNITION_URL, taskId, inputElementForASR).catch(e => console.error("Audio recognition error:", e)); resetVoiceActiveAndIdleTimer(); }
        else { console.error("audioRecognition function (from audioRecognition.js) not found."); }
    };
    const stopRecognition = () => {
        // 1. 停止语音识别录音（来自audioRecognition.js）
        if (typeof stopRecord === 'function') {
            try {
                stopRecord();
            } catch (e) {
                console.warn("Error stopping record:", e);
            }
        }

        // 2. 清理自动发送计时器
        if (appState.autoSendTimer) {
            clearTimeout(appState.autoSendTimer);
            appState.autoSendTimer = null;
        }

        // 3. 关闭UI麦克风流（用于音波显示）
        if (appState.uiMicStream) {
            appState.uiMicStream.getTracks().forEach(track => {
                track.stop();
                console.log(`UI Mic track ${track.id} stopped.`);
            });
            appState.uiMicStream = null;
        }

        // 4. 清理UI音频分析器
        if (appState.uiVoiceAnalyser) {
            if (appState.uiVoiceAnalyser.context?.state !== 'closed') {
                try {
                    appState.uiVoiceAnalyser.disconnect();
                } catch (e) {
                    /* ignore */
                }
            }
            appState.uiVoiceAnalyser = null;
        }

        // 5. 清理音波显示
        if (DOMElements.soundWaveOverlay) {
            const canvasWave = DOMElements.soundWaveOverlay;
            if (canvasWave?.getContext) {
                const ctxWave = canvasWave.getContext("2d");
                if (ctxWave) {
                    ctxWave.clearRect(0, 0, canvasWave.width, canvasWave.height);
                }
            }
            DOMElements.soundWaveOverlay.style.display = "none";
        }

        console.log("Voice recognition and UI mic resources fully cleaned up.");
    };

    // 🔇 TTS期间暂停语音识别（不关闭UI麦克风）
    const pauseRecognitionForTTS = () => {
        if (!appState.isVoiceMode || recognitionPausedByTTS) return;
        recognitionPausedByTTS = true;
        if (appState.autoSendTimer) {
            clearTimeout(appState.autoSendTimer);
            appState.autoSendTimer = null;
        }
        if (typeof stopRecord === 'function') {
            try {
                stopRecord();
            } catch (e) {
                console.warn("Error pausing recognition for TTS:", e);
            }
        }
        console.log('⏸️ 语音识别已在TTS期间暂停');
    };

    // 🔊 TTS结束后恢复语音识别
    const resumeRecognitionAfterTTS = () => {
        if (!recognitionPausedByTTS) return;
        recognitionPausedByTTS = false;
        if (!appState.isVoiceMode) return;
        startRecognition();
        console.log('▶️ TTS结束，语音识别已恢复');
    };

    // 全局麦克风资源清理函数
    const cleanupAllMicrophoneResources = () => {
        console.log("Starting comprehensive microphone cleanup...");

        // 1. 停止语音识别
        if (typeof stopRecord === 'function') {
            try {
                stopRecord();
            } catch (e) {
                console.warn("Error stopping record in cleanup:", e);
            }
        }

        // 2. 关闭UI麦克风
        if (appState.uiMicStream) {
            appState.uiMicStream.getTracks().forEach(track => {
                track.stop();
                console.log(`UI Mic track ${track.id} stopped in cleanup.`);
            });
            appState.uiMicStream = null;
        }

        // 3. 清理音频分析器
        if (appState.uiVoiceAnalyser) {
            if (appState.uiVoiceAnalyser.context?.state !== 'closed') {
                try {
                    appState.uiVoiceAnalyser.disconnect();
                } catch (e) {
                    /* ignore */
                }
            }
            appState.uiVoiceAnalyser = null;
        }

        // 🔥 新增：清理麦克风音量控制节点
        if (appState.micGainNode) {
            try {
                appState.micGainNode.disconnect();
                console.log("Mic GainNode disconnected in cleanup.");
            } catch (e) {
                console.warn("Error disconnecting GainNode:", e);
            }
            appState.micGainNode = null;
        }

        // 5. 强制关闭所有音频上下文
        try {
            // 查找并关闭所有活跃的AudioContext
            const audioContexts = [];
            
            // 检查全局变量
            if (window.ctxAudio && window.ctxAudio.state !== 'closed') {
                audioContexts.push(window.ctxAudio);
            }
            
            // 检查可能的其他AudioContext实例
            if (window.sharedAudioContext && window.sharedAudioContext.state !== 'closed') {
                audioContexts.push(window.sharedAudioContext);
            }
            
            // 关闭所有找到的AudioContext
            audioContexts.forEach(ctx => {
                try {
                    if (ctx.state !== 'closed') {
                        ctx.close().then(() => {
                            console.log("AudioContext closed successfully in cleanup");
                        }).catch(e => {
                            console.warn("Error closing AudioContext:", e);
                        });
                    }
                } catch (e) {
                    console.warn("Error accessing AudioContext:", e);
                }
            });
        } catch (e) {
            console.warn("Error in AudioContext cleanup:", e);
        }

        // 6. 重置状态
        appState.isVoiceMode = false;
        if (appState.autoSendTimer) {
            clearTimeout(appState.autoSendTimer);
            appState.autoSendTimer = null;
        }
        
        // 🔥 新增：同步VoiceStateManager状态
        if (typeof VoiceStateManager !== 'undefined') {
            VoiceStateManager.syncWithVoiceMode(false);
        }
        if (appState.voiceActiveAndIdleTimer) {
            clearTimeout(appState.voiceActiveAndIdleTimer);
            appState.voiceActiveAndIdleTimer = null;
        }

        // 7. 更新UI
        if (DOMElements.toggleIcon) {
            DOMElements.toggleIcon.textContent = "keyboard";
            DOMElements.toggleIcon.style.color = "orange";
            DOMElements.toggleIcon.classList.remove("breathing");
        }
        if (DOMElements.soundWaveOverlay) {
            DOMElements.soundWaveOverlay.style.display = "none";
        }

        // 8. 强制垃圾回收（如果浏览器支持）
        if (window.gc) {
            try {
                window.gc();
                console.log("Forced garbage collection in cleanup");
            } catch (e) {
                console.warn("Garbage collection not available:", e);
            }
        }

        console.log("All microphone resources cleaned up successfully.");
    };
    /**
     * 控制“语音灵敏度调节器”面板显隐（仅负责简单 DOM 操作）
     * @param {boolean} visible 是否显示
     */
    const setVoiceSensitivityPanelVisible = (visible) => {
        try {
            const panel = document.getElementById('voiceSensitivityPanel');
            if (!panel) return; // 某些页面可能没有该面板，静默跳过
            panel.style.display = visible ? 'flex' : 'none';
            console.log(`🎚 灵敏度调节器面板已${visible ? '显示（语音模式）' : '隐藏（键盘模式）'}`);
        } catch (err) {
            console.warn('⚠️ 更新灵敏度调节器可见性时出错:', err);
        }
    };

    const toggleInputMode = async () => {
        console.log(`🔄 切换输入模式: 当前模式 = ${appState.isVoiceMode ? '语音' : '键盘'}`);
        
        if (appState.isVoiceMode) {
            console.log("📱 从语音模式切换到键盘模式...");
            appState.isVoiceMode = false; 
            stopRecognition();
            if (DOMElements.soundWaveOverlay) DOMElements.soundWaveOverlay.style.display = "none";
            // 键盘模式下隐藏灵敏度面板
            setVoiceSensitivityPanelVisible(false);
            if (DOMElements.toggleIcon) { 
                DOMElements.toggleIcon.textContent = "keyboard"; 
                DOMElements.toggleIcon.style.color = "orange"; 
                DOMElements.toggleIcon.classList.remove("breathing"); 
            }
            Utils.setInputPlaceholder("请用键盘输入文本"); 
            if (appState.voiceActiveAndIdleTimer) clearTimeout(appState.voiceActiveAndIdleTimer);
            console.log("✅ 已切换到键盘模式");
            
            // 🔥 新增：同步VoiceStateManager状态
            if (typeof VoiceStateManager !== 'undefined') {
                VoiceStateManager.syncWithVoiceMode(false);
            }
        } else {
            console.log("🎤 从键盘模式切换到语音模式...");
            appState.isVoiceMode = true;
            try {
                await initMicAndVoiceWave();
                if (appState.uiMicStream?.active) { 
                    startRecognition(); 
                    if (DOMElements.soundWaveOverlay) DOMElements.soundWaveOverlay.style.display = "block"; 
                    // 确保语音模式时立即启动波纹绘制
                    drawAdvancedVoiceWave();
                }
                else { 
                    appState.isVoiceMode = false; 
                    if (DOMElements.toggleIcon) { 
                        DOMElements.toggleIcon.textContent = "mic_off"; 
                        DOMElements.toggleIcon.style.color = "red"; 
                        DOMElements.toggleIcon.classList.remove("breathing"); 
                    } 
                    Utils.setInputPlaceholder("麦克风启动失败"); 
                    
                    // 🔥 新增：同步VoiceStateManager状态（失败情况）
                    if (typeof VoiceStateManager !== 'undefined') {
                        VoiceStateManager.syncWithVoiceMode(false);
                    }
                }
            } catch (err) {
                appState.isVoiceMode = false; 
                console.error("Error toggling to voice mode:", err);
                if (DOMElements.toggleIcon) { 
                    DOMElements.toggleIcon.textContent = "mic_off"; 
                    DOMElements.toggleIcon.style.color = "red"; 
                    DOMElements.toggleIcon.classList.remove("breathing"); 
                }
                Utils.setInputPlaceholder("麦克风启动失败，请检查权限");
                
                // 🔥 新增：同步VoiceStateManager状态（异常情况）
                if (typeof VoiceStateManager !== 'undefined') {
                    VoiceStateManager.syncWithVoiceMode(false);
                }
            }
            if (appState.isVoiceMode) {
                if (DOMElements.toggleIcon) { 
                    DOMElements.toggleIcon.textContent = "mic"; 
                    DOMElements.toggleIcon.style.color = "white"; 
                    DOMElements.toggleIcon.classList.add("breathing"); 
                }
                Utils.setInputPlaceholder("请用语音输入（系统自动识别成文字）"); 
                resetVoiceActiveAndIdleTimer();
                console.log("✅ 已切换到语音模式");
                
                // 语音模式下显示灵敏度面板
                setVoiceSensitivityPanelVisible(true);
                
                // 🔥 新增：同步VoiceStateManager状态
                if (typeof VoiceStateManager !== 'undefined') {
                    VoiceStateManager.syncWithVoiceMode(true);
                }
            }
        }
        const focusTarget = Utils.getPlaceholderTarget();
        if (focusTarget && focusTarget.tagName === 'TEXTAREA') focusTarget.focus(); 
        else if (focusTarget?.focus) focusTarget.focus();
    };

    if (DOMElements.toggleBtn) { DOMElements.toggleBtn.addEventListener('click', toggleInputMode); }

    return {
        startInitialRecognition: startRecognition,
        stopVoiceRecognition: stopRecognition,
        pauseRecognitionForTTS,
        resumeRecognitionAfterTTS,
        toggleInputMode,
        initMicAndVoiceWave,
        resetVoiceActiveAndIdleTimer,
        resetAutoSendTimer,
        resetAutoSendTimerForPresetQuestion,
        cleanupAllMicrophoneResources,
        // 🔥 新增：暴露麦克风控制方法
        muteMicrophoneForTTS,
        restoreMicrophoneAfterTTS
    };
})();

/*================== Voice State Manager ==================*/
const VoiceStateManager = (() => {
    // 🎯 语音状态枚举 - 增强版
    const VOICE_STATES = {
        VOICE_OFF: 'voice_off',        // 橙色：语音关闭
        VOICE_ON: 'voice_on',          // 绿色：语音开启  
        TTS_PREPARING: 'tts_preparing', // 🔥 新增：黄色：TTS准备中
        TTS_PLAYING: 'tts_playing'     // 红色：TTS播放中
    };

    // 🎨 状态对应的视觉配置 - 增强版
    const STATE_CONFIGS = {
        [VOICE_STATES.VOICE_OFF]: {
            icon: 'keyboard',           // 🔥 修改：换成小键盘图标
            backgroundColor: '#ff8c00',  // 橙色
            color: '#ffffff',
            pulse: false,
            tooltip: '点击开启语音模式'
        },
        [VOICE_STATES.VOICE_ON]: {
            icon: 'mic',                // 🔥 保持不变：麦克风图标
            backgroundColor: '#28a745',  // 绿色
            color: '#ffffff', 
            pulse: false,
            tooltip: '语音模式已开启'
        },
        [VOICE_STATES.TTS_PREPARING]: {
            icon: 'hourglass_empty',    // 🔥 新增：沙漏图标表示准备中
            backgroundColor: '#ffc107',  // 黄色
            color: '#212529',
            pulse: true,                 // 准备状态有脉冲动画
            tooltip: 'TTS合成中，请稍候'
        },
        [VOICE_STATES.TTS_PLAYING]: {
            icon: 'volume_off',         // 🔥 修改：小喇叭上有斜线（打断对话）
            backgroundColor: '#dc3545',  // 红色
            color: '#ffffff',
            pulse: true,                 // 红色状态有脉冲动画
            tooltip: '点击中断TTS播放'
        }
    };

    const appState = AppStateManager.getState();
    let currentState = VOICE_STATES.VOICE_OFF;
    
    // 🔥 新增：自动回到初始化状态的计时器
    let autoReturnToInitTimer = null;
    const AUTO_RETURN_TO_INIT_DELAY = 60 * 1000; // 60秒

    // 🔧 获取浮动语音状态按钮
    const getVoiceStatusButton = () => {
        return document.getElementById('voiceStatusBtn');
    };

    // 🎨 更新按钮视觉效果
    const updateButtonAppearance = (state) => {
        const button = getVoiceStatusButton();
        if (!button) {
            console.warn('Voice status button not found');
            return;
        }

        const config = STATE_CONFIGS[state];
        if (!config) {
            console.warn('Invalid voice state:', state);
            return;
        }

        // 更新图标
        const icon = button.querySelector('i');
        if (icon) {
            icon.textContent = config.icon;
        }

        // 🔥 修复：使用data-state属性而不是直接设置style
        button.setAttribute('data-state', state);
        
        // 更新脉冲动画
        if (config.pulse) {
            button.classList.add('pulse-animation');
        } else {
            button.classList.remove('pulse-animation');
        }

        // 更新提示文本
        button.title = config.tooltip;

        console.log(`🎨 Voice button updated to state: ${state}`);
    };

    // 🔄 状态切换核心方法
    const setState = (newState) => {
        if (!Object.values(VOICE_STATES).includes(newState)) {
            console.warn('Invalid voice state:', newState);
            return;
        }

        const previousState = currentState;
        currentState = newState;

        console.log(`🔄 Voice state changed: ${previousState} -> ${newState}`);

        // 更新视觉效果
        updateButtonAppearance(newState);

        // 状态切换时的特殊逻辑
        handleStateTransition(previousState, newState);
    };

    // 🎯 状态切换时的特殊处理逻辑 - 增强版
    const handleStateTransition = (fromState, toState) => {
        // TTS准备阶段：提前静音麦克风
        if (toState === VOICE_STATES.TTS_PREPARING) {
            console.log('🔇 TTS preparing, muting microphone early');
            if (VoiceInputHandler?.muteMicrophoneForTTS) {
                VoiceInputHandler.muteMicrophoneForTTS();
            }
            if (VoiceInputHandler?.pauseRecognitionForTTS) {
                VoiceInputHandler.pauseRecognitionForTTS();
            }
        }

        // TTS开始播放：确保麦克风已静音
        if (toState === VOICE_STATES.TTS_PLAYING) {
            console.log('🔇 TTS started, ensuring microphone is muted');
            if (VoiceInputHandler?.muteMicrophoneForTTS) {
                VoiceInputHandler.muteMicrophoneForTTS();
            }
            if (VoiceInputHandler?.pauseRecognitionForTTS) {
                VoiceInputHandler.pauseRecognitionForTTS();
            }
        }

        // TTS结束播放：恢复麦克风（如果之前是语音开启状态）
        if ((fromState === VOICE_STATES.TTS_PLAYING || fromState === VOICE_STATES.TTS_PREPARING) 
            && toState === VOICE_STATES.VOICE_ON) {
            console.log('🔊 TTS ended, restoring microphone');
            if (VoiceInputHandler?.restoreMicrophoneAfterTTS) {
                VoiceInputHandler.restoreMicrophoneAfterTTS();
            }
            if (VoiceInputHandler?.resumeRecognitionAfterTTS) {
                VoiceInputHandler.resumeRecognitionAfterTTS();
            }
        }

        // 语音模式开启：确保麦克风可用
        if (toState === VOICE_STATES.VOICE_ON && fromState === VOICE_STATES.VOICE_OFF) {
            console.log('🎤 Voice mode enabled');
            // 这里可以添加语音模式启用的额外逻辑
        }

        // 语音模式关闭：清理资源
        if (toState === VOICE_STATES.VOICE_OFF && fromState !== VOICE_STATES.VOICE_OFF) {
            console.log('🔇 Voice mode disabled');
            // 这里可以添加语音模式禁用的额外逻辑
        }

        // 🔥 新增：从准备状态被中断
        if (fromState === VOICE_STATES.TTS_PREPARING && 
            (toState === VOICE_STATES.VOICE_ON || toState === VOICE_STATES.VOICE_OFF)) {
            console.log('⏹️ TTS preparation interrupted');
            // 重置TTS状态
            window.TTS_PENDING = false;
            window.TTS_PLAYING = false;
        }
    };

    // 📱 公共API方法 - 增强版
    const startTTSPreparation = () => {
        setState(VOICE_STATES.TTS_PREPARING);
    };

    const startTTS = (options) => {
        setState(VOICE_STATES.TTS_PLAYING);
        if (typeof SubtitleManager !== 'undefined') {
            if (options && typeof options === 'object') {
                SubtitleManager.onTTSStart(options);
            } else {
                SubtitleManager.onTTSStart(window.LAST_TTS_DURATION_SEC);
            }
        }
    };

    const stopTTS = () => {
        // TTS停止后，恢复到之前的语音状态
        const targetState = appState.isVoiceMode ? VOICE_STATES.VOICE_ON : VOICE_STATES.VOICE_OFF;
        setState(targetState);
        if (typeof SubtitleManager !== 'undefined') {
            SubtitleManager.onTTSEnd();
        }
        
        // 🔥 新增：TTS结束后启动自动回到初始化状态的计时器
        startAutoReturnToInitTimer();
    };

    const isInPreparationMode = () => {
        return currentState === VOICE_STATES.TTS_PREPARING;
    };

    const enableVoiceMode = () => {
        setState(VOICE_STATES.VOICE_ON);
    };

    const disableVoiceMode = () => {
        setState(VOICE_STATES.VOICE_OFF);
    };

    const getCurrentState = () => {
        return currentState;
    };

    const isInTTSMode = () => {
        return currentState === VOICE_STATES.TTS_PLAYING;
    };

    // 🎛️ 浮动按钮点击处理逻辑
    const handleButtonClick = () => {
        console.log(`🖱️ Voice status button clicked, current state: ${currentState}`);

        switch (currentState) {
            case VOICE_STATES.VOICE_OFF:
                // 橙色状态点击：开启语音模式
                console.log('Switching to voice mode...');
                if (VoiceInputHandler?.toggleInputMode) {
                    VoiceInputHandler.toggleInputMode();
                }
                break;

            case VOICE_STATES.VOICE_ON:
                // 绿色状态点击：关闭语音模式
                console.log('Switching to text mode...');
                if (VoiceInputHandler?.toggleInputMode) {
                    VoiceInputHandler.toggleInputMode();
                }
                break;

            case VOICE_STATES.TTS_PREPARING:
                // 🔥 新增：黄色状态点击：中断TTS准备
                console.log('Interrupting TTS preparation...');
                if (typeof AIModelManager !== 'undefined' && AIModelManager.interruptTTS) {
                    AIModelManager.interruptTTS();
                    stopTTS();
                } else {
                    console.warn('TTS interrupt method not available');
                    stopTTS();
                }
                break;

            case VOICE_STATES.TTS_PLAYING:
                // 红色状态点击：中断TTS播放
                console.log('Interrupting TTS playback...');
                // 🔥 使用新的TTS中断方法
                if (typeof AIModelManager !== 'undefined' && AIModelManager.interruptTTS) {
                    AIModelManager.interruptTTS();
                    // 中断后自动切换状态
                    stopTTS();
                } else {
                    console.warn('TTS interrupt method not available');
                    // 备用处理：直接切换状态
                    stopTTS();
                }
                break;

            default:
                console.warn('Unknown voice state:', currentState);
        }
    };

    // 🚀 初始化方法 - 增强版
    const init = () => {
        console.log('🚀 VoiceStateManager.init() 开始初始化...');
        console.log('📊 初始化环境检查:', {
            documentReady: document.readyState,
            timestamp: new Date().toISOString(),
            currentVoiceMode: appState.isVoiceMode
        });
        
        // 尝试初始化按钮
        const attemptInit = () => {
            const button = getVoiceStatusButton();
            console.log('🔍 查找按钮结果:', button ? '✅ 找到' : '❌ 未找到');
            
            if (button) {
                console.log('🔍 按钮元素详情:', {
                    id: button.id,
                    className: button.className,
                    innerHTML: button.innerHTML.substring(0, 50) + '...',
                    offsetParent: button.offsetParent !== null,
                    style: button.style.display
                });
                
                // 检查是否已经绑定过事件（避免重复绑定）
                if (!button.hasAttribute('data-voice-state-initialized')) {
                    // 绑定按钮点击事件
                    button.addEventListener('click', handleButtonClick);
                    button.setAttribute('data-voice-state-initialized', 'true');
                    console.log('✅ 按钮事件已绑定（首次）');
                } else {
                    console.log('⚠️ 按钮事件已存在，跳过重复绑定');
                }
                
                // 根据当前语音模式设置初始状态
                const initialState = appState.isVoiceMode ? VOICE_STATES.VOICE_ON : VOICE_STATES.VOICE_OFF;
                console.log(`🎯 设置初始状态: ${initialState} (语音模式: ${appState.isVoiceMode})`);
                setState(initialState);
                
                console.log('✅ VoiceStateManager 初始化完成');
                
                // 🔍 启动状态监控
                startStateMonitoring();
                
                return true;  // 初始化成功
            } else {
                console.warn('❌ VoiceStateManager 初始化失败：找不到浮动按钮元素');
                
                // 调试信息：查看所有按钮
                const allButtons = document.querySelectorAll('button');
                console.log('🔍 页面中所有按钮:', Array.from(allButtons).map(btn => ({
                    id: btn.id || 'no-id',
                    className: btn.className || 'no-class',
                    visible: btn.offsetParent !== null
                })));
                
                return false;  // 初始化失败
            }
        };
        
        // 立即尝试初始化
        if (attemptInit()) {
            return;  // 成功，退出
        }
        
        // 如果失败，设置延迟重试机制
        console.log('⏰ 按钮未找到，启动延迟重试机制...');
        let retryCount = 0;
        const maxRetries = 5;
        const retryInterval = 500;  // 500ms间隔
        
        const retryInit = () => {
            retryCount++;
            console.log(`🔄 重试初始化 (${retryCount}/${maxRetries})...`);
            
            if (attemptInit()) {
                console.log('✅ 延迟初始化成功！');
                return;
            }
            
            if (retryCount < maxRetries) {
                setTimeout(retryInit, retryInterval);
            } else {
                console.error('❌ VoiceStateManager 初始化最终失败：重试次数已达上限');
                // 提供手动初始化接口
                window.retryVoiceStateManager = () => {
                    console.log('🔧 手动重试VoiceStateManager初始化...');
                    init();
                };
                console.log('💡 可通过 window.retryVoiceStateManager() 手动重试');
            }
        };
        
        setTimeout(retryInit, retryInterval);
    };

    // 🔄 与现有系统同步状态的方法 - 增强版
    const syncWithVoiceMode = (isVoiceMode) => {
        console.log(`🔄 同步语音模式状态: ${isVoiceMode ? '开启' : '关闭'} (当前状态: ${currentState})`);
        
        const targetState = isVoiceMode ? VOICE_STATES.VOICE_ON : VOICE_STATES.VOICE_OFF;
        
        // 如果当前是TTS播放状态，不立即切换，记录目标状态
        if (currentState === VOICE_STATES.TTS_PLAYING) {
            console.log('⏸️ TTS正在播放，延迟状态同步');
            // 更新appState但不立即切换UI状态
            appState.isVoiceMode = isVoiceMode;
        } else {
            setState(targetState);
            console.log(`✅ 状态同步完成: ${targetState}`);
        }
    };

    // 🔧 新增：强制状态检查和修复方法
    const checkAndFixState = () => {
        const button = getVoiceStatusButton();
        if (!button) {
            console.warn('⚠️ 按钮不存在，无法检查状态');
            return false;
        }

        // 🔥 新增：更智能的状态检查逻辑
        const actualTTSStates = {
            windowTTSPlaying: window.TTS_PLAYING || false
        };
        
        const anyTTSPlaying = Object.values(actualTTSStates).some(state => state);
        const isTTSPending = window.TTS_PENDING || false;
        
        let expectedState;
        if (anyTTSPlaying) {
            expectedState = VOICE_STATES.TTS_PLAYING;
        } else if (isTTSPending) {
            expectedState = VOICE_STATES.TTS_PREPARING;
        } else {
            expectedState = appState.isVoiceMode ? VOICE_STATES.VOICE_ON : VOICE_STATES.VOICE_OFF;
        }
        
        if (currentState !== expectedState) {
            console.log(`🔧 检测到状态不一致，修复中: ${currentState} -> ${expectedState}`);
            setState(expectedState);
            return true;
        }

        console.log('✅ 状态检查正常');
        return false;
    };

    // 🔧 新增：状态诊断方法 - 增强版
    const diagnosticReport = () => {
        const button = getVoiceStatusButton();
        
        // 检查实际TTS播放状态
        const actualTTSStates = {
            windowTTSPlaying: window.TTS_PLAYING || false
        };
        
        const anyTTSPlaying = Object.values(actualTTSStates).some(state => state);
        const isTTSPending = window.TTS_PENDING || false;
        
        // 🔥 新增：更精确的状态判断逻辑
        let expectedTTSState;
        if (anyTTSPlaying) {
            expectedTTSState = VOICE_STATES.TTS_PLAYING;
        } else if (isTTSPending) {
            expectedTTSState = VOICE_STATES.TTS_PREPARING;
        } else {
            expectedTTSState = appState.isVoiceMode ? VOICE_STATES.VOICE_ON : VOICE_STATES.VOICE_OFF;
        }
        
        const report = {
            timestamp: new Date().toISOString(),
            currentState: currentState,
            expectedState: expectedTTSState,
            appStateVoiceMode: appState.isVoiceMode,
            buttonExists: !!button,
            buttonInitialized: button?.hasAttribute('data-voice-state-initialized'),
            buttonDataState: button?.getAttribute('data-state'),
            actualTTSStates: actualTTSStates,
            anyTTSPlaying: anyTTSPlaying,
            isTTSPending: isTTSPending,
            windowTTSStates: {
                TTS_PLAYING: window.TTS_PLAYING,
                TTS_PENDING: window.TTS_PENDING
            },
            isConsistent: currentState === expectedTTSState,
            needsFixing: currentState !== expectedTTSState
        };
        
        console.log('📊 VoiceStateManager 状态诊断报告:', report);
        return report;
    };

    // 🔧 新增：自动状态一致性监控
    let stateMonitorInterval = null;
    const startStateMonitoring = () => {
        if (stateMonitorInterval) {
            clearInterval(stateMonitorInterval);
        }
        
        stateMonitorInterval = setInterval(() => {
            const report = diagnosticReport();
            if (report.needsFixing) {
                console.warn('⚠️ 检测到状态不一致，尝试自动修复...');
                checkAndFixState();
            }
        }, 5000); // 每5秒检查一次
        
        console.log('🔍 状态监控已启动（5秒间隔）');
    };

    const stopStateMonitoring = () => {
        if (stateMonitorInterval) {
            clearInterval(stateMonitorInterval);
            stateMonitorInterval = null;
            console.log('🛑 状态监控已停止');
        }
    };

    // 🔥 新增：自动回到初始化状态的方法
    const returnToInitialState = () => {
        console.log('🔄 自动回到初始化状态');
        
        // 1. 强制关闭语音识别模式
        appState.isVoiceMode = false;
        
        // 2. 停止语音识别功能
        if (typeof VoiceInputHandler !== 'undefined' && VoiceInputHandler.stopVoiceRecognition) {
            VoiceInputHandler.stopVoiceRecognition();
        }
        
        // 3. 清理所有麦克风资源
        if (typeof VoiceInputHandler !== 'undefined' && VoiceInputHandler.cleanupAllMicrophoneResources) {
            VoiceInputHandler.cleanupAllMicrophoneResources();
        }
        
        // 4. 同步VoiceStateManager到关闭状态
        setState(VOICE_STATES.VOICE_OFF);
        
        // 5. 更新原始toggleBtn的UI状态
        if (DOMElements.toggleIcon) {
            DOMElements.toggleIcon.textContent = "keyboard";
            DOMElements.toggleIcon.style.color = "orange";
            DOMElements.toggleIcon.classList.remove("breathing");
        }
        
        // 6. 更新输入框为键盘输入模式
        if (typeof Utils !== 'undefined' && Utils.setInputPlaceholder) {
            Utils.setInputPlaceholder("请用键盘输入文本");
        }
        
        // 7. 清理音波显示
        if (DOMElements.soundWaveOverlay) {
            DOMElements.soundWaveOverlay.style.display = "none";
        }
        
        // 🔥 清空聊天记录并回到引导界面
        if (typeof ConversationManager !== 'undefined' && ConversationManager.initConversation) {
            ConversationManager.initConversation();
            console.log('🗑️ 已清空聊天记录并重置对话状态');
        }
        
        console.log('✅ 已回到初始化状态：语音识别已关闭，切换为键盘输入，清空聊天记录，显示引导界面');
    };

    // 🔥 新增：启动自动回到初始化状态的计时器
    const startAutoReturnToInitTimer = () => {
        clearAutoReturnToInitTimer(); // 先清除现有计时器
        autoReturnToInitTimer = setTimeout(() => {
            console.log('⏰ TTS结束60秒后自动回到初始化状态');
            returnToInitialState();
        }, AUTO_RETURN_TO_INIT_DELAY);
        console.log('⏳ 已启动60秒自动回到初始化状态计时器');
    };

    // 🔥 新增：清除自动回到初始化状态的计时器
    const clearAutoReturnToInitTimer = () => {
        if (autoReturnToInitTimer) {
            clearTimeout(autoReturnToInitTimer);
            autoReturnToInitTimer = null;
            console.log('🚫 已清除自动回到初始化状态计时器');
        }
    };

    return {
        // 状态管理
        VOICE_STATES,
        getCurrentState,
        isInTTSMode,
        
        // TTS控制
        startTTSPreparation,  // 🔥 新增：TTS准备状态
        startTTS,
        stopTTS,
        isInPreparationMode,  // 🔥 新增：检查是否在准备状态
        
        // 语音模式控制
        enableVoiceMode,
        disableVoiceMode,
        syncWithVoiceMode,
        
        // 初始化
        init,
        
        // 🔥 新增：自动回到初始化状态控制
        clearAutoReturnToInitTimer,
        
        // 🔧 新增：调试和维护方法
        checkAndFixState,
        diagnosticReport,
        getVoiceStatusButton,  // 暴露按钮获取方法
        startStateMonitoring,  // 启动状态监控
        stopStateMonitoring,   // 停止状态监控
        
        // 手动状态设置（调试用）
        setState
    };
})();

// 🔧 全局调试接口 - VoiceStateManager
window.VoiceStateManager = VoiceStateManager;
window.debugVoiceState = () => {
    console.log('🛠️ ===== VoiceStateManager 调试信息 =====');
    if (typeof VoiceStateManager !== 'undefined') {
        VoiceStateManager.diagnosticReport();
        VoiceStateManager.checkAndFixState();
        
        // 显示详细按钮信息
        const button = VoiceStateManager.getVoiceStatusButton();
        if (button) {
            console.log('🔍 按钮详细信息:', {
                element: button,
                computed: window.getComputedStyle(button),
                rect: button.getBoundingClientRect(),
                events: '需要在DevTools中查看getEventListeners()'
            });
        }
    } else {
        console.error('❌ VoiceStateManager 未定义');
    }
    console.log('🛠️ ================================');
};

// 🔧 状态监控控制接口
window.startVoiceStateMonitoring = () => {
    if (typeof VoiceStateManager !== 'undefined') {
        VoiceStateManager.startStateMonitoring();
    } else {
        console.error('❌ VoiceStateManager 未定义');
    }
};

window.stopVoiceStateMonitoring = () => {
    if (typeof VoiceStateManager !== 'undefined') {
        VoiceStateManager.stopStateMonitoring();
    } else {
        console.error('❌ VoiceStateManager 未定义');
    }
};

/*================== Knowledge Base Access & Handler ==================*/
const KnowledgeBaseAccessManager = (() => {
    let passwordModal = null;
    let passwordInput = null;
    let passwordError = null;
    let passwordTitle = null;
    let isKnowledgeBaseOpen = false;

    const setIndexFloatingControlsVisible = (visible) => {
        const displayValue = visible ? '' : 'none';
        const voiceStatusBtn = document.getElementById('voiceStatusBtn');
        const knowledgeBaseBtn = DOMElements.knowledgeBaseBtn || document.getElementById('knowledgeBaseBtn');

        if (voiceStatusBtn) {
            voiceStatusBtn.style.display = displayValue;
        }
        if (knowledgeBaseBtn) {
            knowledgeBaseBtn.style.display = displayValue;
        }
    };

    function createPasswordModal() {
        if (passwordModal) return;

        passwordModal = document.createElement('div');
        passwordModal.className = 'kb-password-modal';

        const title = document.createElement('h3');
        title.textContent = '请输入访问密码';
        title.className = 'kb-password-title';
        passwordTitle = title;

        passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.className = 'kb-password-input';

        passwordError = document.createElement('p');
        passwordError.className = 'kb-password-error';

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'kb-password-button-container';

        const submitButton = document.createElement('button');
        submitButton.textContent = '确认';
        submitButton.className = 'kb-password-submit-btn';

        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.className = 'kb-password-cancel-btn';

        buttonContainer.appendChild(submitButton);
        buttonContainer.appendChild(cancelButton);

        passwordModal.appendChild(title);
        passwordModal.appendChild(passwordInput);
        passwordModal.appendChild(passwordError);
        passwordModal.appendChild(buttonContainer);

        document.body.appendChild(passwordModal);

        submitButton.addEventListener('click', handlePasswordSubmit);
        cancelButton.addEventListener('click', hidePasswordModal);
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handlePasswordSubmit();
        });
    }

    function showPasswordModal() {
        if (!passwordModal) createPasswordModal();
        // Ensure modal is displayed (CSS will handle initial display:none if preferred)
        passwordModal.style.display = 'flex'; // Or rely on CSS to make it visible by adding/removing a class

        if (passwordTitle) {
            passwordTitle.textContent = '请输入知识库密码';
        }
        if (passwordError) passwordError.textContent = '';
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.focus();
        }
    }

    function hidePasswordModal() {
        if (passwordModal) passwordModal.style.display = 'none'; // Or rely on CSS
    }

    // 🔥 新增：统一的打开知识库页面函数
    function openKnowledgeBasePage() {
        console.log('📚 打开知识库页面');
        hidePasswordModal();
        setIndexFloatingControlsVisible(false);
        if (DOMElements.chatContainer) DOMElements.chatContainer.style.display = "none";
        if (DOMElements.knowledgeBasePage) DOMElements.knowledgeBasePage.style.display = "block";
        if (typeof KnowledgeBaseHandler !== 'undefined' && KnowledgeBaseHandler.updateList) {
            KnowledgeBaseHandler.updateList();
        }
        
        // 🔥 关键：添加浏览器历史记录状态
        if (!isKnowledgeBaseOpen) {
            history.pushState({ page: 'knowledgeBase' }, '', '#knowledge-base');
            isKnowledgeBaseOpen = true;
            console.log('✅ 已添加知识库页面到浏览器历史记录');
        }
    }

    // 🔥 新增：统一的关闭知识库页面函数
    function closeKnowledgeBasePage(fromPopState = false) {
        console.log('🔙 关闭知识库页面', fromPopState ? '(浏览器返回按钮)' : '(关闭按钮)');
        
        if (DOMElements.knowledgeBasePage) DOMElements.knowledgeBasePage.style.display = "none";
        if (DOMElements.chatContainer) DOMElements.chatContainer.style.display = "block";
        setIndexFloatingControlsVisible(true);
        hidePasswordModal();
        
        isKnowledgeBaseOpen = false;
        
        // 🔥 如果不是通过popstate触发的（即用户点击关闭按钮），需要回退历史记录
        if (!fromPopState && history.state && history.state.page === 'knowledgeBase') {
            history.back();
            console.log('🔄 已回退浏览器历史记录');
        }
        
        console.log('✅ 已返回聊天页面');
    }

    function handlePasswordSubmit() {
        if (!passwordInput || !passwordError) return;

        if (passwordInput.value !== KNOWLEDGE_BASE_PASSWORD) {
            passwordError.textContent = '密码错误，请重试！';
            passwordInput.focus();
            passwordInput.select();
            return;
        }

        openKnowledgeBasePage();
    }

    // 🔥 新增：监听浏览器返回按钮
    window.addEventListener('popstate', (event) => {
        console.log('🔙 检测到浏览器返回事件', event.state);
        
        // 如果当前在知识库页面，且用户点击了返回按钮
        if (isKnowledgeBaseOpen && (!event.state || event.state.page !== 'knowledgeBase')) {
            closeKnowledgeBasePage(true); // 标记为来自popstate事件
        }
    });

    if (DOMElements.knowledgeBaseBtn) {
        DOMElements.knowledgeBaseBtn.addEventListener('click', () => showPasswordModal());
    }

    // 首页默认显示浮动入口按钮
    setIndexFloatingControlsVisible(true);

    const isPasswordModalVisible = () => !!(passwordModal && passwordModal.style.display !== 'none');
    const isKnowledgeBasePageOpen = () => isKnowledgeBaseOpen;

    return {
        hidePasswordModal,
        closeKnowledgeBasePage: () => closeKnowledgeBasePage(false), // 供外部调用的关闭函数
        isPasswordModalVisible,
        isKnowledgeBasePageOpen
    };

})();


const KnowledgeBaseHandler = (() => { /* ... (保持不变) ... */
    const appState = AppStateManager.getState();
    const updateList = () => {
        if (!DOMElements.knowledgeBaseRight) return;
        appState.knowledgeFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));
        DOMElements.knowledgeBaseRight.innerHTML = ""; const fragment = document.createDocumentFragment();
        appState.knowledgeFiles.forEach(fileInfo => { fragment.appendChild(createKnowledgeFileItemElement(fileInfo)); });
        DOMElements.knowledgeBaseRight.appendChild(fragment);
    };

    const createKnowledgeFileItemElement = (fileInfo) => {
        const itemDiv = document.createElement("div"); itemDiv.className = "knowledge-file-item"; let thumbElement;
        if (fileInfo.fileType.startsWith("image/") && fileInfo.url) {
            thumbElement = new Image(); thumbElement.src = fileInfo.url; thumbElement.alt = "Preview";
            thumbElement.onerror = () => { thumbElement.alt = 'Error loading preview'; };
        } else {
            thumbElement = document.createElement("div"); const icon = document.createElement("span"); icon.className = "material-icons";
            icon.style.fontSize = `${knowledgeBaseConfig.fileItemThumbSize}px`; icon.textContent = getIconForFileType(fileInfo.fileType);
            thumbElement.appendChild(icon);
        }
        thumbElement.className = "knowledge-file-thumb"; itemDiv.appendChild(thumbElement);
        const infoDiv = document.createElement("div"); infoDiv.className = "knowledge-file-info";
        const nameDiv = document.createElement("div"); nameDiv.textContent = fileInfo.fileName; nameDiv.style.wordBreak = "break-all";
        infoDiv.appendChild(nameDiv); itemDiv.appendChild(infoDiv);
        const deleteBtn = document.createElement("button"); deleteBtn.className = "delete-file-btn";
        deleteBtn.innerHTML = `<span class="material-icons" style="font-size:18px; color:red;">delete</span>`; deleteBtn.title = `Delete ${fileInfo.fileName}`;
        deleteBtn.addEventListener('click', () => {
            appState.knowledgeFiles = appState.knowledgeFiles.filter(f => f !== fileInfo);
            if (fileInfo.url?.startsWith('blob:')) URL.revokeObjectURL(fileInfo.url);
            updateList();
        });
        itemDiv.appendChild(deleteBtn); return itemDiv;
    };
    const handleFileUploadForKnowledgeBase = (filesToUpload) => {
        Array.from(filesToUpload).forEach(file => {
            const previewUrl = (file.type.startsWith("image/")) ? URL.createObjectURL(file) : null;
            appState.knowledgeFiles.push({ file: file, fileType: file.type || 'application/octet-stream', fileName: file.name, uploadTime: Date.now(), url: previewUrl });
        });
        updateList();
    };

    if (DOMElements.closeKnowledgeBaseBtn) {
        DOMElements.closeKnowledgeBaseBtn.addEventListener('click', () => {
            // 🔥 使用统一的关闭知识库页面函数
            if (typeof KnowledgeBaseAccessManager !== 'undefined' && KnowledgeBaseAccessManager.closeKnowledgeBasePage) {
                KnowledgeBaseAccessManager.closeKnowledgeBasePage();
            }
        });
    }
    if (DOMElements.addFileBtn) {
        DOMElements.addFileBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = knowledgeBaseConfig.acceptedFileTypes;
            fileInput.multiple = true; fileInput.style.display = 'none';
            fileInput.onchange = () => { if (fileInput.files) handleFileUploadForKnowledgeBase(fileInput.files); document.body.removeChild(fileInput); };
            document.body.appendChild(fileInput); fileInput.click();
        });
    }
    if (DOMElements.dropZone) {
        DOMElements.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); DOMElements.dropZone.classList.add('dragover'); });
        DOMElements.dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); DOMElements.dropZone.classList.remove('dragover'); });
        DOMElements.dropZone.addEventListener('drop', (e) => { e.preventDefault(); DOMElements.dropZone.classList.remove('dragover'); if (e.dataTransfer?.files.length > 0) handleFileUploadForKnowledgeBase(e.dataTransfer.files); });
    }
    let uploadToKBBtnDyn = document.getElementById("uploadToBtn");
    let uploadKBStatusDyn = document.getElementById("uploadStatus");
    if (!uploadToKBBtnDyn && DOMElements.dropZone) {
        uploadToKBBtnDyn = document.createElement("button"); uploadToKBBtnDyn.id = "uploadToBtn"; uploadToKBBtnDyn.className = "upload-to-btn"; uploadToKBBtnDyn.textContent = "上传到知识库";
        DOMElements.dropZone.insertAdjacentElement("afterend", uploadToKBBtnDyn);
    }

    // 保持上传按钮位于 dropZone 下方（移除知识库页“返回首页”按钮与容器）
    if (!uploadKBStatusDyn && uploadToKBBtnDyn) {
        uploadKBStatusDyn = document.createElement("div"); uploadKBStatusDyn.id = "uploadStatus"; uploadKBStatusDyn.className = "upload-status";
        uploadToKBBtnDyn.insertAdjacentElement("afterend", uploadKBStatusDyn);
    }
    if (uploadToKBBtnDyn) {
        uploadToKBBtnDyn.addEventListener("click", () => {
            if (appState.knowledgeFiles.length === 0) { if (uploadKBStatusDyn) uploadKBStatusDyn.textContent = "请先添加文件"; return; }
            if (uploadKBStatusDyn) uploadKBStatusDyn.textContent = "上传中…"; const formData = new FormData();
            Promise.all(appState.knowledgeFiles.map(item => fileUploadBailian(item.file))).then(res => {
                if (uploadKBStatusDyn) uploadKBStatusDyn.textContent = "上传成功！";
                appState.knowledgeFiles.forEach(kf => { if (kf.url?.startsWith('blob:')) URL.revokeObjectURL(kf.url); });
                appState.knowledgeFiles = []; updateList();
                setTimeout(() => { if (uploadKBStatusDyn) uploadKBStatusDyn.textContent = ""; }, 3000);
            })
        });
    }

    // 知识库页不再提供“返回首页”按钮，主界面已有返回按钮
    return { updateList };
})();

/*================== Global Keydowns & Init ==================*/
const initializeGlobalHandlers = () => {
    // 防止重复绑定事件监听器
    if (window.__initedGlobalHandlers) {
        console.log("Global handlers already initialized, skipping...");
        return;
    }
    window.__initedGlobalHandlers = true;

    // 使用 requestAnimationFrame 优化 resize 处理
    let resizeRAF;
    window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeRAF);
        resizeRAF = requestAnimationFrame(adaptResolution);
    });
    const getDigitFromEvent = (e) => {
        if (e.code && e.code.startsWith('Digit') && !e.shiftKey) {
            return Number(e.code.replace('Digit', ''));
        }
        if (e.code && e.code.startsWith('Numpad')) {
            return Number(e.code.replace('Numpad', ''));
        }
        if (typeof e.key === 'string' && /^[0-9]$/.test(e.key)) {
            return Number(e.key);
        }
        return null;
    };

    const isEditableTarget = (el) => {
        if (!el || !(el instanceof Element)) return false;
        if (el.isContentEditable) return true;
        if (el.closest('[contenteditable="true"]')) return true;

        const inputLike = el.closest('input, textarea, select, [role="textbox"]');
        if (!inputLike) return false;
        if (inputLike.tagName !== 'INPUT') return true;

        const inputType = String(inputLike.type || '').toLowerCase();
        return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'].includes(inputType);
    };

    const isKnowledgeBaseContextActive = () => {
        const managerOpen = typeof KnowledgeBaseAccessManager !== 'undefined' &&
            ((KnowledgeBaseAccessManager.isKnowledgeBasePageOpen && KnowledgeBaseAccessManager.isKnowledgeBasePageOpen()) ||
                (KnowledgeBaseAccessManager.isPasswordModalVisible && KnowledgeBaseAccessManager.isPasswordModalVisible()));

        const knowledgeBasePageVisible = !!(DOMElements.knowledgeBasePage &&
            window.getComputedStyle(DOMElements.knowledgeBasePage).display !== 'none');

        return managerOpen || knowledgeBasePageVisible;
    };

    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (
            e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey &&
            (e.code === 'KeyV' || String(e.key || '').toLowerCase() === 'v')
        ) {
            e.preventDefault();
            const button = typeof VoiceStateManager !== 'undefined' && VoiceStateManager.getVoiceStatusButton
                ? VoiceStateManager.getVoiceStatusButton()
                : document.getElementById('voiceStatusBtn');
            if (button) {
                button.click();
            } else {
                console.warn('Voice status button not found for Alt+V');
            }
            return;
        }
        const isTextInputActive = DOMElements.textInput &&
            DOMElements.textInput.tagName === 'TEXTAREA' &&
            DOMElements.textInput === document.activeElement;
        const isEditableContext = isEditableTarget(document.activeElement) || isEditableTarget(e.target);
        const isIndexPageActive = !isKnowledgeBaseContextActive();
        const digit = getDigitFromEvent(e);
        if (
            digit !== null &&
            isIndexPageActive &&
            !isEditableContext &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
        ) {
            e.preventDefault();
            playManualVideo(digit);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isTextInputActive) { e.preventDefault(); DOMElements.sendBtn?.click(); }
        }
    });
};

const initializeApp = async () => { /* ... (保持不变) ... */
    try {
        console.log("🚀 开始初始化高级数字人应用...");
        const appState = AppStateManager.getState();

        // 性能优化：预缓存关键DOM元素
        console.log('⚡ 预缓存DOM元素...');
        const criticalElements = [
            'mainContainer', 'textInput', 'sendBtn',
            'toggleBtn', 'toggleIcon', 'soundWaveOverlay',
            'bgVideoA', 'bgVideoB', 'voiceStatusBtn'  // 🔥 新增：语音状态按钮
        ];
        DOMElements.preCache(criticalElements);
        console.log('✅ DOM缓存初始化完成，缓存了', criticalElements.length, '个关键元素');


        adaptResolution();
        initializeGlobalHandlers();
        ConversationManager.initConversation();
        // 仅在语音模式时初始化麦克风与声波
        if (AppStateManager.getState().isVoiceMode && typeof VoiceInputHandler !== 'undefined') {
            VoiceInputHandler.initMicAndVoiceWave();
        }

        // 🔥 新增：初始化语音状态管理器
        if (typeof VoiceStateManager !== 'undefined') {
            VoiceStateManager.init();
            console.log('✅ Voice State Manager initialized');
        } else {
            console.warn('VoiceStateManager not available');
        }

        // 初始状态应该是静音视频
        updateVideoByTTSState();

        if (!DOMElements.textInput) { console.warn("Chat input element with ID 'textInput' not found."); }

        if (appState.isVoiceMode && VoiceInputHandler) {
            // 注释掉自动启动语音识别，让用户手动选择
            try {
                 await VoiceInputHandler.startInitialRecognition(); 
            }catch (err) {
                 appState.isVoiceMode = false; 
                 if (DOMElements.toggleIcon) { 
                    DOMElements.toggleIcon.textContent = "mic_off";
                    DOMElements.toggleIcon.style.color = "red"; 
                    DOMElements.toggleIcon.classList.remove("breathing");
                } Utils.setInputPlaceholder("麦克风启动失败，请检查权限"); 
            }
            console.log("语音模式已禁用，用户需要手动点击麦克风按钮启用");
        } else if (!appState.isVoiceMode) {
            if (appState.voiceActiveAndIdleTimer) clearTimeout(appState.voiceActiveAndIdleTimer); appState.voiceActiveAndIdleTimer = null;
            Utils.setInputPlaceholder("请用键盘输入文本");
        }
        // 性能监控输出
        setTimeout(() => {
            const domStats = DOMElements.getQueryStats();
            console.log('📊 阶段二性能优化统计:', {
                DOM缓存命中率: domStats.hitRate,
                缓存大小: domStats.cacheSize,
                平均查询时间: domStats.performance.avgQueryTime?.toFixed(2) + 'ms',
                Token状态: typeof TokenManager !== 'undefined' ? TokenManager.getTokenStatus() : '未启用'
            });
        }, 3000);

        console.log('🎉 应用初始化完成！所有系统已就绪。');

    } catch (error) {
        console.error('❌ 应用初始化失败:', error);
        // 降级处理
        console.log('🔄 尝试基础功能初始化...');
        try {
            adaptResolution();
            ConversationManager.initConversation();
            console.log('✅ 基础功能初始化成功');
        } catch (basicError) {
            console.error('❌ 基础功能初始化也失败:', basicError);
        }
    }

    // 🔥 新增：暴露ConversationManager到全局作用域，供其他模块使用
    window.ConversationManager = ConversationManager;

    // 🔥 增强：页面卸载时的完整资源清理
    window.addEventListener('beforeunload', () => {
        console.log("🚪 页面卸载，清理所有资源...");
        
        // 1. 清理TTS播放状态
        if (typeof AIModelManager !== 'undefined' && AIModelManager.interruptTTS) {
            AIModelManager.interruptTTS();
        }
        
        // 2. 清理VoiceStateManager状态
        if (typeof VoiceStateManager !== 'undefined') {
            VoiceStateManager.stopStateMonitoring();
            VoiceStateManager.stopTTS();
        }
        
        // 3. 清理麦克风资源
        if (typeof VoiceInputHandler !== 'undefined' && VoiceInputHandler.cleanupAllMicrophoneResources) {
            VoiceInputHandler.cleanupAllMicrophoneResources();
        }
        
        console.log("✅ 页面卸载清理完成");
    });

    // 🔥 增强：页面可见性变化时的智能处理
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log("👁️ 页面隐藏，暂停不必要的功能...");
            
            // 1. 暂停TTS播放（节省资源）
            if (typeof VoiceStateManager !== 'undefined' && VoiceStateManager.isInTTSMode()) {
                console.log("⏸️ 页面隐藏时暂停TTS播放");
                if (typeof AIModelManager !== 'undefined' && AIModelManager.interruptTTS) {
                    AIModelManager.interruptTTS();
                }
            }
            
            // 2. 清理麦克风资源（移动端优化）
            if (typeof VoiceInputHandler !== 'undefined' && VoiceInputHandler.cleanupAllMicrophoneResources) {
                VoiceInputHandler.cleanupAllMicrophoneResources();
            }
            
            // 3. 暂停状态监控（节省CPU）
            if (typeof VoiceStateManager !== 'undefined') {
                VoiceStateManager.stopStateMonitoring();
            }
            
        } else {
            console.log("👁️ 页面显示，恢复功能...");
            
            // 1. 恢复状态监控
            if (typeof VoiceStateManager !== 'undefined') {
                VoiceStateManager.startStateMonitoring();
            }
            
            // 2. 检查并修复状态一致性
            setTimeout(() => {
                if (typeof VoiceStateManager !== 'undefined') {
                    VoiceStateManager.checkAndFixState();
                }
            }, 1000); // 延迟1秒确保页面完全恢复
        }
    });

    // --- 修正：强制同步输入模式UI和占位符 ---
    const appState = AppStateManager.getState();
    if (appState.isVoiceMode) {
        if (DOMElements.toggleIcon) {
            DOMElements.toggleIcon.textContent = "mic";
            DOMElements.toggleIcon.style.color = "white";
            DOMElements.toggleIcon.classList.add("breathing");
        }
        Utils.setInputPlaceholder("请用语音输入（系统自动识别成文字）");
    } else {
        if (DOMElements.toggleIcon) {
            DOMElements.toggleIcon.textContent = "keyboard";
            DOMElements.toggleIcon.style.color = "orange";
            DOMElements.toggleIcon.classList.remove("breathing");
        }
        Utils.setInputPlaceholder("请用键盘输入文本");
    }
};

window.addEventListener('load', () => {
    // 初始化高级视频管理系统
    VideoStateManager.initialize();

    // 然后调用原有的初始化逻辑
    initializeApp();
});

// 页面可见性检测 - 防止切换标签页导致的视频暂停
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // 页面重新可见时，确保活跃视频继续播放
        setTimeout(() => {
            const activeVideo = document.querySelector('.bgVideo.active');
            if (activeVideo && activeVideo.paused) {
                console.log('🔄 页面重新可见，恢复视频播放');
                activeVideo.play().catch(() => { });
            }
        }, 100);
    }
});

// 用户首次交互检测 - 解决浏览器自动播放限制
let userInteracted = false;
const enableAutoplayAfterInteraction = () => {
    if (!userInteracted) {
        userInteracted = true;
        console.log('✅ 用户已交互，启用视频自动播放');

        // 确保当前活跃视频开始播放
        const activeVideo = document.querySelector('.bgVideo.active');
        if (activeVideo && activeVideo.paused) {
            activeVideo.play().catch(() => { });
        }

        // 移除事件监听器
        document.removeEventListener('click', enableAutoplayAfterInteraction);
        document.removeEventListener('touchstart', enableAutoplayAfterInteraction);
        document.removeEventListener('keydown', enableAutoplayAfterInteraction);
    }
};

document.addEventListener('click', enableAutoplayAfterInteraction);
document.addEventListener('touchstart', enableAutoplayAfterInteraction);
document.addEventListener('keydown', enableAutoplayAfterInteraction);

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
    VideoStateManager.cleanup();
    console.log('视频管理系统资源已清理');
});

/* ===== 防护脚本已集成到构建流程中 ===== */
// --- END OF FILE script.js ---
