FROM node:20-alpine

WORKDIR /app

# Enable corepack for yarn
RUN corepack enable && corepack prepare yarn@4.x --activate

# Copy package files
COPY package*.json yarn.lock ./

# Clear stale cache and reinstall with fresh lockfile
RUN rm -rf .yarn/cache .yarn/install-state.gz && yarn install --refresh-lockfile

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN yarn build

# Expose port (Railway will inject PORT env var)
EXPOSE 8234

# Start the server
CMD ["yarn", "start"]

