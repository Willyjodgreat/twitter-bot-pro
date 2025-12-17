// ==================== ELITE TWITTER BOT PRO ====================
// COMPLETE WITH: Dashboard, Rate Limits, Proxies, Stealth, Database
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.API_PORT || 3000;

// ==================== CONFIGURATION ====================
const CONFIG = {
  // Limits
  DAILY_LIMIT: 500,
  HOURLY_LIMIT: 60,
  MIN_DELAY: 120000,    // 2 minutes
  MAX_DELAY: 300000,    // 5 minutes
  
  // Browser
  MAX_BROWSERS: 3,
  USE_STEALTH: true,
  
  // Proxy
  USE_PROXY: process.env.USE_PROXY === 'true',
  PROXY_LIST: process.env.PROXY_LIST?.split(',') || [],
  
  // Database
  USE_DATABASE: true,
  
  // Safety
  MAX_RETRIES: 3,
  SESSION_TIMEOUT: 3600000
};

// ==================== DATABASE MANAGER ====================
class DatabaseManager {
  constructor() {
    this.db = new sqlite3.Database('bot_stats.db');
    this.initDatabase();
  }
  
  initDatabase() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tweets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        reply_text TEXT,
        status TEXT,
        error TEXT,
        response_time INTEGER,
        proxy_used TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.db.run(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        date DATE PRIMARY KEY,
        count INTEGER DEFAULT 0,
        success INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0
      )
    `);
    
    this.db.run(`
      CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy TEXT UNIQUE,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used DATETIME
      )
    `);
  }
  
  async logTweet(tweetId, replyText, status, error = null, responseTime = null, proxy = null) {
    return new Promise((resolve) => {
      this.db.run(
        `INSERT INTO tweets (tweet_id, reply_text, status, error, response_time, proxy_used) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tweetId, replyText, status, error, responseTime, proxy],
        resolve
      );
    });
  }
  
  async updateDailyStats() {
    const today = new Date().toISOString().split('T')[0];
    return new Promise((resolve) => {
      this.db.run(
        `INSERT OR REPLACE INTO daily_stats (date, count, success, failed)
         VALUES (?, COALESCE((SELECT count FROM daily_stats WHERE date = ?), 0) + 1,
                 COALESCE((SELECT success FROM daily_stats WHERE date = ?), 0) + 1,
                 COALESCE((SELECT failed FROM daily_stats WHERE date = ?), 0))`,
        [today, today, today, today],
        resolve
      );
    });
  }
  
  async getStats() {
    return new Promise((resolve) => {
      this.db.all(`
        SELECT 
          (SELECT COUNT(*) FROM tweets) as total,
          (SELECT COUNT(*) FROM tweets WHERE status = 'success') as success,
          (SELECT COUNT(*) FROM tweets WHERE status = 'failed') as failed,
          (SELECT COUNT(*) FROM tweets WHERE DATE(created_at) = DATE('now')) as today,
          (SELECT SUM(response_time) / COUNT(*) FROM tweets WHERE response_time IS NOT NULL) as avg_time
      `, (err, rows) => {
        resolve(rows?.[0] || { total: 0, success: 0, failed: 0, today: 0, avg_time: 0 });
      });
    });
  }
  
  async getRecentTweets(limit = 20) {
    return new Promise((resolve) => {
      this.db.all(
        `SELECT * FROM tweets ORDER BY created_at DESC LIMIT ?`,
        [limit],
        (err, rows) => resolve(rows || [])
      );
    });
  }
}

// ==================== PROXY ROTATOR ====================
class ProxyRotator {
  constructor() {
    this.proxies = CONFIG.PROXY_LIST;
    this.currentIndex = 0;
    this.stats = {};
  }
  
  getNextProxy() {
    if (!CONFIG.USE_PROXY || this.proxies.length === 0) {
      return null;
    }
    
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    
    return {
      server: proxy,
      bypass: '*.twitter.com,*.x.com'
    };
  }
  
  markSuccess(proxy) {
    if (!proxy) return;
    this.stats[proxy] = (this.stats[proxy] || 0) + 1;
  }
  
