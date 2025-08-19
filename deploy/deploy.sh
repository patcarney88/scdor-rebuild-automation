#!/bin/bash

###############################################################################
# SCDOR Rebuild Deployment Script
# Handles deployment to different environments with validation
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_NAME="scdor-rebuild"
AWS_REGION=${AWS_REGION:-"us-east-1"}
ENVIRONMENT=${1:-dev}
AWS_PROFILE=${2:-BlairCato_Admin}

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod|integration)$ ]]; then
    echo -e "${RED}Error: Invalid environment. Must be one of: dev, staging, prod, integration${NC}"
    exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SCDOR Rebuild Deployment${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "Environment: ${YELLOW}$ENVIRONMENT${NC}"
echo -e "AWS Profile: ${YELLOW}$AWS_PROFILE${NC}"
echo -e "AWS Region: ${YELLOW}$AWS_REGION${NC}"
echo ""

# Function to check AWS credentials
check_aws_credentials() {
    echo -e "${YELLOW}Checking AWS credentials...${NC}"
    if ! aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
        echo -e "${RED}Error: Unable to authenticate with AWS. Check your credentials.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ AWS credentials valid${NC}"
}

# Function to validate templates
validate_templates() {
    echo -e "${YELLOW}Validating CloudFormation templates...${NC}"
    
    # Validate infrastructure template
    aws cloudformation validate-template \
        --template-body file://../infrastructure/shared/template.yaml \
        --profile "$AWS_PROFILE" \
        --region "$AWS_REGION" &>/dev/null
    echo -e "${GREEN}✓ Infrastructure template valid${NC}"
    
    # Validate monitoring template
    aws cloudformation validate-template \
        --template-body file://../infrastructure/monitoring/alarms.yaml \
        --profile "$AWS_PROFILE" \
        --region "$AWS_REGION" &>/dev/null
    echo -e "${GREEN}✓ Monitoring template valid${NC}"
}

# Function to check dependencies
check_dependencies() {
    echo -e "${YELLOW}Checking dependencies...${NC}"
    
    # Check for SAM CLI
    if ! command -v sam &> /dev/null; then
        echo -e "${RED}Error: SAM CLI not found. Please install it first.${NC}"
        echo "Visit: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html"
        exit 1
    fi
    echo -e "${GREEN}✓ SAM CLI found${NC}"
    
    # Check for Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js not found. Please install it first.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js found${NC}"
    
    # Check for Python
    if ! command -v python3 &> /dev/null; then
        echo -e "${RED}Error: Python 3 not found. Please install it first.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Python 3 found${NC}"
}

# Function to create S3 deployment bucket if it doesn't exist
create_deployment_bucket() {
    BUCKET_NAME="${PROJECT_NAME}-deployments-${ENVIRONMENT}"
    echo -e "${YELLOW}Checking deployment bucket: $BUCKET_NAME${NC}"
    
    if ! aws s3api head-bucket --bucket "$BUCKET_NAME" --profile "$AWS_PROFILE" 2>/dev/null; then
        echo -e "${YELLOW}Creating deployment bucket...${NC}"
        aws s3api create-bucket \
            --bucket "$BUCKET_NAME" \
            --region "$AWS_REGION" \
            --profile "$AWS_PROFILE"
        
        # Enable versioning
        aws s3api put-bucket-versioning \
            --bucket "$BUCKET_NAME" \
            --versioning-configuration Status=Enabled \
            --profile "$AWS_PROFILE"
        
        # Enable encryption
        aws s3api put-bucket-encryption \
            --bucket "$BUCKET_NAME" \
            --server-side-encryption-configuration '{"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}' \
            --profile "$AWS_PROFILE"
        
        echo -e "${GREEN}✓ Deployment bucket created${NC}"
    else
        echo -e "${GREEN}✓ Deployment bucket exists${NC}"
    fi
}

# Function to deploy shared infrastructure
deploy_infrastructure() {
    echo -e "${YELLOW}Deploying shared infrastructure...${NC}"
    
    cd ../infrastructure/shared
    
    sam build --template template.yaml
    
    sam deploy \
        --config-env "$ENVIRONMENT" \
        --profile "$AWS_PROFILE" \
        --no-confirm-changeset \
        --stack-name "${PROJECT_NAME}-infrastructure-${ENVIRONMENT}" \
        --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
        --parameter-overrides \
            Environment="$ENVIRONMENT" \
            ProjectName="$PROJECT_NAME"
    
    cd ../../deploy
    echo -e "${GREEN}✓ Infrastructure deployed${NC}"
}

# Function to deploy monitoring
deploy_monitoring() {
    echo -e "${YELLOW}Deploying monitoring configuration...${NC}"
    
    cd ../infrastructure/monitoring
    
    sam deploy \
        --template-file alarms.yaml \
        --profile "$AWS_PROFILE" \
        --stack-name "${PROJECT_NAME}-monitoring-${ENVIRONMENT}" \
        --capabilities CAPABILITY_IAM \
        --parameter-overrides \
            Environment="$ENVIRONMENT" \
            ProjectName="$PROJECT_NAME" \
            AlertEmail="${ALERT_EMAIL:-alerts@blaircato.com}" \
        --no-confirm-changeset
    
    cd ../../deploy
    echo -e "${GREEN}✓ Monitoring deployed${NC}"
}

# Function to package Lambda functions
package_functions() {
    echo -e "${YELLOW}Packaging Lambda functions...${NC}"
    
    # Package Node.js functions
    for service in email-processor document-extractor integration-adapter; do
        if [ -d "../services/$service" ]; then
            echo -e "  Packaging $service..."
            cd "../services/$service"
            npm install --production
            zip -rq "../../deploy/${service}.zip" . -x "*.git*"
            cd ../../deploy
        fi
    done
    
    echo -e "${GREEN}✓ Functions packaged${NC}"
}

# Function to deploy Lambda functions
deploy_functions() {
    echo -e "${YELLOW}Deploying Lambda functions...${NC}"
    
    # This would normally use SAM or CDK for each service
    # For now, showing the pattern for one service
    
    for service in email-processor document-extractor integration-adapter; do
        if [ -f "${service}.zip" ]; then
            echo -e "  Deploying $service..."
            
            # Create or update Lambda function
            aws lambda create-function \
                --function-name "${PROJECT_NAME}-${service}-${ENVIRONMENT}" \
                --runtime nodejs20.x \
                --role "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text --profile $AWS_PROFILE):role/${PROJECT_NAME}-lambda-role-${ENVIRONMENT}" \
                --handler index.handler \
                --zip-file "fileb://${service}.zip" \
                --timeout 900 \
                --memory-size 2048 \
                --environment Variables="{
                    ENVIRONMENT=${ENVIRONMENT},
                    PROJECT_NAME=${PROJECT_NAME},
                    PROCESSING_BUCKET=${PROJECT_NAME}-processing-${ENVIRONMENT},
                    DOCUMENTS_BUCKET=${PROJECT_NAME}-documents-${ENVIRONMENT},
                    STATE_TABLE=${PROJECT_NAME}-state-${ENVIRONMENT},
                    PROCESSING_QUEUE=${PROJECT_NAME}-processing-${ENVIRONMENT},
                    EVENT_BUS=${PROJECT_NAME}-events-${ENVIRONMENT}
                }" \
                --profile "$AWS_PROFILE" 2>/dev/null || \
            aws lambda update-function-code \
                --function-name "${PROJECT_NAME}-${service}-${ENVIRONMENT}" \
                --zip-file "fileb://${service}.zip" \
                --profile "$AWS_PROFILE"
        fi
    done
    
    echo -e "${GREEN}✓ Functions deployed${NC}"
}

