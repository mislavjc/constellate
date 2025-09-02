#!/usr/bin/env node

// Load environment variables first
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available, continue without it
}

// Now run the main CLI using dynamic import
import('./dist/index.js').catch((err) => {
  console.error('Error running CLI:', err);
  process.exit(1);
});
