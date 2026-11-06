FROM node:24.21.0-bookworm-slim
WORKDIR /plugin
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
CMD ["npm","test"]
