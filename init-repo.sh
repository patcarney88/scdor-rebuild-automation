#!/bin/bash

###############################################################################
# SCDOR Rebuild Repository Initialization Script
# Creates and configures a new GitHub repository for the SCDOR rebuild project
###############################################################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_NAME="scdor-rebuild-automation"
GITHUB_ORG="Viking-Sasquatch"  # Update if using a different org
GITHUB_USER=${GITHUB_USER:-"Viking-Sasquatch"}
PROJECT_NAME="SCDOR Rebuild Automation"
DESCRIPTION="Production-ready automation services for UITax and MyDorway with enhanced error handling, monitoring, and browser management"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}SCDOR Rebuild Repository Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Function to check if GitHub CLI is installed
check_github_cli() {
    if ! command -v gh &> /dev/null; then
        echo -e "${RED}GitHub CLI (gh) is not installed.${NC}"
        echo "Please install it from: https://cli.github.com/"
        exit 1
    fi
    echo -e "${GREEN}✓ GitHub CLI found${NC}"
}

# Function to check GitHub authentication
check_github_auth() {
    if ! gh auth status &>/dev/null; then
        echo -e "${YELLOW}Not authenticated with GitHub. Running 'gh auth login'...${NC}"
        gh auth login
    fi
    echo -e "${GREEN}✓ GitHub authenticated${NC}"
}

# Function to create repository
create_repository() {
    echo -e "${YELLOW}Creating GitHub repository: $REPO_NAME${NC}"
    
    # Check if repo already exists
    if gh repo view "$GITHUB_USER/$REPO_NAME" &>/dev/null; then
        echo -e "${YELLOW}Repository already exists. Would you like to use it? (y/n)${NC}"
        read -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${RED}Exiting...${NC}"
            exit 1
        fi
    else
        # Create new repository
        gh repo create "$REPO_NAME" \
            --public \
            --description "$DESCRIPTION" \
            --clone=false \
            --add-readme=false
        
        echo -e "${GREEN}✓ Repository created${NC}"
    fi
}

# Function to initialize git repository
init_git_repo() {
    echo -e "${YELLOW}Initializing local git repository...${NC}"
    
    if [ -d .git ]; then
        echo -e "${YELLOW}Git repository already initialized${NC}"
    else
        git init
        echo -e "${GREEN}✓ Git repository initialized${NC}"
    fi
    
    # Set remote
    if git remote get-url origin &>/dev/null; then
        echo -e "${YELLOW}Remote 'origin' already exists${NC}"
    else
        git remote add origin "https://github.com/$GITHUB_USER/$REPO_NAME.git"
        echo -e "${GREEN}✓ Remote added${NC}"
    fi
}

# Function to create .gitignore
create_gitignore() {
    echo -e "${YELLOW}Creating .gitignore file...${NC}"
    
    cat > .gitignore << 'EOF'
# Dependencies
node_modules/
*.pyc
__pycache__/
.Python
env/
venv/
.venv/

# AWS SAM
.aws-sam/
samconfig.toml.local

# Environment variables
.env
.env.local
.env.*.local
*.env

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# Build artifacts
dist/
build/
*.zip
*.tar.gz

# Logs
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Testing
coverage/
.nyc_output/
*.lcov
.coverage
htmlcov/

# Temporary files
tmp/
temp/
*.tmp

# AWS
.aws/
*.pem

# Terraform
*.tfstate
*.tfstate.*
.terraform/
.terraform.lock.hcl

# Secrets
**/secrets/
**/credentials/
*.key
*.cert
*.crt

# Lambda packages
lambda-packages/
layer/
EOF
    
    echo -e "${GREEN}✓ .gitignore created${NC}"
}

# Function to create README
create_readme() {
    echo -e "${YELLOW}Creating README.md...${NC}"
    
    cat > README.md << 'EOF'
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
EOF
    
    echo -e "${GREEN}✓ README.md created${NC}"
}

