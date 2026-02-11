/**
 * 智能数智人应用后端服务器
 * 双胞胎策略 - 重构版本（双胞胎B）
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// 导入业务服务
const BaiLianService = require('./services/bailian-service');
const CosyVoiceService = require('./services/cosyvoice-service');
const FileService = require('./services/file-service');

class IntelligentAvatarServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.socketIoPath = process.env.SOCKET_IO_PATH || '/api-fl/socket.io';
        this.io = socketIo(this.server, {
            path: this.socketIoPath,
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });

        // 初始化服务
        this.baiLianService = new BaiLianService();
        this.cosyVoiceService = new CosyVoiceService();
        this.fileService = new FileService();

        // 前端静态资源目录（refactored/frontend）
        this.frontendDir = path.join(__dirname, '../frontend');

        // 会话管理
        this.sessions = new Map();
        this.clientConnections = new Map();
        this.activeTtsTasks = new Map();
        this.sessionTtlMs = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 2); // 默认2小时
        this.sessionCleanupIntervalMs = Number(process.env.SESSION_CLEANUP_INTERVAL_MS || 1000 * 60 * 10); // 默认10分钟
        this.sessionCleanupTimer = null;

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.setupFileUpload();
        this.startSessionCleanup();
    }

    /**
     * 设置中间件
     */
    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
        
        // 静态文件服务（视频、音频等）
        this.app.use('/videos', express.static(path.join(__dirname, 'public/videos')));
        this.app.use('/audio', express.static(path.join(__dirname, 'public/audio')));

        // 提供前端静态资源（HTML/CSS/JS/图片/视频）
        this.app.use(express.static(this.frontendDir));
        
        // 日志中间件
        this.app.use((req, res, next) => {
            console.log(`📡 ${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }

    /**
     * 设置HTTP路由
     */
    setupRoutes() {
        // 根路由与登录页路由，直接返回前端页面
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(this.frontendDir, 'index.html'));
        });

        this.app.get('/login', (req, res) => {
            res.sendFile(path.join(this.frontendDir, 'login.html'));
        });

        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                services: {
                    bailian: 'ready',
                    cosyvoice: 'ready'
                }
            });
        });

        // 获取会话信息
        this.app.get('/api-fl/session/:sessionId', (req, res) => {
            const sessionId = req.params.sessionId;
            const session = this.getOrCreateSession(sessionId);
            this.touchSession(sessionId);
            res.json(session);
        });

        // 初始化新会话
        this.app.post('/api-fl/session/init', (req, res) => {
            const session = this.createSession();
            const sessionId = session.id;
            
            console.log(`🆕 创建新会话: ${sessionId}`);
            res.json({ sessionId, session });
        });

        // 视频流服务
        this.app.get('/api-fl/videos/:filename', (req, res) => {
            const filename = req.params.filename;
            const videoPath = path.join(__dirname, 'public/videos', filename);
            
            if (fs.existsSync(videoPath)) {
                const stat = fs.statSync(videoPath);
                const fileSize = stat.size;
                const range = req.headers.range;

                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(videoPath, { start, end });
                    const head = {
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': 'video/mp4',
                    };
                    res.writeHead(206, head);
                    file.pipe(res);
                } else {
                    const head = {
                        'Content-Length': fileSize,
                        'Content-Type': 'video/mp4',
                    };
                    res.writeHead(200, head);
                    fs.createReadStream(videoPath).pipe(res);
                }
            } else {
                res.status(404).json({ error: 'Video not found' });
            }
        });
    }

    /**
     * 设置文件上传
     */
    setupFileUpload() {
        const upload = multer({ 
            dest: 'uploads/',
            limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit (与原版本一致)
        });

        // 兼容原版本的文件上传API
        this.app.post('/api-fl/files/upload', upload.array('files'), async (req, res) => {
            try {
                const { isChat = false, appCode, token } = req.body;
                
                if (!appCode || !token) {
                    return res.status(401).json({ error: '缺少认证信息' });
                }

                const files = req.files;
                if (!files || files.length === 0) {
                    return res.status(400).json({ error: '没有上传文件' });
                }

                console.log(`📎 开始处理文件上传: ${files.length} 个文件`);

                // 验证所有文件
                for (const file of files) {
                    const validation = this.fileService.validateFile(file);
                    if (!validation.valid) {
                        await this.cleanupUploadedFiles(files);
                        return res.status(400).json({ 
                            error: `文件验证失败: ${file.originalname}`,
                            details: validation.errors
                        });
                    }
                }

                // 上传到百炼智能体
                const results = await this.fileService.uploadMultipleFiles(
                    files, 
                    isChat === 'true' || isChat === true, 
                    appCode, 
                    token
                );

                const successResults = results.filter(r => r.success);
                const failedResults = results.filter(r => !r.success);

                if (failedResults.length > 0) {
                    console.warn(`⚠️ 部分文件上传失败:`, failedResults);
                }

                console.log(`✅ 文件上传完成: ${successResults.length}/${files.length} 成功`);

                res.json({
                    success: true,
                    uploadedFiles: successResults,
                    failedFiles: failedResults,
                    totalCount: files.length,
                    successCount: successResults.length
                });

            } catch (error) {
                console.error('❌ 文件上传处理失败:', error);
                await this.cleanupUploadedFiles(req.files);
                res.status(500).json({ 
                    error: '文件上传失败', 
                    details: error.message 
                });
            }
        });

        // 兼容原版本的单文件上传（如果需要）
        this.app.post('/api-fl/files/upload-single', upload.single('file'), async (req, res) => {
            try {
                const { isChat = false, appCode, token } = req.body;
                const file = req.file;

                if (!appCode || !token) {
                    return res.status(401).json({ error: '缺少认证信息' });
                }

                if (!file) {
                    return res.status(400).json({ error: '没有上传文件' });
                }

                console.log(`📄 处理单文件上传: ${file.originalname}`);

                // 验证文件
                const validation = this.fileService.validateFile(file);
                if (!validation.valid) {
                    await this.cleanupUploadedFile(file);
                    return res.status(400).json({ 
                        error: '文件验证失败',
                        details: validation.errors
                    });
                }

                // 上传到百炼智能体
                const fileId = await this.fileService.uploadToBailian(
                    file, 
                    isChat === 'true' || isChat === true, 
                    appCode, 
                    token
                );

                console.log(`✅ 单文件上传成功: ${file.originalname} -> ${fileId}`);

                res.json({
                    success: true,
                    fileId: fileId,
                    originalName: file.originalname
                });

            } catch (error) {
                console.error('❌ 单文件上传失败:', error);
                await this.cleanupUploadedFile(req.file);
                res.status(500).json({ 
                    error: '文件上传失败', 
                    details: error.message 
                });
            }
        });
    }

    /**
     * 设置WebSocket通信
     */
    setupWebSocket() {
        this.io.on('connection', (socket) => {
            console.log(`🔌 客户端连接: ${socket.id}`);
            
            // 存储客户端连接
            this.clientConnections.set(socket.id, {
                socket: socket,
                sessionId: null,
                connectedAt: new Date().toISOString()
            });

            // 处理用户消息
            socket.on('user_message', async (data) => {
                await this.handleUserMessage(socket, data);
            });

            socket.on('tts_request', async (data) => {
                await this.handleTtsRequest(socket, data);
            });

            socket.on('tts_abort', () => {
                this.abortTtsTask(socket.id);
            });

            // 处理会话初始化
            socket.on('init_session', (data) => {
                const connection = this.clientConnections.get(socket.id);
                if (connection) {
                    connection.sessionId = data.sessionId;
                    console.log(`🆔 绑定会话: ${socket.id} -> ${data.sessionId}`);
                }
            });

            // 处理断开连接
            socket.on('disconnect', () => {
                console.log(`🔌 客户端断开: ${socket.id}`);
                this.abortTtsTask(socket.id);
                this.clientConnections.delete(socket.id);
            });

            // 错误处理
            socket.on('error', (error) => {
                console.error(`❌ WebSocket错误 (${socket.id}):`, error);
            });
        });
    }

    /**
     * 处理用户消息的核心逻辑
     * @param {Object} socket - WebSocket连接
     * @param {Object} data - 消息数据
     */
    async handleUserMessage(socket, data) {
        try {
            const { text, files = [], sessionId, appCode, token } = data;
            
            console.log(`💬 处理用户消息: ${text?.substring(0, 50)}...`, {
                sessionId,
                hasFiles: files.length > 0,
                socketId: socket.id
            });

            // 验证必要参数
            if (!appCode || !token) {
                socket.emit('error', { message: '认证信息缺失' });
                return;
            }

            // 发送状态提示
            socket.emit('status_update', { 
                type: 'knowledge_search', 
                message: '🔍 正在检索知识库，为您查找最准确的信息...' 
            });

            // 第一步：调用百炼智能体
            let knowledgeResponse;
            try {
                knowledgeResponse = await this.baiLianService.requestBaiLianAgent(
                    text, sessionId, [], appCode, token
                );
                
                console.log("✅ 百炼智能体检索完成，开始语音合成");
                
                // 发送文本回复给前端
                socket.emit('text_response', {
                    text: knowledgeResponse,
                    messageId: `msg_${Date.now()}`,
                    isComplete: true
                });

            } catch (error) {
                console.error("❌ 百炼智能体调用失败:", error);
                // 降级处理：直接使用用户输入
                knowledgeResponse = `抱歉，暂时无法检索到相关信息。您的问题是：${text}`;
                
                socket.emit('text_response', {
                    text: knowledgeResponse,
                    messageId: `msg_${Date.now()}_fallback`,
                    isComplete: true
                });
            }

            // 第二步：调用CosyVoice模型进行语音合成
            try {
                const speakText = String(knowledgeResponse || '').trim();

                socket.emit('status_update', { 
                    type: 'tts_synthesis', 
                    message: '🎤 正在合成语音...' 
                });

                await this.handleCosyVoiceStreamResponse(socket, {
                    text: speakText,
                    appCode,
                    token
                });

            } catch (error) {
                console.error("❌ CosyVoice语音合成失败:", error);
                socket.emit('tts_error', { requestId: null, message: '语音合成失败', details: error.message });
            }

            // 更新会话历史
            const session = this.getOrCreateSession(sessionId);
            session.messages.push({
                type: 'owner',
                text,
                timestamp: new Date().toISOString()
            });
            session.messages.push({
                type: 'other',
                text: knowledgeResponse,
                timestamp: new Date().toISOString()
            });
            this.touchSession(session.id);
            this.sessions.set(session.id, session);

        } catch (error) {
            console.error("❌ 处理用户消息失败:", error);
            socket.emit('error', {
                message: '处理消息失败',
                details: error.message 
            });
        }
    }

    /**
     * 处理CosyVoice流式响应
     * @param {Object} socket - WebSocket连接
     * @param {Object} options - 合成参数
     */
    async handleCosyVoiceStreamResponse(socket, options) {
        const apiKey = process.env.DASHSCOPE_API_KEY || process.env.COSYVOICE_API_KEY;
        if (!apiKey) {
            throw new Error('CosyVoice API Key 未配置');
        }

        this.abortTtsTask(socket.id);
        const activeTask = { aborted: false };
        this.activeTtsTasks.set(socket.id, activeTask);

        let emittedChunks = 0;
        const sampleRate = Number(process.env.COSYVOICE_SAMPLE_RATE || 24000);

        const safeEmit = (event, payload) => {
            if (!activeTask.aborted) {
                socket.emit(event, payload);
            }
        };

        const ttsVoice = process.env.COSYVOICE_VOICE || this.cosyVoiceService.DEFAULT_VOICE;
        const ttsModel = process.env.COSYVOICE_MODEL || this.cosyVoiceService.DEFAULT_MODEL;
        const ttsRate = Number(process.env.COSYVOICE_RATE || this.cosyVoiceService.DEFAULT_RATE || 1);
        const rawInstruction = process.env.COSYVOICE_INSTRUCTION || this.cosyVoiceService.DEFAULT_INSTRUCTION;
        const modelLower = String(ttsModel || '').toLowerCase();
        const voiceLower = String(ttsVoice || '').toLowerCase();
        const supportsInstruction = !modelLower.startsWith('cosyvoice-v2') && !voiceLower.endsWith('_v2');
        const instruction = supportsInstruction ? rawInstruction : '';
        safeEmit('tts_config', {
            requestId: options.requestId || null,
            voice: ttsVoice,
            model: ttsModel,
            rate: ttsRate
        });

        await this.cosyVoiceService.synthesizeText({
            text: options.text,
            apiKey,
            model: ttsModel,
            voice: ttsVoice,
            sampleRate,
            instruction,
            wordTimestampEnabled: true,
            debug: true,
            onAudioChunk: (audioData) => {
                if (activeTask.aborted) return;
                safeEmit('audio_chunk', {
                    requestId: options.requestId || null,
                    audioData,
                    sampleRate,
                    format: 'pcm'
                });
                emittedChunks += 1;
            },
            onWordTimestamps: (payload) => {
                if (activeTask.aborted) return;
                console.log('🕒 CosyVoice时间戳回调:', {
                    requestId: options.requestId || null,
                    words: Array.isArray(payload?.words) ? payload.words.length : 0
                });
                safeEmit('subtitle_timestamps', {
                    requestId: options.requestId || null,
                    ...payload
                });
            },
            onEvent: (payload) => {
                const event = payload?.header?.event;
                if (!event) return;
                if (event === 'task-started') {
                    console.log('✅ CosyVoice任务已启动');
                } else if (event === 'task-finished') {
                    console.log('✅ CosyVoice任务完成');
                } else if (event === 'task-failed') {
                    console.error('❌ CosyVoice任务失败:', payload?.header?.error_message || payload);
                }
            },
            onError: (err) => {
                if (activeTask.aborted) return;
                safeEmit('tts_error', { requestId: options.requestId || null, message: '语音合成失败', details: err.message });
            }
        });

        if (!activeTask.aborted) {
            safeEmit('audio_complete', {
                requestId: options.requestId || null,
                message: '语音合成完成',
                totalChunks: emittedChunks
            });
        }
        this.activeTtsTasks.delete(socket.id);
    }

    abortTtsTask(socketId) {
        const task = this.activeTtsTasks.get(socketId);
        if (task) {
            task.aborted = true;
            this.activeTtsTasks.delete(socketId);
            console.log(`🛑 语音合成任务已中断: ${socketId}`);
        }
    }

    async cleanupUploadedFile(file) {
        if (!file?.path) return;
        try {
            await fs.promises.unlink(file.path);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn('⚠️ 清理上传临时文件失败:', file.path, error.message);
            }
        }
    }

    async cleanupUploadedFiles(files = []) {
        if (!Array.isArray(files) || files.length === 0) return;
        await Promise.all(files.map((file) => this.cleanupUploadedFile(file)));
    }

    async handleTtsRequest(socket, data) {
        try {
            const { text, requestId } = data || {};
            if (!text) {
                socket.emit('tts_error', { requestId: requestId || null, message: 'TTS文本为空' });
                return;
            }
            console.log('🎤 收到TTS请求:', {
                socketId: socket.id,
                requestId,
                textPreview: String(text).slice(0, 80)
            });
            await this.handleCosyVoiceStreamResponse(socket, { text, requestId });
        } catch (error) {
            console.error('❌ TTS请求失败:', error);
            socket.emit('tts_error', { requestId: data?.requestId || null, message: 'TTS请求失败', details: error.message });
        }
    }

    /**
     * 获取会话历史
     * @param {string} sessionId - 会话ID
     * @returns {Array} 会话消息历史
     */
    getSessionHistory(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.touchSession(sessionId);
            return session.messages;
        }
        return [];
    }

    /**
     * 创建新会话
     * @param {string} [sessionId] - 可选的会话ID
     * @returns {Object} 会话对象
     */
    createSession(sessionId) {
        const now = new Date().toISOString();
        const id = sessionId || 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const session = {
            id,
            messages: [],
            createdAt: now,
            lastSeen: now
        };
        this.sessions.set(id, session);
        return session;
    }

    /**
     * 获取已有会话，没有则创建
     * @param {string} sessionId
     * @returns {Object} 会话对象
     */
    getOrCreateSession(sessionId) {
        if (!sessionId) {
            return this.createSession();
        }
        const existing = this.sessions.get(sessionId);
        if (existing) {
            return existing;
        }
        return this.createSession(sessionId);
    }

    /**
     * 更新会话最后活跃时间
     * @param {string} sessionId
     */
    touchSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.lastSeen = new Date().toISOString();
        }
    }

    /**
     * 定期清理超时会话
     */
    startSessionCleanup() {
        if (!this.sessionTtlMs || this.sessionTtlMs <= 0) return;
        this.sessionCleanupTimer = setInterval(() => {
            const now = Date.now();
            let removed = 0;
            for (const [id, session] of this.sessions.entries()) {
                const lastSeenMs = session.lastSeen ? new Date(session.lastSeen).getTime() : new Date(session.createdAt).getTime();
                if (now - lastSeenMs > this.sessionTtlMs) {
                    this.sessions.delete(id);
                    removed++;
                }
            }
            if (removed > 0) {
                console.log(`🧹 清理过期会话: ${removed} 个`);
            }
        }, this.sessionCleanupIntervalMs);
        if (this.sessionCleanupTimer.unref) {
            this.sessionCleanupTimer.unref();
        }
    }

    /**
     * 启动服务器
     * @param {number} port - 端口号
     */
    start(port = Number(process.env.PORT || 3003)) {
        this.server.listen(port, () => {
            console.log(`
🚀 智能数智人后端服务启动成功!

📡 WebSocket服务: ws://localhost:${port}
🌐 HTTP服务: http://localhost:${port}
💊 健康检查: http://localhost:${port}/health
🔌 Socket.IO Path: ${this.socketIoPath}

🎯 双胞胎策略 - 重构版本（双胞胎B）
📋 功能状态:
   ✅ 百炼智能体服务
   ✅ CosyVoice语音合成  
   ✅ WebSocket通信
   ✅ 文件上传服务
   ✅ 视频流服务
            `);
        });

        // 错误处理
        this.server.on('error', (error) => {
            console.error('❌ 服务器启动失败:', error);
            process.exit(1);
        });

        // 优雅关闭
        process.on('SIGTERM', () => {
            console.log('📴 收到SIGTERM信号，开始优雅关闭...');
            if (this.sessionCleanupTimer) {
                clearInterval(this.sessionCleanupTimer);
            }
            this.server.close(() => {
                console.log('✅ 服务器已关闭');
                process.exit(0);
            });
        });
    }
}

// 启动服务器
const server = new IntelligentAvatarServer();
server.start(Number(process.env.PORT || 3003)); 
