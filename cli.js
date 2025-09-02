#!/usr/bin/env node

// Load environment variables first
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available, continue without it
}

// Now run the main CLI
require('./dist/index.js');