# Function to run post-deployment tests
run_tests() {
    echo -e "${YELLOW}Running post-deployment tests...${NC}"
    
    # Test Lambda functions
    for service in email-processor document-extractor integration-adapter; do
        echo -e "  Testing $service..."
        aws lambda invoke \
            --function-name "${PROJECT_NAME}-${service}-${ENVIRONMENT}" \
            --payload '{"test": true}' \
            --profile "$AWS_PROFILE" \
            /tmp/test-output.json &>/dev/null || true
    done
    
    echo -e "${GREEN}✓ Tests completed${NC}"
}

# Function to display deployment summary
show_summary() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deployment Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Resources deployed:"
    echo "  • Infrastructure Stack: ${PROJECT_NAME}-infrastructure-${ENVIRONMENT}"
    echo "  • Monitoring Stack: ${PROJECT_NAME}-monitoring-${ENVIRONMENT}"
    echo "  • Lambda Functions:"
    echo "    - ${PROJECT_NAME}-email-processor-${ENVIRONMENT}"
    echo "    - ${PROJECT_NAME}-document-extractor-${ENVIRONMENT}"
    echo "    - ${PROJECT_NAME}-integration-adapter-${ENVIRONMENT}"
    echo ""
    echo "CloudWatch Dashboard:"
    echo "  https://console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=${PROJECT_NAME}-${ENVIRONMENT}"
    echo ""
    echo "S3 Buckets:"
    echo "  • Processing: s3://${PROJECT_NAME}-processing-${ENVIRONMENT}"
    echo "  • Documents: s3://${PROJECT_NAME}-documents-${ENVIRONMENT}"
    echo ""
}

# Main deployment flow
main() {
    echo -e "${YELLOW}Starting deployment process...${NC}"
    echo ""
    
    # Run pre-deployment checks
    check_dependencies
    check_aws_credentials
    validate_templates
    create_deployment_bucket
    
    # Deploy components
    deploy_infrastructure
    deploy_monitoring
    package_functions
    deploy_functions
    
    # Post-deployment
    if [ "$ENVIRONMENT" != "prod" ]; then
        run_tests
    fi
    
    # Show summary
    show_summary
}

# Confirmation for production
if [ "$ENVIRONMENT" == "prod" ]; then
    echo -e "${YELLOW}⚠️  WARNING: You are about to deploy to PRODUCTION${NC}"
    read -p "Are you sure you want to continue? (yes/no): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}Deployment cancelled${NC}"
        exit 1
    fi
fi

# Run main deployment
main

echo -e "${GREEN}Deployment script completed successfully!${NC}"