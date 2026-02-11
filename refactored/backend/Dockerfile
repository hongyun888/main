FROM rjotyps3.mirror.aliyuncs.com/library/node:latest

WORKDIR /app



RUN npm config set registry https://registry.npmmirror.com


COPY package*.json ./

RUN npm install

COPY . .


EXPOSE 3004

# 启动应用程序
CMD ["node", "server.js"]