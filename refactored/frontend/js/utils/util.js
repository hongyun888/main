// --- START OF FILE util.js ---

// 渐进启用开关 - 放在顶部
window.ENABLE_CLEAN_LAYOUT = true;
window.ENABLE_MARKDOWN_LITE = true;

(function initBackendEndpoints() {
    const resolvePort = () => {
        const envPort =
            (typeof process !== 'undefined' && process.env && (process.env.BACKEND_PORT || process.env.PORT)) ||
            (typeof window !== 'undefined' && window.BACKEND_PORT);
        const parsed = Number(envPort);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 3003;
    };

    const resolveDefaultBase = () => {
        const port = resolvePort();
        return `http://localhost:${port}`;
    };

    try {
        const explicitHttp = typeof window.BACKEND_HTTP_URL === 'string' ? window.BACKEND_HTTP_URL : null;
        const hasOrigin =
            typeof window.location !== 'undefined' &&
            typeof window.location.origin === 'string' &&
            window.location.origin !== 'null';
        const fallbackOrigin = hasOrigin ? window.location.origin : resolveDefaultBase();
        const normalizedBase = (explicitHttp || fallbackOrigin || resolveDefaultBase()).replace(/\/$/, '');
        const parsedHttp = new URL(normalizedBase);
        window.BACKEND_HTTP_URL = normalizedBase;
        if (!window.BACKEND_WS_URL) {
            const wsUrl = new URL(normalizedBase);
            wsUrl.protocol = parsedHttp.protocol === 'https:' ? 'wss:' : 'ws:';
            window.BACKEND_WS_URL = wsUrl.origin;
        }
    } catch (error) {
        console.warn('[BackendConfig] Fallback to default backend URLs due to error:', error);
        const fallback = resolveDefaultBase();
        window.BACKEND_HTTP_URL = fallback;
        window.BACKEND_WS_URL = fallback.replace(/^http/, 'ws');
    }

    if (typeof window.getBackendHttpUrl !== 'function') {
        window.getBackendHttpUrl = () => window.BACKEND_HTTP_URL;
    }
    if (typeof window.getBackendWsUrl !== 'function') {
        window.getBackendWsUrl = () => window.BACKEND_WS_URL;
    }
    if (typeof window.resolveBackendBaseUrl !== 'function') {
        window.resolveBackendBaseUrl = () => window.getBackendHttpUrl();
    }
})();

