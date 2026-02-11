// 统一日志管理模块
// 支持开发/生产环境切换，高频日志节流，减少性能影响

// 检测是否在开发环境
const isDevelopment = () => {
    return window.location.hostname === 'localhost' || 
           window.location.hostname === '127.0.0.1' || 
           window.location.hostname.includes('dev') ||
           window.location.search.includes('debug=true');
};

// 日志节流器
class LogThrottler {
    constructor() {
        this.throttleMap = new Map();
        this.THROTTLE_INTERVAL = 1000; // 1秒内相同消息只显示一次
    }
    
    shouldLog(key, interval = this.THROTTLE_INTERVAL) {
        const now = Date.now();
        const lastTime = this.throttleMap.get(key);
        
        if (!lastTime || now - lastTime > interval) {
            this.throttleMap.set(key, now);
            return true;
        }
        return false;
    }
    
    clear() {
        this.throttleMap.clear();
    }
}

// 全局日志控制器
class Logger {
    constructor() {
        this.isDevMode = isDevelopment();
        this.throttler = new LogThrottler();
        
        // 日志级别
        this.LEVELS = {
            ERROR: 0,   // 总是显示
            WARN: 1,    // 警告
            INFO: 2,    // 信息
            DEBUG: 3    // 调试（仅开发环境）
        };
        
        // 当前日志级别
        this.currentLevel = this.isDevMode ? this.LEVELS.DEBUG : this.LEVELS.WARN;
    }
    
    // 设置日志级别
    setLevel(level) {
        this.currentLevel = level;
    }
    
    // 错误日志（总是显示）
    error(message, ...args) {
        console.error(message, ...args);
    }
    
    // 警告日志
    warn(message, ...args) {
        if (this.currentLevel >= this.LEVELS.WARN) {
            console.warn(message, ...args);
        }
    }
    
    // 信息日志
    info(message, ...args) {
        if (this.currentLevel >= this.LEVELS.INFO) {
            console.log(message, ...args);
        }
    }
    
    // 调试日志（仅开发环境）
    debug(message, ...args) {
        if (this.currentLevel >= this.LEVELS.DEBUG) {
            console.log(`[DEBUG] ${message}`, ...args);
        }
    }
    
    // 高频日志（带节流）
    frequent(key, message, ...args) {
        if (this.throttler.shouldLog(key)) {
            this.info(message, ...args);
        }
    }
    
    // 音频相关日志（高频，需要节流）
    audio(key, message, ...args) {
        if (this.throttler.shouldLog(`audio:${key}`, 500)) { // 500ms节流
            this.debug(`[AUDIO] ${message}`, ...args);
        }
    }
    
    // 视频相关日志
    video(key, message, ...args) {
        if (this.throttler.shouldLog(`video:${key}`, 1000)) { // 1s节流
            this.debug(`[VIDEO] ${message}`, ...args);
        }
    }
    
    // WebSocket相关日志
    websocket(message, ...args) {
        this.info(`[WebSocket] ${message}`, ...args);
    }
    
    // Token相关日志
    token(message, ...args) {
        this.info(`[Token] ${message}`, ...args);
    }
    
    // 性能相关日志
    perf(key, message, ...args) {
        if (this.throttler.shouldLog(`perf:${key}`, 2000)) { // 2s节流
            this.debug(`[PERF] ${message}`, ...args);
        }
    }
}

// 导出单例
export const logger = new Logger();

// 为了向后兼容，提供简化的API
export const log = {
    error: (...args) => logger.error(...args),
    warn: (...args) => logger.warn(...args),
    info: (...args) => logger.info(...args),
    debug: (...args) => logger.debug(...args),
    
    // 高频日志
    audio: (key, ...args) => logger.audio(key, ...args),
    video: (key, ...args) => logger.video(key, ...args),
    websocket: (...args) => logger.websocket(...args),
    token: (...args) => logger.token(...args),
    perf: (key, ...args) => logger.perf(key, ...args)
};

// 挂载到全局，供非模块脚本使用
if (typeof window !== 'undefined') {
    window.logger = logger;
    window.log = log;
} 