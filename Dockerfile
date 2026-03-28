# Use Node 20
FROM node:20

# Create app dir
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install deps
RUN npm install

# Copy everything
COPY . .

# Expose port
EXPOSE 5050

# Start app
CMD ["node", "server.js"]