  markFailed(proxy) {
    if (!proxy) return;
    this.stats[proxy] = (this.stats[proxy] || 0) - 1;
  }
}

// ==================== RATE LIMITER ====================
class RateLimiter {
  constructor() {
    this.dailyCount = 0;
    this.hourlyCount = 0;
    this.lastAction = 0;
    this.loadState();
  }
  
  canProceed() {
    // Reset if new day
    const now = new Date();
    if (now.getDate() !== new Date(this.lastAction).getDate()) {
      this.dailyCount = 0;
    }
    
    // Reset if new hour
    if (now.getHours() !== new Date(this.lastAction).getHours()) {
      this.hourlyCount = 0;
    }
    
    if (this.dailyCount >= CONFIG.DAILY_LIMIT) {
      console.log(`🚫 Daily limit reached: ${this.dailyCount}/${CONFIG.DAILY_LIMIT}`);
      return false;
    }
    
    if (this.hourlyCount >= CONFIG.HOURLY_LIMIT) {
      console.log(`🚫 Hourly limit reached: ${this.hourlyCount}/${CONFIG.HOURLY_LIMIT}`);
      return false;
    }
    
    const timeSince = Date.now() - this.lastAction;
    if (timeSince < CONFIG.MIN_DELAY) {
      const waitSec = Math.ceil((CONFIG.MIN_DELAY - timeSince) / 1000);
      console.log(`⏳ Please wait ${waitSec} seconds`);
      return false;
    }
    
    return true;
  }
  
  recordAction() {
    this.dailyCount++;
    this.hourlyCount++;
    this.lastAction = Date.now();
    this.saveState();
    
    console.log(`📊 Daily: ${this.dailyCount}/${CONFIG.DAILY_LIMIT} | Hourly: ${this.hourlyCount}/${CONFIG.HOURLY_LIMIT}`);
    console.log(`🎯 Remaining today: ${CONFIG.DAILY_LIMIT - this.dailyCount}`);
  }
  
  getWaitTime() {
    const timeSince = Date.now() - this.lastAction;
    if (timeSince < CONFIG.MIN_DELAY) {
      return CONFIG.MIN_DELAY - timeSince;
    }
    
    // Random delay between min and max
    return CONFIG.MIN_DELAY + Math.random() * (CONFIG.MAX_DELAY - CONFIG.MIN_DELAY);
  }
  
  saveState() {
    const state = {
      dailyCount: this.dailyCount,
      hourlyCount: this.hourlyCount,
      lastAction: this.lastAction,
      savedAt: Date.now()
    };
    
    fs.writeFileSync('rate_state.json', JSON.stringify(state, null, 2));
  }
  
  loadState() {
    try {
      if (fs.existsSync('rate_state.json')) {
        const state = JSON.parse(fs.readFileSync('rate_state.json', 'utf8'));
        this.dailyCount = state.dailyCount || 0;
        this.hourlyCount = state.hourlyCount || 0;
        this.lastAction = state.lastAction || 0;
      }
    } catch (e) {
      console.log('No previous rate state found');
    }
  }
}

// ==================== TWITTER BOT ====================
class TwitterBot {
  constructor(database, proxyRotator, rateLimiter) {
    this.db = database;
    this.proxyRotator = proxyRotator;
    this.rateLimiter = rateLimiter;
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
  }
  
