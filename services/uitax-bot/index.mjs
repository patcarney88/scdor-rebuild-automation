/**
 * Enhanced UITax Bot Service
 * Advanced browser automation with pool management, CAPTCHA solving, and circuit breakers
 */

import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import BrowserPool from '../shared/lib/browserPool.mjs';
import CircuitBreaker from '../shared/lib/circuitBreaker.mjs';
import Logger from '../shared/lib/logger.mjs';

// Initialize AWS clients
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const eventbridge = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const logger = new Logger('UITaxBot');

// Configuration
const CONFIG = {
    stateTable: process.env.STATE_TABLE || 'scdor-rebuild-state-dev',
    documentsBucket: process.env.DOCUMENTS_BUCKET || 'scdor-rebuild-documents-dev',
    processingQueue: process.env.PROCESSING_QUEUE || 'scdor-rebuild-processing-dev',
    eventBus: process.env.EVENT_BUS || 'scdor-rebuild-events-dev',
    captchaApiKeyParam: process.env.CAPTCHA_API_KEY_PARAM || '/scdor-rebuild/dev/captcha_api_key',
    uitaxBaseUrl: 'https://uitax.sc.gov',
    maxRetries: 3,
    timeoutMs: 300000, // 5 minutes
    browserTimeout: 240000, // 4 minutes
    captchaTimeout: 60000 // 1 minute
};

// Initialize browser pool and circuit breakers
const browserPool = new BrowserPool({
    maxBrowsers: 3,
    maxPagesPerBrowser: 2,
    browserTimeout: CONFIG.browserTimeout,
    pageTimeout: 30000,
    healthCheckInterval: 60000
});

const captchaBreaker = new CircuitBreaker('CaptchaSolver', {
    threshold: 3,
    timeout: CONFIG.captchaTimeout,
    resetTimeout: 300000 // 5 minutes
});

const uitaxBreaker = new CircuitBreaker('UITaxSite', {
    threshold: 5,
    timeout: CONFIG.timeoutMs,
    resetTimeout: 600000 // 10 minutes
});

class UITaxBot {
    constructor() {
        this.sessionId = uuidv4();
        this.metrics = {
            processed: 0,
            successful: 0,
            failed: 0,
            captchaSolved: 0,
            captchaFailed: 0,
            browserCrashes: 0,
            timeouts: 0
        };
        this.captchaApiKey = null;
    }

