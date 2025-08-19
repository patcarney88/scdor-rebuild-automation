/**
 * Enhanced MyDorway Bot Service
 * Advanced browser automation with exponential backoff, circuit breakers, and health monitoring
 */

import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import BrowserPool from '../shared/lib/browserPool.mjs';
import CircuitBreaker from '../shared/lib/circuitBreaker.mjs';
import Logger from '../shared/lib/logger.mjs';

// Initialize AWS clients
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const eventbridge = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const logger = new Logger('MyDorwayBot');

// Configuration
const CONFIG = {
    stateTable: process.env.STATE_TABLE || 'scdor-rebuild-state-dev',
    documentsBucket: process.env.DOCUMENTS_BUCKET || 'scdor-rebuild-documents-dev',
    processingQueue: process.env.PROCESSING_QUEUE || 'scdor-rebuild-processing-dev',
    eventBus: process.env.EVENT_BUS || 'scdor-rebuild-events-dev',
    mydorwayBaseUrl: 'https://mydorway.scdor.gov',
    maxRetries: 5,
    baseRetryDelay: 1000, // 1 second
    maxRetryDelay: 32000, // 32 seconds
    timeoutMs: 180000, // 3 minutes
    browserTimeout: 120000, // 2 minutes
    healthCheckInterval: 30000 // 30 seconds
};

// Initialize browser pool and circuit breakers
const browserPool = new BrowserPool({
    maxBrowsers: 2,
    maxPagesPerBrowser: 3,
    browserTimeout: CONFIG.browserTimeout,
    pageTimeout: 30000,
    healthCheckInterval: CONFIG.healthCheckInterval
});

const mydorwayBreaker = new CircuitBreaker('MyDorwaySite', {
    threshold: 3,
    timeout: CONFIG.timeoutMs,
    resetTimeout: 300000 // 5 minutes
});

const searchBreaker = new CircuitBreaker('MyDorwaySearch', {
    threshold: 5,
    timeout: 60000, // 1 minute
    resetTimeout: 180000 // 3 minutes
});

class MyDorwayBot {
    constructor() {
        this.sessionId = uuidv4();
        this.metrics = {
            processed: 0,
            successful: 0,
            failed: 0,
            retries: 0,
            timeouts: 0,
            browserCrashes: 0,
            sessionErrors: 0
        };
    }

