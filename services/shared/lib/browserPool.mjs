/**
 * Browser Pool Manager
 * Manages Playwright browser instances with health monitoring and automatic recovery
 * Prevents resource exhaustion and memory leaks
 */

import { chromium, firefox, webkit } from 'playwright';
import { EventEmitter } from 'events';
import Logger from './logger.mjs';

const logger = new Logger('BrowserPool');

class BrowserPool extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxBrowsers: options.maxBrowsers || 5,
            maxPages: options.maxPages || 10,
            browserType: options.browserType || 'chromium',
            headless: options.headless !== false,
            timeout: options.timeout || 30000,
            healthCheckInterval: options.healthCheckInterval || 30000,
            maxMemoryMB: options.maxMemoryMB || 500,
            maxCpuPercent: options.maxCpuPercent || 80,
            sessionTimeout: options.sessionTimeout || 300000, // 5 minutes
            retryAttempts: options.retryAttempts || 3,
            ...options
        };

        this.browsers = new Map();
        this.sessions = new Map();
        this.metrics = {
            created: 0,
            destroyed: 0,
            crashed: 0,
            healthy: 0,
            unhealthy: 0,
            activePages: 0,
            totalRequests: 0,
            failedRequests: 0
        };

        this.healthCheckTimer = null;
        this.isShuttingDown = false;
    }

    /**
     * Initialize the browser pool
     */
    async initialize() {
        logger.info('Initializing browser pool', {
            maxBrowsers: this.config.maxBrowsers,
            browserType: this.config.browserType
        });

        // Pre-warm pool with minimum browsers
        const minBrowsers = Math.min(2, this.config.maxBrowsers);
        for (let i = 0; i < minBrowsers; i++) {
            await this.createBrowser();
        }

        // Start health monitoring
        this.startHealthMonitoring();

        logger.info('Browser pool initialized', {
            activeBrowsers: this.browsers.size
        });
    }

    /**
     * Get a browser page for automation
     */
    async getPage(sessionId, options = {}) {
        this.metrics.totalRequests++;
        
        try {
            // Check if we're shutting down
            if (this.isShuttingDown) {
                throw new Error('Browser pool is shutting down');
            }

            // Find or create a browser
            const browser = await this.getAvailableBrowser();
            if (!browser) {
                throw new Error('No available browsers in pool');
            }

            // Create new context for isolation
            const context = await browser.newContext({
                viewport: options.viewport || { width: 1920, height: 1080 },
                userAgent: options.userAgent,
                locale: options.locale || 'en-US',
                timezoneId: options.timezoneId || 'America/New_York',
                permissions: options.permissions,
                recordVideo: options.recordVideo ? {
                    dir: `./recordings/${sessionId}`,
                    size: { width: 1280, height: 720 }
                } : undefined,
                ...options.contextOptions
            });

            // Set default timeout
            context.setDefaultTimeout(this.config.timeout);
            context.setDefaultNavigationTimeout(this.config.timeout);

            // Create page
            const page = await context.newPage();

            // Track session
            const session = {
                sessionId,
                browser,
                context,
                page,
                createdAt: Date.now(),
                lastActivity: Date.now(),
                memoryUsage: 0,
                cpuUsage: 0
            };

            this.sessions.set(sessionId, session);
            this.metrics.activePages++;

            // Set up error handlers
            page.on('crash', () => this.handlePageCrash(sessionId));
            page.on('pageerror', error => this.handlePageError(sessionId, error));

            // Set up activity tracking
            page.on('request', () => {
                session.lastActivity = Date.now();
            });

            logger.info('Page created', {
                sessionId,
                browserPid: browser._process?.pid
            });

            return page;

        } catch (error) {
            this.metrics.failedRequests++;
            logger.error('Failed to get page', {
                sessionId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Release a page and clean up resources
     */
    async releasePage(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn('Session not found for release', { sessionId });
            return;
        }

        try {
            // Close page and context
            if (session.page && !session.page.isClosed()) {
                await session.page.close();
            }
            
            if (session.context) {
                await session.context.close();
            }

            this.sessions.delete(sessionId);
            this.metrics.activePages--;

            logger.info('Page released', {
                sessionId,
                duration: Date.now() - session.createdAt
            });

        } catch (error) {
            logger.error('Error releasing page', {
                sessionId,
                error: error.message
            });
        }
    }

    /**
     * Get an available browser from the pool
     */
    async getAvailableBrowser() {
        // Try to find a healthy browser with capacity
        for (const [id, browser] of this.browsers) {
            if (browser.isHealthy && browser.contexts.length < this.config.maxPages) {
                return browser.instance;
            }
        }

        // Create new browser if under limit
        if (this.browsers.size < this.config.maxBrowsers) {
            return await this.createBrowser();
        }

        // Wait for available browser
        return await this.waitForAvailableBrowser();
    }

    /**
     * Create a new browser instance
     */
    async createBrowser() {
        const browserId = `browser-${Date.now()}`;
        
        try {
            logger.info('Creating new browser', { browserId });

            const launchOptions = {
                headless: this.config.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--deterministic-fetch',
                    '--disable-features=IsolateOrigins',
                    '--disable-site-isolation-trials',
                    `--max-old-space-size=${this.config.maxMemoryMB}`,
                ],
                timeout: this.config.timeout
            };

            let instance;
            switch (this.config.browserType) {
                case 'firefox':
                    instance = await firefox.launch(launchOptions);
                    break;
                case 'webkit':
                    instance = await webkit.launch(launchOptions);
                    break;
                default:
                    instance = await chromium.launch(launchOptions);
            }

            const browser = {
                id: browserId,
                instance,
                contexts: [],
                isHealthy: true,
                createdAt: Date.now(),
                lastHealthCheck: Date.now(),
                metrics: {
                    pagesCreated: 0,
                    errors: 0,
                    memoryUsage: 0,
                    cpuUsage: 0
                }
            };

            this.browsers.set(browserId, browser);
            this.metrics.created++;
            this.metrics.healthy++;

            // Set up disconnect handler
            instance.on('disconnected', () => this.handleBrowserDisconnect(browserId));

            logger.info('Browser created', {
                browserId,
                pid: instance._process?.pid
            });

            return instance;

        } catch (error) {
            logger.error('Failed to create browser', {
                browserId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Wait for an available browser
     */
    async waitForAvailableBrowser(timeout = 10000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            for (const [id, browser] of this.browsers) {
                if (browser.isHealthy && browser.contexts.length < this.config.maxPages) {
                    return browser.instance;
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        throw new Error('Timeout waiting for available browser');
    }

    /**
     * Start health monitoring
     */
    startHealthMonitoring() {
        this.healthCheckTimer = setInterval(async () => {
            await this.performHealthCheck();
        }, this.config.healthCheckInterval);

        logger.info('Health monitoring started', {
            interval: this.config.healthCheckInterval
        });
    }

    /**
     * Perform health check on all browsers
     */
    async performHealthCheck() {
        const checks = [];
        
        for (const [id, browser] of this.browsers) {
            checks.push(this.checkBrowserHealth(id, browser));
        }

        await Promise.allSettled(checks);

        // Clean up unhealthy browsers
        await this.cleanupUnhealthyBrowsers();

        // Clean up stale sessions
        await this.cleanupStaleSessions();

        // Emit metrics
        this.emit('metrics', this.getMetrics());
    }

    /**
     * Check individual browser health
     */
    async checkBrowserHealth(browserId, browser) {
        try {
            // Check if browser is still connected
            if (!browser.instance.isConnected()) {
                browser.isHealthy = false;
                this.metrics.unhealthy++;
                return;
            }

            // Check memory usage (simplified - in production use process metrics)
            const contexts = browser.instance.contexts();
            browser.contexts = contexts;
            
            // Check responsiveness
            const testContext = await browser.instance.newContext();
            const testPage = await testContext.newPage();
            await testPage.evaluate(() => 1 + 1);
            await testPage.close();
            await testContext.close();

            browser.isHealthy = true;
            browser.lastHealthCheck = Date.now();
            
        } catch (error) {
            logger.warn('Browser health check failed', {
                browserId,
                error: error.message
            });
            browser.isHealthy = false;
            this.metrics.unhealthy++;
        }
    }

    /**
     * Clean up unhealthy browsers
     */
    async cleanupUnhealthyBrowsers() {
        const toRemove = [];
        
        for (const [id, browser] of this.browsers) {
            if (!browser.isHealthy) {
                toRemove.push(id);
            }
        }

        for (const id of toRemove) {
            await this.removeBrowser(id);
        }

        // Ensure minimum browsers
        const minBrowsers = Math.min(2, this.config.maxBrowsers);
        while (this.browsers.size < minBrowsers && !this.isShuttingDown) {
            await this.createBrowser();
        }
    }

    /**
     * Clean up stale sessions
     */
    async cleanupStaleSessions() {
        const now = Date.now();
        const stale = [];

        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastActivity > this.config.sessionTimeout) {
                stale.push(sessionId);
            }
        }

        for (const sessionId of stale) {
            logger.warn('Cleaning up stale session', {
                sessionId,
                age: now - this.sessions.get(sessionId).createdAt
            });
            await this.releasePage(sessionId);
        }
    }

    /**
     * Remove a browser from the pool
     */
    async removeBrowser(browserId) {
        const browser = this.browsers.get(browserId);
        if (!browser) return;

        try {
            logger.info('Removing browser', { browserId });
            
            // Close all contexts
            const contexts = browser.instance.contexts();
            for (const context of contexts) {
                await context.close();
            }

            // Close browser
            await browser.instance.close();
            
        } catch (error) {
            logger.error('Error closing browser', {
                browserId,
                error: error.message
            });
        }

        this.browsers.delete(browserId);
        this.metrics.destroyed++;
    }

    /**
     * Handle browser disconnect
     */
    handleBrowserDisconnect(browserId) {
        logger.error('Browser disconnected', { browserId });
        this.metrics.crashed++;
        
        const browser = this.browsers.get(browserId);
        if (browser) {
            browser.isHealthy = false;
        }
    }

    /**
     * Handle page crash
     */
    handlePageCrash(sessionId) {
        logger.error('Page crashed', { sessionId });
        this.metrics.crashed++;
        
        // Clean up session
        this.releasePage(sessionId);
        
        // Emit event for monitoring
        this.emit('page-crash', { sessionId });
    }

    /**
     * Handle page error
     */
    handlePageError(sessionId, error) {
        logger.error('Page error', {
            sessionId,
            error: error.message
        });
        
        const session = this.sessions.get(sessionId);
        if (session && session.browser) {
            const browser = Array.from(this.browsers.values())
                .find(b => b.instance === session.browser);
            if (browser) {
                browser.metrics.errors++;
            }
        }
    }

    /**
     * Get pool metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            activeBrowsers: this.browsers.size,
            activeSessions: this.sessions.size,
            healthyBrowsers: Array.from(this.browsers.values())
                .filter(b => b.isHealthy).length
        };
    }

    /**
     * Shutdown the browser pool
     */
    async shutdown() {
        logger.info('Shutting down browser pool');
        this.isShuttingDown = true;

        // Stop health monitoring
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }

        // Release all sessions
        const sessionIds = Array.from(this.sessions.keys());
        for (const sessionId of sessionIds) {
            await this.releasePage(sessionId);
        }

        // Close all browsers
        const browserIds = Array.from(this.browsers.keys());
        for (const browserId of browserIds) {
            await this.removeBrowser(browserId);
        }

        logger.info('Browser pool shutdown complete', this.metrics);
    }
}

export default BrowserPool;