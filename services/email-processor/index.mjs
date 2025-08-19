/**
 * Email Processor Service
 * Handles email processing for SCDOR automation with circuit breakers
 * Includes attachment extraction, validation, and error recovery
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import CircuitBreaker from './lib/circuitBreaker.mjs';
import Logger from './lib/logger.mjs';

// Initialize AWS clients
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const eventbridge = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });

const logger = new Logger('EmailProcessor');

// Configuration
const CONFIG = {
    processingBucket: process.env.PROCESSING_BUCKET || 'scdor-rebuild-processing-dev',
    documentsBucket: process.env.DOCUMENTS_BUCKET || 'scdor-rebuild-documents-dev',
    stateTable: process.env.STATE_TABLE || 'scdor-rebuild-state-dev',
    processingQueue: process.env.PROCESSING_QUEUE || 'scdor-rebuild-processing-dev',
    eventBus: process.env.EVENT_BUS || 'scdor-rebuild-events-dev',
    maxAttachmentSize: 25 * 1024 * 1024, // 25MB
    allowedFileTypes: ['.pdf', '.xlsx', '.xls', '.doc', '.docx', '.png', '.jpg', '.jpeg'],
    retryAttempts: 3,
    retryDelay: 1000,
    circuitBreakerThreshold: 5,
    circuitBreakerTimeout: 60000
};

// Initialize circuit breakers
const emailParsingBreaker = new CircuitBreaker('EmailParsing', {
    threshold: CONFIG.circuitBreakerThreshold,
    timeout: CONFIG.circuitBreakerTimeout,
    resetTimeout: 120000
});

const s3UploadBreaker = new CircuitBreaker('S3Upload', {
    threshold: 3,
    timeout: 30000,
    resetTimeout: 60000
});

const databaseBreaker = new CircuitBreaker('Database', {
    threshold: 5,
    timeout: 10000,
    resetTimeout: 60000
});

class EmailProcessor {
    constructor() {
        this.sessionId = uuidv4();
        this.metrics = {
            processed: 0,
            failed: 0,
            attachmentsExtracted: 0,
            validationErrors: 0
        };
    }

    /**
     * Main handler for Lambda function
     */
    async handler(event, context) {
        const correlationId = context.requestId || uuidv4();
        logger.setCorrelationId(correlationId);
        
        logger.info('Processing email event', {
            eventType: event.Records ? 'SQS' : 'Direct',
            recordCount: event.Records?.length || 1
        });

        try {
            if (event.Records) {
                // Process SQS messages
                for (const record of event.Records) {
                    await this.processEmailMessage(record, correlationId);
                }
            } else {
                // Direct invocation
                await this.processEmail(event, correlationId);
            }

            await this.publishMetrics();
            
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Email processing completed',
                    metrics: this.metrics,
                    correlationId
                })
            };

        } catch (error) {
            logger.error('Email processing failed', { error: error.message });
            await this.handleProcessingError(error, correlationId);
            
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Email processing failed',
                    message: error.message,
                    correlationId
                })
            };
        }
    }

    /**
     * Process SQS message containing email
     */
    async processEmailMessage(record, correlationId) {
        try {
            const message = JSON.parse(record.body);
            await this.processEmail(message, correlationId);
            
            // Delete message from queue on success
            await sqs.send(new DeleteMessageCommand({
                QueueUrl: CONFIG.processingQueue,
                ReceiptHandle: record.receiptHandle
            }));
            
        } catch (error) {
            logger.error('Failed to process SQS message', {
                messageId: record.messageId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Process individual email
     */
    async processEmail(emailData, correlationId) {
        const processingId = uuidv4();
        const startTime = Date.now();

        logger.info('Processing email', {
            processingId,
            subject: emailData.subject,
            from: emailData.from
        });

        try {
            // Record processing start
            await this.recordProcessingStart(processingId, emailData, correlationId);

            // Parse email with circuit breaker
            const parsedEmail = await emailParsingBreaker.execute(async () => {
                return await this.parseEmail(emailData);
            });

            // Validate email
            const validation = await this.validateEmail(parsedEmail);
            if (!validation.valid) {
                throw new Error(`Email validation failed: ${validation.errors.join(', ')}`);
            }

            // Extract and process attachments
            const attachments = await this.processAttachments(parsedEmail, processingId);

            // Extract metadata
            const metadata = this.extractMetadata(parsedEmail, attachments);

            // Store processed email
            await this.storeProcessedEmail(processingId, parsedEmail, attachments, metadata);

            // Trigger downstream processing
            await this.triggerDownstreamProcessing(processingId, metadata);

            // Record success
            await this.recordProcessingComplete(processingId, Date.now() - startTime);
            
            this.metrics.processed++;
            
            logger.info('Email processed successfully', {
                processingId,
                attachmentCount: attachments.length,
                processingTime: Date.now() - startTime
            });

            return {
                processingId,
                attachments: attachments.length,
                metadata
            };

        } catch (error) {
            this.metrics.failed++;
            await this.recordProcessingError(processingId, error);
            throw error;
        }
    }

    /**
     * Parse email content
     */
    async parseEmail(emailData) {
        try {
            // If raw email content provided
            if (emailData.raw) {
                return await simpleParser(emailData.raw);
            }

            // Construct parsed email from structured data
            return {
                subject: emailData.subject,
                from: emailData.from,
                to: emailData.to,
                date: emailData.date || new Date(),
                text: emailData.text || '',
                html: emailData.html || '',
                attachments: emailData.attachments || []
            };

        } catch (error) {
            logger.error('Email parsing failed', { error: error.message });
            throw new Error(`Failed to parse email: ${error.message}`);
        }
    }

    /**
     * Validate email content and structure
     */
    async validateEmail(parsedEmail) {
        const errors = [];
        
        // Check required fields
        if (!parsedEmail.subject) {
            errors.push('Missing email subject');
        }
        
        if (!parsedEmail.from) {
            errors.push('Missing sender information');
        }

        // Validate sender domain if required
        if (process.env.ALLOWED_DOMAINS) {
            const allowedDomains = process.env.ALLOWED_DOMAINS.split(',');
            const senderDomain = parsedEmail.from?.value?.[0]?.address?.split('@')[1];
            
            if (!allowedDomains.includes(senderDomain)) {
                errors.push(`Sender domain not allowed: ${senderDomain}`);
            }
        }

        // Check for suspicious content
        const suspiciousPatterns = [
            /javascript:/gi,
            /<script/gi,
            /onclick=/gi,
            /onerror=/gi
        ];

        const content = parsedEmail.text + parsedEmail.html;
        for (const pattern of suspiciousPatterns) {
            if (pattern.test(content)) {
                errors.push('Suspicious content detected');
                break;
            }
        }

        if (errors.length > 0) {
            this.metrics.validationErrors++;
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Process email attachments
     */
    async processAttachments(parsedEmail, processingId) {
        const attachments = [];
        
        if (!parsedEmail.attachments || parsedEmail.attachments.length === 0) {
            return attachments;
        }

        for (const attachment of parsedEmail.attachments) {
            try {
                // Validate attachment
                const validation = this.validateAttachment(attachment);
                if (!validation.valid) {
                    logger.warn('Attachment validation failed', {
                        filename: attachment.filename,
                        errors: validation.errors
                    });
                    continue;
                }

                // Upload to S3 with circuit breaker
                const s3Key = await s3UploadBreaker.execute(async () => {
                    return await this.uploadAttachment(attachment, processingId);
                });

                attachments.push({
                    filename: attachment.filename,
                    contentType: attachment.contentType,
                    size: attachment.size,
                    checksum: attachment.checksum,
                    s3Key,
                    uploadedAt: new Date().toISOString()
                });

                this.metrics.attachmentsExtracted++;

            } catch (error) {
                logger.error('Failed to process attachment', {
                    filename: attachment.filename,
                    error: error.message
                });
            }
        }

        return attachments;
    }

    /**
     * Validate attachment
     */
    validateAttachment(attachment) {
        const errors = [];

        // Check file size
        if (attachment.size > CONFIG.maxAttachmentSize) {
            errors.push(`File too large: ${attachment.size} bytes`);
        }

        // Check file type
        const extension = attachment.filename?.toLowerCase().match(/\.[^.]+$/)?.[0];
        if (!extension || !CONFIG.allowedFileTypes.includes(extension)) {
            errors.push(`Invalid file type: ${extension}`);
        }

        // Check for malicious content
        if (attachment.contentType?.includes('executable') || 
            attachment.filename?.includes('..')) {
            errors.push('Potentially malicious file detected');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Upload attachment to S3
     */
    async uploadAttachment(attachment, processingId) {
        const fileId = uuidv4();
        const extension = attachment.filename?.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
        const s3Key = `emails/${processingId}/attachments/${fileId}${extension}`;

        // Calculate checksum
        const checksum = crypto
            .createHash('sha256')
            .update(attachment.content)
            .digest('hex');

        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.processingBucket,
            Key: s3Key,
            Body: attachment.content,
            ContentType: attachment.contentType,
            Metadata: {
                'original-filename': attachment.filename,
                'processing-id': processingId,
                'checksum': checksum,
                'upload-timestamp': new Date().toISOString()
            },
            ServerSideEncryption: 'AES256'
        }));

        logger.info('Attachment uploaded', {
            s3Key,
            filename: attachment.filename,
            size: attachment.size
        });

        return s3Key;
    }

    /**
     * Extract metadata from email
     */
    extractMetadata(parsedEmail, attachments) {
        return {
            subject: parsedEmail.subject,
            from: parsedEmail.from?.value?.[0]?.address || 'unknown',
            fromName: parsedEmail.from?.value?.[0]?.name || 'Unknown Sender',
            to: parsedEmail.to?.value?.map(t => t.address) || [],
            date: parsedEmail.date?.toISOString() || new Date().toISOString(),
            hasAttachments: attachments.length > 0,
            attachmentCount: attachments.length,
            textLength: parsedEmail.text?.length || 0,
            htmlLength: parsedEmail.html?.length || 0,
            messageId: parsedEmail.messageId,
            inReplyTo: parsedEmail.inReplyTo,
            references: parsedEmail.references
        };
    }

    /**
     * Store processed email data
     */
    async storeProcessedEmail(processingId, parsedEmail, attachments, metadata) {
        const s3Key = `emails/${processingId}/email.json`;

        // Store email content in S3
        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.documentsBucket,
            Key: s3Key,
            Body: JSON.stringify({
                processingId,
                metadata,
                content: {
                    text: parsedEmail.text,
                    html: parsedEmail.html
                },
                attachments,
                processedAt: new Date().toISOString()
            }),
            ContentType: 'application/json',
            ServerSideEncryption: 'AES256'
        }));

        logger.info('Email content stored', { s3Key, processingId });
        return s3Key;
    }

    /**
     * Trigger downstream processing
     */
    async triggerDownstreamProcessing(processingId, metadata) {
        // Send to EventBridge for routing
        await eventbridge.send(new PutEventsCommand({
            Entries: [{
                Source: 'scdor.email.processor',
                DetailType: 'EmailProcessed',
                Detail: JSON.stringify({
                    processingId,
                    metadata,
                    timestamp: new Date().toISOString()
                }),
                EventBusName: CONFIG.eventBus
            }]
        }));

        // Queue for document extraction if attachments present
        if (metadata.attachmentCount > 0) {
            await sqs.send(new SendMessageCommand({
                QueueUrl: CONFIG.processingQueue,
                MessageBody: JSON.stringify({
                    type: 'DOCUMENT_EXTRACTION',
                    processingId,
                    attachmentCount: metadata.attachmentCount,
                    priority: this.determinePriority(metadata)
                }),
                MessageAttributes: {
                    Type: {
                        DataType: 'String',
                        StringValue: 'DocumentExtraction'
                    }
                }
            }));
        }

        logger.info('Downstream processing triggered', { processingId });
    }

    /**
     * Determine processing priority
     */
    determinePriority(metadata) {
        // High priority for certain keywords
        const highPriorityKeywords = ['urgent', 'critical', 'immediate', 'priority'];
        const subject = (metadata.subject || '').toLowerCase();
        
        for (const keyword of highPriorityKeywords) {
            if (subject.includes(keyword)) {
                return 'HIGH';
            }
        }

        // Medium priority for emails with attachments
        if (metadata.attachmentCount > 0) {
            return 'MEDIUM';
        }

        return 'NORMAL';
    }

    /**
     * Record processing start in database
     */
    async recordProcessingStart(processingId, emailData, correlationId) {
        await databaseBreaker.execute(async () => {
            await dynamodb.send(new PutItemCommand({
                TableName: CONFIG.stateTable,
                Item: {
                    id: { S: processingId },
                    timestamp: { N: Date.now().toString() },
                    status: { S: 'PROCESSING' },
                    service: { S: 'EmailProcessor' },
                    correlationId: { S: correlationId },
                    subject: { S: emailData.subject || 'No Subject' },
                    from: { S: emailData.from || 'Unknown' },
                    startTime: { S: new Date().toISOString() }
                }
            }));
        });
    }

    /**
     * Record processing completion
     */
    async recordProcessingComplete(processingId, processingTime) {
        await databaseBreaker.execute(async () => {
            await dynamodb.send(new UpdateItemCommand({
                TableName: CONFIG.stateTable,
                Key: {
                    id: { S: processingId },
                    timestamp: { N: Date.now().toString() }
                },
                UpdateExpression: 'SET #status = :status, endTime = :endTime, processingTime = :processingTime',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': { S: 'COMPLETED' },
                    ':endTime': { S: new Date().toISOString() },
                    ':processingTime': { N: processingTime.toString() }
                }
            }));
        });
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
                UpdateExpression: 'SET #status = :status, errorMessage = :error, errorTime = :errorTime',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': { S: 'FAILED' },
                    ':error': { S: error.message },
                    ':errorTime': { S: new Date().toISOString() }
                }
            }));
        } catch (dbError) {
            logger.error('Failed to record error in database', { error: dbError.message });
        }
    }

    /**
     * Handle processing error
     */
    async handleProcessingError(error, correlationId) {
        // Send alert for critical errors
        if (error.message.includes('Circuit breaker open')) {
            await this.sendAlert('CRITICAL', 'Circuit breaker triggered in email processor', {
                error: error.message,
                correlationId,
                timestamp: new Date().toISOString()
            });
        }

        // Log to CloudWatch
        logger.error('Email processing error', {
            error: error.message,
            stack: error.stack,
            correlationId
        });
    }

    /**
     * Send alert via EventBridge
     */
    async sendAlert(severity, message, details) {
        try {
            await eventbridge.send(new PutEventsCommand({
                Entries: [{
                    Source: 'scdor.email.processor',
                    DetailType: 'ProcessingAlert',
                    Detail: JSON.stringify({
                        severity,
                        message,
                        ...details
                    }),
                    EventBusName: CONFIG.eventBus
                }]
            }));
        } catch (error) {
            logger.error('Failed to send alert', { error: error.message });
        }
    }

    /**
     * Publish metrics to CloudWatch
     */
    async publishMetrics() {
        // In production, this would use CloudWatch PutMetricData
        logger.info('Processing metrics', this.metrics);
    }
}

// Export handler for Lambda
const processor = new EmailProcessor();
export const handler = processor.handler.bind(processor);