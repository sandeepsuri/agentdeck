# Issue #90: the AgentDeck relay as its own small image. It needs only Node
# and `ws`: none of the Mac app's native modules. Build from the repo root:
#   docker build -f relay/Dockerfile -t agentdeck-relay .
FROM node:24-alpine AS build
WORKDIR /build
RUN echo '{"type":"module","private":true}' > package.json \
  && npm install --no-audit --no-fund typescript@5 ws@8 @types/ws@8 @types/node@22
COPY src/relay/server.ts src/relay/apns.ts src/relay/main.ts src/relay/
RUN npx tsc --outDir out --rootDir src --module nodenext --moduleResolution nodenext --target es2022 \
  --strict --noUncheckedIndexedAccess --skipLibCheck --types node src/relay/main.ts

FROM node:24-alpine
WORKDIR /app
RUN echo '{"type":"module","private":true}' > package.json && npm install --no-audit --no-fund --omit=dev ws@8
COPY --from=build /build/out/relay ./relay
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "relay/main.js"]
