# SCDOR Rebuild Automation

Production-ready automation services for UITax and MyDorway with enhanced error handling, monitoring, and browser management.

## 🎯 Project Goals

- **Error Rate**: < 2% (from current 15-20%)
- **Browser Crashes**: < 0.5% (from current 10%)
- **Timeout Errors**: < 1% (from current 8%)
- **System Uptime**: 99.5%
- **Processing Time**: < 5 minutes per record

## 🏗️ Architecture

### Core Services

1. **Email Processor** - Handles incoming emails with attachments
2. **Document Extractor** - OCR and AI-powered data extraction using AWS Textract
3. **Integration Adapter** - Bridges existing SCDOR BCPC services with new infrastructure
4. **UITax Automation** - Enhanced browser automation with CAPTCHA solving
5. **MyDorway Automation** - Robust search with retry logic and health monitoring

### Key Features

- **Browser Pool Management** - Prevents resource exhaustion and memory leaks
- **Circuit Breakers** - Fail fast pattern for external service calls
- **Health Monitoring** - Proactive session health checks and recovery
- **Structured Logging** - CloudWatch integration with correlation tracking
- **Queue-Based Processing** - SQS with DLQ for reliable message handling
- **Event-Driven Architecture** - EventBridge for service orchestration

### AWS Services Used

- Lambda Functions (Node.js 20.x, Python 3.13)
- S3 for document storage
- DynamoDB for state management
- SQS for queue processing
- EventBridge for event routing
- CloudWatch for monitoring and alarms
- Textract for OCR
- SSM Parameter Store for secrets

## 🚀 Quick Start

### Prerequisites

- AWS CLI configured with appropriate credentials
- SAM CLI installed
- Node.js 20.x
- Python 3.13
- GitHub CLI (for repository setup)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/Viking-Sasquatch/scdor-rebuild-automation.git
cd scdor-rebuild-automation
```

2. Install dependencies:
```bash
npm install
cd services/email-processor && npm install && cd ../..
cd services/document-extractor && npm install && cd ../..
cd services/integration-adapter && npm install && cd ../..
```

3. Configure AWS credentials:
```bash
aws configure --profile BlairCato_Admin
```

4. Deploy to development:
```bash
cd deploy
./deploy.sh dev BlairCato_Admin
```

## 📁 Project Structure

```
scdor-rebuild/
├── infrastructure/          # AWS CloudFormation/SAM templates
│   ├── shared/             # Shared infrastructure resources
│   └── monitoring/         # CloudWatch alarms and dashboards
├── services/               # Lambda function services
│   ├── email-processor/    # Email processing service
│   ├── document-extractor/ # Document extraction with OCR
│   ├── integration-adapter/# Integration with existing services
│   └── shared/            # Shared libraries
│       └── lib/
│           ├── browserPool.mjs    # Browser pool management
│           ├── circuitBreaker.mjs # Circuit breaker implementation
│           └── logger.mjs         # Structured logging
├── deploy/                 # Deployment scripts and configuration
│   ├── deploy.sh          # Main deployment script
│   └── samconfig.toml     # SAM deployment configuration
└── tests/                 # Test suites

```

## 🔧 Configuration

### Environment Variables

Set these in SSM Parameter Store:

- `/scdor-rebuild/dev/captcha_api_key` - 2Captcha API key
- `/scdor-rebuild/dev/openai_api_key` - OpenAI API key
- `/scdor-rebuild/dev/slack_webhook_url` - Slack webhook for notifications

### Migration Modes

The system supports three migration modes:

1. **Shadow Mode** - Run both old and new systems in parallel for comparison
2. **Cutover Mode** - Use new system with automatic fallback to old
3. **Rollback Mode** - Use existing system only

Configure via `MIGRATION_MODE` environment variable.

## 📊 Monitoring

### CloudWatch Dashboard

Access the monitoring dashboard at:
```
https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=scdor-rebuild-dev
```

### Key Metrics

- Error Rate
- Browser Crash Rate
- CAPTCHA Success Rate
- Processing Time
- Queue Depth
- Lambda Errors

### Alarms

- High Error Rate (> 2%)
- Browser Crashes (> 0.5%)
- CAPTCHA Failures (< 90% success)
- Processing Time (> 5 minutes)
- DLQ Messages (> 5)

## 🧪 Testing

Run unit tests:
```bash
npm test
```

Run integration tests:
```bash
npm run test:integration
```

## 🚢 Deployment

### Development
```bash
./deploy/deploy.sh dev
```

### Staging
```bash
./deploy/deploy.sh staging
```

### Production
```bash
./deploy/deploy.sh prod
```

## 📈 Performance Targets

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Error Rate | 15-20% | < 2% | 🔄 |
| Browser Crashes | ~10% | < 0.5% | 🔄 |
| Timeout Errors | ~8% | < 1% | 🔄 |
| Processing Time | Variable | < 5 min | 🔄 |
| System Uptime | ~90% | 99.5% | 🔄 |

## 🤝 Team

- **Queen Orchestrator** - Executive oversight and resource allocation
- **Project Manager** - Sprint planning and progress tracking
- **Title Insurance Expert** - Domain expertise and compliance
- **Tech Lead** - Architecture and technical decisions
- **Backend Engineers** - Service implementation
- **DevOps** - Infrastructure and deployment
- **QA** - Testing and quality assurance

## 📝 License

Private - Blair & Cato, P.C.

## 🆘 Support

For issues or questions, contact the development team or create an issue in this repository.

---

**Project Status**: 🚧 Active Development

**Last Updated**: January 2025