# Function to create initial commit
create_initial_commit() {
    echo -e "${YELLOW}Creating initial commit...${NC}"
    
    # Add all files
    git add .
    
    # Create commit
    git commit -m "feat: Initial commit - SCDOR Rebuild Automation

- Infrastructure setup with AWS SAM/CloudFormation
- Email processor with circuit breakers
- Document extractor with OCR and AI
- Integration adapter for migration
- Shared libraries (browserPool, circuitBreaker, logger)
- Monitoring and alerting configuration
- Deployment scripts

Targets:
- Error rate < 2%
- Browser crashes < 0.5%
- Timeout errors < 1%
- System uptime 99.5%"
    
    echo -e "${GREEN}✓ Initial commit created${NC}"
}

# Function to push to GitHub
push_to_github() {
    echo -e "${YELLOW}Pushing to GitHub...${NC}"
    
    # Set main branch
    git branch -M main
    
    # Push to remote
    git push -u origin main
    
    echo -e "${GREEN}✓ Pushed to GitHub${NC}"
}

# Function to set up GitHub repository settings
setup_github_settings() {
    echo -e "${YELLOW}Configuring GitHub repository settings...${NC}"
    
    # Add topics
    gh repo edit "$GITHUB_USER/$REPO_NAME" \
        --add-topic "aws" \
        --add-topic "automation" \
        --add-topic "playwright" \
        --add-topic "serverless" \
        --add-topic "nodejs" \
        --add-topic "python"
    
    # Create initial issues
    gh issue create \
        --title "Implement UITax bot service with browser pool" \
        --body "Enhance UITax automation with browser pool management and health monitoring" \
        --label "enhancement"
    
    gh issue create \
        --title "Implement MyDorway bot service with retry logic" \
        --body "Enhance MyDorway automation with exponential backoff and circuit breakers" \
        --label "enhancement"
    
    gh issue create \
        --title "Complete integration testing" \
        --body "End-to-end testing of email → PDF → bot → annotation flow" \
        --label "testing"
    
    echo -e "${GREEN}✓ Repository settings configured${NC}"
}

# Function to create GitHub Actions workflow
create_github_actions() {
    echo -e "${YELLOW}Creating GitHub Actions workflow...${NC}"
    
    mkdir -p .github/workflows
    
    cat > .github/workflows/deploy.yml << 'EOF'
name: Deploy SCDOR Rebuild

on:
  push:
    branches:
      - main
      - develop
  pull_request:
    branches:
      - main

env:
  AWS_REGION: us-east-1

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test

  deploy-dev:
    needs: test
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup AWS SAM
        uses: aws-actions/setup-sam@v2
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
      
      - name: Deploy to Dev
        run: |
          cd deploy
          ./deploy.sh dev

  deploy-prod:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup AWS SAM
        uses: aws-actions/setup-sam@v2
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
      
      - name: Deploy to Production
        run: |
          cd deploy
          ./deploy.sh prod
EOF
    
    echo -e "${GREEN}✓ GitHub Actions workflow created${NC}"
}

# Main execution
main() {
    echo -e "${YELLOW}Setting up SCDOR Rebuild repository...${NC}"
    echo ""
    
    # Check prerequisites
    check_github_cli
    check_github_auth
    
    # Create repository
    create_repository
    
    # Initialize local repository
    init_git_repo
    
    # Create essential files
    create_gitignore
    create_readme
    create_github_actions
    
    # Commit and push
    create_initial_commit
    push_to_github
    
    # Configure repository
    setup_github_settings
    
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Repository Setup Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Repository URL: https://github.com/$GITHUB_USER/$REPO_NAME"
    echo ""
    echo "Next steps:"
    echo "1. Add AWS credentials as GitHub secrets:"
    echo "   - AWS_ACCESS_KEY_ID"
    echo "   - AWS_SECRET_ACCESS_KEY"
    echo ""
    echo "2. Configure SSM parameters in AWS:"
    echo "   - /scdor-rebuild/dev/captcha_api_key"
    echo "   - /scdor-rebuild/dev/openai_api_key"
    echo "   - /scdor-rebuild/dev/slack_webhook_url"
    echo ""
    echo "3. Deploy to development:"
    echo "   cd deploy && ./deploy.sh dev"
    echo ""
}

# Run main function
main

echo -e "${GREEN}Repository initialization complete!${NC}"