  async initialize() {
    console.log('🚀 Initializing Twitter Bot Pro...');
    
    // Check session
    if (!fs.existsSync('twitter_session.json')) {
      throw new Error('❌ No session file! Run: npm run login');
    }
    
    const launchOptions = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--hide-scrollbars',
        '--mute-audio'
      ]
    };
    
    // Add proxy if enabled
    const proxy = this.proxyRotator.getNextProxy();
    if (proxy) {
      launchOptions.proxy = proxy;
      console.log(`🌐 Using proxy: ${proxy.server}`);
    }
    
    this.browser = await chromium.launch(launchOptions);
    
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    
    // Stealth mode
    if (CONFIG.USE_STEALTH) {
      await context.addInitScript(() => {
        // Override webdriver property
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        
        // Override plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        
        // Override languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
        
        // Mock Chrome runtime
        window.chrome = { runtime: {} };
        
        // Mock permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      });
    }
    
    // Load cookies
    const sessionData = JSON.parse(fs.readFileSync('twitter_session.json', 'utf8'));
    await context.addCookies(sessionData.cookies);
    console.log(`✅ Loaded ${sessionData.cookies.length} cookies`);
    
    this.page = await context.newPage();
    
    // Verify login
    await this.verifyLogin();
    
    console.log('✅ Twitter Bot Pro initialized!');
  }
  
  async verifyLogin() {
    console.log('🔐 Verifying login...');
    
    await this.page.goto('https://twitter.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    await this.page.waitForTimeout(5000);
    
    try {
      await this.page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      this.isLoggedIn = true;
      console.log('✅ Successfully logged in!');
      return true;
    } catch (error) {
      console.log('❌ Not logged in. Please run: npm run login');
      this.isLoggedIn = false;
      return false;
    }
  }
  
  async sendReply(tweetId, replyText) {
    const startTime = Date.now();
    const proxy = this.proxyRotator.getNextProxy();
    
    // Rate limit check
    if (!this.rateLimiter.canProceed()) {
      const waitTime = this.rateLimiter.getWaitTime();
      throw new Error(`Rate limited. Wait ${Math.ceil(waitTime/1000)}s`);
    }
    
    if (!this.isLoggedIn) {
      throw new Error('Not logged into Twitter');
    }
    
    try {
      console.log(`\n🎯 Starting reply to tweet: ${tweetId}`);
      console.log(`💬 Text: ${replyText.substring(0, 50)}...`);
      console.log(`🌐 Proxy: ${proxy?.server || 'None'}`);
      
      // Wait based on rate limits
      const waitTime = this.rateLimiter.getWaitTime();
      console.log(`⏳ Waiting ${Math.ceil(waitTime/1000)} seconds...`);
      await this.page.waitForTimeout(waitTime);
      
      // Navigate to tweet
      await this.page.goto(`https://twitter.com/i/status/${tweetId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      
      await this.page.waitForTimeout(3000);
      
      // Simulate human scrolling
      await this.page.evaluate(() => {
        window.scrollBy(0, 200);
      });
      await this.page.waitForTimeout(1000);
      
      // Find reply button
      console.log('🔍 Looking for reply button...');
      const replyButton = await this.page.waitForSelector('[data-testid="reply"]', { timeout: 10000 });
      
      // Human-like mouse movement
      const box = await replyButton.boundingBox();
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await this.page.waitForTimeout(500);
      
      await replyButton.click();
      await this.page.waitForTimeout(2000);
      
      // Type reply
      console.log('⌨️ Typing reply...');
      const textarea = await this.page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      await textarea.click();
      
      // Type with human-like delays
      for (let i = 0; i < replyText.length; i++) {
        await this.page.keyboard.type(replyText[i], { 
          delay: Math.floor(Math.random() * 100) + 30 
        });
        
        // Random pause
        if (Math.random() > 0.95) {
          await this.page.waitForTimeout(300);
        }
      }
      
      await this.page.waitForTimeout(1500);
      
      // Send tweet
      console.log('🚀 Sending reply...');
      const sendButton = await this.page.waitForSelector('[data-testid="tweetButton"]', { timeout: 10000 });
      await sendButton.click();
      
      await this.page.waitForTimeout(8000);
      
      // Check for success
      try {
        await this.page.waitForSelector('[data-testid="toast"]', { timeout: 5000 });
        console.log('✅ Success toast detected!');
      } catch (e) {
        console.log('✅ Reply sent (no toast detected)');
      }
      
      const responseTime = Date.now() - startTime;
      
      // Update rate limits
      this.rateLimiter.recordAction();
      
      // Log to database
      await this.db.logTweet(
        tweetId,
        replyText,
        'success',
        null,
        responseTime,
        proxy?.server
      );
      
      await this.db.updateDailyStats();
      
      console.log(`✨ Reply completed in ${responseTime}ms`);
      
      return {
        success: true,
        tweetId,
        responseTime,
        proxy: proxy?.server,
        dailyUsed: this.rateLimiter.dailyCount,
        dailyRemaining: CONFIG.DAILY_LIMIT - this.rateLimiter.dailyCount,
        hourlyUsed: this.rateLimiter.hourlyCount,
        hourlyRemaining: CONFIG.HOURLY_LIMIT - this.rateLimiter.hourlyCount
      };
      
    } catch (error) {
      console.error(`❌ Error:`, error.message);
      
      await this.db.logTweet(
        tweetId,
        replyText,
        'failed',
        error.message,
        Date.now() - startTime,
        proxy?.server
      );
      
      // Save screenshot for debugging
      try {
        await this.page.screenshot({ path: `error_${Date.now()}.png` });
        console.log('📸 Error screenshot saved');
      } catch (e) {}
      
      throw error;
    }
  }
  
  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ==================== INITIALIZE ====================
const database = new DatabaseManager();
const proxyRotator = new ProxyRotator();
const rateLimiter = new RateLimiter();
const bot = new TwitterBot(database, proxyRotator, rateLimiter);

// ==================== EXPRESS SETUP ====================
app.use(express.json());

// ==================== API ENDPOINTS ====================
app.post('/api/v1/reply', async (req, res) => {
  try {
    const { tweetId, replyText } = req.body;
    
    if (!tweetId || !replyText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing tweetId or replyText' 
      });
    }
    
    const result = await bot.sendReply(tweetId, replyText);
    
    res.json({
      success: true,
      ...result,
      message: `Reply sent successfully! ${result.dailyRemaining} replies remaining today.`
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// N8N Webhook
app.post('/n8n/webhook', async (req, res) => {
  try {
    console.log('📥 N8N Webhook received:', req.body);
    
    const { tweetId, replyText } = req.body;
    
    if (!tweetId || !replyText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing tweetId or replyText in webhook payload' 
      });
    }
    
    const result = await bot.sendReply(tweetId, replyText);
    
    res.json({
      success: true,
      ...result,
      source: 'n8n',
      webhook_id: req.body.id || 'unknown'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'n8n'
    });
  }
});

app.get('/api/v1/stats', async (req, res) => {
  try {
    const stats = await database.getStats();
    const recent = await database.getRecentTweets(10);
    
    res.json({
      success: true,
      stats: {
        ...stats,
        dailyLimit: CONFIG.DAILY_LIMIT,
        hourlyLimit: CONFIG.HOURLY_LIMIT,
        currentDaily: rateLimiter.dailyCount,
        currentHourly: rateLimiter.hourlyCount
      },
      recent,
      config: {
        useProxy: CONFIG.USE_PROXY,
        proxyCount: proxyRotator.proxies.length,
        useStealth: CONFIG.USE_STEALTH,
        minDelay: CONFIG.MIN_DELAY / 1000,
        maxDelay: CONFIG.MAX_DELAY / 1000
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v1/reset', (req, res) => {
  try {
    rateLimiter.dailyCount = 0;
    rateLimiter.hourlyCount = 0;
    rateLimiter.saveState();
    
    res.json({
      success: true,
      message: 'Rate limits reset successfully!'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== DASHBOARD ====================
app.get('/', async (req, res) => {
  try {
    const stats = await database.getStats();
    const recent = await database.getRecentTweets(5);
    
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🐦 Twitter Bot Pro Dashboard</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <script>
        tailwind.config = {
          theme: {
            extend: {
              colors: {
                twitter: '#1DA1F2',
              }
            }
          }
        }
      </script>
    </head>
    <body class="bg-gray-900 text-white min-h-screen">
      <div class="container mx-auto px-4 py-8">
        <!-- Header -->
        <div class="text-center mb-12">
          <h1 class="text-4xl font-bold mb-4">
            <i class="fab fa-twitter text-twitter mr-3"></i>
            Twitter Bot Pro Dashboard
          </h1>
          <div class="flex flex-wrap justify-center gap-4 mb-6">
            <span class="bg-green-500 text-white px-4 py-2 rounded-full font-bold">
              <i class="fas fa-bolt mr-2"></i>500 REPLIES/DAY
            </span>
            <span class="bg-purple-500 text-white px-4 py-2 rounded-full font-bold">
              <i class="fas fa-shield-alt mr-2"></i>STEALTH MODE
            </span>
            <span class="bg-blue-500 text-white px-4 py-2 rounded-full font-bold">
              <i class="fas fa-sync-alt mr-2"></i>PROXY ROTATION
            </span>
            <span class="bg-yellow-500 text-white px-4 py-2 rounded-full font-bold">
              <i class="fas fa-database mr-2"></i>SQLITE TRACKING
            </span>
          </div>
        </div>
        
        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-400">Total Replies</p>
                <p class="text-3xl font-bold">${stats.total}</p>
              </div>
              <i class="fas fa-paper-plane text-twitter text-3xl"></i>
            </div>
          </div>
          
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-400">Successful</p>
                <p class="text-3xl font-bold text-green-400">${stats.success}</p>
              </div>
              <i class="fas fa-check-circle text-green-400 text-3xl"></i>
            </div>
          </div>
          
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-400">Today's Count</p>
                <p class="text-3xl font-bold">${stats.today}/500</p>
              </div>
              <i class="fas fa-calendar-day text-yellow-400 text-3xl"></i>
            </div>
            <div class="mt-4">
              <div class="w-full bg-gray-700 rounded-full h-2">
                <div class="bg-twitter h-2 rounded-full" style="width: ${(stats.today/500)*100}%"></div>
              </div>
            </div>
          </div>
          
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-400">Avg Response Time</p>
                <p class="text-3xl font-bold">${Math.round(stats.avg_time || 0)}ms</p>
              </div>
              <i class="fas fa-clock text-blue-400 text-3xl"></i>
            </div>
          </div>
        </div>
        
        <!-- Main Content -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <!-- Send Reply Panel -->
          <div class="bg-gray-800 rounded-xl shadow-lg p-6">
            <h2 class="text-2xl font-bold mb-6">
              <i class="fas fa-rocket mr-3"></i>Send Reply
            </h2>
            
            <div class="space-y-4">
              <div>
                <label class="block text-gray-400 mb-2">Tweet ID</label>
                <input type="text" id="tweetId" 
                       class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 focus:outline-none focus:border-twitter"
                       placeholder="e.g., 1980163291399041147"
                       value="1980163291399041147">
              </div>
              
              <div>
                <label class="block text-gray-400 mb-2">Reply Text</label>
                <textarea id="replyText" rows="4"
                          class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 focus:outline-none focus:border-twitter"
                          placeholder="Enter your reply text here...">🤖 Twitter Bot Pro - 500 replies/day with proxy rotation! 🚀</textarea>
              </div>
              
              <div class="flex gap-4">
                <button onclick="sendReply()" 
                        class="flex-1 bg-twitter hover:bg-blue-600 text-white font-bold py-3 px-6 rounded-lg transition duration-200">
                  <i class="fas fa-paper-plane mr-2"></i>Send Reply
                </button>
                
                <button onclick="resetLimits()" 
                        class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-3 px-6 rounded-lg transition duration-200">
                  <i class="fas fa-redo mr-2"></i>Reset Limits
                </button>
              </div>
            </div>
            
            <div id="result" class="mt-6 hidden p-4 rounded-lg"></div>
          </div>
          
          <!-- Recent Activity -->
          <div class="bg-gray-800 rounded-xl shadow-lg p-6">
            <h2 class="text-2xl font-bold mb-6">
              <i class="fas fa-history mr-3"></i>Recent Activity
            </h2>
            
            <div class="space-y-4">
              ${recent.map(tweet => `
                <div class="bg-gray-700 rounded-lg p-4">
                  <div class="flex justify-between items-start">
                    <div>
                      <p class="font-mono text-sm text-gray-300">${tweet.tweet_id}</p>
                      <p class="text-sm mt-2">${tweet.reply_text?.substring(0, 60)}${tweet.reply_text?.length > 60 ? '...' : ''}</p>
                    </div>
                    <span class="px-3 py-1 rounded-full text-xs font-bold ${tweet.status === 'success' ? 'bg-green-500' : 'bg-red-500'}">
                      ${tweet.status === 'success' ? '✅' : '❌'} ${tweet.status}
                    </span>
                  </div>
                  <div class="flex justify-between text-xs text-gray-400 mt-3">
                    <span>${new Date(tweet.created_at).toLocaleTimeString()}</span>
                    <span>${tweet.response_time ? tweet.response_time + 'ms' : ''}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        
        <!-- N8N Integration -->
        <div class="bg-gray-800 rounded-xl shadow-lg p-6 mt-8">
          <h2 class="text-2xl font-bold mb-4">
            <i class="fas fa-plug mr-3"></i>N8N Integration
          </h2>
          
          <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm">
            <p class="text-green-400">Webhook URL:</p>
            <p class="text-gray-300 mb-2">POST http://localhost:${PORT}/n8n/webhook</p>
            
            <p class="text-green-400 mt-4">JSON Payload:</p>
            <pre class="text-gray-300 bg-gray-800 p-3 rounded mt-2">
{
  "tweetId": "123456789",
  "replyText": "Your reply here"
}</pre>
            
            <div class="mt-4 p-3 bg-blue-900 rounded">
              <p class="text-blue-300">
                <i class="fas fa-info-circle mr-2"></i>
                Use this in N8N HTTP Request node to automate replies
              </p>
            </div>
          </div>
        </div>
        
        <!-- System Info -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
          <div class="bg-gray-800 rounded-lg p-4">
            <h3 class="font-bold mb-2"><i class="fas fa-tachometer-alt mr-2"></i>Rate Limits</h3>
            <p class="text-sm text-gray-400">Daily: ${rateLimiter.dailyCount}/500</p>
            <p class="text-sm text-gray-400">Hourly: ${rateLimiter.hourlyCount}/60</p>
            <p class="text-sm text-gray-400">Delay: ${CONFIG.MIN_DELAY/1000}-${CONFIG.MAX_DELAY/1000}s</p>
          </div>
          
          <div class="bg-gray-800 rounded-lg p-4">
            <h3 class="font-bold mb-2"><i class="fas fa-user-secret mr-2"></i>Stealth Features</h3>
            <p class="text-sm text-gray-400">✓ Webdriver hidden</p>
            <p class="text-sm text-gray-400">✓ Human-like typing</p>
            <p class="text-sm text-gray-400">✓ Random delays</p>
          </div>
          
          <div class="bg-gray-800 rounded-lg p-4">
            <h3 class="font-bold mb-2"><i class="fas fa-network-wired mr-2"></i>Proxy System</h3>
            <p class="text-sm text-gray-400">Status: ${CONFIG.USE_PROXY ? '✅ Enabled' : '❌ Disabled'}</p>
            <p class="text-sm text-gray-400">Proxies: ${proxyRotator.proxies.length}</p>
            <p class="text-sm text-gray-400">Rotation: Active</p>
          </div>
        </div>
        
        <div class="text-center text-gray-500 text-sm mt-12">
          <p>🐦 Twitter Bot Pro v4.0 | 500 replies/day | Stealth Mode | Proxy Rotation</p>
        </div>
      </div>
      
      <script>
        async function sendReply() {
          const tweetId = document.getElementById('tweetId').value;
          const replyText = document.getElementById('replyText').value;
          const resultDiv = document.getElementById('result');
          
          if (!tweetId || !replyText) {
            showResult('Please enter both Tweet ID and reply text', false);
            return;
          }
          
          showResult('Sending reply... Please wait...', true);
          
          try {
            const response = await fetch('/api/v1/reply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tweetId, replyText })
            });
            
            const data = await response.json();
            
            if (data.success) {
              showResult(\`
                <div class="bg-green-900 border border-green-700 rounded-lg p-4">
                  <h4 class="font-bold text-green-300 mb-2">
                    <i class="fas fa-check-circle mr-2"></i>Success!
                  </h4>
                  <p class="text-sm">Reply sent to tweet: \${data.tweetId}</p>
                  <p class="text-sm">Proxy used: \${data.proxy || 'None'}</p>
                  <p class="text-sm">Response time: \${data.responseTime}ms</p>
                  <p class="text-sm font-bold mt-2">Daily: \${data.dailyUsed}/500 (\${data.dailyRemaining} remaining)</p>
                </div>
              \`, true);
              
              setTimeout(() => location.reload(), 3000);
            } else {
              showResult(\`
                <div class="bg-red-900 border border-red-700 rounded-lg p-4">
                  <h4 class="font-bold text-red-300 mb-2">
                    <i class="fas fa-times-circle mr-2"></i>Error
                  </h4>
                  <p class="text-sm">\${data.error}</p>
                </div>
              \`, false);
            }
          } catch (error) {
            showResult(\`
              <div class="bg-red-900 border border-red-700 rounded-lg p-4">
                <h4 class="font-bold text-red-300 mb-2">
                  <i class="fas fa-exclamation-triangle mr-2"></i>Network Error
                </h4>
                <p class="text-sm">\${error.message}</p>
              </div>
            \`, false);
          }
        }
        
        async function resetLimits() {
          const response = await fetch('/api/v1/reset', { method: 'POST' });
          const data = await response.json();
          
          const resultDiv = document.getElementById('result');
          resultDiv.innerHTML = \`
            <div class="bg-yellow-900 border border-yellow-700 rounded-lg p-4">
              <p class="text-yellow-300">\${data.message}</p>
            </div>
          \`;
          resultDiv.classList.remove('hidden');
          
          setTimeout(() => location.reload(), 1500);
        }
        
        function showResult(html, isSuccess) {
          const resultDiv = document.getElementById('result');
          resultDiv.innerHTML = html;
          resultDiv.classList.remove('hidden');
        }
        
        // Auto-refresh every 30 seconds
        setInterval(() => {
          window.location.reload();
        }, 30000);
      </script>
    </body>
    </html>
    `;
    
    res.send(html);
    
  } catch (error) {
    res.send('<h1 class="text-red-500">Error loading dashboard</h1>');
  }
});

// ==================== START SERVER ====================
async function start() {
  try {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║     🐦 TWITTER BOT PRO - ULTIMATE EDITION           ║
║     🎯 500 REPLIES/DAY | 🛡️ STEALTH | 🌐 PROXY     ║
╚═══════════════════════════════════════════════════════╝

🚀 Initializing system...
    `);
    
    await bot.initialize();
    
    app.listen(PORT, () => {
      console.log(`
✅ SYSTEM READY!
📍 Dashboard: http://localhost:${PORT}
📊 API: POST http://localhost:${PORT}/api/v1/reply
🔗 N8N: POST http://localhost:${PORT}/n8n/webhook

🎯 FEATURES:
   • 📊 SQLite Database Tracking
   • 🛡️ Playwright Stealth Mode
   • 🌐 Proxy Rotation Support
   • ⚡ 500 Replies/Day Limit
   • 📈 Beautiful Dashboard
   • 🔗 N8N Integration Ready
   • ⏱️ Smart Rate Limiting

📝 USAGE:
   1. Web: Open dashboard above
   2. API: POST JSON to /api/v1/reply
   3. N8N: Configure webhook node

🎯 TARGET: ${CONFIG.DAILY_LIMIT} replies per day
⏱️  DELAYS: ${CONFIG.MIN_DELAY/1000}-${CONFIG.MAX_DELAY/1000}s between actions
🌐 PROXIES: ${proxyRotator.proxies.length} loaded
      `);
    });
    
  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await bot.close();
  process.exit(0);
});

start();