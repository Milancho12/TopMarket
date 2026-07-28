FROM ghcr.io/puppeteer/puppeteer:latest

# Set working directory
WORKDIR /app

# Switch to root for installing dependencies if needed
USER root

# Copy package.json first
COPY package*.json ./

# Install npm dependencies and force rebuild sqlite3 from source to fix GLIBC issues
RUN npm install && npm rebuild sqlite3 --build-from-source

# Create a symlink for the bundled Chrome to bypass Puppeteer version checks
RUN ln -s $(find /home/pptruser/.cache/puppeteer/chrome -name "chrome" -type f | head -n 1) /usr/bin/google-chrome-stable

# Copy all other files
COPY . .

# Set permissions for sqlite database directory
RUN mkdir -p /app/data && chown -R pptruser:pptruser /app

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
