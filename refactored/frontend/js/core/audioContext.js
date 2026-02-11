// 单例 AudioContext 管理模块
// 避免重复创建 AudioContext，提高性能和资源利用率

// 导入统一的日志管理
import { log } from './logger.js';

let sharedAudioCtx = null;

/**
 * 获取或创建共享的 AudioContext 实例
 * @returns {AudioContext} 共享的 AudioContext 实例
 */
export const getSharedAudioContext = () => {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        log.audio('context-create', '创建新的共享 AudioContext');
    }
    
    if (sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().then(() => {
            log.audio('context-auto-resume', 'AudioContext 已恢复');
        }).catch(e => {
            log.warn('AudioContext 恢复失败:', e);
        });
    }
    
    return sharedAudioCtx;
};

/**
 * 暂停共享的 AudioContext
 * @returns {Promise<void>}
 */
export const suspendSharedAudioContext = async () => {
    if (sharedAudioCtx && sharedAudioCtx.state !== 'closed' && sharedAudioCtx.state !== 'suspended') {
        try {
            await sharedAudioCtx.suspend();
            log.audio('context-suspend', '共享 AudioContext 已暂停');
        } catch (e) {
            log.warn('暂停 AudioContext 失败:', e);
        }
    }
};

/**
 * 恢复共享的 AudioContext
 * @returns {Promise<void>}
 */
export const resumeSharedAudioContext = async () => {
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
        try {
            await sharedAudioCtx.resume();
            log.audio('context-manual-resume', '共享 AudioContext 已恢复');
        } catch (e) {
            log.warn('恢复 AudioContext 失败:', e);
        }
    }
};

/**
 * 关闭共享的 AudioContext
 * @returns {Promise<void>}
 */
export const closeSharedAudioContext = async () => {
    if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') {
        try {
            await sharedAudioCtx.close();
            log.info('共享 AudioContext 已关闭');
            sharedAudioCtx = null;
        } catch (e) {
            log.warn('关闭 AudioContext 失败:', e);
        }
    }
};

/**
 * 获取 AudioContext 状态
 * @returns {string|null} AudioContext 的状态
 */
export const getAudioContextState = () => {
    return sharedAudioCtx ? sharedAudioCtx.state : null;
};

// 页面卸载时自动清理
window.addEventListener('beforeunload', () => {
    suspendSharedAudioContext();
});

// 导出共享实例（向后兼容）
export { sharedAudioCtx as sharedAudioContext }; 