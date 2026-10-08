FROM oven/bun:1.3.11
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV MINI_LETTA_HOME=/data
EXPOSE 8787
CMD ["bun", "src/cli.ts", "palace", "--host", "0.0.0.0", "--port", "8787"]
