FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 3000

CMD ["npm", "start"]