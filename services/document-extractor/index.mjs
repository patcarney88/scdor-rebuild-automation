/**
 * Document Extractor Service
 * Extracts data from PDFs and other documents using OCR and AI
 * Includes validation, error handling, and structured data output
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import PDFParser from 'pdf-parse';
import Tesseract from 'tesseract.js';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import CircuitBreaker from '../shared/lib/circuitBreaker.mjs';
import Logger from '../shared/lib/logger.mjs';

// Initialize AWS clients
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const eventbridge = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });

const logger = new Logger('DocumentExtractor');

// Configuration
const CONFIG = {
    processingBucket: process.env.PROCESSING_BUCKET || 'scdor-rebuild-processing-dev',
    documentsBucket: process.env.DOCUMENTS_BUCKET || 'scdor-rebuild-documents-dev',
    stateTable: process.env.STATE_TABLE || 'scdor-rebuild-state-dev',
    eventBus: process.env.EVENT_BUS || 'scdor-rebuild-events-dev',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    supportedFormats: ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.xlsx', '.xls', '.doc', '.docx'],
    ocrLanguages: ['eng', 'spa'],
    extractionTimeout: 120000, // 2 minutes
    openAIModel: 'gpt-4-vision-preview',
    confidenceThreshold: 0.85
};

// Initialize OpenAI client (will be configured with API key from SSM)
let openaiClient = null;

// Circuit breakers
const ocrBreaker = new CircuitBreaker('OCR', {
    threshold: 3,
    timeout: 60000,
    resetTimeout: 120000
});

const aiBreaker = new CircuitBreaker('OpenAI', {
    threshold: 5,
    timeout: 30000,
    resetTimeout: 60000
});

const s3Breaker = new CircuitBreaker('S3Operations', {
    threshold: 3,
    timeout: 30000,
    resetTimeout: 60000
});

class DocumentExtractor {
    constructor() {
        this.extractionId = uuidv4();
        this.metrics = {
            processed: 0,
            failed: 0,
            ocrProcessed: 0,
            aiProcessed: 0,
            extractionTime: []
        };
    }

    /**
     * Initialize OpenAI client with API key from SSM
     */
    async initializeOpenAI() {
        if (openaiClient) return;

        try {
            const parameter = await ssm.send(new GetParameterCommand({
                Name: `/${CONFIG.stateTable.split('-')[0]}/${process.env.ENVIRONMENT || 'dev'}/openai_api_key`,
                WithDecryption: true
            }));

            openaiClient = new OpenAI({
                apiKey: parameter.Parameter.Value
            });

            logger.info('OpenAI client initialized');
        } catch (error) {
            logger.error('Failed to initialize OpenAI', { error: error.message });
            throw error;
        }
    }

    /**
     * Main handler for Lambda function
     */
    async handler(event, context) {
        const correlationId = context.requestId || uuidv4();
        logger.setCorrelationId(correlationId);

        logger.info('Processing document extraction event', {
            eventType: event.Records ? 'SQS' : 'S3',
            recordCount: event.Records?.length || 1
        });

        try {
            // Initialize OpenAI if needed
            await this.initializeOpenAI();

            if (event.Records) {
                // Process SQS or S3 events
                for (const record of event.Records) {
                    if (record.eventSource === 'aws:s3') {
                        await this.processS3Event(record, correlationId);
                    } else {
                        await this.processSQSMessage(record, correlationId);
                    }
                }
            } else {
                // Direct invocation
                await this.extractDocument(event, correlationId);
            }

            await this.publishMetrics();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Document extraction completed',
                    metrics: this.metrics,
                    correlationId
                })
            };

        } catch (error) {
            logger.error('Document extraction failed', { error: error.message });
            
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Document extraction failed',
                    message: error.message,
                    correlationId
                })
            };
        }
    }

    /**
     * Process S3 event
     */
    async processS3Event(record, correlationId) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

        logger.info('Processing S3 event', { bucket, key });

        await this.extractDocument({
            bucket,
            key,
            processingId: uuidv4()
        }, correlationId);
    }

    /**
     * Process SQS message
     */
    async processSQSMessage(record, correlationId) {
        try {
            const message = JSON.parse(record.body);
            
            await this.extractDocument({
                processingId: message.processingId,
                attachments: message.attachments
            }, correlationId);

            // Delete message from queue on success
            await sqs.send(new DeleteMessageCommand({
                QueueUrl: process.env.PROCESSING_QUEUE,
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
     * Extract document data
     */
    async extractDocument(params, correlationId) {
        const startTime = Date.now();
        const { processingId, bucket, key, attachments } = params;

        logger.info('Starting document extraction', {
            processingId,
            documentCount: attachments?.length || 1
        });

        try {
            // Update status
            await this.updateStatus(processingId, 'EXTRACTING');

            let documents = [];

            if (attachments) {
                // Process multiple attachments
                for (const attachment of attachments) {
                    const doc = await this.processDocument(attachment.s3Key, processingId);
                    documents.push(doc);
                }
            } else if (bucket && key) {
                // Process single document
                const doc = await this.processDocument(`${bucket}/${key}`, processingId);
                documents.push(doc);
            }

            // Aggregate extracted data
            const extractedData = await this.aggregateExtractedData(documents);

            // Validate extracted data
            const validation = await this.validateExtractedData(extractedData);

            // Store results
            await this.storeExtractionResults(processingId, extractedData, validation);

            // Trigger downstream processing
            await this.triggerDownstreamProcessing(processingId, extractedData);

            // Update metrics
            const duration = Date.now() - startTime;
            this.metrics.processed++;
            this.metrics.extractionTime.push(duration);

            // Update status
            await this.updateStatus(processingId, 'EXTRACTED', {
                documentCount: documents.length,
                duration
            });

            logger.info('Document extraction completed', {
                processingId,
                documentCount: documents.length,
                duration
            });

            return extractedData;

        } catch (error) {
            this.metrics.failed++;
            await this.updateStatus(processingId, 'EXTRACTION_FAILED', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Process individual document
     */
    async processDocument(s3Path, processingId) {
        const [bucket, ...keyParts] = s3Path.split('/');
        const key = keyParts.join('/');

        logger.info('Processing document', { bucket, key });

        try {
            // Download document from S3
            const document = await s3Breaker.execute(async () => {
                const response = await s3.send(new GetObjectCommand({
                    Bucket: bucket || CONFIG.processingBucket,
                    Key: key
                }));
                return {
                    body: await response.Body.transformToByteArray(),
                    contentType: response.ContentType,
                    metadata: response.Metadata
                };
            });

            // Determine document type and process accordingly
            const fileExtension = key.toLowerCase().match(/\.[^.]+$/)?.[0];
            let extractedData = {};

            if (fileExtension === '.pdf') {
                extractedData = await this.extractFromPDF(document.body, key);
            } else if (['.png', '.jpg', '.jpeg', '.tiff'].includes(fileExtension)) {
                extractedData = await this.extractFromImage(document.body, key);
            } else if (['.xlsx', '.xls'].includes(fileExtension)) {
                extractedData = await this.extractFromSpreadsheet(document.body, key);
            } else if (['.doc', '.docx'].includes(fileExtension)) {
                extractedData = await this.extractFromDocument(document.body, key);
            } else {
                throw new Error(`Unsupported file type: ${fileExtension}`);
            }

            // Enhance with AI if needed
            if (extractedData.requiresAI || extractedData.confidence < CONFIG.confidenceThreshold) {
                extractedData = await this.enhanceWithAI(extractedData, document.body);
            }

            return {
                source: s3Path,
                type: fileExtension,
                extractedAt: new Date().toISOString(),
                ...extractedData
            };

        } catch (error) {
            logger.error('Document processing failed', {
                s3Path,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Extract data from PDF
     */
    async extractFromPDF(buffer, filename) {
        logger.info('Extracting from PDF', { filename });

        try {
            const data = await PDFParser(buffer);
            
            // Extract text content
            const text = data.text;
            
            // Extract metadata
            const metadata = {
                pages: data.numpages,
                info: data.info,
                version: data.version
            };

            // Parse structured data
            const structuredData = this.parseStructuredData(text);

            // Check if OCR is needed (low text content)
            let ocrData = {};
            if (text.length < 100 && data.numpages > 0) {
                logger.info('PDF has minimal text, attempting OCR');
                ocrData = await this.performOCR(buffer);
                this.metrics.ocrProcessed++;
            }

            return {
                text: text || ocrData.text,
                metadata,
                structuredData,
                confidence: text.length > 100 ? 0.95 : 0.7,
                requiresAI: !structuredData.complete
            };

        } catch (error) {
            logger.error('PDF extraction failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Extract data from image using OCR
     */
    async extractFromImage(buffer, filename) {
        logger.info('Extracting from image', { filename });

        const ocrData = await ocrBreaker.execute(async () => {
            return await this.performOCR(buffer);
        });

        this.metrics.ocrProcessed++;

        return {
            text: ocrData.text,
            confidence: ocrData.confidence,
            structuredData: this.parseStructuredData(ocrData.text),
            requiresAI: true
        };
    }

    /**
     * Perform OCR on image/document
     */
    async performOCR(buffer) {
        try {
            const worker = await Tesseract.createWorker();
            await worker.loadLanguage('eng');
            await worker.initialize('eng');
            
            const { data } = await worker.recognize(buffer);
            
            await worker.terminate();

            return {
                text: data.text,
                confidence: data.confidence / 100,
                words: data.words,
                lines: data.lines
            };

        } catch (error) {
            logger.error('OCR failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Parse structured data from text
     */
    parseStructuredData(text) {
        const data = {
            complete: false,
            fields: {}
        };

        // Extract common patterns
        const patterns = {
            name: /(?:name|owner):\s*([^\n]+)/i,
            ssn: /(?:ssn|social):\s*(\d{3}-\d{2}-\d{4})/i,
            taxId: /(?:tax\s*id|tin):\s*(\d{2}-\d{7})/i,
            address: /(?:address|property):\s*([^\n]+)/i,
            amount: /(?:amount|value|price):\s*\$?([\d,]+\.?\d*)/i,
            date: /(?:date|dated):\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
            parcelNumber: /(?:parcel|apn):\s*([A-Z0-9-]+)/i,
            documentType: /(?:type|document):\s*(deed|lien|mortgage|tax)/i
        };

        for (const [field, pattern] of Object.entries(patterns)) {
            const match = text.match(pattern);
            if (match) {
                data.fields[field] = match[1].trim();
            }
        }

        // Check if we have minimum required fields
        data.complete = Object.keys(data.fields).length >= 3;

        return data;
    }

    /**
     * Enhance extraction with AI
     */
    async enhanceWithAI(extractedData, documentBuffer) {
        logger.info('Enhancing with AI');

        try {
            return await aiBreaker.execute(async () => {
                const completion = await openaiClient.chat.completions.create({
                    model: CONFIG.openAIModel,
                    messages: [
                        {
                            role: 'system',
                            content: `You are a document extraction specialist for title insurance and property records. 
                                     Extract structured data from documents including names, addresses, amounts, dates, 
                                     parcel numbers, and document types. Return data in JSON format.`
                        },
                        {
                            role: 'user',
                            content: `Extract structured data from this text: ${extractedData.text?.substring(0, 4000)}`
                        }
                    ],
                    temperature: 0.1,
                    max_tokens: 1000
                });

                const aiData = JSON.parse(completion.choices[0].message.content);
                this.metrics.aiProcessed++;

                return {
                    ...extractedData,
                    aiEnhanced: true,
                    structuredData: {
                        ...extractedData.structuredData,
                        ...aiData
                    },
                    confidence: Math.max(extractedData.confidence, 0.9)
                };
            });

        } catch (error) {
            logger.error('AI enhancement failed', { error: error.message });
            // Return original data if AI fails
            return extractedData;
        }
    }

    /**
     * Extract from spreadsheet (placeholder)
     */
    async extractFromSpreadsheet(buffer, filename) {
        logger.info('Extracting from spreadsheet', { filename });
        
        // In production, use xlsx or similar library
        return {
            text: 'Spreadsheet extraction not yet implemented',
            structuredData: {},
            confidence: 0.5,
            requiresAI: true
        };
    }

    /**
     * Extract from Word document (placeholder)
     */
    async extractFromDocument(buffer, filename) {
        logger.info('Extracting from document', { filename });
        
        // In production, use mammoth or similar library
        return {
            text: 'Document extraction not yet implemented',
            structuredData: {},
            confidence: 0.5,
            requiresAI: true
        };
    }

    /**
     * Aggregate extracted data from multiple documents
     */
    async aggregateExtractedData(documents) {
        const aggregated = {
            documentCount: documents.length,
            extractedAt: new Date().toISOString(),
            documents: documents,
            summary: {},
            confidence: 0
        };

        // Combine structured data
        const allFields = {};
        let totalConfidence = 0;

        for (const doc of documents) {
            if (doc.structuredData?.fields) {
                Object.assign(allFields, doc.structuredData.fields);
            }
            totalConfidence += doc.confidence || 0;
        }

        aggregated.summary = allFields;
        aggregated.confidence = totalConfidence / documents.length;

        return aggregated;
    }

    /**
     * Validate extracted data
     */
    async validateExtractedData(data) {
        const validation = {
            valid: true,
            errors: [],
            warnings: []
        };

        // Check required fields
        const requiredFields = ['name', 'address'];
        for (const field of requiredFields) {
            if (!data.summary[field]) {
                validation.warnings.push(`Missing ${field}`);
            }
        }

        // Validate formats
        if (data.summary.ssn && !/^\d{3}-\d{2}-\d{4}$/.test(data.summary.ssn)) {
            validation.errors.push('Invalid SSN format');
            validation.valid = false;
        }

        if (data.summary.taxId && !/^\d{2}-\d{7}$/.test(data.summary.taxId)) {
            validation.errors.push('Invalid Tax ID format');
            validation.valid = false;
        }

        // Check confidence
        if (data.confidence < 0.7) {
            validation.warnings.push('Low confidence extraction');
        }

        return validation;
    }

    /**
     * Store extraction results
     */
    async storeExtractionResults(processingId, extractedData, validation) {
        const s3Key = `extractions/${processingId}/results.json`;

        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.documentsBucket,
            Key: s3Key,
            Body: JSON.stringify({
                processingId,
                extractedData,
                validation,
                extractedAt: new Date().toISOString()
            }),
            ContentType: 'application/json',
            ServerSideEncryption: 'AES256'
        }));

        logger.info('Extraction results stored', { s3Key });
        return s3Key;
    }

    /**
     * Trigger downstream processing
     */
    async triggerDownstreamProcessing(processingId, extractedData) {
        await eventbridge.send(new PutEventsCommand({
            Entries: [{
                Source: 'scdor.document.extractor',
                DetailType: 'DocumentExtracted',
                Detail: JSON.stringify({
                    processingId,
                    summary: extractedData.summary,
                    confidence: extractedData.confidence,
                    documentCount: extractedData.documentCount,
                    timestamp: new Date().toISOString()
                }),
                EventBusName: CONFIG.eventBus
            }]
        }));

        logger.info('Downstream processing triggered', { processingId });
    }

    /**
     * Update processing status in DynamoDB
     */
    async updateStatus(processingId, status, metadata = {}) {
        try {
            await dynamodb.send(new UpdateItemCommand({
                TableName: CONFIG.stateTable,
                Key: {
                    id: { S: processingId },
                    timestamp: { N: Date.now().toString() }
                },
                UpdateExpression: 'SET #status = :status, #service = :service, #metadata = :metadata',
                ExpressionAttributeNames: {
                    '#status': 'status',
                    '#service': 'service',
                    '#metadata': 'extractionMetadata'
                },
                ExpressionAttributeValues: {
                    ':status': { S: status },
                    ':service': { S: 'DocumentExtractor' },
                    ':metadata': { S: JSON.stringify(metadata) }
                }
            }));
        } catch (error) {
            logger.error('Failed to update status', { error: error.message });
        }
    }

    /**
     * Publish metrics to CloudWatch
     */
    async publishMetrics() {
        const avgExtractionTime = this.metrics.extractionTime.length > 0
            ? this.metrics.extractionTime.reduce((a, b) => a + b, 0) / this.metrics.extractionTime.length
            : 0;

        logger.metric('DocumentsProcessed', this.metrics.processed);
        logger.metric('DocumentsFailed', this.metrics.failed);
        logger.metric('OCRProcessed', this.metrics.ocrProcessed);
        logger.metric('AIProcessed', this.metrics.aiProcessed);
        logger.metric('AverageExtractionTime', avgExtractionTime, 'Milliseconds');
    }
}

// Export handler for Lambda
const extractor = new DocumentExtractor();
export const handler = extractor.handler.bind(extractor);