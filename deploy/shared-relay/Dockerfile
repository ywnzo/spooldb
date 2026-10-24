FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY src ./src
COPY schemas ./schemas
USER node
VOLUME /data
EXPOSE 8878
CMD ["node", "src/team-host.js", "start", "/data", "--host=0.0.0.0", "--port=8878"]
