const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 8000;

// Enable compression for better performance
const compression = require('compression');
app.use(compression());

// Serve static files from the current directory
app.use(express.static('.'));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Handle all routes - serve index.html for SPA-like behavior
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
