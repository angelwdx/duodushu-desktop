#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const sourceWorker = path.join(__dirname, '../node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
const targetWorker = path.join(__dirname, '../public/pdf.worker.modern.mjs');

console.log('Copying PDF.js worker file...');
console.log('Source:', sourceWorker);
console.log('Target:', targetWorker);

try {
  fs.copyFileSync(sourceWorker, targetWorker);
  console.log('✓ PDF.js worker copied successfully');
} catch (err) {
  console.error('✗ Failed to copy PDF.js worker:', err);
  process.exit(1);
}