// crypto.randomUUID() 兼容性 polyfill for Safari ≤ 15、部分安卓 WebView
if (!crypto.randomUUID) {
    crypto.randomUUID = () => ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>
        (c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
}

const base64ToArrayBuffer = (base64) => {
    // Handles both raw base64 string and Data URLs
    const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;

    try {
        const binaryString = atob(cleanBase64);
        const buffer = new ArrayBuffer(binaryString.length);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer; // Return ArrayBuffer
    } catch (e) {
        console.error("Error in base64ToArrayBuffer (atob failed):", e, "Input length:", cleanBase64.length);
        // Optionally, inspect the first few chars of cleanBase64 if it's consistently failing
        // console.log("First 100 chars of failing base64:", cleanBase64.substring(0,100));
        throw e; // Re-throw the error so the caller knows
    }
};


const getUrlParams = (url) => {
    // Ensure the input is a string and contains a '?'
    if (typeof url !== 'string' || !url.includes('?')) {
        return {};
    }
    const queryString = url.substring(url.indexOf('?') + 1);
    const urlSearchParams = new URLSearchParams(queryString);
    return Object.fromEntries(urlSearchParams);
};


const sha256 = async (message) => {
    if (typeof message !== 'string') {
        console.error("SHA256: Input message must be a string.");
        return null; // Or throw an error
    }
    try {
        const msgUint8 = new TextEncoder().encode(message); // UTF-8 encode
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    } catch (error) {
        console.error("Error in sha256:", error);
        return null; // Or re-throw
    }
};


const dataURLtoFile = (dataurl, filename) => {
    if (typeof dataurl !== 'string' || !dataurl.startsWith('data:')) {
        console.error("dataURLtoFile: Invalid Data URL format.");
        return null; // Or throw
    }
    try {
        const arr = dataurl.split(',');
        const mimeMatch = arr[0].match(/:(.*?);/);
        if (!mimeMatch || mimeMatch.length < 2) {
            console.error("dataURLtoFile: Could not extract MIME type from Data URL.");
            return null; // Or throw
        }
        const mime = mimeMatch[1];
        const bstr = atob(arr[1]);
        
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        
        return new File([u8arr], filename, { type: mime });
    } catch (error) {
        console.error("Error in dataURLtoFile:", error);
        return null; // Or re-throw
    }
};

const streamToString = async (stream) => {
    return await new Response(stream).text();
}

// 统一请求错误提示函数
const request = async (url, options = {}) => {
    const resp = await fetch(url, options);
    if (!resp.ok) {
        const msg = `网络/鉴权错误 (${resp.status})`;
        if (window.Toast) Toast.error(msg);        // 若已封装 Toast
        else alert(msg);
        throw new Error(msg);
    }
    return resp;
};

// 带认证的fetch包装，处理token失效自动跳转
const fetchWithAuth = async (url, options = {}) => {
    try {
        const resp = await fetch(url, options);
        
        // 检查认证失败
        if (resp.status === 401 || resp.status === 403) {
            console.warn(`认证失败 (${resp.status})，准备跳转登录页`);
            
            // 清理过期的认证信息
            sessionStorage.removeItem('userInfo');
            sessionStorage.removeItem('token');
            sessionStorage.removeItem('appCode');
            
            // 提示用户并跳转
            const message = resp.status === 401 ? '登录已过期，请重新登录' : '权限不足，请重新登录';
            if (window.Toast) {
                window.Toast.error(message);
            } else {
                alert(message);
            }
            
            // 延迟跳转，给用户时间看到提示
            setTimeout(() => {
                window.location.href = './login.html';
            }, 1500);
            
            throw new Error(`Authentication failed: ${resp.status}`);
        }
        
        if (!resp.ok) {
            const msg = `请求失败 (${resp.status})`;
            if (window.Toast) {
                window.Toast.error(msg);
            } else {
                alert(msg);
            }
            throw new Error(msg);
        }
        
        return resp;
        
    } catch (error) {
        // 网络错误等其他异常
        if (error.message.includes('Authentication failed')) {
            throw error; // 重新抛出认证错误
        }
        
        console.error('请求发生错误:', error);
        const msg = '网络连接失败，请检查网络设置';
        if (window.Toast) {
            window.Toast.error(msg);
        } else {
            alert(msg);
        }
        throw error;
    }
};

// 惰性读取token和appCode，防止空值
const getToken = () => sessionStorage.getItem('token') || '';
const getAppCode = () => sessionStorage.getItem('appCode') || '';

// 登录函数
const LOGIN_URL = "https://hongchuanai.com/agent/login";

const login = (option, sucess, fail) => {
    fetch(LOGIN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(option)
    }).then(async res => {
        const resp = await res.json()
        res.ok ? sucess(resp) : fail(resp)
    }).catch(err => {
        fail(err)
    })
};

// 对外暴露函数，兼容全局调用
if (typeof window !== 'undefined') {
    window.login = login;
    window.getToken = getToken;
    window.getAppCode = getAppCode;
    window.fetchWithAuth = fetchWithAuth;
    
    // 文本清洗和格式化函数
    window.sanitizeAndFormatLLMText = (text) => {
        if (!text || typeof text !== 'string') return '';
        
        // 1) 基础清理
        let txt = text.trim();
        if (!txt) return '';
        
        // 2) 标准化换行符
        txt = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        
        // 3) 按行切分
        const rawLines = txt.split('\n');
        const blocks = [];
        
        // 4) 循环 rawLines → 生成 blocks 数组
        rawLines.forEach(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine) {
                // 空行作为普通块保留
                blocks.push({ type: 'normal', text: '' });
                return;
            }
            
            // 若行以 ### 开头
            if (trimmedLine.startsWith('###')) {
                blocks.push({ 
                    type: 'title', 
                    text: trimmedLine.replace(/^###\s*/, '') 
                });
                return;
            }
            
            // 若行以 - 或 * 开头
            if (/^[*-]\s+/.test(trimmedLine)) {
                blocks.push({ 
                    type: 'bullet', 
                    text: trimmedLine.replace(/^[*-]\s+/, '') 
                });
                return;
            }
            
            // 其它行
            blocks.push({ 
                type: 'normal', 
                text: trimmedLine 
            });
        });
        
        // 5) 对每个 block.text 做行内替换，只留下纯文字
        blocks.forEach(block => {
            block.text = block.text
                .replace(/\*\*([^*]+)\*\*/g, (_, w) => `[_b]${w}[_]`)
                .replace(/\*([^*]+)\*/g, (_, w) => `[_i]${w}[_]`);
        });
        
        return blocks;
    };
}

// --- END OF FILE util.js ---