    /**
     * Main Lambda handler
     */
    async handler(event, context) {
        const correlationId = context.requestId || uuidv4();
        logger.setCorrelationId(correlationId);
        
        logger.info('MyDorway bot processing started', {
            sessionId: this.sessionId,
            eventType: event.Records ? 'SQS' : 'Direct'
        });

        try {
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
                    message: 'MyDorway processing completed',
                    results,
                    metrics: this.metrics,
                    correlationId
                })
            };

        } catch (error) {
            logger.error('MyDorway bot processing failed', { error: error.message });
            
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'MyDorway processing failed',
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
     * Process individual record with retry logic
     */
    async processRecord(record, correlationId) {
        const processingId = uuidv4();
        const startTime = Date.now();

        // Extract search data
        const searchData = this.extractSearchData(record);
        
        logger.info('Processing MyDorway search', {
            processingId,
            searchCount: searchData.names.length
        });

        // Record processing start
        await this.recordProcessingStart(processingId, correlationId, searchData);

        try {
            // Search MyDorway for each name with retry logic
            const results = [];
            
            for (const nameData of searchData.names) {
                const searchResult = await this.searchWithRetry(nameData, processingId);
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
     * Search with exponential backoff retry logic
     */
    async searchWithRetry(nameData, processingId, attempt = 1) {
        try {
            return await this.searchMyDorway(nameData, processingId);
        } catch (error) {
            if (attempt >= CONFIG.maxRetries) {
                logger.error('Max retries exceeded', {
                    name: nameData,
                    attempt,
                    error: error.message
                });
                throw error;
            }

            // Calculate exponential backoff delay
            const delay = Math.min(
                CONFIG.baseRetryDelay * Math.pow(2, attempt - 1),
                CONFIG.maxRetryDelay
            );

            logger.warn('Search failed, retrying', {
                name: nameData,
                attempt,
                nextAttempt: attempt + 1,
                delay,
                error: error.message
            });

            this.metrics.retries++;

            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, delay));

            return await this.searchWithRetry(nameData, processingId, attempt + 1);
        }
    }

    /**
     * Search MyDorway for a specific name
     */
    async searchMyDorway(nameData, processingId) {
        return await mydorwayBreaker.execute(async () => {
            const browser = await browserPool.getBrowser();
            let page = null;
            
            try {
                page = await browser.newPage();
                
                // Configure page for better reliability
                await page.setViewport({ width: 1280, height: 720 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                
                // Set longer timeouts for MyDorway
                page.setDefaultTimeout(45000);
                page.setDefaultNavigationTimeout(45000);

                // Navigate to MyDorway search
                await page.goto(`${CONFIG.mydorwayBaseUrl}/DORway/Delinquent.aspx`, { 
                    waitUntil: 'networkidle0',
                    timeout: 45000 
                });

                // Validate page loaded correctly
                await this.validatePageLoad(page);

                // Fill search form
                await this.fillSearchForm(page, nameData);

                // Submit search and wait for results
                const searchResults = await this.submitSearchAndWaitForResults(page, nameData);

                // Take screenshot for evidence
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

                // Check if this is a session error
                if (error.message.includes('session') || error.message.includes('disconnected')) {
                    this.metrics.sessionErrors++;
                    this.metrics.browserCrashes++;
                }
                
                logger.error('MyDorway search failed', {
                    name: nameData,
                    error: error.message,
                    type: error.name
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
     * Validate that MyDorway page loaded correctly
     */
    async validatePageLoad(page) {
        // Check for key elements that indicate proper page load
        const requiredSelectors = [
            'input[name="txtLastName"]',
            'input[name="txtFirstName"]',
            'input[type="submit"]'
        ];

        for (const selector of requiredSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
            } catch (error) {
                throw new Error(`Page validation failed: ${selector} not found`);
            }
        }

        // Check for error messages
        const errorElement = await page.$('.error, .alert-danger, [id*="error"]');
        if (errorElement) {
            const errorText = await errorElement.textContent();
            throw new Error(`Page error detected: ${errorText}`);
        }

        logger.debug('MyDorway page validation passed');
    }

    /**
     * Fill MyDorway search form with enhanced error handling
     */
    async fillSearchForm(page, nameData) {
        // Wait for form to be ready
        await page.waitForSelector('input[name="txtLastName"]', { timeout: 15000 });

        // Clear any existing values
        await page.fill('input[name="txtLastName"]', '');
        await page.fill('input[name="txtFirstName"]', '');

        // Fill last name (required)
        await page.type('input[name="txtLastName"]', nameData.lastName || 'Unknown');
        
        // Fill first name if provided
        if (nameData.firstName) {
            await page.type('input[name="txtFirstName"]', nameData.firstName);
        }

        // Add small delay for form stability
        await page.waitForTimeout(1000);

        // Verify form values were set correctly
        const lastNameValue = await page.inputValue('input[name="txtLastName"]');
        const firstNameValue = await page.inputValue('input[name="txtFirstName"]');

        if (!lastNameValue) {
            throw new Error('Failed to set last name in search form');
        }

        logger.debug('Search form filled', {
            lastName: lastNameValue,
            firstName: firstNameValue
        });
    }

    /**
     * Submit search and wait for results with circuit breaker
     */
    async submitSearchAndWaitForResults(page, nameData) {
        return await searchBreaker.execute(async () => {
            // Submit the search form
            await page.click('input[type="submit"]');

            // Wait for either results or no results message
            try {
                await page.waitForSelector('.search-results, .no-results, .grid, table', { 
                    timeout: 30000 
                });
            } catch (error) {
                // If timeout, check if page is still loading
                const loadingElement = await page.$('.loading, [id*="loading"]');
                if (loadingElement) {
                    throw new Error('Search timed out - page still loading');
                }
                throw error;
            }

            // Process the results
            return await this.processSearchResults(page, nameData);
        });
    }

    /**
     * Process MyDorway search results with enhanced parsing
     */
    async processSearchResults(page, nameData) {
        try {
            // Check for various result indicators
            const hasResults = await page.evaluate(() => {
                // Look for data tables
                const tables = document.querySelectorAll('table');
                for (const table of tables) {
                    const rows = table.querySelectorAll('tr');
                    if (rows.length > 1) { // More than just header
                        return true;
                    }
                }

                // Look for grid results
                const gridResults = document.querySelectorAll('.grid .row, .results .item');
                if (gridResults.length > 0) {
                    return true;
                }

                // Look for specific result classes
                const resultElements = document.querySelectorAll('.result, .search-result, .record');
                return resultElements.length > 0;
            });

            if (!hasResults) {
                // Check for explicit "no results" messages
                const noResultsText = await page.evaluate(() => {
                    const possibleSelectors = [
                        '.no-results',
                        '.empty',
                        '[id*="noResults"]',
                        '.message'
                    ];
                    
                    for (const selector of possibleSelectors) {
                        const element = document.querySelector(selector);
                        if (element && element.textContent.toLowerCase().includes('no')) {
                            return element.textContent.trim();
                        }
                    }
                    
                    // Check page text for common "no results" phrases
                    const bodyText = document.body.textContent.toLowerCase();
                    if (bodyText.includes('no records found') || 
                        bodyText.includes('no results') ||
                        bodyText.includes('no matches')) {
                        return 'No records found';
                    }
                    
                    return null;
                });

                return {
                    hit: false,
                    details: {
                        type: 'no_results',
                        message: noResultsText || 'No records found'
                    }
                };
            }

            // Extract detailed results
            const results = await page.evaluate(() => {
                const resultData = [];
                
                // Try to extract from tables
                const tables = document.querySelectorAll('table');
                for (const table of tables) {
                    const rows = Array.from(table.querySelectorAll('tr'));
                    if (rows.length > 1) {
                        // Get headers
                        const headers = Array.from(rows[0].querySelectorAll('th, td')).map(cell => 
                            cell.textContent.trim()
                        );
                        
                        // Get data rows
                        for (let i = 1; i < Math.min(rows.length, 6); i++) { // Limit to 5 results
                            const cells = Array.from(rows[i].querySelectorAll('td')).map(cell => 
                                cell.textContent.trim()
                            );
                            
                            if (cells.length > 0) {
                                const rowData = {};
                                headers.forEach((header, index) => {
                                    if (cells[index]) {
                                        rowData[header] = cells[index];
                                    }
                                });
                                resultData.push(rowData);
                            }
                        }
                    }
                }

                return resultData;
            });

            if (results.length > 0) {
                return {
                    hit: true,
                    details: {
                        type: 'results_found',
                        count: results.length,
                        results: results
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
            const fileName = `${processingId}-${nameData.firstName || 'unknown'}-${nameData.lastName || 'unknown'}-${type}-${timestamp}.png`;
            const s3Key = `screenshots/mydorway/${processingId}/${fileName}`;

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
        const s3Key = `bot-api-responses/${searchData.user}/${searchData.uuid}/MyDorway.json`;
        
        const resultData = {
            processingId,
            bot: 'MyDorway',
            timestamp: new Date().toISOString(),
            searchData,
            results,
            metadata: {
                version: '2.0.0',
                processingTime: Date.now(),
                sessionId: this.sessionId,
                retryCount: this.metrics.retries
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
     * Record processing start in state table
     */
    async recordProcessingStart(processingId, correlationId, searchData) {
        await dynamodb.send(new PutItemCommand({
            TableName: CONFIG.stateTable,
            Item: {
                id: { S: processingId },
                timestamp: { N: Date.now().toString() },
                status: { S: 'PROCESSING' },
                service: { S: 'MyDorwayBot' },
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
                Source: 'scdor-rebuild.mydorway-bot',
                DetailType: 'MyDorway Search Completed',
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
        logger.metric('MyDorwayProcessed', this.metrics.processed);
        logger.metric('MyDorwaySuccessful', this.metrics.successful);
        logger.metric('MyDorwayFailed', this.metrics.failed);
        logger.metric('MyDorwayRetries', this.metrics.retries);
        logger.metric('MyDorwayTimeouts', this.metrics.timeouts);
        logger.metric('MyDorwayBrowserCrashes', this.metrics.browserCrashes);
        logger.metric('MyDorwaySessionErrors', this.metrics.sessionErrors);
        
        // Calculate success rate
        const successRate = this.metrics.processed > 0 
            ? (this.metrics.successful / this.metrics.processed) * 100 
            : 0;
        logger.metric('MyDorwaySuccessRate', successRate);

        // Calculate retry rate
        const retryRate = this.metrics.processed > 0 
            ? (this.metrics.retries / this.metrics.processed) * 100 
            : 0;
        logger.metric('MyDorwayRetryRate', retryRate);
    }
}

// Export handler for Lambda
const mydorwayBot = new MyDorwayBot();
export const handler = mydorwayBot.handler.bind(mydorwayBot);