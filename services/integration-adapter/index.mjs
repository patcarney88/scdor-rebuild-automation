/**
 * Integration Adapter Service
 * Bridges the existing SCDOR BCPC document processing with our new infrastructure
 * Provides compatibility layer for seamless migration
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import CircuitBreaker from '../shared/lib/circuitBreaker.mjs';
import Logger from '../shared/lib/logger.mjs';

// Initialize AWS clients
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const eventbridge = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const logger = new Logger('IntegrationAdapter');

// Configuration
const CONFIG = {
    // New infrastructure
    newProcessingBucket: process.env.PROCESSING_BUCKET || 'scdor-rebuild-processing-dev',
    newDocumentsBucket: process.env.DOCUMENTS_BUCKET || 'scdor-rebuild-documents-dev',
    stateTable: process.env.STATE_TABLE || 'scdor-rebuild-state-dev',
    processingQueue: process.env.PROCESSING_QUEUE || 'scdor-rebuild-processing-dev',
    eventBus: process.env.EVENT_BUS || 'scdor-rebuild-events-dev',
    
    // Existing infrastructure
    existingBucket: process.env.EXISTING_BUCKET || 'scdor-bcpc-bucket-dev',
    existingEmailProcessor: 'scdor-bcpc-process-emails',
    existingTableExtractor: 'scdor-bcpc-extract-table-data',
    existingHitUpdater: 'scdor-bcpc-update-hits',
    
    // Integration settings
    enableNewInfrastructure: process.env.ENABLE_NEW_INFRASTRUCTURE === 'true',
    enableParallelProcessing: process.env.ENABLE_PARALLEL === 'true',
    migrationMode: process.env.MIGRATION_MODE || 'shadow' // shadow, cutover, rollback
};

// Circuit breakers for existing services
const emailProcessorBreaker = new CircuitBreaker('EmailProcessor', {
    threshold: 5,
    timeout: 60000,
    resetTimeout: 120000
});

const tableExtractorBreaker = new CircuitBreaker('TableExtractor', {
    threshold: 3,
    timeout: 120000,
    resetTimeout: 180000
});

const hitUpdaterBreaker = new CircuitBreaker('HitUpdater', {
    threshold: 3,
    timeout: 60000,
    resetTimeout: 120000
});

class IntegrationAdapter {
    constructor() {
        this.sessionId = uuidv4();
        this.metrics = {
            processed: 0,
            failed: 0,
            migrated: 0,
            existingServiceCalls: 0,
            newServiceCalls: 0
        };
    }

    /**
     * Main handler - routes between existing and new infrastructure
     */
    async handler(event, context) {
        const correlationId = context.requestId || uuidv4();
        logger.setCorrelationId(correlationId);
        
        logger.info('Processing integration event', {
            mode: CONFIG.migrationMode,
            eventType: event.Records ? 'SQS' : 'Direct'
        });

        try {
            // Determine processing path based on migration mode
            switch (CONFIG.migrationMode) {
                case 'shadow':
                    // Run both old and new in parallel, compare results
                    await this.shadowModeProcessing(event, correlationId);
                    break;
                    
                case 'cutover':
                    // Use new infrastructure with fallback to old
                    await this.cutoverModeProcessing(event, correlationId);
                    break;
                    
                case 'rollback':
                    // Use existing infrastructure only
                    await this.rollbackModeProcessing(event, correlationId);
                    break;
                    
                default:
                    await this.defaultProcessing(event, correlationId);
            }

            await this.publishMetrics();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Integration processing completed',
                    mode: CONFIG.migrationMode,
                    metrics: this.metrics,
                    correlationId
                })
            };

        } catch (error) {
            logger.error('Integration processing failed', { error: error.message });
            
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Integration processing failed',
                    message: error.message,
                    correlationId
                })
            };
        }
    }

    /**
     * Shadow mode - run both systems in parallel
     */
    async shadowModeProcessing(event, correlationId) {
        logger.info('Shadow mode processing - running both systems');
        
        const processingId = uuidv4();
        const startTime = Date.now();

        // Start tracking in our state table
        await this.recordProcessingStart(processingId, 'SHADOW_MODE', correlationId);

        try {
            // Run both systems in parallel
            const [existingResult, newResult] = await Promise.allSettled([
                this.callExistingServices(event, processingId),
                this.processWithNewInfrastructure(event, processingId, correlationId)
            ]);

            // Compare results
            const comparison = await this.compareResults(
                existingResult.value,
                newResult.value,
                processingId
            );

            // Log comparison metrics
            logger.info('Shadow mode comparison', {
                processingId,
                matchRate: comparison.matchRate,
                discrepancies: comparison.discrepancies,
                processingTime: Date.now() - startTime
            });

            // Store comparison results
            await this.storeComparisonResults(processingId, comparison);

            // Update state
            await this.recordProcessingComplete(processingId, 'SHADOW_COMPLETE', {
                matchRate: comparison.matchRate,
                duration: Date.now() - startTime
            });

            this.metrics.processed++;

        } catch (error) {
            this.metrics.failed++;
            await this.recordProcessingError(processingId, error);
            throw error;
        }
    }

    /**
     * Cutover mode - use new infrastructure with fallback
     */
    async cutoverModeProcessing(event, correlationId) {
        logger.info('Cutover mode - new infrastructure with fallback');
        
        const processingId = uuidv4();
        
        try {
            // Try new infrastructure first
            const result = await this.processWithNewInfrastructure(
                event, 
                processingId, 
                correlationId
            );
            
            this.metrics.newServiceCalls++;
            this.metrics.processed++;
            
            return result;
            
        } catch (error) {
            logger.warn('New infrastructure failed, falling back to existing', {
                error: error.message
            });
            
            // Fallback to existing services
            try {
                const result = await this.callExistingServices(event, processingId);
                this.metrics.existingServiceCalls++;
                this.metrics.processed++;
                
                return result;
                
            } catch (fallbackError) {
                logger.error('Both systems failed', {
                    newError: error.message,
                    existingError: fallbackError.message
                });
                
                this.metrics.failed++;
                throw fallbackError;
            }
        }
    }

    /**
     * Rollback mode - use existing infrastructure only
     */
    async rollbackModeProcessing(event, correlationId) {
        logger.info('Rollback mode - existing infrastructure only');
        
        const processingId = uuidv4();
        
        try {
            const result = await this.callExistingServices(event, processingId);
            
            // Still track in our state table for monitoring
            await this.recordProcessingComplete(processingId, 'ROLLBACK_MODE', {
                service: 'existing'
            });
            
            this.metrics.existingServiceCalls++;
            this.metrics.processed++;
            
            return result;
            
        } catch (error) {
            this.metrics.failed++;
            throw error;
        }
    }

    /**
     * Call existing SCDOR BCPC services
     */
    async callExistingServices(event, processingId) {
        logger.info('Calling existing services', { processingId });
        
        const results = {
            emailProcessor: null,
            tableExtractor: null,
            hitUpdater: null
        };

        // Transform event to existing format if needed
        const existingEvent = this.transformToExistingFormat(event);

        // Call email processor
        if (this.shouldCallEmailProcessor(existingEvent)) {
            results.emailProcessor = await emailProcessorBreaker.execute(async () => {
                return await this.invokeLambda(CONFIG.existingEmailProcessor, existingEvent);
            });
        }

        // Call table extractor
        if (this.shouldCallTableExtractor(existingEvent)) {
            results.tableExtractor = await tableExtractorBreaker.execute(async () => {
                return await this.invokeLambda(CONFIG.existingTableExtractor, existingEvent);
            });
        }

        // Call hit updater if we have bot responses
        if (this.shouldCallHitUpdater(existingEvent)) {
            results.hitUpdater = await hitUpdaterBreaker.execute(async () => {
                return await this.invokeLambda(CONFIG.existingHitUpdater, existingEvent);
            });
        }

        return results;
    }

    /**
     * Process with new infrastructure
     */
    async processWithNewInfrastructure(event, processingId, correlationId) {
        logger.info('Processing with new infrastructure', { processingId });
        
        // Route to appropriate new service based on event type
        if (this.isEmailEvent(event)) {
            return await this.processEmailWithNewService(event, processingId, correlationId);
        } else if (this.isDocumentEvent(event)) {
            return await this.processDocumentWithNewService(event, processingId, correlationId);
        } else {
            throw new Error('Unknown event type');
        }
    }

    /**
     * Transform event to existing service format
     */
    transformToExistingFormat(event) {
        // Handle SQS wrapper
        if (event.Records && event.Records[0].eventSource === 'aws:sqs') {
            const body = JSON.parse(event.Records[0].body);
            
            // Transform to EventBridge S3 event format expected by existing services
            return {
                detail: {
                    bucket: {
                        name: body.bucket || CONFIG.existingBucket
                    },
                    object: {
                        key: body.key || body.s3Key
                    }
                }
            };
        }
        
        return event;
    }

    /**
     * Invoke Lambda function
     */
    async invokeLambda(functionName, payload) {
        const response = await lambda.send(new InvokeCommand({
            FunctionName: functionName,
            Payload: JSON.stringify(payload)
        }));
        
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        
        if (response.StatusCode !== 200 || result.errorMessage) {
            throw new Error(result.errorMessage || 'Lambda invocation failed');
        }
        
        return result;
    }

    /**
     * Compare results from both systems
     */
    async compareResults(existingResult, newResult, processingId) {
        const comparison = {
            processingId,
            timestamp: new Date().toISOString(),
            matchRate: 0,
            discrepancies: [],
            existingMetrics: {},
            newMetrics: {}
        };

        // Extract key metrics from both results
        if (existingResult) {
            comparison.existingMetrics = {
                recordsExtracted: existingResult.tableExtractor?.body?.records_extracted || 0,
                processingTime: existingResult.processingTime || 0,
                success: !existingResult.error
            };
        }

        if (newResult) {
            comparison.newMetrics = {
                recordsExtracted: newResult.recordsExtracted || 0,
                processingTime: newResult.processingTime || 0,
                success: !newResult.error
            };
        }

        // Calculate match rate
        if (comparison.existingMetrics.recordsExtracted === comparison.newMetrics.recordsExtracted) {
            comparison.matchRate = 100;
        } else if (comparison.existingMetrics.recordsExtracted > 0) {
            comparison.matchRate = (comparison.newMetrics.recordsExtracted / 
                                   comparison.existingMetrics.recordsExtracted) * 100;
        }

        // Identify discrepancies
        if (comparison.matchRate < 100) {
            comparison.discrepancies.push({
                type: 'record_count',
                existing: comparison.existingMetrics.recordsExtracted,
                new: comparison.newMetrics.recordsExtracted
            });
        }

        return comparison;
    }

    /**
     * Store comparison results for analysis
     */
    async storeComparisonResults(processingId, comparison) {
        const s3Key = `comparisons/${processingId}/results.json`;
        
        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.newDocumentsBucket,
            Key: s3Key,
            Body: JSON.stringify(comparison, null, 2),
            ContentType: 'application/json'
        }));
        
        logger.info('Comparison results stored', { s3Key });
    }

    /**
     * Helper methods to determine which services to call
     */
    shouldCallEmailProcessor(event) {
        return event.detail?.object?.key?.includes('incoming-emails');
    }

    shouldCallTableExtractor(event) {
        return event.detail?.object?.key?.includes('attachments');
    }

    shouldCallHitUpdater(event) {
        return event.detail?.object?.key?.includes('bot-check.json');
    }

    isEmailEvent(event) {
        const key = event.detail?.object?.key || event.Records?.[0]?.s3?.object?.key || '';
        return key.includes('email') || key.includes('.eml');
    }

    isDocumentEvent(event) {
        const key = event.detail?.object?.key || event.Records?.[0]?.s3?.object?.key || '';
        return key.includes('.pdf') || key.includes('attachment');
    }

    /**
     * Process email with new service
     */
    async processEmailWithNewService(event, processingId, correlationId) {
        // Call our new email processor
        return await this.invokeLambda('scdor-rebuild-email-processor-dev', {
            processingId,
            correlationId,
            ...event
        });
    }

    /**
     * Process document with new service
     */
    async processDocumentWithNewService(event, processingId, correlationId) {
        // Call our new document extractor
        return await this.invokeLambda('scdor-rebuild-document-extractor-dev', {
            processingId,
            correlationId,
            ...event
        });
    }

    /**
     * Record processing start in state table
     */
    async recordProcessingStart(processingId, mode, correlationId) {
        await dynamodb.send(new PutItemCommand({
            TableName: CONFIG.stateTable,
            Item: {
                id: { S: processingId },
                timestamp: { N: Date.now().toString() },
                status: { S: 'PROCESSING' },
                service: { S: 'IntegrationAdapter' },
                mode: { S: mode },
                correlationId: { S: correlationId },
                startTime: { S: new Date().toISOString() }
            }
        }));
    }

    /**
     * Record processing completion
     */
    async recordProcessingComplete(processingId, status, metadata = {}) {
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
                ':status': { S: status },
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
     * Default processing when mode is not specified
     */
    async defaultProcessing(event, correlationId) {
        // Default to shadow mode for safety
        return await this.shadowModeProcessing(event, correlationId);
    }

    /**
     * Publish metrics to CloudWatch
     */
    async publishMetrics() {
        logger.metric('IntegrationProcessed', this.metrics.processed);
        logger.metric('IntegrationFailed', this.metrics.failed);
        logger.metric('ExistingServiceCalls', this.metrics.existingServiceCalls);
        logger.metric('NewServiceCalls', this.metrics.newServiceCalls);
        logger.metric('MigrationMode', CONFIG.migrationMode === 'shadow' ? 1 : 0);
    }
}

// Export handler for Lambda
const adapter = new IntegrationAdapter();
export const handler = adapter.handler.bind(adapter);