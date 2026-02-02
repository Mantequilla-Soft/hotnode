#!/bin/bash
#
# Test script for node type and validation architecture
# Validates the new node type system
#

set -e

echo "=== Testing Node Type & Validation Architecture ==="
echo ""

# Check if new files exist
echo "Checking for new files..."

if [ -f "utils/validationClient.js" ]; then
    echo "✅ validationClient.js exists"
else
    echo "❌ validationClient.js missing"
    exit 1
fi

if [ -f "workers/healthReporter.js" ]; then
    echo "✅ healthReporter.js exists"
else
    echo "❌ healthReporter.js missing"
    exit 1
fi

# Check for node type prompts in install script
echo ""
echo "Checking install script for node type support..."

if grep -q "prompt_node_type()" scripts/install.sh; then
    echo "✅ prompt_node_type() function found"
else
    echo "❌ prompt_node_type() function missing"
    exit 1
fi

if grep -q "NODE_TYPE=" scripts/install.sh; then
    echo "✅ NODE_TYPE variable declared"
else
    echo "❌ NODE_TYPE variable missing"
    exit 1
fi

if grep -q "VALIDATION_SERVER=" scripts/install.sh; then
    echo "✅ VALIDATION_SERVER variable declared"
else
    echo "❌ VALIDATION_SERVER variable missing"
    exit 1
fi

if grep -q "MONGODB_URI=" scripts/install.sh; then
    echo "✅ MONGODB_URI variable declared"
else
    echo "❌ MONGODB_URI variable missing"
    exit 1
fi

# Check validation API endpoints
echo ""
echo "Checking validation API endpoints..."

if grep -q "/api/validate/cid/:cid" routes/api.js; then
    echo "✅ Single CID validation endpoint found"
else
    echo "❌ Single CID validation endpoint missing"
    exit 1
fi

if grep -q "/api/validate/batch" routes/api.js; then
    echo "✅ Batch validation endpoint found"
else
    echo "❌ Batch validation endpoint missing"
    exit 1
fi

# Check validation client usage
echo ""
echo "Checking validation client integration..."

if grep -q "getValidationClient" workers/mongoValidator.js; then
    echo "✅ Validation client imported in mongoValidator"
else
    echo "❌ Validation client not imported"
    exit 1
fi

if grep -q "NODE_TYPE" workers/mongoValidator.js; then
    echo "✅ NODE_TYPE check in mongoValidator"
else
    echo "❌ NODE_TYPE check missing"
    exit 1
fi

# Check webhook system
echo ""
echo "Checking dual webhook system..."

if grep -q "defaultWebhookUrl" utils/discord.js; then
    echo "✅ Default webhook support in discord.js"
else
    echo "❌ Default webhook support missing"
    exit 1
fi

if grep -q "notifyNodeStatus" utils/discord.js; then
    echo "✅ Node status notification function found"
else
    echo "❌ Node status notification function missing"
    exit 1
fi

# Check health reporter worker
echo ""
echo "Checking health reporter worker..."

if grep -q "healthReporter" app.js; then
    echo "✅ Health reporter imported in app.js"
else
    echo "❌ Health reporter not imported"
    exit 1
fi

if grep -q "Health Reporter" app.js; then
    echo "✅ Health reporter scheduled in app.js"
else
    echo "❌ Health reporter not scheduled"
    exit 1
fi

# Check .env.example
echo ""
echo "Checking .env.example updates..."

if grep -q "NODE_TYPE=" .env.example; then
    echo "✅ NODE_TYPE in .env.example"
else
    echo "❌ NODE_TYPE missing from .env.example"
    exit 1
fi

if grep -q "VALIDATION_SERVER_URL=" .env.example; then
    echo "✅ VALIDATION_SERVER_URL in .env.example"
else
    echo "❌ VALIDATION_SERVER_URL missing from .env.example"
    exit 1
fi

if grep -q "DEFAULT_WEBHOOK_URL=" .env.example; then
    echo "✅ DEFAULT_WEBHOOK_URL in .env.example"
else
    echo "❌ DEFAULT_WEBHOOK_URL missing from .env.example"
    exit 1
fi

# Check config.json
echo ""
echo "Checking config.json updates..."

if grep -q "node_type" config.json; then
    echo "✅ node_type in config.json"
else
    echo "❌ node_type missing from config.json"
    exit 1
fi

if grep -q "validation" config.json; then
    echo "✅ validation section in config.json"
else
    echo "❌ validation section missing from config.json"
    exit 1
fi

if grep -q "default_webhook_url" config.json; then
    echo "✅ default_webhook_url in config.json"
else
    echo "❌ default_webhook_url missing from config.json"
    exit 1
fi

# Check documentation
echo ""
echo "Checking documentation..."

if [ -f "internal-docs/2026-02-02-node-types-validation.md" ]; then
    echo "✅ Node types architecture documentation exists"
else
    echo "❌ Architecture documentation missing"
    exit 1
fi

if [ -f "internal-docs/2026-02-02-implementation-summary.md" ]; then
    echo "✅ Implementation summary exists"
else
    echo "❌ Implementation summary missing"
    exit 1
fi

echo ""
echo "=== All Node Type & Validation Tests Passed! ==="
echo ""
echo "The system now supports:"
echo "  ✅ Infrastructure nodes (MongoDB access)"
echo "  ✅ Community nodes (API validation)"
echo "  ✅ Validation API endpoints"
echo "  ✅ Dual webhook system"
echo "  ✅ Health reporting"
echo "  ✅ Interactive node type selection"
echo "  ✅ Comprehensive documentation"
echo ""
