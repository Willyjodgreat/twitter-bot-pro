// manual_login.js - IMPROVED VERSION
const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');

async function createManualSession() {
  console.log('\n🔓 MANUAL TWITTER SESSION CREATOR');
  console.log('====================================');
  console.log('IMPORTANT: Twitter may show Google/Gmail login option');
  console.log('This script handles BOTH methods\n');
  
  // Create readline interface for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const browser = await chromium.launch({ 
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled' // Hide automation
    ]
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  
  console.log('📱 Browser opening...');
  console.log('\n=== LOGIN OPTIONS ===');
  console.log('Option A: If Twitter shows Google button:');
  console.log('  1. Click "Continue with Google"');
  console.log('  2. Log into your Google account');
  console.log('  3. Authorize Twitter access');
  console.log('\nOption B: If Twitter shows username/password:');
  console.log('  1. Enter your Twitter username/email/phone');
  console.log('  2. Enter password');
  console.log('  3. Complete 2FA if you have it\n');
  
  console.log('=== IMPORTANT NOTES ===');
  console.log('• DO NOT close the browser manually');
  console.log('• Wait until you see your Twitter HOME PAGE');
  console.log('• You should see tweets in your timeline');
  console.log('• Script will auto-continue after successful login\n');
  
  // Go to Twitter login
  try {
    console.log('🌐 Navigating to Twitter login...');
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
  } catch (error) {
    console.log('⚠️  Using fallback URL...');
    await page.goto('https://twitter.com/login', {
      waitUntil: 'networkidle',
      timeout: 60000
    });
  }
  
  console.log('\n✅ Login page loaded!');
  console.log('\n=== INSTRUCTIONS ===');
  console.log('1. Complete the login process in the browser window');
  console.log('2. Wait until you see your Twitter HOME PAGE (with tweets)');
  console.log('3. Press Enter in this terminal when you see your home page');
  console.log('\n🎯 START LOGGING IN NOW!');
  
  // Wait for user to press Enter when done
  await new Promise(resolve => {
    rl.question('\n⏳ Press Enter ONLY AFTER you see your Twitter home page (with tweets): ', () => {
      rl.close();
      resolve();
    });
  });
  
  console.log('\n🔍 Checking login status...');
  
  // Wait a moment for any final page loads
  await page.waitForTimeout(5000);
  
  // Try multiple URLs to confirm login
  const checkUrls = [
    'https://twitter.com/home',
    'https://x.com/home',
    'https://twitter.com',
    'https://x.com'
  ];
  
  let loginVerified = false;
  let currentUrl = '';
  
  for (const url of checkUrls) {
    try {
      console.log(`Trying ${url}...`);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      });
      
      await page.waitForTimeout(3000);
      currentUrl = page.url();
      
      // Enhanced login checks
      const loginSelectors = [
        '[data-testid="tweetTextarea_0"]',
        '[data-testid="SideNav_NewTweet_Button"]',
        'a[href="/compose/tweet"]',
        'article[data-testid="tweet"]',
        '[data-testid="primaryColumn"]',
        'text="Home"',
        'text="Tweet"'
      ];
      
      for (const selector of loginSelectors) {
        try {
          const element = await page.waitForSelector(selector, { 
            timeout: 5000,
            state: 'visible'
          });
          if (element) {
            loginVerified = true;
            console.log(`✅ Found logged-in indicator: ${selector}`);
            break;
          }
        } catch { /* Continue to next selector */ }
      }
      
      if (loginVerified) break;
      
    } catch (error) {
      console.log(`⚠️  Could not load ${url}: ${error.message}`);
      continue;
    }
  }
  
  if (loginVerified) {
    // Save session
    await context.storageState({ path: 'twitter_session.json' });
    
    // Verify file was created
    if (fs.existsSync('twitter_session.json')) {
      const stats = fs.statSync('twitter_session.json');
      if (stats.size > 100) { // Ensure file has content
        console.log('\n🎉 SUCCESS: Session saved to twitter_session.json');
        console.log(`📁 File size: ${stats.size} bytes`);
        console.log('✅ You can now start the bot with: node index.js');
        
        // Show quick verification
        const sessionData = JSON.parse(fs.readFileSync('twitter_session.json', 'utf8'));
        const cookies = sessionData.cookies || [];
        console.log(`🍪 ${cookies.length} cookies saved`);
        
      } else {
        console.log('\n⚠️  WARNING: Session file is too small');
        console.log('Try logging in again');
      }
    } else {
      console.log('\n❌ ERROR: Session file was not created');
    }
  } else {
    console.log('\n❌ LOGIN FAILED: Not logged in');
    console.log(`Current URL: ${currentUrl || 'Unknown'}`);
    console.log('\nPossible issues:');
    console.log('1. Login not completed');
    console.log('2. Twitter showing different layout');
    console.log('3. Account verification required');
    
    // Save debug info
    await page.screenshot({ path: 'login_debug.png', fullPage: true });
    console.log('📸 Screenshot saved: login_debug.png');
    
    // Save page HTML for debugging
    const html = await page.content();
    fs.writeFileSync('login_page.html', html);
    console.log('📄 Page HTML saved: login_page.html');
  }
  
  // Give user time to read output
  console.log('\n⏳ Closing browser in 5 seconds...');
  await page.waitForTimeout(5000);
  
  await browser.close();
  console.log('\n=== NEXT STEPS ===');
  if (loginVerified) {
    console.log('1. Run: node index.js');
    console.log('2. Bot will use the saved session');
  } else {
    console.log('1. Check login_debug.png and login_page.html');
    console.log('2. Run this script again: node manual_login.js');
    console.log('3. Make sure to complete login fully');
  }
}

// Run if called directly
if (require.main === module) {
  createManualSession().catch(error => {
    console.error('❌ FATAL ERROR:', error);
    process.exit(1);
  });
}

module.exports = { createManualSession };