/**
 * 语音灵敏度调节器组件
 * ------------------------------------------------------------
 * 职责：
 *  - 管理“灵敏度调节器”UI（标题、徽标文案、滑块）
 *  - 将用户选择的档位转换为业务含义，并调用底层 setVoiceSensitivity
 *  - 保持完全前端可插拔，不直接依赖音频实现细节
 *
 * 设计约束：
 *  - 不修改现有音频识别默认行为：默认 3 档，且 1 档 == 当前线上行为
 *  - 当底层未暴露 setVoiceSensitivity 时，组件只负责 UI，不报致命错误
 */

class VoiceSensitivityController {
    /**
     * @param {Object} options
     * @param {string} [options.sliderId] 滑块元素ID
     * @param {string} [options.badgeId]  显示当前档位说明的徽标ID
     * @param {number} [options.defaultLevel] 默认档位（1~6）
     */
    constructor(options = {}) {
        this.sliderId = options.sliderId || 'voiceSensitivitySlider';
        this.badgeId = options.badgeId || 'voiceSensitivityBadge';
        // 默认索引 3：对应“1档 · 近距离对话”，与音频底层 DEFAULT_SENSITIVITY_LEVEL 保持一致
        this.defaultLevel = options.defaultLevel ?? 3;

        /** @type {HTMLInputElement|null} */
        this.slider = document.getElementById(this.sliderId);
        /** @type {HTMLElement|null} */
        this.badge = document.getElementById(this.badgeId);

        this.currentLevel = this.normalizeLevel(this.defaultLevel);

        console.log('[VoiceSensitivityController] 初始化组件', {
            sliderFound: !!this.slider,
            badgeFound: !!this.badge,
            defaultLevel: this.currentLevel
        });

        if (!this.slider) {
            console.warn('[VoiceSensitivityController] 未找到滑块元素，组件仅以占位模式运行');
            return;
        }

        // 绑定事件
        this.bindEvents();

        // 初始化一次 UI 与底层配置
        this.setLevel(this.currentLevel, { fromInit: true });
    }

    /**
     * 规范化档位到 0~6 区间（内部索引）
     * @param {number} level
     * @returns {number}
     */
    normalizeLevel(level) {
        const n = Number(level);
        // 默认使用索引 3（即“1档 · 近距离对话”）
        const fallback = 3;
        if (Number.isNaN(n)) return fallback;
        return Math.min(6, Math.max(0, n));
    }

    /**
     * 根据档位生成说明文案
     * @param {number} level
     */
    getDescription(level) {
        const map = {
            0: '-2档 · 极近距离（环境嘈杂时使用）',
            1: '-1档 · 超近距离',
            2: '0档 · 近距离加强',
            3: '1档 · 近距离对话',
            4: '2档 · 约 1 米',
            5: '3档 · 小范围讲解',
            6: '4档 · 稍大空间'
        };
        return map[level] || `档位 ${level}`;
    }

    /**
     * 绑定滑块事件
     */
    bindEvents() {
        if (!this.slider) return;

        this.slider.addEventListener('input', () => {
            const level = this.normalizeLevel(this.slider.value);
            this.setLevel(level, { fromUser: true });
        });

        console.log('[VoiceSensitivityController] 滑块事件绑定完成');
    }

    /**
     * 设置当前档位（更新 UI + 调用底层）
     * @param {number} level 档位索引（0~6）
     * @param {Object} [options]
     * @param {boolean} [options.fromUser] 是否来源于用户手动拖动
     * @param {boolean} [options.fromInit] 是否为初始化阶段调用
     */
    setLevel(level, options = {}) {
        const { fromUser = false, fromInit = false } = options;
        const normalizedLevel = this.normalizeLevel(level);
        const previousLevel = this.currentLevel;
        this.currentLevel = normalizedLevel;

        if (this.slider && String(this.slider.value) !== String(normalizedLevel)) {
            this.slider.value = String(normalizedLevel);
        }

        // 更新徽标文案
        if (this.badge) {
            this.badge.textContent = this.getDescription(normalizedLevel);
        }

        // 调用底层语音识别灵敏度接口（如果存在）
        if (typeof window.setVoiceSensitivity === 'function') {
            try {
                window.setVoiceSensitivity(normalizedLevel);
            } catch (err) {
                console.warn('[VoiceSensitivityController] 调用 setVoiceSensitivity 失败:', err);
            }
        } else if (!fromInit) {
            console.warn('[VoiceSensitivityController] setVoiceSensitivity 接口不存在，仅更新前端 UI');
        }

        console.log('[VoiceSensitivityController] 灵敏度档位已更新', {
            previousLevel,
            newLevel: normalizedLevel,
            fromUser,
            fromInit
        });
    }

    /**
     * 获取当前灵敏度状态，方便调试
     */
    getState() {
        return {
            currentLevel: this.currentLevel,
            description: this.getDescription(this.currentLevel),
            sliderAttached: !!this.slider,
            badgeAttached: !!this.badge
        };
    }
}

// 将组件暴露到全局，方便调试与按需复用
if (typeof window !== 'undefined') {
    window.VoiceSensitivityController = VoiceSensitivityController;

    // 自动初始化：在 DOM 就绪后挂载一次默认实例
    document.addEventListener('DOMContentLoaded', () => {
        try {
            const slider = document.getElementById('voiceSensitivitySlider');
            if (!slider) {
                console.warn('[VoiceSensitivityController] DOMContentLoaded：未找到 voiceSensitivitySlider，跳过自动初始化');
                return;
            }

            window.voiceSensitivityController = new VoiceSensitivityController({
                sliderId: 'voiceSensitivitySlider',
                badgeId: 'voiceSensitivityBadge',
                defaultLevel: 1
            });

            console.log('[VoiceSensitivityController] 自动初始化完成，已挂载到 window.voiceSensitivityController');
        } catch (err) {
            console.error('[VoiceSensitivityController] 自动初始化失败:', err);
        }
    });
}


