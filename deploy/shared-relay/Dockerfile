FROM docker.io/oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --ignore-scripts && mkdir /data && chown bun:bun /data
COPY src ./src
COPY schemas ./schemas
USER bun
VOLUME /data
EXPOSE 8878
CMD ["bun", "src/team-host.js", "start", "/data", "--host=0.0.0.0", "--port=8878"]
