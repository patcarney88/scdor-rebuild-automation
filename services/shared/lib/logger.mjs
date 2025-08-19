/**
 * Structured Logger with CloudWatch Integration
 * Provides consistent logging across all services with correlation tracking
 */

import { CloudWatchLogsClient, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { hostname } from 'os';

const cloudwatchLogs = new CloudWatchLogsClient({ 
    region: process.env.AWS_REGION || 'us-east-1' 
});

class Logger {
    constructor(service, options = {}) {
        this.service = service;
        this.environment = process.env.ENVIRONMENT || 'dev';
        this.logGroup = options.logGroup || `/aws/lambda/${process.env.PROJECT_NAME || 'scdor-rebuild'}-${this.environment}`;
        this.logStream = options.logStream || `${service}-${hostname()}-${Date.now()}`;
        this.correlationId = null;
        this.buffer = [];
        this.bufferSize = options.bufferSize || 100;
        this.flushInterval = options.flushInterval || 5000;
        this.enableCloudWatch = options.enableCloudWatch !== false && process.env.ENABLE_CLOUDWATCH === 'true';
        
        // Log levels
        this.levels = {
            ERROR: 0,
            WARN: 1,
            INFO: 2,
            DEBUG: 3,
            TRACE: 4
        };
        
        this.currentLevel = this.levels[process.env.LOG_LEVEL || 'INFO'];
        
        // Start buffer flush timer if CloudWatch is enabled
        if (this.enableCloudWatch) {
            this.startFlushTimer();
        }

        // Ensure logs are flushed on process exit
        process.on('beforeExit', () => this.flush());
    }

    /**
     * Set correlation ID for request tracking
     */
    setCorrelationId(correlationId) {
        this.correlationId = correlationId;
    }

    /**
     * Log error level message
     */
    error(message, meta = {}) {
        this.log('ERROR', message, meta);
    }

    /**
     * Log warning level message
     */
    warn(message, meta = {}) {
        this.log('WARN', message, meta);
    }

    /**
     * Log info level message
     */
    info(message, meta = {}) {
        this.log('INFO', message, meta);
    }

    /**
     * Log debug level message
     */
    debug(message, meta = {}) {
        this.log('DEBUG', message, meta);
    }

    /**
     * Log trace level message
     */
    trace(message, meta = {}) {
        this.log('TRACE', message, meta);
    }

    /**
     * Core logging function
     */
    log(level, message, meta = {}) {
        if (this.levels[level] > this.currentLevel) {
            return;
        }

        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            service: this.service,
            environment: this.environment,
            correlationId: this.correlationId,
            message,
            ...this.sanitizeMeta(meta)
        };

        // Add error details if present
        if (meta.error instanceof Error) {
            logEntry.error = {
                name: meta.error.name,
                message: meta.error.message,
                stack: meta.error.stack
            };
        }

        // Console output
        this.consoleLog(level, logEntry);

        // Buffer for CloudWatch
        if (this.enableCloudWatch) {
            this.buffer.push(logEntry);
            
            if (this.buffer.length >= this.bufferSize) {
                this.flush();
            }
        }
    }

    /**
     * Console logging with color coding
     */
    consoleLog(level, logEntry) {
        const colors = {
            ERROR: '\x1b[31m', // Red
            WARN: '\x1b[33m',  // Yellow
            INFO: '\x1b[36m',  // Cyan
            DEBUG: '\x1b[35m', // Magenta
            TRACE: '\x1b[37m'  // White
        };
        
        const reset = '\x1b[0m';
        const color = colors[level] || reset;
        
        const output = process.env.NODE_ENV === 'production' 
            ? JSON.stringify(logEntry)
            : `${color}[${level}]${reset} ${logEntry.timestamp} - ${logEntry.service} - ${logEntry.message} ${JSON.stringify(this.sanitizeMeta(logEntry))}`;
        
        if (level === 'ERROR') {
            console.error(output);
        } else if (level === 'WARN') {
            console.warn(output);
        } else {
            console.log(output);
        }
    }

    /**
     * Sanitize metadata to remove sensitive information
     */
    sanitizeMeta(meta) {
        const sanitized = { ...meta };
        const sensitiveKeys = [
            'password', 'token', 'apiKey', 'secret', 
            'authorization', 'cookie', 'ssn', 'taxId'
        ];

        const sanitizeObject = (obj) => {
            if (typeof obj !== 'object' || obj === null) {
                return obj;
            }

            const result = Array.isArray(obj) ? [] : {};
            
            for (const [key, value] of Object.entries(obj)) {
                const lowerKey = key.toLowerCase();
                
                if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
                    result[key] = '***REDACTED***';
                } else if (typeof value === 'object' && value !== null) {
                    result[key] = sanitizeObject(value);
                } else {
                    result[key] = value;
                }
            }
            
            return result;
        };

        return sanitizeObject(sanitized);
    }

    /**
     * Start flush timer for CloudWatch
     */
    startFlushTimer() {
        this.flushTimer = setInterval(() => {
            if (this.buffer.length > 0) {
                this.flush();
            }
        }, this.flushInterval);
    }

    /**
     * Flush logs to CloudWatch
     */
    async flush() {
        if (!this.enableCloudWatch || this.buffer.length === 0) {
            return;
        }

        const logs = [...this.buffer];
        this.buffer = [];

        try {
            const logEvents = logs.map(log => ({
                timestamp: new Date(log.timestamp).getTime(),
                message: JSON.stringify(log)
            }));

            await cloudwatchLogs.send(new PutLogEventsCommand({
                logGroupName: this.logGroup,
                logStreamName: this.logStream,
                logEvents: logEvents
            }));

        } catch (error) {
            // Fallback to console if CloudWatch fails
            console.error('Failed to send logs to CloudWatch:', error.message);
            
            // Re-add logs to buffer for retry if not too many
            if (this.buffer.length < this.bufferSize) {
                this.buffer.unshift(...logs);
            }
        }
    }

    /**
     * Create metrics entry
     */
    metric(name, value, unit = 'Count', dimensions = {}) {
        this.info('METRIC', {
            metricName: name,
            value,
            unit,
            dimensions: {
                Service: this.service,
                Environment: this.environment,
                ...dimensions
            }
        });
    }

    /**
     * Start timing operation
     */
    startTimer() {
        return Date.now();
    }

    /**
     * End timing and log duration
     */
    endTimer(startTime, operation, meta = {}) {
        const duration = Date.now() - startTime;
        this.info(`Operation completed: ${operation}`, {
            ...meta,
            duration,
            durationUnit: 'ms'
        });
        return duration;
    }

    /**
     * Log performance metrics
     */
    performance(operation, metrics) {
        this.info('PERFORMANCE', {
            operation,
            metrics: {
                ...metrics,
                timestamp: new Date().toISOString()
            }
        });
    }

    /**
     * Create child logger with additional context
     */
    child(additionalContext) {
        const childLogger = new Logger(this.service, {
            logGroup: this.logGroup,
            enableCloudWatch: this.enableCloudWatch
        });
        
        childLogger.correlationId = this.correlationId;
        childLogger.context = {
            ...this.context,
            ...additionalContext
        };
        
        return childLogger;
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }
        
        await this.flush();
    }
}

export default Logger;