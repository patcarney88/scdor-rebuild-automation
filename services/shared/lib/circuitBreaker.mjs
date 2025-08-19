/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures by failing fast when a service is unavailable
 * Implements three states: CLOSED (normal), OPEN (failing), HALF_OPEN (testing)
 */

import { EventEmitter } from 'events';
import Logger from './logger.mjs';

const logger = new Logger('CircuitBreaker');

const State = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker extends EventEmitter {
    constructor(name, options = {}) {
        super();
        
        this.name = name;
        this.config = {
            threshold: options.threshold || 5,           // Number of failures before opening
            timeout: options.timeout || 60000,           // Timeout for requests (ms)
            resetTimeout: options.resetTimeout || 30000, // Time before attempting reset (ms)
            volumeThreshold: options.volumeThreshold || 10, // Minimum requests before opening
            errorThresholdPercentage: options.errorThresholdPercentage || 50,
            rollingWindowSize: options.rollingWindowSize || 10000, // 10 seconds
            sleepWindow: options.sleepWindow || 5000,    // Time to wait in open state
            ...options
        };

        this.state = State.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = null;
        this.nextAttempt = null;
        this.requestCount = 0;
        
        // Rolling window for error percentage calculation
        this.requestWindow = [];
        this.windowStartTime = Date.now();
        
        // Metrics
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rejectedRequests: 0,
            timeouts: 0,
            stateChanges: []
        };
    }

    /**
     * Execute a function with circuit breaker protection
     */
    async execute(fn, fallback = null) {
        this.metrics.totalRequests++;
        
        // Check if circuit is open
        if (this.state === State.OPEN) {
            if (Date.now() >= this.nextAttempt) {
                this.setState(State.HALF_OPEN);
            } else {
                this.metrics.rejectedRequests++;
                
                if (fallback) {
                    logger.warn('Circuit breaker open, using fallback', {
                        name: this.name,
                        nextAttempt: new Date(this.nextAttempt).toISOString()
                    });
                    return await this.executeFallback(fallback);
                }
                
                throw new Error(`Circuit breaker is OPEN for ${this.name}`);
            }
        }

        try {
            // Execute with timeout
            const result = await this.executeWithTimeout(fn);
            this.onSuccess();
            return result;
            
        } catch (error) {
            this.onFailure(error);
            
            if (fallback) {
                logger.warn('Execution failed, using fallback', {
                    name: this.name,
                    error: error.message
                });
                return await this.executeFallback(fallback);
            }
            
            throw error;
        }
    }

    /**
     * Execute function with timeout
     */
    async executeWithTimeout(fn) {
        return new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => {
                this.metrics.timeouts++;
                reject(new Error(`Timeout after ${this.config.timeout}ms`));
            }, this.config.timeout);

            try {
                const result = await fn();
                clearTimeout(timer);
                resolve(result);
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    /**
     * Execute fallback function
     */
    async executeFallback(fallback) {
        try {
            if (typeof fallback === 'function') {
                return await fallback();
            }
            return fallback;
        } catch (error) {
            logger.error('Fallback execution failed', {
                name: this.name,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Handle successful execution
     */
    onSuccess() {
        this.failures = 0;
        this.successes++;
        this.metrics.successfulRequests++;
        this.recordRequest(true);

        if (this.state === State.HALF_OPEN) {
            // Successfully tested, close the circuit
            this.setState(State.CLOSED);
            logger.info('Circuit breaker recovered', {
                name: this.name,
                successes: this.successes
            });
        }
    }

    /**
     * Handle failed execution
     */
    onFailure(error) {
        this.failures++;
        this.lastFailureTime = Date.now();
        this.metrics.failedRequests++;
        this.recordRequest(false);

        logger.error('Circuit breaker failure', {
            name: this.name,
            failures: this.failures,
            error: error.message
        });

        if (this.state === State.HALF_OPEN) {
            // Test failed, reopen the circuit
            this.setState(State.OPEN);
        } else if (this.state === State.CLOSED) {
            // Check if we should open the circuit
            if (this.shouldOpen()) {
                this.setState(State.OPEN);
            }
        }
    }

    /**
     * Determine if circuit should open
     */
    shouldOpen() {
        // Check absolute threshold
        if (this.failures >= this.config.threshold) {
            return true;
        }

        // Check error percentage in rolling window
        const recentRequests = this.getRecentRequests();
        if (recentRequests.length >= this.config.volumeThreshold) {
            const errorCount = recentRequests.filter(r => !r.success).length;
            const errorPercentage = (errorCount / recentRequests.length) * 100;
            
            if (errorPercentage >= this.config.errorThresholdPercentage) {
                logger.warn('Error threshold exceeded', {
                    name: this.name,
                    errorPercentage,
                    threshold: this.config.errorThresholdPercentage
                });
                return true;
            }
        }

        return false;
    }

    /**
     * Record request in rolling window
     */
    recordRequest(success) {
        const now = Date.now();
        this.requestWindow.push({
            timestamp: now,
            success
        });

        // Clean old entries
        this.requestWindow = this.requestWindow.filter(
            r => now - r.timestamp <= this.config.rollingWindowSize
        );
    }

    /**
     * Get recent requests from rolling window
     */
    getRecentRequests() {
        const now = Date.now();
        return this.requestWindow.filter(
            r => now - r.timestamp <= this.config.rollingWindowSize
        );
    }

    /**
     * Set circuit breaker state
     */
    setState(newState) {
        const oldState = this.state;
        this.state = newState;

        logger.info('Circuit breaker state change', {
            name: this.name,
            from: oldState,
            to: newState
        });

        this.metrics.stateChanges.push({
            from: oldState,
            to: newState,
            timestamp: new Date().toISOString()
        });

        // Set next attempt time when opening
        if (newState === State.OPEN) {
            this.nextAttempt = Date.now() + this.config.sleepWindow;
            this.emit('open', {
                name: this.name,
                failures: this.failures,
                nextAttempt: new Date(this.nextAttempt).toISOString()
            });
        } else if (newState === State.CLOSED) {
            this.failures = 0;
            this.nextAttempt = null;
            this.emit('close', {
                name: this.name,
                successes: this.successes
            });
        } else if (newState === State.HALF_OPEN) {
            this.emit('half-open', {
                name: this.name
            });
        }

        this.emit('state-change', {
            name: this.name,
            from: oldState,
            to: newState
        });
    }

    /**
     * Force circuit to open
     */
    open() {
        this.setState(State.OPEN);
    }

    /**
     * Force circuit to close
     */
    close() {
        this.setState(State.CLOSED);
        this.failures = 0;
        this.nextAttempt = null;
    }

    /**
     * Reset circuit breaker
     */
    reset() {
        this.state = State.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = null;
        this.nextAttempt = null;
        this.requestWindow = [];
        this.windowStartTime = Date.now();
        
        logger.info('Circuit breaker reset', { name: this.name });
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            name: this.name,
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            lastFailureTime: this.lastFailureTime,
            nextAttempt: this.nextAttempt,
            metrics: this.getMetrics()
        };
    }

    /**
     * Get metrics
     */
    getMetrics() {
        const recentRequests = this.getRecentRequests();
        const errorCount = recentRequests.filter(r => !r.success).length;
        const errorRate = recentRequests.length > 0 
            ? (errorCount / recentRequests.length) * 100 
            : 0;

        return {
            ...this.metrics,
            currentErrorRate: errorRate.toFixed(2),
            recentRequestCount: recentRequests.length
        };
    }

    /**
     * Health check
     */
    isHealthy() {
        return this.state === State.CLOSED;
    }

    /**
     * Middleware for Express/Lambda
     */
    middleware() {
        return async (req, res, next) => {
            try {
                if (this.state === State.OPEN && Date.now() < this.nextAttempt) {
                    res.status(503).json({
                        error: 'Service Unavailable',
                        message: `Circuit breaker is OPEN for ${this.name}`,
                        retryAfter: new Date(this.nextAttempt).toISOString()
                    });
                    return;
                }
                next();
            } catch (error) {
                next(error);
            }
        };
    }
}

export default CircuitBreaker;