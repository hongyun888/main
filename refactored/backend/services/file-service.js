/**
 * 文件上传服务 - 代理百炼智能体文件上传
 * 保持与原版本完全一致的功能
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs').promises;

class FileService {
    constructor() {
        this.ALI_BAILIAN_UPLOAD_URL = 'https://hongchuanai.com/agent/file/lease';
        this.ALI_BAILIAN_ADDFILE_URL = 'https://hongchuanai.com/agent/file/upload';
        // 通过环境变量配置应用信息，避免误用其他项目的默认值
        this.APP_ID = process.env.BAILIAN_APP_ID || '2af93eb45a0b4db9be4833da94650392';
        this.APP_NAME = process.env.BAILIAN_APP_NAME || '妇联智能体活动';
    }

    /**
     * 计算文件MD5
     * @param {Buffer} fileBuffer - 文件内容
     * @returns {string} MD5哈希值
     */
    calculateFileMD5(fileBuffer) {
        return crypto.createHash('md5').update(fileBuffer).digest('hex');
    }

    /**
     * 文件上传到百炼智能体知识库
     * @param {Object} file - 文件对象 
     * @param {boolean} isChat - 是否为对话文件
     * @param {string} appCode - 应用代码
     * @param {string} token - 认证token
     * @returns {Promise<string>} 文件ID
     */
    async uploadToBailian(file, isChat = false, appCode, token) {
        console.log('🔄 后端：开始文件上传到百炼智能体:', {
            fileName: file.originalname,
            fileSize: file.size,
            isChat: isChat
        });

        try {
            // 读取文件内容（异步，避免阻塞事件循环）
            const fileBuffer = await fs.readFile(file.path);
            
            // 计算MD5
            const md5Str = this.calculateFileMD5(fileBuffer);
            console.log('📊 文件MD5计算完成:', md5Str);

            // 生成唯一文件名
            const fileName = crypto.randomUUID() + "_" + file.originalname;

            // 第一步：获取上传凭证
            const leaseUrl = this.ALI_BAILIAN_UPLOAD_URL + `?AppCode=${appCode}`;
            console.log('🔐 获取上传凭证...');
            
            const leaseResponse = await fetch(leaseUrl, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    "fileSize": file.size,
                    "md5": md5Str,
                    "fileName": fileName,
                    "categoryType": isChat ? "SESSION_FILE" : "UNSTRUCTURED"
                })
            });

            if (!leaseResponse.ok) {
                throw new Error(`获取上传凭证失败: ${leaseResponse.status} ${leaseResponse.statusText}`);
            }

            const cert = await leaseResponse.json();
            const leaseId = cert.fileUploadLeaseId;
            console.log('✅ 上传凭证获取成功:', leaseId);

            // 第二步：上传文件到OSS
            console.log('📤 上传文件到OSS...');
            const uploadResponse = await fetch(cert.param.url, {
                method: cert.param.method,
                headers: cert.param.headers,
                body: fileBuffer
            });

            if (!uploadResponse.ok) {
                throw new Error(`文件上传到OSS失败: ${uploadResponse.status} ${uploadResponse.statusText}`);
            }
            console.log('✅ 文件上传到OSS成功');

            // 第三步：确认文件添加到知识库
            console.log('📚 添加文件到知识库...');
            const addFilePayload = {
                leaseId: leaseId,
                categoryType: isChat ? "SESSION_FILE" : "UNSTRUCTURED"
            };
            if (this.APP_ID) addFilePayload.appId = this.APP_ID;
            if (this.APP_NAME) addFilePayload.appName = this.APP_NAME;

            const addFileResponse = await fetch(`${this.ALI_BAILIAN_ADDFILE_URL}?AppCode=${appCode}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Date': (new Date()).toGMTString(),
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(addFilePayload)
            });

            if (!addFileResponse.ok) {
                throw new Error(`添加文件到知识库失败: ${addFileResponse.status} ${addFileResponse.statusText}`);
            }

            const result = await addFileResponse.json();
            const fileId = result.fileId;

            console.log('🎉 文件上传完成:', {
                fileId: fileId,
                fileName: fileName,
                originalName: file.originalname
            });

            return fileId;

        } catch (error) {
            console.error('❌ 文件上传到百炼智能体失败:', error);
            throw error;
        } finally {
            if (file?.path) {
                try {
                    await fs.unlink(file.path);
                    console.log('🧹 临时文件清理完成');
                } catch (err) {
                    if (err?.code !== 'ENOENT') {
                        console.warn('⚠️ 临时文件清理失败:', err);
                    }
                }
            }
        }
    }

    /**
     * 批量文件上传
     * @param {Array} files - 文件数组
     * @param {boolean} isChat - 是否为对话文件
     * @param {string} appCode - 应用代码  
     * @param {string} token - 认证token
     * @returns {Promise<Array>} 文件ID数组
     */
    async uploadMultipleFiles(files, isChat = false, appCode, token) {
        console.log(`📁 批量上传文件: ${files.length} 个文件`);
        
        const uploadTasks = files.map(async (file, index) => {
            try {
                console.log(`📄 上传文件 ${index + 1}/${files.length}: ${file.originalname}`);
                const fileId = await this.uploadToBailian(file, isChat, appCode, token);
                return {
                    originalName: file.originalname,
                    fileId,
                    success: true
                };
            } catch (error) {
                console.error(`❌ 文件上传失败 ${file.originalname}:`, error);
                return {
                    originalName: file.originalname,
                    error: error.message,
                    success: false
                };
            }
        });

        const results = await Promise.all(uploadTasks);
        const successCount = results.filter(r => r.success).length;
        console.log(`📊 批量上传完成: ${successCount}/${files.length} 成功`);

        return results;
    }

    /**
     * 验证文件类型和大小
     * @param {Object} file - 文件对象
     * @returns {Object} 验证结果
     */
    validateFile(file) {
        const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
        const ALLOWED_TYPES = [
            'application/pdf',
            'application/msword', 
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
            'image/jpeg',
            'image/png',
            'image/gif',
            'audio/mpeg',
            'audio/wav',
            'video/mp4',
            'video/avi'
        ];

        const validation = {
            valid: true,
            errors: []
        };

        // 检查文件大小
        if (file.size > MAX_FILE_SIZE) {
            validation.valid = false;
            validation.errors.push(`文件太大: ${(file.size / 1024 / 1024).toFixed(1)}MB, 最大允许100MB`);
        }

        // 检查文件类型
        if (!ALLOWED_TYPES.includes(file.mimetype)) {
            validation.valid = false;
            validation.errors.push(`不支持的文件类型: ${file.mimetype}`);
        }

        return validation;
    }
}

module.exports = FileService; 
