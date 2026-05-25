# node:20-alpine is already cached locally — Docker Hub is unreliable on this
# network, so we reuse what's there. 20 vs 22 doesn't matter for Vite/React.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com && npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
