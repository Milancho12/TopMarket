FROM ghcr.io/puppeteer/puppeteer:latest

# Set working directory
WORKDIR /app

# Switch to root for installing dependencies if needed
USER root

# Copy package.json first
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy all other files
COPY . .

# Set permissions for sqlite database directory
RUN mkdir -p /app/data && chown -R pptruser:pptruser /app

# Switch back to the non-privileged user for security
USER pptruser

# Expose port
EXPOSE 3000

# Start command
CMD ["npm", "start"]
