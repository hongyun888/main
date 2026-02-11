// Web Worker for MD5 calculation to avoid blocking main thread
// 本地优先，失败再兜底 CDN，版本统一为 4.2.0
(() => {
    const sources = [
        '/vendor/crypto-js/4.2.0/crypto-js.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js'
    ];
    for (const src of sources) {
        try {
            importScripts(src);
            return;
        } catch (error) {
            // 尝试下一个兜底源
        }
    }
    throw new Error('CryptoJS 加载失败');
})();

self.onmessage = function(e) {
    try {
        const { fileBuffer, fileSize } = e.data;
        
        // Convert ArrayBuffer to CryptoJS WordArray
        const wordArray = CryptoJS.lib.WordArray.create(fileBuffer);
        
        // Calculate MD5 hash
        const md5Hash = CryptoJS.MD5(wordArray).toString();
        
        // Send result back to main thread
        self.postMessage({
            success: true,
            md5: md5Hash,
            fileSize: fileSize
        });
    } catch (error) {
        // Send error back to main thread
        self.postMessage({
            success: false,
            error: error.message
        });
    }
};

self.onerror = function(error) {
    self.postMessage({
        success: false,
        error: 'Worker error: ' + error.message
    });
}; 