    /**
     * Main Lambda handler
     */
    async handler(event, context) {
        const correlationId = context.requestId || uuidv4();
        logger.setCorrelationId(correlationId);
        
        logger.info('UITax bot processing started', {
            sessionId: this.sessionId,
            eventType: event.Records ? 'SQS' : 'Direct'
        });

        try {
            // Initialize CAPTCHA API key
            await this.initializeCaptchaApiKey();

            // Process records
            const results = [];
            const records = event.Records || [event];

            for (const record of records) {
                try {
                    const result = await this.processRecord(record, correlationId);
                    results.push(result);
                    this.metrics.processed++;
                    this.metrics.successful++;
                } catch (error) {
                    logger.error('Record processing failed', { 
                        error: error.message,
                        recordId: record.messageId || 'direct'
                    });
                    results.push({
                        success: false,
                        error: error.message,
                        recordId: record.messageId || 'direct'
                    });
                    this.metrics.processed++;
                    this.metrics.failed++;
                }
            }

            // Publish metrics
            await this.publishMetrics();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'UITax processing completed',
                    results,
                    metrics: this.metrics,
                    correlationId
                })
            };

        } catch (error) {
            logger.error('UITax bot processing failed', { error: error.message });
            
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'UITax processing failed',
                    message: error.message,
                    correlationId
                })
            };
        } finally {
            // Cleanup browser pool
            await browserPool.cleanup();
        }
    }

    /**
     * Process individual record
     */
    async processRecord(record, correlationId) {
        const processingId = uuidv4();
        const startTime = Date.now();

        // Extract search data
        const searchData = this.extractSearchData(record);
        
        logger.info('Processing UITax search', {
            processingId,
            searchCount: searchData.names.length
        });

        // Record processing start
        await this.recordProcessingStart(processingId, correlationId, searchData);

        try {
            // Search UITax for each name
            const results = [];
            
            for (const nameData of searchData.names) {
                const searchResult = await this.searchUITax(nameData, processingId);
                results.push(searchResult);
            }

            // Store results
            const s3Key = await this.storeResults(processingId, results, searchData);

            // Record completion
            await this.recordProcessingComplete(processingId, {
                resultCount: results.length,
                s3Key,
                duration: Date.now() - startTime
            });

            // Publish completion event
            await this.publishCompletionEvent(processingId, s3Key, results);

            return {
                success: true,
                processingId,
                resultCount: results.length,
                s3Key,
                duration: Date.now() - startTime
            };

        } catch (error) {
            await this.recordProcessingError(processingId, error);
            throw error;
        }
    }

    /**
     * Search UITax for a specific name
     */
    async searchUITax(nameData, processingId) {
        return await uitaxBreaker.execute(async () => {
            const browser = await browserPool.getBrowser();
            let page = null;
            
            try {
                page = await browser.newPage();
                
                // Configure page
                await page.setViewport({ width: 1280, height: 720 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                
                // Navigate to UITax search
                await page.goto(`${CONFIG.uitaxBaseUrl}/search`, { 
                    waitUntil: 'networkidle0',
                    timeout: 30000 
                });

                // Fill search form
                await this.fillSearchForm(page, nameData);

                // Handle CAPTCHA if present
                const captchaSolved = await this.solveCaptchaIfPresent(page, processingId);
                
                if (captchaSolved) {
                    this.metrics.captchaSolved++;
                } else if (await page.$('.captcha')) {
                    this.metrics.captchaFailed++;
                    throw new Error('CAPTCHA solving failed');
                }

                // Submit search
                await page.click('#search-button');
                await page.waitForNavigation({ timeout: 30000 });

                // Process results
                const searchResults = await this.processSearchResults(page, nameData);

                // Take screenshot
                const screenshotUrl = await this.takeScreenshot(page, processingId, nameData);

                return {
                    name: nameData,
                    hit: searchResults.hit,
                    details: searchResults.details,
                    screenshotUrl,
                    timestamp: new Date().toISOString()
                };

            } catch (error) {
                if (error.name === 'TimeoutError') {
                    this.metrics.timeouts++;
                }
                
                logger.error('UITax search failed', {
                    name: nameData,
                    error: error.message
                });

                // Take error screenshot
                let errorScreenshotUrl = null;
                if (page) {
                    try {
                        errorScreenshotUrl = await this.takeScreenshot(page, processingId, nameData, 'error');
                    } catch (screenshotError) {
                        logger.warn('Error screenshot failed', { error: screenshotError.message });
                    }
                }

                return {
                    name: nameData,
                    hit: false,
                    error: {
                        message: error.message,
                        type: error.name,
                        screenshotUrl: errorScreenshotUrl
                    },
                    timestamp: new Date().toISOString()
                };
            } finally {
                if (page) {
                    try {
                        await page.close();
                    } catch (closeError) {
                        logger.warn('Failed to close page', { error: closeError.message });
                    }
                }
                
                await browserPool.releaseBrowser(browser);
            }
        });
    }

    /**
     * Fill UITax search form
     */
    async fillSearchForm(page, nameData) {
        // Wait for form to load
        await page.waitForSelector('#first-name', { timeout: 10000 });

        // Fill name fields
        await page.type('#first-name', nameData.firstName);
        
        if (nameData.lastName) {
            await page.type('#last-name', nameData.lastName);
        }

        // Add small delay for form stability
        await page.waitForTimeout(1000);
    }

    /**
     * Solve CAPTCHA if present using 2Captcha service
     */
    async solveCaptchaIfPresent(page, processingId) {
        const captchaElement = await page.$('.captcha img, .g-recaptcha, .h-captcha');
        
        if (!captchaElement) {
            return false;
        }

        logger.info('CAPTCHA detected, attempting to solve', { processingId });

        return await captchaBreaker.execute(async () => {
            // Handle image CAPTCHA
            if (await page.$('.captcha img')) {
                return await this.solveImageCaptcha(page, processingId);
            }
            
            // Handle reCAPTCHA
            if (await page.$('.g-recaptcha')) {
                return await this.solveRecaptcha(page, processingId);
            }

            // Handle hCaptcha
            if (await page.$('.h-captcha')) {
                return await this.solveHCaptcha(page, processingId);
            }

            return false;
        });
    }

    /**
     * Solve image CAPTCHA using 2Captcha
     */
    async solveImageCaptcha(page, processingId) {
        try {
            // Take screenshot of CAPTCHA
            const captchaElement = await page.$('.captcha img');
            const captchaImage = await captchaElement.screenshot({ encoding: 'base64' });

            // Submit to 2Captcha
            const captchaResult = await this.submit2Captcha({
                method: 'base64',
                body: captchaImage
            });

            // Enter solution
            await page.type('#captcha-input', captchaResult);
            
            logger.info('Image CAPTCHA solved', { processingId });
            return true;
            
        } catch (error) {
            logger.error('Image CAPTCHA solving failed', { 
                processingId, 
                error: error.message 
            });
            return false;
        }
    }

    /**
     * Solve reCAPTCHA using 2Captcha
     */
    async solveRecaptcha(page, processingId) {
        try {
            // Get site key
            const siteKey = await page.evaluate(() => {
                const element = document.querySelector('.g-recaptcha');
                return element ? element.getAttribute('data-sitekey') : null;
            });

            if (!siteKey) {
                throw new Error('reCAPTCHA site key not found');
            }

            // Submit to 2Captcha
            const captchaResult = await this.submit2Captcha({
                method: 'userrecaptcha',
                googlekey: siteKey,
                pageurl: page.url()
            });

            // Execute solution
            await page.evaluate((token) => {
                if (window.grecaptcha) {
                    window.grecaptcha.execute();
                }
                const callback = window.___grecaptcha_cfg?.clients?.[0]?.callback;
                if (callback) {
                    callback(token);
                }
            }, captchaResult);

            logger.info('reCAPTCHA solved', { processingId });
            return true;
            
        } catch (error) {
            logger.error('reCAPTCHA solving failed', { 
                processingId, 
                error: error.message 
            });
            return false;
        }
    }

    /**
     * Solve hCaptcha using 2Captcha
     */
    async solveHCaptcha(page, processingId) {
        try {
            // Get site key
            const siteKey = await page.evaluate(() => {
                const element = document.querySelector('.h-captcha');
                return element ? element.getAttribute('data-sitekey') : null;
            });

            if (!siteKey) {
                throw new Error('hCaptcha site key not found');
            }

            // Submit to 2Captcha
            const captchaResult = await this.submit2Captcha({
                method: 'hcaptcha',
                sitekey: siteKey,
                pageurl: page.url()
            });

            // Execute solution
            await page.evaluate((token) => {
                if (window.hcaptcha) {
                    window.hcaptcha.execute();
                }
                const callback = window.hcaptcha?.callback;
                if (callback) {
                    callback(token);
                }
            }, captchaResult);

            logger.info('hCaptcha solved', { processingId });
            return true;
            
        } catch (error) {
            logger.error('hCaptcha solving failed', { 
                processingId, 
                error: error.message 
            });
            return false;
        }
    }

    /**
     * Submit CAPTCHA to 2Captcha service
     */
    async submit2Captcha(params) {
        if (!this.captchaApiKey) {
            throw new Error('CAPTCHA API key not configured');
        }

        const submitUrl = 'http://2captcha.com/in.php';
        const resultUrl = 'http://2captcha.com/res.php';

        // Submit CAPTCHA
        const submitResponse = await fetch(submitUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                key: this.captchaApiKey,
                ...params
            })
        });

        const submitResult = await submitResponse.text();
        
        if (!submitResult.startsWith('OK|')) {
            throw new Error(`2Captcha submit failed: ${submitResult}`);
        }

        const captchaId = submitResult.split('|')[1];

        // Poll for result
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000));

            const resultResponse = await fetch(resultUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    key: this.captchaApiKey,
                    action: 'get',
                    id: captchaId
                })
            });

            const result = await resultResponse.text();

            if (result === 'CAPCHA_NOT_READY') {
                continue;
            }

            if (result.startsWith('OK|')) {
                return result.split('|')[1];
            }

            throw new Error(`2Captcha result failed: ${result}`);
        }

        throw new Error('2Captcha timeout');
    }

    /**
     * Process UITax search results
     */
    async processSearchResults(page, nameData) {
        try {
            // Wait for results to load
            await page.waitForSelector('.search-results, .no-results', { timeout: 10000 });

            // Check for no results
            const noResults = await page.$('.no-results');
            if (noResults) {
                return {
                    hit: false,
                    details: {
                        type: 'no_results',
                        message: 'No records found'
                    }
                };
            }

            // Extract result details
            const results = await page.evaluate(() => {
                const resultElements = document.querySelectorAll('.search-result');
                return Array.from(resultElements).map(element => ({
                    name: element.querySelector('.result-name')?.textContent?.trim(),
                    ssn: element.querySelector('.result-ssn')?.textContent?.trim(),
                    details: element.querySelector('.result-details')?.textContent?.trim()
                }));
            });

            if (results.length > 0) {
                return {
                    hit: true,
                    details: {
                        type: 'results_found',
                        count: results.length,
                        results: results.slice(0, 5) // Limit to first 5 results
                    }
                };
            }

            return {
                hit: false,
                details: {
                    type: 'no_matches',
                    message: 'Search completed but no matching records found'
                }
            };

        } catch (error) {
            logger.error('Failed to process search results', { 
                name: nameData,
                error: error.message 
            });

            return {
                hit: false,
                details: {
                    type: 'processing_error',
                    message: error.message
                }
            };
        }
    }

    /**
     * Take screenshot for evidence
     */
    async takeScreenshot(page, processingId, nameData, type = 'result') {
        try {
            const timestamp = Date.now();
            const fileName = `${processingId}-${nameData.firstName}-${nameData.lastName || 'unknown'}-${type}-${timestamp}.png`;
            const s3Key = `screenshots/uitax/${processingId}/${fileName}`;

            const screenshot = await page.screenshot({ 
                fullPage: true,
                type: 'png'
            });

            await s3.send(new PutObjectCommand({
                Bucket: CONFIG.documentsBucket,
                Key: s3Key,
                Body: screenshot,
                ContentType: 'image/png'
            }));

            const screenshotUrl = `https://${CONFIG.documentsBucket}.s3.amazonaws.com/${s3Key}`;
            logger.info('Screenshot saved', { s3Key, type });

            return screenshotUrl;

        } catch (error) {
            logger.error('Screenshot failed', { error: error.message });
            return null;
        }
    }

    /**
     * Extract search data from event record
     */
    extractSearchData(record) {
        // Handle SQS message
        if (record.body) {
            const body = typeof record.body === 'string' ? JSON.parse(record.body) : record.body;
            return {
                names: body.names || [body],
                user: body.user || 'unknown',
                fileNumber: body.fileNumber || 'unknown',
                uuid: body.uuid || uuidv4()
            };
        }

        // Handle direct invocation
        return {
            names: record.names || [record],
            user: record.user || 'unknown', 
            fileNumber: record.fileNumber || 'unknown',
            uuid: record.uuid || uuidv4()
        };
    }

    /**
     * Store search results in S3
     */
    async storeResults(processingId, results, searchData) {
        const s3Key = `bot-api-responses/${searchData.user}/${searchData.uuid}/UITax.json`;
        
        const resultData = {
            processingId,
            bot: 'UITax',
            timestamp: new Date().toISOString(),
            searchData,
            results,
            metadata: {
                version: '2.0.0',
                processingTime: Date.now(),
                sessionId: this.sessionId
            }
        };

        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.documentsBucket,
            Key: s3Key,
            Body: JSON.stringify(resultData, null, 2),
            ContentType: 'application/json'
        }));

        logger.info('Results stored', { s3Key, resultCount: results.length });
        return s3Key;
    }

    /**
     * Initialize CAPTCHA API key from SSM
     */
    async initializeCaptchaApiKey() {
        if (this.captchaApiKey) {
            return;
        }

        try {
            const response = await ssm.send(new GetParameterCommand({
                Name: CONFIG.captchaApiKeyParam,
                WithDecryption: true
            }));

            this.captchaApiKey = response.Parameter.Value;
            logger.info('CAPTCHA API key initialized');

        } catch (error) {
            logger.warn('Failed to load CAPTCHA API key', { error: error.message });
            // Continue without CAPTCHA solving capability
        }
    }

    /**
     * Record processing start in state table
     */
    async recordProcessingStart(processingId, correlationId, searchData) {
        await dynamodb.send(new PutItemCommand({
            TableName: CONFIG.stateTable,
            Item: {
                id: { S: processingId },
                timestamp: { N: Date.now().toString() },
                status: { S: 'PROCESSING' },
                service: { S: 'UITaxBot' },
                correlationId: { S: correlationId },
                searchCount: { N: searchData.names.length.toString() },
                user: { S: searchData.user },
                startTime: { S: new Date().toISOString() }
            }
        }));
    }

    /**
     * Record processing completion
     */
    async recordProcessingComplete(processingId, metadata) {
        await dynamodb.send(new UpdateItemCommand({
            TableName: CONFIG.stateTable,
            Key: {
                id: { S: processingId },
                timestamp: { N: Date.now().toString() }
            },
            UpdateExpression: 'SET #status = :status, endTime = :endTime, metadata = :metadata',
            ExpressionAttributeNames: {
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':status': { S: 'COMPLETED' },
                ':endTime': { S: new Date().toISOString() },
                ':metadata': { S: JSON.stringify(metadata) }
            }
        }));
    }

    /**
     * Record processing error
     */
    async recordProcessingError(processingId, error) {
        try {
            await dynamodb.send(new UpdateItemCommand({
                TableName: CONFIG.stateTable,
                Key: {
                    id: { S: processingId },
                    timestamp: { N: Date.now().toString() }
                },
                UpdateExpression: 'SET #status = :status, errorMessage = :error',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': { S: 'FAILED' },
                    ':error': { S: error.message }
                }
            }));
        } catch (dbError) {
            logger.error('Failed to record error', { error: dbError.message });
        }
    }

    /**
     * Publish completion event
     */
    async publishCompletionEvent(processingId, s3Key, results) {
        const hitCount = results.filter(r => r.hit).length;
        
        await eventbridge.send(new PutEventsCommand({
            Entries: [{
                Source: 'scdor-rebuild.uitax-bot',
                DetailType: 'UITax Search Completed',
                Detail: JSON.stringify({
                    processingId,
                    s3Key,
                    resultCount: results.length,
                    hitCount,
                    timestamp: new Date().toISOString()
                }),
                EventBusName: CONFIG.eventBus
            }]
        }));

        logger.info('Completion event published', { processingId, hitCount });
    }

    /**
     * Publish metrics to CloudWatch
     */
    async publishMetrics() {
        logger.metric('UITaxProcessed', this.metrics.processed);
        logger.metric('UITaxSuccessful', this.metrics.successful);
        logger.metric('UITaxFailed', this.metrics.failed);
        logger.metric('UITaxCaptchaSolved', this.metrics.captchaSolved);
        logger.metric('UITaxCaptchaFailed', this.metrics.captchaFailed);
        logger.metric('UITaxBrowserCrashes', this.metrics.browserCrashes);
        logger.metric('UITaxTimeouts', this.metrics.timeouts);
        
        // Calculate success rate
        const successRate = this.metrics.processed > 0 
            ? (this.metrics.successful / this.metrics.processed) * 100 
            : 0;
        logger.metric('UITaxSuccessRate', successRate);
    }
}

// Export handler for Lambda
const uitaxBot = new UITaxBot();
export const handler = uitaxBot.handler.bind(uitaxBot);