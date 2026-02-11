const ALI_BAILIAN_UPLOAD_URL = 'https://hongchuanai.com/agent/file/lease'
const ALI_BAILIAN_ADDFILE_URL = 'https://hongchuanai.com/agent/file/upload'

// 使用 CryptoJS 计算 MD5
async function computeMD5WithCryptoJS(buffer) {
    return new Promise((resolve, reject) => {
        try {
            const wordArray = CryptoJS.lib.WordArray.create(buffer);
            const md5 = CryptoJS.MD5(wordArray).toString();
            resolve(md5);
        } catch (error) {
            console.error('CryptoJS MD5计算失败:', error);
            reject(error);
        }
    });
}

// 使用 WebCrypto 计算 MD5（注意：WebCrypto API 通常不支持 MD5，这里仅作示例）
async function computeMD5WithWebCrypto(buffer) {
    try {
        // 注意：大多数现代浏览器的 WebCrypto API 不支持 MD5
        // 这里保留是为了完整性，实际可能会失败并降级到 CryptoJS
        const hashBuffer = await crypto.subtle.digest('MD5', buffer);
        const md5Hash = Array.from(new Uint8Array(hashBuffer))
                             .map(b => b.toString(16).padStart(2, '0'))
                             .join('');
        return md5Hash;
    } catch (error) {
        console.warn('WebCrypto MD5 不支持或失败，降级到 CryptoJS:', error);
        throw error; // 让调用者处理降级
    }
}

// 等待 CryptoJS 加载的辅助函数
async function waitForCryptoJS(maxWaitTime = 5000) {
    return new Promise((resolve, reject) => {
        if (typeof CryptoJS !== 'undefined') {
            resolve();
            return;
        }
        
        let attempts = 0;
        const maxAttempts = maxWaitTime / 100;
        
        const checkInterval = setInterval(() => {
            attempts++;
            if (typeof CryptoJS !== 'undefined') {
                clearInterval(checkInterval);
                resolve();
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                reject(new Error('CryptoJS加载超时'));
            }
        }, 100);
    });
}

const calculateFileMD5 = async (file) => {
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
    
    return new Promise(async (resolve, reject) => {
        // 对于大文件给出提示
        if (file.size > MAX_FILE_SIZE) {
            const proceed = confirm(`文件较大 (${(file.size / 1024 / 1024).toFixed(1)}MB)，MD5计算可能需要较长时间，是否继续？`);
            if (!proceed) {
                reject(new Error('用户取消上传大文件'));
                return;
            }
        }

        try {
            const buffer = await file.arrayBuffer();
            
            // 统一的降级链：Worker -> WebCrypto -> CryptoJS
            if (window.Worker) {
                try {
                    console.log('使用 Web Worker 计算 MD5');
                    
                    const worker = new Worker('./js/utils/md5.worker.js');
                    
                    worker.onmessage = (e) => {
                        worker.terminate();
                        
                        if (e.data.success) {
                            resolve(e.data.md5);
                        } else {
                            console.warn('Worker MD5 计算失败:', e.data.error);
                            // 降级到主线程计算
                            fallbackToMainThread();
                        }
                    };
                    
                    worker.onerror = (error) => {
                        console.warn('Worker 创建失败:', error);
                        worker.terminate();
                        // 降级到主线程计算
                        fallbackToMainThread();
                    };
                    
                    // 发送文件数据到 Worker
                    worker.postMessage({
                        fileBuffer: buffer,
                        fileSize: file.size
                    }, [buffer]); // 使用 Transferable Objects 提高性能
                    
                    return;
                } catch (workerError) {
                    console.warn('Web Worker MD5 失败，降级到主线程:', workerError);
                    // 继续执行降级逻辑
                }
            }
            
            // 主线程降级处理函数
            const fallbackToMainThread = async () => {
                try {
                    // 重新读取 buffer（因为可能被 Worker 转移了）
                    const newBuffer = buffer.byteLength ? buffer : await file.arrayBuffer();
                    
                    // 优先尝试 WebCrypto
                    if (window.crypto?.subtle) {
                        try {
                            const md5Hash = await computeMD5WithWebCrypto(newBuffer);
                            resolve(md5Hash);
                            return;
                        } catch (cryptoError) {
                            console.warn('WebCrypto MD5 失败，尝试 CryptoJS:', cryptoError);
                            // 继续使用 CryptoJS
                        }
                    }
                    
                    // 使用 CryptoJS
                    if (typeof CryptoJS !== 'undefined') {
                        console.log('使用预加载的 CryptoJS 计算 MD5');
                        const md5 = await computeMD5WithCryptoJS(newBuffer);
                        resolve(md5);
                    } else {
                        // 等待 CryptoJS 加载
                        console.log('等待 CryptoJS 加载...');
                        await waitForCryptoJS();
                        console.log('CryptoJS 加载完成，开始计算 MD5');
                        const md5 = await computeMD5WithCryptoJS(newBuffer);
                        resolve(md5);
                    }
                    
                } catch (error) {
                    console.error('主线程 MD5 计算失败:', error);
                    reject(error);
                }
            };
            
            // 如果不支持 Web Worker，直接降级
            fallbackToMainThread();
            
        } catch (error) {
            console.error('MD5计算总体失败:', error);
            reject(error);
        }
    });
}

const fileUploadBailian = async (file, isChat) => {
    if (typeof(isChat) != 'boolean') {
        isChat = false
    }
    
    const appCode = getAppCode();
    const token = getToken();
    
    const fileName = crypto.randomUUID() + "_" + file.name
    let leaseId;
    const md5Str = await calculateFileMD5(file)
    const url = ALI_BAILIAN_UPLOAD_URL + `?AppCode=${appCode}`
    const fileId = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
            "fileSize": file.size,
            "md5": md5Str,
            "fileName": fileName,
            "categoryType": isChat ? "SESSION_FILE" : "UNSTRUCTURED"
        })
    }).then(res => {
        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json()
    }).then(cert => {
        leaseId = cert.fileUploadLeaseId
        const url = cert.param.url
        return fetch(url, {
            method: cert.param.method,
            headers: cert.param.headers,
            body: file,
        })
    }).then(r => {
        if (!r.ok) {
            throw new Error(`HTTP error! status: ${r.status}`);
        }
        return fetch(`${ALI_BAILIAN_ADDFILE_URL}?AppCode=${appCode}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Date': (new Date()).toGMTString(),
                'Authorization': `Bearer ${token}`

            },
            body: JSON.stringify({
                "leaseId": leaseId,
                "categoryType": isChat ? "SESSION_FILE" : "UNSTRUCTURED",
                "appId": '2af93eb45a0b4db9be4833da94650392',
                "appName": "妇联智能体活动"
            })
        })
    }).then( r =>   {
        if (r.ok) {
         return r.json()
        }
        throw new Error('file upload fail')
    }).then(data => {
        // 上传成功后释放临时 blob URL
        if (file.previewUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(file.previewUrl);
        }
        return data.fileId;
    })
    return fileId
}
