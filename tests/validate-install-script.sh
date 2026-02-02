#!/bin/bash
#
# Test script for install.sh validation
# Tests the logic without actually installing anything
#

set -e

echo "=== Testing install.sh Logic ==="
echo ""

# Check if install.sh exists and is readable
if [ ! -f "scripts/install.sh" ]; then
    echo "❌ scripts/install.sh not found"
    exit 1
fi

echo "✅ install.sh exists"

# Check for required functions
echo ""
echo "Checking for required functions..."

REQUIRED_FUNCTIONS=(
    "prompt_domain_config"
    "generate_nginx_config"
    "setup_ssl"
    "install_ipfs"
    "configure_nginx"
    "configure_firewall"
)

for func in "${REQUIRED_FUNCTIONS[@]}"; do
    if grep -q "^${func}()" scripts/install.sh; then
        echo "✅ Function found: $func"
    else
        echo "❌ Function missing: $func"
        exit 1
    fi
done

# Check for domain configuration variables
echo ""
echo "Checking for configuration variables..."

REQUIRED_VARS=(
    "USE_DOMAIN"
    "DOMAIN_NAME"
    "USE_SSL"
    "ADMIN_EMAIL"
)

for var in "${REQUIRED_VARS[@]}"; do
    if grep -q "^${var}=" scripts/install.sh; then
        echo "✅ Variable declared: $var"
    else
        echo "❌ Variable missing: $var"
        exit 1
    fi
done

# Check for certbot in dependencies
echo ""
echo "Checking for SSL dependencies..."

if grep -q "certbot" scripts/install.sh; then
    echo "✅ certbot included in dependencies"
else
    echo "❌ certbot not found in dependencies"
    exit 1
fi

# Check nginx config generator handles both scenarios
echo ""
echo "Checking nginx config generator..."

if grep -q 'if \[ "\$USE_DOMAIN" = "yes" \]' scripts/install.sh; then
    echo "✅ Domain-based config handling found"
else
    echo "❌ Domain-based config handling missing"
    exit 1
fi

if grep -q "IP-only" scripts/install.sh; then
    echo "✅ IP-only config handling found"
else
    echo "❌ IP-only config handling missing"
    exit 1
fi

# Check IPFS version validation
echo ""
echo "Checking IPFS version validation..."

if grep -q "INSTALLED_VERSION" scripts/install.sh && grep -q "REQUIRED_VERSION" scripts/install.sh; then
    echo "✅ IPFS version checking implemented"
else
    echo "❌ IPFS version checking missing"
    exit 1
fi

# Check firewall configuration adapts
echo ""
echo "Checking firewall configuration..."

if grep -q "Configure ports based on deployment type" scripts/install.sh; then
    echo "✅ Adaptive firewall configuration found"
else
    echo "❌ Adaptive firewall configuration missing"
    exit 1
fi

echo ""
echo "=== All Tests Passed! ==="
echo ""
echo "The install script includes:"
echo "  ✅ Interactive domain configuration"
echo "  ✅ Dynamic nginx config generation"
echo "  ✅ SSL/Let's Encrypt support"
echo "  ✅ IPFS version checking"
echo "  ✅ IP-only deployment support"
echo "  ✅ Adaptive firewall rules"
echo ""
